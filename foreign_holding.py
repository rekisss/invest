"""
Foreign holding ratio change utilities (TaiwanStockShareholding).

Fetches institutional shareholding data from FinMind and computes 5-day
holding ratio changes — distinguishing structural foreign buying from
short-term tactical flows.

Standalone module — no existing files modified.
"""
from __future__ import annotations

import math
import os
from typing import Optional

import pandas as pd
import requests


FINMIND_API_URL = "https://api.finmindtrade.com/api/v4/data"

_EMPTY_COLS = ["stock_id", "date", "HoldingSharesRatio"]


def fetch_all_shareholding(
    date: str,
    lookback: int = 10,
    token: str | None = None,
) -> pd.DataFrame:
    """Fetch foreign shareholding data from FinMind.

    Parameters
    ----------
    date : str
        Reference date in YYYY-MM-DD format (end_date for the query).
    lookback : int
        Number of calendar days to look back for start_date.
    token : str, optional
        FinMind API token. Falls back to FINMIND_TOKEN env var.

    Returns
    -------
    pd.DataFrame
        Columns: stock_id (str), date (str), HoldingSharesRatio (float).
        Sorted by stock_id, date ascending.
        Empty DataFrame with those columns on any failure.
    """
    api_token = token or os.getenv("FINMIND_TOKEN", "")
    if not api_token:
        return pd.DataFrame(columns=_EMPTY_COLS)

    start_date = (pd.Timestamp(date) - pd.Timedelta(days=lookback)).strftime("%Y-%m-%d")
    end_date = date

    params: dict = {
        "dataset": "TaiwanStockShareholding",
        "start_date": start_date,
        "end_date": end_date,
        "token": api_token,
    }

    try:
        resp = requests.get(FINMIND_API_URL, params=params, timeout=30)
        resp.raise_for_status()
        payload = resp.json()
        data = payload.get("data", [])
        if not data:
            return pd.DataFrame(columns=_EMPTY_COLS)

        df = pd.DataFrame(data)
        required = {"stock_id", "date", "HoldingSharesRatio"}
        if not required.issubset(df.columns):
            return pd.DataFrame(columns=_EMPTY_COLS)

        df = df[list(_EMPTY_COLS)].copy()
        df["stock_id"] = df["stock_id"].astype(str)
        df["date"] = df["date"].astype(str)
        df["HoldingSharesRatio"] = pd.to_numeric(df["HoldingSharesRatio"], errors="coerce")
        df = df.sort_values(["stock_id", "date"]).reset_index(drop=True)
        return df

    except Exception:
        return pd.DataFrame(columns=_EMPTY_COLS)


def compute_holding_change(
    df: pd.DataFrame,
    lookback_days: int = 5,
) -> pd.DataFrame:
    """Compute 5-day foreign holding ratio change per stock.

    Parameters
    ----------
    df : pd.DataFrame
        Output of fetch_all_shareholding.
    lookback_days : int
        Number of trading sessions to look back (iloc-based, not calendar).

    Returns
    -------
    pd.DataFrame
        Columns: stock_id, foreign_holding_latest, foreign_holding_chg_5d.
        foreign_holding_chg_5d = 0.0 if fewer than 2 data points.
    """
    if df.empty:
        return pd.DataFrame(columns=["stock_id", "foreign_holding_latest", "foreign_holding_chg_5d"])

    rows = []
    for stock_id, grp in df.groupby("stock_id", sort=False):
        g = grp.sort_values("date").reset_index(drop=True)
        n = len(g)
        latest_ratio = float(g["HoldingSharesRatio"].iloc[-1])

        if n < 2:
            chg = 0.0
        else:
            # Use iloc to get ~5 sessions ago
            ago_idx = max(0, n - 1 - lookback_days)
            ratio_5d_ago = float(g["HoldingSharesRatio"].iloc[ago_idx])
            chg = latest_ratio - ratio_5d_ago

        rows.append({
            "stock_id": str(stock_id),
            "foreign_holding_latest": latest_ratio,
            "foreign_holding_chg_5d": chg,
        })

    return pd.DataFrame(rows, columns=["stock_id", "foreign_holding_latest", "foreign_holding_chg_5d"])


