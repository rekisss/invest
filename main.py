from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import time
from typing import Any

import pandas as pd

from backtest import run_backtest
from data_loader import (
    FinMindClient,
    fetch_financial_statement_dates,
    fetch_foreign_investor_data,
    fetch_market_index,
    fetch_stock_info,
    fetch_stock_kbar,
    fetch_stock_prices,
    load_stock_list,
)
from fugle_client import FugleClient, fetch_watch_quotes
from notifier import send_discord_messages, split_message
from report import save_hybrid_report, save_reports, save_scan_report, save_sponsor_monitor_report
from strategy import (
    StrategyConfig,
    latest_signal_snapshot,
    prepare_market_frame,
    prepare_stock_signals,
    rank_candidates,
)
from universe import build_auto_universe


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Taiwan MACD swing strategy backtester and scanner.")
    parser.add_argument("--mode", choices=["backtest", "scan", "hybrid-monitor", "sponsor-monitor"], default="scan")
    parser.add_argument("--stocks", default="auto", help="CSV file containing stock_id and optional name, or 'auto'.")
    parser.add_argument("--start", default="2020-01-01")
    parser.add_argument("--end", default=pd.Timestamp.today().strftime("%Y-%m-%d"))
    parser.add_argument("--capital", type=float, default=1_000_000)
    parser.add_argument("--output", default="output")
    parser.add_argument("--lookback-days", type=int, default=420)
    parser.add_argument("--max-universe", type=int, default=120)
    parser.add_argument("--top-n", type=int, default=20)
    parser.add_argument("--watch-top", type=int, default=10, help="Maximum live-watch symbols.")
    parser.add_argument("--interval-seconds", type=int, default=120, help="Polling interval for repeated monitor runs.")
    parser.add_argument("--repeat-count", type=int, default=1, help="How many monitor cycles to run.")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--notify", action="store_true")
    parser.add_argument("--use-earnings-filter", action="store_true")
    return parser.parse_args()


def load_universe(args: argparse.Namespace, client: FinMindClient) -> pd.DataFrame:
    if args.stocks != "auto":
        return load_stock_list(args.stocks)
    stock_info = fetch_stock_info(client)
    return build_auto_universe(stock_info, max_symbols=args.max_universe)


def collect_signals(
    stock_list: pd.DataFrame,
    client: FinMindClient,
    market: pd.DataFrame,
    config: StrategyConfig,
    start_date: str,
    end_date: str,
    workers: int,
) -> tuple[dict[str, pd.DataFrame], list[pd.DataFrame]]:
    signals_by_stock: dict[str, pd.DataFrame] = {}
    signal_frames: list[pd.DataFrame] = []

    def load_one(stock: dict[str, Any]) -> tuple[str, pd.DataFrame] | None:
        prices = fetch_stock_prices(client, stock["stock_id"], start_date, end_date)
        if prices.empty:
            return None
        foreign = fetch_foreign_investor_data(client, stock["stock_id"], start_date, end_date)
        earnings = fetch_financial_statement_dates(client, stock["stock_id"], start_date, end_date)
        frame = prepare_stock_signals(stock, prices, market, foreign, config, earnings_dates=earnings)
        return stock["stock_id"], frame

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(load_one, stock) for stock in stock_list.to_dict("records")]
        for future in as_completed(futures):
            result = future.result()
            if result is None:
                continue
            stock_id, signal_frame = result
            signals_by_stock[stock_id] = signal_frame
            signal_frames.append(
                signal_frame[
                    [
                        "date",
                        "stock_id",
                        "name",
                        "industry_category",
                        "entry_signal",
                        "entry_reason",
                        "skip_trade",
                        "skip_reason",
                        "base_exit_signal",
                        "base_exit_reason",
                        "condition_count",
                        "entry_score",
                        "relative_strength_5d",
                        "volume_ratio",
                        "rsi14",
                        "adx14",
                        "foreign_buy_streak",
                        "close",
                    ]
                ].copy()
            )
    return signals_by_stock, signal_frames


def build_daily_snapshot(args: argparse.Namespace, client: FinMindClient, config: StrategyConfig) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    end_date = pd.Timestamp(args.end)
    start_date = (end_date - pd.Timedelta(days=args.lookback_days)).strftime("%Y-%m-%d")
    end_date_text = end_date.strftime("%Y-%m-%d")

    market_raw = fetch_market_index(client, start_date, end_date_text)
    if market_raw.empty:
        raise RuntimeError("Unable to download TAIEX market data from FinMind.")
    market = prepare_market_frame(market_raw, config)

    universe = load_universe(args, client)
    signals_by_stock, _ = collect_signals(universe, client, market, config, start_date, end_date_text, args.workers)
    snapshot = latest_signal_snapshot(signals_by_stock)
    candidates, watchlist = rank_candidates(snapshot, args.top_n)
    return candidates, watchlist, universe


