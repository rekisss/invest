from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
from types import SimpleNamespace

from flask import Flask, render_template, request, send_from_directory, url_for
import pandas as pd

from backtest import run_backtest
from data_loader import FinMindClient
from fugle_client import FugleClient, fetch_watch_quotes
from news_service import NewsClient, summarize_news
from main import (
    build_daily_snapshot,
    collect_signals,
    format_hybrid_message_rich,
    format_scan_message_rich,
    load_universe,
)
from notifier import send_discord_messages, split_message
from report import save_hybrid_report, save_reports, save_scan_report
from strategy import StrategyConfig, prepare_market_frame
from data_loader import fetch_market_index


BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR / "output" / "web"
RUN_LOCK = Lock()

app = Flask(__name__)


def _bool_from_form(key: str) -> bool:
    return request.form.get(key) in {"1", "true", "on", "yes"}


def _int_from_form(key: str, default: int) -> int:
    raw = (request.form.get(key) or "").strip()
    if not raw:
        return default
    return int(raw)


def _float_from_form(key: str, default: float | None = None) -> float | None:
    raw = (request.form.get(key) or "").strip()
    if not raw:
        return default
    return float(raw)


def _build_args(mode: str) -> SimpleNamespace:
    return SimpleNamespace(
        mode=mode,
        stocks=request.form.get("stocks", "auto").strip() or "auto",
        start=request.form.get("start", "2020-01-01").strip() or "2020-01-01",
        end=request.form.get("end", pd.Timestamp.today().strftime("%Y-%m-%d")).strip() or pd.Timestamp.today().strftime("%Y-%m-%d"),
        capital=_float_from_form("capital", 1_000_000) or 1_000_000,
        output=str(OUTPUT_DIR),
        lookback_days=_int_from_form("lookback_days", 420),
        max_universe=_int_from_form("max_universe", 40),
        top_n=_int_from_form("top_n", 15),
        watch_top=_int_from_form("watch_top", 5),
        interval_seconds=_int_from_form("interval_seconds", 120),
        repeat_count=_int_from_form("repeat_count", 1),
        workers=_int_from_form("workers", 2),
        max_price=_float_from_form("max_price"),
        prefer_lower_price=_bool_from_form("prefer_lower_price"),
        include_news=_bool_from_form("include_news"),
        notify=_bool_from_form("notify"),
        use_earnings_filter=_bool_from_form("use_earnings_filter"),
        next_day_fill=_bool_from_form("next_day_fill"),
    )


def _frame_records(frame: pd.DataFrame, limit: int = 20) -> list[dict[str, object]]:
    if frame.empty:
        return []
    cleaned = frame.head(limit).copy()
    for column in cleaned.columns:
        if pd.api.types.is_datetime64_any_dtype(cleaned[column]):
            cleaned[column] = cleaned[column].dt.strftime("%Y-%m-%d %H:%M:%S")
        else:
            cleaned[column] = cleaned[column].where(cleaned[column].notna(), None)
    return cleaned.to_dict(orient="records")


def _artifact_url(path: Path | None) -> str | None:
    if path is None or not path.exists():
        return None
    return url_for("artifacts", filename=path.name)


def _default_context() -> dict[str, object]:
    today = pd.Timestamp.today().strftime("%Y-%m-%d")
    return {
        "today": today,
        "errors": [],
        "scan": None,
        "hybrid": None,
        "backtest": None,
    }


def _build_news_map(news_client: NewsClient, rows: list[dict[str, object]], limit: int = 3) -> dict[str, dict[str, object]]:
    targets = [(str(row.get("stock_id") or ""), str(row.get("name") or row.get("stock_id") or "")) for row in rows[:5]]
    targets = [(sid, name) for sid, name in targets if sid]

    def _fetch_one(stock_id: str, name: str) -> tuple[str, dict[str, object]]:
        try:
            items = news_client.fetch_stock_news(stock_id, name, limit=limit)
            item_records = _frame_records(items, limit=limit)
            return stock_id, {"news_items": item_records, "summary": summarize_news(item_records)}
        except Exception:
            return stock_id, {"news_items": [], "summary": {}}

    news_map: dict[str, dict[str, object]] = {}
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(_fetch_one, sid, name): sid for sid, name in targets}
        for future in as_completed(futures):
            sid, data = future.result()
            news_map[sid] = data
    return news_map


