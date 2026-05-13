from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
from pathlib import Path
import sys
import time
from typing import Any

import pandas as pd

from backtest import run_backtest
from data_loader import (
    FinMindClient,
    clean_cache,
    fetch_financial_statement_dates,
    fetch_institutional_data,
    fetch_market_index,
    fetch_stock_info,
    fetch_stock_kbar,
    fetch_stock_prices,
    load_stock_list,
)
from fugle_client import FugleClient, fetch_watch_quotes
from news_service import NewsClient, summarize_news
from notifier import send_discord_messages, split_message
from report import save_hybrid_report, save_reports, save_scan_report, save_sponsor_monitor_report
from strategy import (
    StrategyConfig,
    compute_market_breadth,
    latest_signal_snapshot,
    prepare_market_frame,
    prepare_stock_signals,
    rank_candidates,
)
from universe import build_auto_universe
from notion_sync import notion_enabled, recommend_observation_period, sync_scan_results


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Taiwan MACD swing strategy backtester and scanner.")
    parser.add_argument("--mode", choices=["backtest", "scan", "hybrid-monitor", "sponsor-monitor", "event-monitor", "daily-report", "walk-forward"], default="scan")
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
    parser.add_argument("--max-price", type=float, default=None, help="Optional maximum close price filter for ranking.")
    parser.add_argument("--prefer-lower-price", action="store_true", help="Prefer lower-priced names when ranking candidates.")
    parser.add_argument("--include-news", action="store_true", help="Attach recent news summary to notifications.")
    parser.add_argument("--news-limit", type=int, default=2, help="Maximum number of news headlines per stock in notifications.")
    parser.add_argument("--event-rise-threshold", type=float, default=0.045, help="Intraday rise threshold for event monitor.")
    parser.add_argument("--event-drop-threshold", type=float, default=-0.035, help="Intraday drop threshold for event monitor.")
    parser.add_argument("--event-volume-multiplier", type=float, default=2.5, help="Volume surge multiple versus previous sample.")
    parser.add_argument("--event-cooldown-seconds", type=int, default=600, help="Cooldown before the same symbol+event can notify again.")
    parser.add_argument("--notify", action="store_true")
    parser.add_argument("--use-earnings-filter", action="store_true")
    parser.add_argument("--next-day-fill", action="store_true", help="Fill backtest entries at next day open instead of signal-day close.")
    parser.add_argument("--heartbeat-minutes", type=int, default=0, help="Send a status snapshot every N minutes during event-monitor (0 = disabled).")
    parser.add_argument("--clean-cache", action="store_true", help="Delete stale cache files before running.")
    parser.add_argument("--clean-cache-days", type=int, default=30, help="Age threshold in days for --clean-cache (default 30).")
    parser.add_argument("--wf-folds", type=int, default=4, help="Number of folds for walk-forward analysis (default 4).")
    parser.add_argument("--wf-overlap-days", type=int, default=0, help="Overlap days between walk-forward folds (default 0).")
    parser.add_argument("--watch-extra", default="", help="Comma-separated stock IDs to always include in event-monitor watch list.")
    return parser.parse_args()


_SENTIMENT_EMOJI: dict[str, str] = {
    "positive": "📈",
    "negative": "📉",
    "neutral": "📰",
}

ENTRY_REASON_LABELS = {
    "macd_golden_cross": "MACD黃金交叉",
    "hist_turn_positive": "柱狀圖翻正",
    "above_ema60": "站上EMA60",
    "ema60_gt_ema120": "EMA60大於EMA120",
    "volume_break": "量能放大",
    "rsi_strong": "RSI偏強",
    "adx_trending": "ADX趨勢成立",
    "breakout_20d": "突破20日高點",
    "market_above_ma60": "大盤站上MA60",
    "foreign_buy_3d": "外資連3買",
    "avoid_chase": "未過度追價",
    "liquidity_ok": "流動性合格",
    "stronger_than_market": "強於大盤",
    "kd_golden_cross": "KD黃金交叉",
    "obv_uptrend": "OBV趨勢向上",
    "invest_trust_buy_2d": "投信連買2天",
    "bb_squeeze_breakout": "BB壓縮突破",
    "breakout_volume_confirm": "突破量能確認",
    "williams_r_recovery": "W%R超賣回升",
    "cci_momentum": "CCI動能強勁",
    "mfi_strong": "MFI資金流入",
    "above_ichimoku_cloud": "站上一目雲",
    "dealer_buy_3d": "自營連買3天",
}

_MAX_CONDITION_COUNT = 23


def _confidence_score(row: object) -> int:
    cond = min(int(float(row.get("condition_count", 0) or 0)) / 23 * 55, 55)  # type: ignore[union-attr]
    adx_pts = min(float(row.get("adx14", 0) or 0) / 40 * 20, 20)  # type: ignore[union-attr]
    rs_pts = min(max(float(row.get("relative_strength_5d", 0) or 0) * 200, 0), 15)  # type: ignore[union-attr]
    vol_pts = min(max((float(row.get("volume_ratio", 0) or 0) - 1) / 2 * 10, 0), 10)  # type: ignore[union-attr]
    return max(0, min(100, int(cond + adx_pts + rs_pts + vol_pts)))