def format_scan_message(candidates: pd.DataFrame, watchlist: pd.DataFrame, latest_date: str) -> str:
    header = [f"Taiwan MACD scan ({latest_date})", ""]
    if candidates.empty:
        lines = header + ["No stocks fully matched all daily MACD filters today.", "", "Closest watchlist:"]
        for _, row in watchlist.head(10).iterrows():
            lines.append(
                f"- {row['stock_id']} {row['name']} | {row['industry_category']} | score {int(row['condition_count'])}/13 | close {row['close']:.2f}"
            )
        return "\n".join(lines)

    lines = header + ["Daily candidates:"]
    for _, row in candidates.iterrows():
        lines.append(
            f"- {row['stock_id']} {row['name']} | {row['industry_category']} | close {row['close']:.2f} | RSI {row['rsi14']:.1f} | ADX {row['adx14']:.1f} | RS5 {row['relative_strength_5d']:.2%} | foreign streak {int(row['foreign_buy_streak'])}"
        )
    if not watchlist.empty:
        lines.extend(["", "Closest watchlist:"])
        for _, row in watchlist.head(8).iterrows():
            lines.append(
                f"- {row['stock_id']} {row['name']} | {row['industry_category']} | score {int(row['condition_count'])}/13 | close {row['close']:.2f}"
            )
    return "\n".join(lines)


def format_hybrid_message(candidates: pd.DataFrame, watchlist: pd.DataFrame, live_quotes: pd.DataFrame, latest_date: str) -> str:
    lines = [f"Taiwan hybrid monitor ({latest_date})", "", "Step 1: daily MACD prefilter"]
    if candidates.empty:
        lines.append("No full-match candidates today.")
    else:
        for _, row in candidates.head(5).iterrows():
            lines.append(
                f"- {row['stock_id']} {row['name']} | close {row['close']:.2f} | score {int(row['condition_count'])}/13"
            )

    if not watchlist.empty:
        lines.extend(["", "Step 2: near-match watchlist"])
        for _, row in watchlist.head(5).iterrows():
            lines.append(
                f"- {row['stock_id']} {row['name']} | close {row['close']:.2f} | score {int(row['condition_count'])}/13"
            )

    if not live_quotes.empty:
        lines.extend(["", "Step 3: Fugle live quotes"])
        for _, row in live_quotes.iterrows():
            if pd.notna(row.get("error")):
                lines.append(f"- {row['symbol']} | live quote error: {row['error']}")
                continue
            last = row.get("last")
            prev_close = row.get("prev_close")
            intraday = None
            if pd.notna(last) and pd.notna(prev_close) and prev_close not in (0, None):
                intraday = (float(last) / float(prev_close) - 1) * 100
            intraday_text = f"{intraday:.2f}%" if intraday is not None else "N/A"
            lines.append(
                f"- {row['symbol']} {row.get('name') or ''} | last {row.get('last')} | open {row.get('open')} | high {row.get('high')} | vol {row.get('volume')} | intraday {intraday_text}"
            )
    return "\n".join(lines)


def collect_intraday_snapshot(
    client: FinMindClient,
    watch_symbols: list[str],
    trade_date: str,
) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    for symbol in watch_symbols:
        try:
            kbars = fetch_stock_kbar(client, symbol, trade_date)
            if kbars.empty:
                rows.append({"stock_id": symbol, "error": "No KBar data returned"})
                continue
            latest = kbars.iloc[-1].to_dict()
            rows.append(latest)
        except Exception as error:
            rows.append({"stock_id": symbol, "error": str(error)})
    return pd.DataFrame(rows)


def format_sponsor_message(
    candidates: pd.DataFrame,
    watchlist: pd.DataFrame,
    intraday_rows: pd.DataFrame,
    latest_date: str,
    cycle: int,
    repeat_count: int,
) -> str:
    lines = [f"Taiwan sponsor monitor ({latest_date}) cycle {cycle}/{repeat_count}", "", "Step 1: daily prefilter"]
    if candidates.empty:
        lines.append("No full-match candidates today.")
    else:
        for _, row in candidates.head(5).iterrows():
            lines.append(f"- {row['stock_id']} {row['name']} | close {row['close']:.2f} | score {int(row['condition_count'])}/13")

    if not watchlist.empty:
        lines.extend(["", "Step 2: tracked symbols"])
        for _, row in watchlist.head(5).iterrows():
            lines.append(f"- {row['stock_id']} {row['name']} | close {row['close']:.2f} | score {int(row['condition_count'])}/13")

    if not intraday_rows.empty:
        lines.extend(["", "Step 3: intraday KBar snapshot"])
        for _, row in intraday_rows.iterrows():
            if pd.notna(row.get("error")):
                lines.append(f"- {row.get('stock_id')} | KBar error: {row['error']}")
                continue
            lines.append(
                f"- {row.get('stock_id')} | {row.get('minute')} | O {row.get('open')} H {row.get('high')} L {row.get('low')} C {row.get('close')} V {row.get('volume')}"
            )
    return "\n".join(lines)