@app.get("/")
def index() -> str:
    return render_template("dashboard.html", **_default_context())


@app.post("/run")
def run_dashboard() -> str:
    context = _default_context()
    mode = (request.form.get("mode") or "scan").strip()
    args = _build_args(mode)

    client = FinMindClient(cache_dir=OUTPUT_DIR / "cache")
    news_client = NewsClient(cache_dir=OUTPUT_DIR / "news_cache")
    config = StrategyConfig(
        use_earnings_filter=args.use_earnings_filter,
        next_day_fill=args.next_day_fill,
    )

    try:
        with RUN_LOCK:
            if mode == "scan":
                candidates, watchlist, universe, breadth = build_daily_snapshot(args, client, config)
                report_path = save_scan_report(args.output, candidates, watchlist, universe)
                if args.notify:
                    news_map_notify = _build_news_map(news_client, _frame_records(candidates)) if args.include_news else {}
                    send_discord_messages(split_message(format_scan_message_rich(candidates, watchlist, args.end, news_map_notify, breadth=breadth)))
                context["scan"] = {
                    "report_path": str(report_path),
                    "report_url": _artifact_url(report_path),
                    "candidates": _frame_records(candidates),
                    "watchlist": _frame_records(watchlist),
                    "universe_size": len(universe),
                    "breadth": breadth,
                    "news_map": _build_news_map(news_client, _frame_records(candidates) or _frame_records(watchlist)) if args.include_news else {},
                }
            elif mode == "hybrid-monitor":
                if args.stocks != "auto":
                    universe = load_universe(args, client)
                    candidates = pd.DataFrame(columns=["stock_id", "name"])
                    watchlist = universe.copy()
                    watch_pool = universe.copy()
                    breadth = {}
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
                if args.notify:
                    news_map_notify = _build_news_map(news_client, _frame_records(watch_pool)) if args.include_news else {}
                    send_discord_messages(split_message(format_hybrid_message_rich(candidates, watchlist, live_quotes, args.end, news_map_notify)))
                context["hybrid"] = {
                    "report_path": str(report_path),
                    "report_url": _artifact_url(report_path),
                    "candidates": _frame_records(candidates),
                    "watchlist": _frame_records(watchlist),
                    "live_quotes": _frame_records(live_quotes),
                    "watch_symbols": watch_symbols,
                    "news_map": _build_news_map(news_client, _frame_records(watch_pool)) if args.include_news else {},
                }
            elif mode == "backtest":
                stock_list = load_universe(args, client)
                market_raw = fetch_market_index(client, args.start, args.end)
                if market_raw.empty:
                    raise RuntimeError("Unable to download TAIEX market data from FinMind.")
                market = prepare_market_frame(market_raw, config)
                signals_by_stock, signal_frames = collect_signals(
                    stock_list,
                    client,
                    market,
                    config,
                    args.start,
                    args.end,
                    args.workers,
                )
                if not signals_by_stock:
                    raise RuntimeError("No stock data was loaded. Check your universe, token, or paid-data access.")

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
                    notes=backtest["notes"],
                    config=config,
                )
                context["backtest"] = {
                    "metrics": backtest["metrics"],
                    "yearly": _frame_records(backtest["yearly"]),
                    "trades": _frame_records(backtest["trade_summary"]),
                    "excel_url": _artifact_url(reports["excel"]),
                    "equity_chart_url": _artifact_url(reports["equity_chart"]),
                    "yearly_chart_url": _artifact_url(reports["yearly_chart"]),
                    "monthly_chart_url": _artifact_url(reports.get("monthly_chart")),
                    "trade_dist_chart_url": _artifact_url(reports.get("trade_dist_chart")),
                }
            else:
                raise RuntimeError(f"Unsupported mode: {mode}")
    except Exception as error:
        context["errors"] = [str(error)]

    return render_template("dashboard.html", **context)


@app.get("/artifacts/<path:filename>")
def artifacts(filename: str):
    return send_from_directory(OUTPUT_DIR, filename)


if __name__ == "__main__":
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    app.run(host="127.0.0.1", port=5000, debug=True)