def _entry_stop_target(close: float, atr: float | None, stop_pct: float = 0.05, target_pct: float = 0.10) -> tuple[str, str, str, str]:
    if atr and atr > 0:
        # ATR-based: entry within 0.5 ATR, stop 2 ATR below, target 3 ATR above
        entry_hi = round(close + 0.5 * atr, 2)
        stop = round(close - 2.0 * atr, 2)
        target = round(close + 3.0 * atr, 2)
    else:
        entry_hi = round(close * 1.015, 2)
        stop = round(close * (1 - stop_pct), 2)
        target = round(close * (1 + target_pct), 2)
    rr = round((target - close) / max(close - stop, 0.01), 1)
    return f"{close:.2f}–{entry_hi:.2f}", f"{stop:.2f}", f"{target:.2f}", f"{rr}:1"


def _safe_print(message: str = "") -> None:
    try:
        print(message)
    except UnicodeEncodeError:
        encoded = message.encode(sys.stdout.encoding or "utf-8", errors="replace").decode(sys.stdout.encoding or "utf-8", errors="replace")
        print(encoded)


def _reason_labels(raw_reason: object, max_items: int = 3) -> str:
    parts = [part.strip() for part in str(raw_reason or "").split(",") if part.strip()]
    labels = [ENTRY_REASON_LABELS.get(part, part) for part in parts[:max_items]]
    return " / ".join(labels) if labels else "條件接近"


def _low_price_tag(close_value: object) -> str:
    try:
        close_float = float(close_value)
    except (TypeError, ValueError):
        return ""
    if close_float <= 30:
        return "低價"
    if close_float <= 80:
        return "中低價"
    return ""


def build_news_map(
    output_dir: str | Path,
    rows: list[dict[str, object]],
    news_limit: int = 2,
) -> dict[str, dict[str, object]]:
    client = NewsClient(cache_dir=Path(output_dir) / "news_cache")
    news_map: dict[str, dict[str, object]] = {}

    def _fetch_one(row: dict[str, object]) -> tuple[str, dict[str, object]] | None:
        stock_id = str(row.get("stock_id") or "")
        name = str(row.get("name") or stock_id)
        if not stock_id:
            return None
        try:
            frame = client.fetch_stock_news(stock_id, name, limit=news_limit)
            items = frame.to_dict(orient="records")
            return stock_id, {"items": items, "summary": summarize_news(items)}
        except Exception as exc:
            print(f"[news] {stock_id} 抓取失敗: {exc}", file=sys.stderr)
            return None

    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(_fetch_one, row) for row in rows[:5]]
        for future in as_completed(futures):
            result = future.result()
            if result:
                stock_id, data = result
                news_map[stock_id] = data

    return news_map


def _news_brief(stock_id: str, news_map: dict[str, dict[str, object]]) -> str:
    payload = news_map.get(stock_id)
    if not payload:
        return ""
    summary = payload.get("summary", {})
    sentiment = str(summary.get("sentiment") or "neutral")
    emoji = _SENTIMENT_EMOJI.get(sentiment, "📰")
    top = summary.get("top_headlines") or []
    titles = [str(h.get("title") or "").replace("\n", " ").strip() for h in top[:2] if h.get("title")]
    if not titles:
        headline = str(summary.get("headline") or "").replace("\n", " ").strip()
        if not headline:
            return ""
        titles = [headline]
    parts = [(t[:38] + "…") if len(t) > 38 else t for t in titles]
    return f"\n  {emoji} {' / '.join(parts)}"


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
        try:
            prices = fetch_stock_prices(client, stock["stock_id"], start_date, end_date)
            if prices.empty:
                return None
            institutional = fetch_institutional_data(client, stock["stock_id"], start_date, end_date)
            earnings = pd.DataFrame(columns=["date"])
            if config.use_earnings_filter:
                earnings = fetch_financial_statement_dates(client, stock["stock_id"], start_date, end_date)
            frame = prepare_stock_signals(stock, prices, market, institutional, config, earnings_dates=earnings)
            return stock["stock_id"], frame
        except Exception as error:
            print(f"[warn] skipped {stock['stock_id']}: {error}", file=sys.stderr)
            return None

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(load_one, stock) for stock in stock_list.to_dict("records")]
        for future in as_completed(futures):
            result = future.result()
            if result is None:
                continue
            stock_id, signal_frame = result
            signals_by_stock[stock_id] = signal_frame
            _signal_cols = [
                "date", "stock_id", "name", "industry_category",
                "open", "high", "low", "close",
                "entry_signal", "entry_reason", "skip_trade", "skip_reason",
                "base_exit_signal", "base_exit_reason",
                "condition_count", "entry_score",
                "relative_strength_5d", "volume_ratio",
                "rsi14", "adx14", "atr14",
                "foreign_buy_streak", "invest_trust_streak",
                "stoch_k", "stoch_d", "bb_pct_b", "bb_bandwidth",
                "obv_uptrend", "bb_squeeze_breakout", "breakout_volume_confirm",
                "dealer_buy_streak", "dealer_buy_3d",
                "williams_r", "cci20", "mfi14", "mfi_strong", "above_ichimoku_cloud",
            ]
            _signal_cols_present = [c for c in _signal_cols if c in signal_frame.columns]
            signal_frames.append(signal_frame[_signal_cols_present].copy())
    return signals_by_stock, signal_frames