def run_scan(args: argparse.Namespace, client: FinMindClient, config: StrategyConfig) -> None:
    candidates, watchlist, universe = build_daily_snapshot(args, client, config)
    latest_date = args.end
    report_path = save_scan_report(args.output, candidates, watchlist, universe)
    message = format_scan_message(candidates, watchlist, latest_date)
    print(message)
    print("")
    print(f"Scan report: {report_path}")
    if args.notify:
        send_discord_messages(split_message(message))


def run_hybrid_monitor(args: argparse.Namespace, client: FinMindClient, config: StrategyConfig) -> None:
    candidates, watchlist, universe = build_daily_snapshot(args, client, config)
    watch_pool = candidates.copy()
    if len(watch_pool) < args.watch_top:
        extra = watchlist.head(args.watch_top - len(watch_pool))
        watch_pool = pd.concat([watch_pool, extra], ignore_index=True)
    watch_symbols = watch_pool["stock_id"].astype(str).head(args.watch_top).tolist()

    fugle = FugleClient()
    if fugle.enabled and watch_symbols:
        live_quotes = fetch_watch_quotes(fugle, watch_symbols)
    else:
        live_quotes = pd.DataFrame(
            [{"symbol": symbol, "error": "FUGLE_API_KEY not configured"} for symbol in watch_symbols]
        )

    report_path = save_hybrid_report(args.output, candidates, watchlist, live_quotes, universe)
    message = format_hybrid_message(candidates, watchlist, live_quotes, args.end)
    print(message)
    print("")
    print(f"Hybrid report: {report_path}")
    if args.notify:
        send_discord_messages(split_message(message))


def run_sponsor_monitor(args: argparse.Namespace, client: FinMindClient, config: StrategyConfig) -> None:
    candidates, watchlist, universe = build_daily_snapshot(args, client, config)
    watch_pool = candidates.copy()
    if len(watch_pool) < args.watch_top:
        extra = watchlist.head(args.watch_top - len(watch_pool))
        watch_pool = pd.concat([watch_pool, extra], ignore_index=True)
    watch_symbols = watch_pool["stock_id"].astype(str).head(args.watch_top).tolist()

    last_report_path = None
    for cycle in range(1, args.repeat_count + 1):
        intraday_rows = collect_intraday_snapshot(client, watch_symbols, args.end)
        last_report_path = save_sponsor_monitor_report(args.output, candidates, watchlist, intraday_rows, universe)
        message = format_sponsor_message(candidates, watchlist, intraday_rows, args.end, cycle, args.repeat_count)
        print(message)
        print("")
        print(f"Sponsor report: {last_report_path}")
        if args.notify:
            send_discord_messages(split_message(message))
        if cycle < args.repeat_count:
            time.sleep(args.interval_seconds)


def run_backtest_mode(args: argparse.Namespace, client: FinMindClient, config: StrategyConfig) -> None:
    stock_list = load_universe(args, client)
    market_raw = fetch_market_index(client, args.start, args.end)
    if market_raw.empty:
        raise RuntimeError("Unable to download TAIEX market data from FinMind.")
    market = prepare_market_frame(market_raw, config)
    signals_by_stock, signal_frames = collect_signals(stock_list, client, market, config, args.start, args.end, args.workers)
    if not signals_by_stock:
        raise RuntimeError("No stock data was loaded. Check the stock universe and FinMind credentials.")

    backtest = run_backtest(signals_by_stock, market, config, args.capital)
    all_signals = pd.concat(signal_frames, ignore_index=True).sort_values(["date", "stock_id"])
    reports = save_reports(
        output_dir=args.output,
        metrics=backtest["metrics"],
        yearly=backtest["yearly"],
        trade_summary=backtest["trade_summary"],
        fills=backtest["fills"],
        equity_curve=backtest["equity_curve"],
        signals=all_signals,
        notes=backtest["notes"]
        + [
            "Daily backtest assumes signal evaluation and fills occur on the same close for simplicity.",
            "The earnings-date filter is optional because FinMind statement timing fields may vary by dataset.",
            "Position sizing uses integer shares and a 5% initial stop to cap risk at roughly 1% of portfolio equity.",
        ],
    )
    print("Backtest complete.")
    print(f"Excel report: {reports['excel']}")
    print(f"Equity chart: {reports['equity_chart']}")
    print(f"Yearly chart: {reports['yearly_chart']}")
    print("")
    print("Key metrics:")
    for key, value in backtest["metrics"].items():
        if isinstance(value, float):
            print(f"- {key}: {value:,.2f}")
        else:
            print(f"- {key}: {value}")


def main() -> None:
    args = parse_args()
    client = FinMindClient(cache_dir=Path(args.output) / "cache")
    config = StrategyConfig(use_earnings_filter=args.use_earnings_filter)

    if args.mode == "backtest":
        run_backtest_mode(args, client, config)
    elif args.mode == "sponsor-monitor":
        run_sponsor_monitor(args, client, config)
    elif args.mode == "hybrid-monitor":
        run_hybrid_monitor(args, client, config)
    else:
        run_scan(args, client, config)


if __name__ == "__main__":
    main()