def holding_change_bonus(foreign_holding_chg_5d: float) -> int:
    """Map 5-day holding change (percentage points) to a score bonus.

    Parameters
    ----------
    foreign_holding_chg_5d : float
        Absolute change in foreign holding ratio (pp), e.g. +1.5 means 1.5pp increase.

    Returns
    -------
    int
        Score bonus: 20 / 10 / 0 / -10 / -20.
        Returns 0 for NaN/None input.
    """
    if foreign_holding_chg_5d is None:
        return 0
    try:
        if math.isnan(foreign_holding_chg_5d):
            return 0
    except (TypeError, ValueError):
        return 0

    if foreign_holding_chg_5d > 1.0:
        return 20
    if foreign_holding_chg_5d > 0.3:
        return 10
    if foreign_holding_chg_5d >= -0.3:
        return 0
    if foreign_holding_chg_5d >= -1.0:
        return -10
    return -20


def get_latest_holding_signals(
    date: str,
    stock_ids: list[str] | None = None,
    token: str | None = None,
) -> pd.DataFrame:
    """Fetch, compute, and optionally filter foreign holding signals.

    Parameters
    ----------
    date : str
        Reference date in YYYY-MM-DD format.
    stock_ids : list[str], optional
        If provided, filter results to these stock IDs.
    token : str, optional
        FinMind API token. Falls back to FINMIND_TOKEN env var.

    Returns
    -------
    pd.DataFrame
        Indexed by stock_id with columns:
        foreign_holding_latest, foreign_holding_chg_5d, holding_bonus (int).
        Empty DataFrame on failure.
    """
    _empty = pd.DataFrame(
        columns=["foreign_holding_latest", "foreign_holding_chg_5d", "holding_bonus"]
    )
    _empty.index.name = "stock_id"

    try:
        raw = fetch_all_shareholding(date, token=token)
        if raw.empty:
            return _empty

        chg_df = compute_holding_change(raw)
        if chg_df.empty:
            return _empty

        if stock_ids is not None:
            chg_df = chg_df[chg_df["stock_id"].isin(stock_ids)].copy()

        chg_df["holding_bonus"] = chg_df["foreign_holding_chg_5d"].apply(holding_change_bonus).astype(int)
        chg_df = chg_df.set_index("stock_id")
        return chg_df[["foreign_holding_latest", "foreign_holding_chg_5d", "holding_bonus"]]

    except Exception:
        return _empty


def format_holding_summary(
    df: pd.DataFrame,
    top_n: int = 5,
    bottom_n: int = 3,
) -> str:
    """Format foreign holding changes as a Discord-ready string.

    Parameters
    ----------
    df : pd.DataFrame
        Output of get_latest_holding_signals (indexed by stock_id).
    top_n : int
        Number of top stocks (biggest buyers) to show.
    bottom_n : int
        Number of bottom stocks (biggest sellers) to show.

    Returns
    -------
    str
        Discord-formatted summary string, or "" if df is empty or has no chg data.

    Example
    -------
    🏦 外資持股變化（5日）
    ▲ 增持：2330 +2.1pp | 2454 +1.8pp | 3034 +1.2pp
    ▼ 減持：2317 -1.5pp | 2382 -0.8pp | 2412 -0.6pp
    """
    if df is None or df.empty:
        return ""

    if "foreign_holding_chg_5d" not in df.columns:
        return ""

    valid = df.dropna(subset=["foreign_holding_chg_5d"])
    if valid.empty:
        return ""

    sorted_df = valid.sort_values("foreign_holding_chg_5d", ascending=False)

    top = sorted_df.head(top_n)
    bottom = sorted_df.tail(bottom_n).sort_values("foreign_holding_chg_5d")

    def _fmt_row(stock_id: str, chg: float) -> str:
        sign = "+" if chg >= 0 else ""
        return f"{stock_id} {sign}{chg:.1f}pp"

    top_parts = " | ".join(
        _fmt_row(str(sid), float(row["foreign_holding_chg_5d"]))
        for sid, row in top.iterrows()
    )
    bottom_parts = " | ".join(
        _fmt_row(str(sid), float(row["foreign_holding_chg_5d"]))
        for sid, row in bottom.iterrows()
    )

    lines = [
        "🏦 外資持股變化（5日）",
        f"▲ 增持：{top_parts}",
        f"▼ 減持：{bottom_parts}",
    ]
    return "\n".join(lines)