def build_daily_snapshot(
    args: argparse.Namespace, client: FinMindClient, config: StrategyConfig
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, dict[str, object]]:
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
    breadth = compute_market_breadth(snapshot)
    candidates, watchlist = rank_candidates(
        snapshot,
        args.top_n,
        max_price=args.max_price,
        prefer_lower_price=args.prefer_lower_price,
    )
    return candidates, watchlist, universe, breadth


def _format_breadth_line(breadth: dict[str, object]) -> str:
    total = int(breadth.get("total_stocks", 0))
    if not total:
        return ""
    entry_pct = int(breadth.get("entry_signal_pct", 0))
    above_ema = int(breadth.get("above_ema60", 0))
    trend_up = int(breadth.get("ema60_gt_ema120", 0))
    market_ok = int(breadth.get("market_above_ma60", 0))
    momentum = int(breadth.get("macd_golden_cross", 0))
    return (
        f"📊 市場廣度（{total}支）｜全條件候選 `{entry_pct}%` | "
        f"站EMA60 `{above_ema}%` | 趨勢向上 `{trend_up}%` | "
        f"MACD交叉 `{momentum}%` | 大盤 `{'✅' if market_ok > 50 else '❌'}`"
    )


def format_scan_message_rich(
    candidates: pd.DataFrame,
    watchlist: pd.DataFrame,
    latest_date: str,
    news_map: dict[str, dict[str, object]] | None = None,
    breadth: dict[str, object] | None = None,
) -> str:
    news_map = news_map or {}
    lines = [f"🔍 **Taiwan MACD Scan** · {latest_date}", ""]
    if breadth:
        breadth_line = _format_breadth_line(breadth)
        if breadth_line:
            lines.append(breadth_line)
            lines.append("")
    if candidates.empty:
        lines.extend(["今日無全條件候選。", "", "**近似觀察名單**"])
        for _, row in watchlist.head(8).iterrows():
            price_tag = _low_price_tag(row.get("close"))
            price_note = f" `{price_tag}`" if price_tag else ""
            brief = _news_brief(str(row["stock_id"]), news_map)
            lines.append(
                f"• **{row['stock_id']}** {row['name']} | `{int(row['condition_count'])}/{_MAX_CONDITION_COUNT}` | 收 `{row['close']:.2f}`{price_note} | {_reason_labels(row.get('entry_reason'))}{brief}"
            )
        return "\n".join(lines)

    lines.append("**每日候選**")
    for _, row in candidates.head(6).iterrows():
        close = float(row["close"])
        atr = float(row["atr14"]) if "atr14" in row and pd.notna(row.get("atr14")) else None
        entry_zone, stop, target, rr = _entry_stop_target(close, atr)
        confidence = _confidence_score(row)
        cond_count = int(row["condition_count"])
        price_tag = _low_price_tag(row.get("close"))
        price_note = f" `{price_tag}`" if price_tag else ""
        brief = _news_brief(str(row["stock_id"]), news_map)
        obs = recommend_observation_period(row, is_candidate=True)
        stoch_k = float(row["stoch_k"]) if "stoch_k" in row and pd.notna(row.get("stoch_k")) else None
        kd_txt = f" | KD `{stoch_k:.0f}`" if stoch_k is not None else ""
        mfi_val = float(row["mfi14"]) if "mfi14" in row and pd.notna(row.get("mfi14")) else None
        mfi_txt = f" | MFI `{mfi_val:.0f}`" if mfi_val is not None else ""
        invest_streak = int(row.get("invest_trust_streak", 0) or 0)
        invest_txt = f" | 投信 `{invest_streak}d`" if invest_streak >= 1 else ""
        dealer_streak = int(row.get("dealer_buy_streak", 0) or 0)
        dealer_txt = f" | 自營 `{dealer_streak}d`" if dealer_streak >= 1 else ""
        ichi_txt = " | ☁雲上" if bool(row.get("above_ichimoku_cloud")) else ""
        lines.append(f"━━━━━━━━━━━━━━━━━━━━")
        lines.append(f"**{row['stock_id']}** {row['name']}{price_note}  信心 `{confidence}/100` | `{cond_count}/{_MAX_CONDITION_COUNT}條`")
        lines.append(f"💰 收 `{close:.2f}` | 進場 `{entry_zone}` | 停損 `{stop}` | 目標 `{target}` | R:R `{rr}`")
        lines.append(f"📊 RSI `{row['rsi14']:.1f}` | ADX `{row['adx14']:.1f}`{kd_txt}{mfi_txt} | 量比 `{float(row.get('volume_ratio', 0)):.1f}x`{ichi_txt}")
        lines.append(f"🏦 外資連買 `{int(row.get('foreign_buy_streak', 0))}d`{invest_txt}{dealer_txt}")
        lines.append(f"🔍 {_reason_labels(row.get('entry_reason'), max_items=5)}")
        if brief:
            lines.append(f"  {brief.strip()}")
        lines.append(f"⏱ {obs}")
    if not watchlist.empty:
        lines.extend(["", "━━━━━━━━━━━━━━━━━━━━", "**近似觀察名單**"])
        for _, row in watchlist.head(5).iterrows():
            price_tag = _low_price_tag(row.get("close"))
            price_note = f" `{price_tag}`" if price_tag else ""
            brief = _news_brief(str(row["stock_id"]), news_map)
            lines.append(
                f"• **{row['stock_id']}** {row['name']} | `{int(row['condition_count'])}/{_MAX_CONDITION_COUNT}` | 收 `{row['close']:.2f}`{price_note} | {_reason_labels(row.get('entry_reason'))}{brief}"
            )
    return "\n".join(lines)


