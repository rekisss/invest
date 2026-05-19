from __future__ import annotations

import argparse
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
from pathlib import Path
import random
import sys
import time
from typing import Any

# 自動載入專案目錄的 .env 檔案（若存在）
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for _line in _env_path.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip())

from datetime import datetime, timezone, timedelta

import pandas as pd

from backtest import run_backtest
from data_loader import (
    FinMindClient,
    clean_cache,
    fetch_financial_statement_dates,
    fetch_fundamentals,
    fetch_institutional_data,
    fetch_market_index,
    fetch_stock_info,
    fetch_stock_kbar,
    fetch_stock_prices,
    load_stock_list,
    validate_finmind_token,
)
from fundamentals import compute_f_score
from fugle_client import FugleClient, fetch_watch_quotes
from news_service import NewsClient, summarize_news
from notifier import send_discord_messages, split_message
from report import save_hybrid_report, save_reports, save_scan_report, save_sponsor_monitor_report
from strategy import (
    StrategyConfig,
    compute_market_breadth,
    compute_market_regime,
    latest_signal_snapshot,
    prepare_market_frame,
    prepare_stock_signals,
    rank_candidates,
)
from universe import build_auto_universe
from notion_sync import confidence_score as _confidence_score, notion_enabled, recommend_observation_period, sync_scan_results
from market_predictor import MarketPredictor, fetch_us_features, format_prediction_block

_CST = timezone(timedelta(hours=8))


def _cst_now(fmt: str = "%H:%M") -> str:
    return datetime.now(_CST).strftime(fmt)


def _cst_today() -> str:
    """Return today's date in CST (UTC+8) as YYYY-MM-DD."""
    return _cst_now("%Y-%m-%d")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Taiwan MACD swing strategy backtester and scanner.")
    parser.add_argument("--mode", choices=["backtest", "scan", "hybrid-monitor", "sponsor-monitor", "event-monitor", "daily-report", "walk-forward", "predict", "aggregate"], default="scan")
    parser.add_argument("--stocks", default="auto", help="CSV file containing stock_id and optional name, or 'auto'.")
    parser.add_argument("--start", default="2020-01-01")
    parser.add_argument("--end", default=_cst_today())
    parser.add_argument("--capital", type=float, default=1_000_000)
    parser.add_argument("--output", default="output")
    parser.add_argument("--lookback-days", type=int, default=420)
    parser.add_argument("--max-universe", type=int, default=120)
    parser.add_argument("--top-n", type=int, default=20)