def format_hybrid_message_rich(
    candidates: pd.DataFrame,
    watchlist: pd.DataFrame,
    live_quotes: pd.DataFrame,
    latest_date: str,
    news_map: dict[str, dict[str, object]] | None = None,
) -> str:
    news_map = news_map or {}
    lines = [f"📊 **Taiwan Hybrid Monitor** · {latest_date}", "", "**Step 1｜MACD 每日篩選**"]
    if candidates.empty:
        lines.append("今日無全條件候選。")
    else:
        for _, row in candidates.head(5).iterrows():
            price_tag = _low_price_tag(row.get("close"))
            price_note = f" `{price_tag}`" if price_tag else ""
            brief = _news_brief(str(row["stock_id"]), news_map)
            lines.append(
                f"• **{row['stock_id']}** {row['name']} | 收 `{float(row['close']):.2f}`{price_note} | {_reason_labels(row.get('entry_reason'))}{brief}"
            )
    if not watchlist.empty:
        lines.extend(["", "**Step 2｜近似觀察名單**"])
        for _, row in watchlist.head(5).iterrows():
            close_value = row["close"] if "close" in row and pd.notna(row["close"]) else None
            close_text = f"`{float(close_value):.2f}`" if close_value is not None else "N/A"
            price_tag = _low_price_tag(close_value)
            price_note = f" `{price_tag}`" if price_tag else ""
            score_value = row["condition_count"] if "condition_count" in row and pd.notna(row["condition_count"]) else None
            score_text = f"`{int(score_value)}/23`" if score_value is not None else "manual"
            brief = _news_brief(str(row["stock_id"]), news_map)
            lines.append(
                f"• **{row['stock_id']}** {row['name']} | 收 {close_text}{price_note} | {score_text} | {_reason_labels(row.get('entry_reason'))}{brief}"
            )
    if not live_quotes.empty:
        lines.extend(["", "**Step 3｜即時報價**"])
        for _, row in live_quotes.iterrows():
            if pd.notna(row.get("error")):
                lines.append(f"• {row['symbol']} — 報價錯誤: {row['error']}")
                continue
            intraday = row.get("intraday_pct")
            intraday_text = f"`{float(intraday) * 100:.2f}%`" if pd.notna(intraday) else "N/A"
            lines.append(
                f"• **{row['symbol']}** {row.get('name') or ''} | 最新 `{row.get('last')}` | 高 `{row.get('high')}` | 量 `{row.get('volume')}` | 漲幅 {intraday_text}"
            )
    return "\n".join(lines)


def detect_quote_events(
    current_quotes: pd.DataFrame,
    previous_state: dict[str, dict[str, float | str]],
    rise_threshold: float,
    drop_threshold: float,
    volume_multiplier: float,
    daily_volume_lookup: dict[str, float] | None = None,
) -> tuple[list[dict[str, object]], dict[str, dict[str, float | str]]]:
    events: list[dict[str, object]] = []
    next_state = dict(previous_state)
    for _, row in current_quotes.iterrows():
        symbol = str(row.get("symbol") or "")
        if not symbol or pd.notna(row.get("error")):
            continue
        last_value = pd.to_numeric(row.get("last"), errors="coerce")
        high_value = pd.to_numeric(row.get("high"), errors="coerce")
        volume_value = pd.to_numeric(row.get("volume"), errors="coerce")
        intraday_value = pd.to_numeric(row.get("intraday_pct"), errors="coerce")
        previous = next_state.get(symbol, {})
        previous_high = float(previous.get("high") or 0)
        previous_intraday = float(previous.get("intraday_pct") or 0)
        previous_volume = float(previous.get("volume") or 0)

        if (pd.notna(high_value) and high_value > previous_high
                and pd.notna(last_value) and last_value >= high_value * 0.998
                and pd.notna(intraday_value) and intraday_value >= 0.015):
            events.append({"symbol": symbol, "event_key": "breakout_high", "label": "突破盤中新高", "row": row.to_dict()})
        if pd.notna(intraday_value) and intraday_value >= rise_threshold and previous_intraday < rise_threshold:
            events.append({"symbol": symbol, "event_key": "sharp_rise", "label": f"急拉 {intraday_value * 100:.2f}%", "row": row.to_dict()})
        if pd.notna(intraday_value) and intraday_value <= drop_threshold and previous_intraday > drop_threshold:
            events.append({"symbol": symbol, "event_key": "sharp_drop", "label": f"急跌 {intraday_value * 100:.2f}%", "row": row.to_dict()})

        daily_baseline = (daily_volume_lookup or {}).get(symbol, 0)
        if daily_baseline > 0:
            if pd.notna(volume_value) and volume_value >= daily_baseline * volume_multiplier:
                ratio = volume_value / daily_baseline
                events.append({"symbol": symbol, "event_key": "volume_surge", "label": f"量能放大 x{ratio:.1f}（vs 日均）", "row": row.to_dict()})
        elif pd.notna(volume_value) and previous_volume > 0 and volume_value >= previous_volume * volume_multiplier:
            events.append({"symbol": symbol, "event_key": "volume_surge", "label": f"量能放大 x{volume_value / previous_volume:.1f}", "row": row.to_dict()})

        next_state[symbol] = {
            "high": float(high_value) if pd.notna(high_value) else previous_high,
            "intraday_pct": float(intraday_value) if pd.notna(intraday_value) else previous_intraday,
            "volume": float(volume_value) if pd.notna(volume_value) else previous_volume,
            "quote_time": str(row.get("quote_time") or ""),
        }
    return events, next_state


_EVENT_EMOJI: dict[str, str] = {
    "breakout_high": "🆙",
    "sharp_rise": "📈",
    "sharp_drop": "📉",
    "volume_surge": "🔥",
}


def format_event_message(
    event: dict[str, object],
    snapshot_lookup: dict[str, dict[str, object]],
    news_map: dict[str, dict[str, object]] | None = None,
) -> str:
    news_map = news_map or {}
    row = event["row"]
    symbol = str(event["symbol"])
    snapshot = snapshot_lookup.get(symbol, {})
    name = row.get("name") or snapshot.get("name") or ""
    last_value = row.get("last")
    high_value = row.get("high")
    volume_value = row.get("volume")
    intraday_value = row.get("intraday_pct")
    intraday_text = f"**{float(intraday_value) * 100:.2f}%**" if pd.notna(intraday_value) else "N/A"
    price_tag = _low_price_tag(last_value)
    price_note = f" `{price_tag}`" if price_tag else ""
    reason_text = _reason_labels(snapshot.get("entry_reason"))
    emoji = _EVENT_EMOJI.get(str(event["event_key"]), "⚠️")
    news_text = _news_brief(symbol, news_map).strip()
    confidence = _confidence_score(snapshot) if snapshot else 0
    # Stop / target based on last price
    try:
        last_f = float(last_value)  # type: ignore[arg-type]
        stop = round(last_f * 0.95, 2)
        target = round(last_f * 1.10, 2)
        rr = round((target - last_f) / max(last_f - stop, 0.01), 1)
        risk_line = f"停損 `{stop}` | 目標 `{target}` | R:R `{rr}:1`"
    except (TypeError, ValueError):
        risk_line = ""
    parts = [
        f"{emoji} **即時警報｜{event['label']}**",
        f"**{symbol}** {name}{price_note}  信心 `{confidence}/100`",
        f"最新 `{last_value}` | 高點 `{high_value}` | 量 `{volume_value}` | 漲幅 {intraday_text}",
    ]
    if risk_line:
        parts.append(risk_line)
    parts.append(f"技術: {reason_text}")
    parts.append(f"新聞: {news_text if news_text else '無近期消息'}")
    return "\n".join(parts)


def format_heartbeat_message(quotes: pd.DataFrame, date: str) -> str:
    now = pd.Timestamp.now().strftime("%H:%M")
    lines = [f"💓 **盤中快報** · {now} ({date})", ""]
    if quotes.empty:
        lines.append("無即時報價。")
        return "\n".join(lines)
    for _, row in quotes.iterrows():
        if pd.notna(row.get("error")):
            lines.append(f"• **{row['symbol']}** — 報價錯誤")
            continue
        intraday = row.get("intraday_pct")
        if pd.notna(intraday):
            pct = float(intraday) * 100
            arrow = "📈" if pct > 0.5 else ("📉" if pct < -0.5 else "➡️")
            pct_text = f"`{pct:+.2f}%`"
        else:
            arrow, pct_text = "➡️", "N/A"
        lines.append(
            f"• **{row['symbol']}** {row.get('name') or ''} | {arrow} {pct_text} | 最新 `{row.get('last')}` | 量 `{row.get('volume')}`"
        )
    return "\n".join(lines)


def format_daily_report_message(
    candidates: pd.DataFrame,
    watchlist: pd.DataFrame,
    closing_quotes: pd.DataFrame,
    date: str,
    news_map: dict[str, dict[str, object]] | None = None,
) -> str:
    news_map = news_map or {}
    lines = [f"📋 **盤後總結** · {date}", ""]
    lines.append("**今日候選（篩選時收盤）**")
    if candidates.empty:
        lines.append("今日無全條件候選。")
    else:
        for _, row in candidates.head(8).iterrows():
            price_tag = _low_price_tag(row.get("close"))
            price_note = f" `{price_tag}`" if price_tag else ""
            brief = _news_brief(str(row["stock_id"]), news_map)
            lines.append(
                f"• **{row['stock_id']}** {row['name']} | 收 `{row['close']:.2f}`{price_note} | {_reason_labels(row.get('entry_reason'))}{brief}"
            )
    if not closing_quotes.empty:
        lines.extend(["", "**盤後報價對比**"])
        for _, row in closing_quotes.iterrows():
            if pd.notna(row.get("error")):
                lines.append(f"• **{row['symbol']}** — {row['error']}")
                continue
            intraday = row.get("intraday_pct")
            if pd.notna(intraday):
                pct = float(intraday) * 100
                arrow = "📈" if pct > 1 else ("📉" if pct < -1 else "➡️")
                pct_text = f"**{pct:+.2f}%**"
            else:
                arrow, pct_text = "➡️", "N/A"
            lines.append(
                f"• **{row['symbol']}** {row.get('name') or ''} | {arrow} {pct_text} | 收 `{row.get('last')}` | 量 `{row.get('volume')}`"
            )
    if not watchlist.empty:
        lines.extend(["", "**近似名單（今日未達全條件）**"])
        for _, row in watchlist.head(5).iterrows():
            lines.append(
                f"• **{row['stock_id']}** {row['name']} | `{int(row['condition_count'])}/{_MAX_CONDITION_COUNT}` | 收 `{row['close']:.2f}`"
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
            close_value = row["close"] if "close" in row and pd.notna(row["close"]) else None
            score_value = row["condition_count"] if "condition_count" in row and pd.notna(row["condition_count"]) else None
            close_text = f"{float(close_value):.2f}" if close_value is not None else "N/A"
            score_text = f"{int(score_value)}/23" if score_value is not None else "manual"
            lines.append(f"- {row['stock_id']} {row['name']} | close {close_text} | score {score_text}")

    if not watchlist.empty:
        lines.extend(["", "Step 2: tracked symbols"])
        for _, row in watchlist.head(5).iterrows():
            close_value = row["close"] if "close" in row and pd.notna(row["close"]) else None
            score_value = row["condition_count"] if "condition_count" in row and pd.notna(row["condition_count"]) else None
            close_text = f"{float(close_value):.2f}" if close_value is not None else "N/A"
            score_text = f"{int(score_value)}/23" if score_value is not None else "manual"
            lines.append(f"- {row['stock_id']} {row['name']} | close {close_text} | score {score_text}")

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
    candidates, watchlist, universe, breadth = build_daily_snapshot(args, client, config)
    latest_date = args.end
    report_path = save_scan_report(args.output, candidates, watchlist, universe)
    news_map = {}
    if args.include_news:
        scan_rows = candidates.to_dict("records") if not candidates.empty else watchlist.to_dict("records")
        news_map = build_news_map(args.output, scan_rows, news_limit=args.news_limit)
    message = format_scan_message_rich(candidates, watchlist, latest_date, news_map=news_map, breadth=breadth)
    _safe_print(message)
    _safe_print("")
    _safe_print(f"Scan report: {report_path}")
    if args.notify:
        send_discord_messages(split_message(message))
    if notion_enabled():
        sync_scan_results(candidates, watchlist, latest_date, news_map)


def run_hybrid_monitor(args: argparse.Namespace, client: FinMindClient, config: StrategyConfig) -> None:
    if args.stocks != "auto":
        universe = load_universe(args, client)
        candidates = pd.DataFrame(columns=["stock_id", "name"])
        watchlist = universe.copy()
        watch_pool = universe.copy()
        breadth: dict[str, object] = {}
    else:
        candidates, watchlist, universe, breadth = build_daily_snapshot(args, client, config)
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
    news_map = {}
    if args.include_news:
        news_map = build_news_map(args.output, watch_pool.to_dict("records"), news_limit=args.news_limit)
    message = format_hybrid_message_rich(candidates, watchlist, live_quotes, args.end, news_map=news_map)
    _safe_print(message)
    _safe_print("")
    _safe_print(f"Hybrid report: {report_path}")
    if args.notify:
        send_discord_messages(split_message(message))


def run_sponsor_monitor(args: argparse.Namespace, client: FinMindClient, config: StrategyConfig) -> None:
    if args.stocks != "auto":
        universe = load_universe(args, client)
        candidates = pd.DataFrame(columns=["stock_id", "name"])
        watchlist = universe.copy()
        watch_pool = universe.copy()
    else:
        candidates, watchlist, universe, _breadth = build_daily_snapshot(args, client, config)
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
        _safe_print(message)
        _safe_print("")
        _safe_print(f"Sponsor report: {last_report_path}")
        if args.notify:
            send_discord_messages(split_message(message))
        if cycle < args.repeat_count:
            time.sleep(args.interval_seconds)


def run_event_monitor(args: argparse.Namespace, client: FinMindClient, config: StrategyConfig) -> None:
    if args.stocks != "auto":
        universe = load_universe(args, client)
        candidates = pd.DataFrame(columns=["stock_id", "name"])
        watchlist = universe.copy()
        watch_pool = universe.copy()
    else:
        candidates, watchlist, universe, _breadth = build_daily_snapshot(args, client, config)
        watch_pool = candidates.copy()
        if len(watch_pool) < args.watch_top:
            extra = watchlist.head(args.watch_top - len(watch_pool))
            watch_pool = pd.concat([watch_pool, extra], ignore_index=True)

    watch_pool = watch_pool.head(args.watch_top).copy()
    watch_symbols = watch_pool["stock_id"].astype(str).tolist()

    extra_symbols = [s.strip() for s in getattr(args, "watch_extra", "").split(",") if s.strip()]
    for sym in extra_symbols:
        if sym not in watch_symbols:
            watch_symbols.append(sym)

    snapshot_lookup = {str(row["stock_id"]): row for row in watch_pool.to_dict("records")}
    daily_volume_lookup: dict[str, float] = {
        str(row.get("stock_id") or ""): float(row["volume_ma20"])
        for row in watch_pool.to_dict("records")
        if row.get("volume_ma20") and float(row.get("volume_ma20") or 0) > 0
    }
    news_map = build_news_map(args.output, watch_pool.to_dict("records"), news_limit=args.news_limit) if args.include_news else {}

    fugle = FugleClient()
    if not fugle.enabled:
        raise RuntimeError("FUGLE_API_KEY is not configured.")

    previous_state: dict[str, dict[str, float | str]] = {}
    last_notified: dict[str, float] = {}
    last_heartbeat_ts: float = 0.0
    consecutive_error_cycles = 0
    _MAX_ERROR_CYCLES = 10
    start_msg = f"🟢 **事件監控啟動** · {pd.Timestamp.now().strftime('%H:%M')} (UTC)\n監控標的：{', '.join(watch_symbols)}\n觸發條件：急拉 ≥{args.event_rise_threshold*100:.1f}% ｜急跌 ≤{args.event_drop_threshold*100:.1f}% ｜量能 ≥{args.event_volume_multiplier}x"
    _safe_print(start_msg)
    if args.notify:
        send_discord_messages(split_message(start_msg))

    for cycle in range(1, args.repeat_count + 1):
        quotes = fetch_watch_quotes(fugle, watch_symbols)

        all_errors = (
            not quotes.empty
            and "error" in quotes.columns
            and quotes["error"].notna().all()
        )
        if all_errors:
            consecutive_error_cycles += 1
            if consecutive_error_cycles >= _MAX_ERROR_CYCLES:
                abort_msg = f"⚠️ **事件監控中止** · Fugle API 連續 {_MAX_ERROR_CYCLES} 個週期全部錯誤，已停止"
                _safe_print(abort_msg)
                if args.notify:
                    send_discord_messages(split_message(abort_msg))
                break
        else:
            consecutive_error_cycles = 0

        events, next_state = detect_quote_events(
            quotes,
            previous_state,
            rise_threshold=args.event_rise_threshold,
            drop_threshold=args.event_drop_threshold,
            volume_multiplier=args.event_volume_multiplier,
            daily_volume_lookup=daily_volume_lookup,
        )
        if not previous_state:
            previous_state = next_state
            if cycle < args.repeat_count:
                time.sleep(args.interval_seconds)
            continue
        previous_state = next_state
        now_ts = time.time()

        # Heartbeat
        if args.heartbeat_minutes > 0 and now_ts - last_heartbeat_ts >= args.heartbeat_minutes * 60:
            hb_msg = format_heartbeat_message(quotes, args.end)
            _safe_print("")
            _safe_print(hb_msg)
            if args.notify:
                send_discord_messages(split_message(hb_msg))
            last_heartbeat_ts = now_ts

        for event in events:
            key = f"{event['symbol']}:{event['event_key']}"
            if now_ts - last_notified.get(key, 0) < args.event_cooldown_seconds:
                continue
            message = format_event_message(event, snapshot_lookup, news_map=news_map)
            _safe_print("")
            _safe_print(message)
            if args.notify:
                send_discord_messages(split_message(message))
            last_notified[key] = now_ts
        if cycle < args.repeat_count:
            time.sleep(args.interval_seconds)


def run_daily_report(args: argparse.Namespace, client: FinMindClient, config: StrategyConfig) -> None:
    candidates, watchlist, universe, breadth = build_daily_snapshot(args, client, config)
    watch_pool = candidates.head(args.watch_top).copy()
    if len(watch_pool) < args.watch_top:
        extra = watchlist.head(args.watch_top - len(watch_pool))
        watch_pool = pd.concat([watch_pool, extra], ignore_index=True)
    watch_symbols = watch_pool["stock_id"].astype(str).tolist()

    fugle = FugleClient()
    if fugle.enabled and watch_symbols:
        closing_quotes = fetch_watch_quotes(fugle, watch_symbols)
    else:
        closing_quotes = pd.DataFrame(
            [{"symbol": s, "error": "FUGLE_API_KEY not configured"} for s in watch_symbols]
        )

    news_map = build_news_map(args.output, watch_pool.to_dict("records"), news_limit=args.news_limit) if args.include_news else {}
    message = format_daily_report_message(candidates, watchlist, closing_quotes, args.end, news_map=news_map)
    _safe_print(message)
    if args.notify:
        send_discord_messages(split_message(message))
    if notion_enabled():
        sync_scan_results(candidates, watchlist, args.end, news_map)


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
        config=config,
    )
    _safe_print("Backtest complete.")
    _safe_print(f"Excel report: {reports['excel']}")
    _safe_print(f"Equity chart: {reports['equity_chart']}")
    _safe_print(f"Yearly chart: {reports['yearly_chart']}")
    _safe_print("")
    _safe_print("Key metrics:")
    for key, value in backtest["metrics"].items():
        if isinstance(value, float):
            _safe_print(f"- {key}: {value:,.2f}")
        else:
            _safe_print(f"- {key}: {value}")


def run_walk_forward(args: argparse.Namespace, client: FinMindClient, config: StrategyConfig) -> None:
    """Run walk-forward validation: split the date range into folds and backtest each."""
    folds = getattr(args, "wf_folds", 4)
    overlap = getattr(args, "wf_overlap_days", 0)
    full_start = pd.Timestamp(args.start)
    full_end = pd.Timestamp(args.end)
    total_days = (full_end - full_start).days
    fold_days = total_days // folds

    _safe_print(f"Walk-forward: {folds} folds × ~{fold_days}d, {full_start.date()} → {full_end.date()}")

    market_raw = fetch_market_index(client, args.start, args.end)
    if market_raw.empty:
        raise RuntimeError("Unable to download TAIEX market data.")
    market_full = prepare_market_frame(market_raw, config)

    stock_list = load_universe(args, client)
    signals_by_stock, _ = collect_signals(stock_list, client, market_full, config, args.start, args.end, args.workers)
    if not signals_by_stock:
        raise RuntimeError("No signal data loaded.")

    fold_rows: list[dict[str, object]] = []
    for fold_idx in range(folds):
        fold_start = full_start + pd.Timedelta(days=fold_idx * fold_days - overlap)
        fold_end = full_start + pd.Timedelta(days=(fold_idx + 1) * fold_days)
        if fold_idx == folds - 1:
            fold_end = full_end
        fold_start = max(fold_start, full_start)
        fold_label = f"{fold_start.date()} → {fold_end.date()}"

        market_slice = market_full[
            (pd.to_datetime(market_full["date"]) >= fold_start)
            & (pd.to_datetime(market_full["date"]) <= fold_end)
        ].copy()
        signals_slice = {
            sid: frame[
                (pd.to_datetime(frame["date"]) >= fold_start)
                & (pd.to_datetime(frame["date"]) <= fold_end)
            ].copy()
            for sid, frame in signals_by_stock.items()
        }
        signals_slice = {sid: f for sid, f in signals_slice.items() if not f.empty}
        if not signals_slice or market_slice.empty:
            _safe_print(f"  Fold {fold_idx + 1}: no data — skipping")
            continue

        try:
            result = run_backtest(signals_slice, market_slice, config, args.capital)
            m = result["metrics"]
            fold_rows.append({
                "fold": fold_idx + 1,
                "period": fold_label,
                "total_return_pct": m.get("total_return_pct", 0),
                "annual_return_pct": m.get("annual_return_pct", 0),
                "max_drawdown_pct": m.get("max_drawdown_pct", 0),
                "sharpe_ratio": m.get("sharpe_ratio", 0),
                "win_rate_pct": m.get("win_rate_pct", 0),
                "total_trades": m.get("total_trades", 0),
                "benchmark_return_pct": m.get("benchmark_return_pct", None),
            })
            _safe_print(f"  Fold {fold_idx + 1} [{fold_label}]: "
                        f"return={m.get('total_return_pct', 0):+.1f}% "
                        f"DD={m.get('max_drawdown_pct', 0):.1f}% "
                        f"Sharpe={m.get('sharpe_ratio', 0):.2f} "
                        f"trades={m.get('total_trades', 0)}")
        except Exception as exc:
            _safe_print(f"  Fold {fold_idx + 1} error: {exc}")

    if fold_rows:
        wf_frame = pd.DataFrame(fold_rows)
        _safe_print("\nWalk-forward summary:")
        _safe_print(wf_frame.to_string(index=False))
        output_path = Path(args.output)
        output_path.mkdir(parents=True, exist_ok=True)
        wf_frame.to_csv(output_path / "walk_forward_results.csv", index=False)
        _safe_print(f"\nSaved: {output_path / 'walk_forward_results.csv'}")


def main() -> None:
    args = parse_args()
    cache_dir = Path(args.output) / "cache"
    client = FinMindClient(cache_dir=cache_dir)
    config = StrategyConfig(
        use_earnings_filter=args.use_earnings_filter,
        next_day_fill=args.next_day_fill,
    )

    if getattr(args, "clean_cache", False):
        deleted = clean_cache(cache_dir, max_age_days=getattr(args, "clean_cache_days", 30))
        _safe_print(f"[cache] Deleted {deleted} stale cache files from {cache_dir}")

    if args.mode == "backtest":
        run_backtest_mode(args, client, config)
    elif args.mode == "walk-forward":
        run_walk_forward(args, client, config)
    elif args.mode == "sponsor-monitor":
        run_sponsor_monitor(args, client, config)
    elif args.mode == "event-monitor":
        run_event_monitor(args, client, config)
    elif args.mode == "hybrid-monitor":
        run_hybrid_monitor(args, client, config)
    elif args.mode == "daily-report":
        run_daily_report(args, client, config)
    else:
        run_scan(args, client, config)


if __name__ == "__main__":
    main()
