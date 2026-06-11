"""
Disposition stock and suspended trading filters.

Fetches TaiwanStockDispositionSecuritiesPeriod and suspended stock data
from FinMind to build skip-sets for the scanner — preventing the system
from recommending stocks under regulatory action.

Standalone module — no existing files modified.
"""

from __future__ import annotations

import os
from typing import Optional

import pandas as pd
import requests


_FINMIND_BASE_URL = "https://api.finmindtrade.com/api/v4/data"


def _get_token(token: Optional[str]) -> Optional[str]:
    """Resolve token from argument or environment variable."""
    return token or os.environ.get("FINMIND_TOKEN")


def fetch_disposition_stocks(date: str, token: Optional[str] = None) -> frozenset:
    """
    Fetch stocks currently under disposition (處置) on the given date.

    Calls FinMind API dataset="TaiwanStockDispositionSecuritiesPeriod".

    Parameters
    ----------
    date : str
        Date string in "YYYY-MM-DD" format.
    token : str | None
        FinMind API token. Falls back to FINMIND_TOKEN env var if None.

    Returns
    -------
    frozenset[str]
        Set of stock_id strings under disposition on that date.
        Returns empty frozenset on any error.
    """
    resolved_token = _get_token(token)
    params: dict = {
        "dataset": "TaiwanStockDispositionSecuritiesPeriod",
        "start_date": date,
        "end_date": date,
    }
    if resolved_token:
        params["token"] = resolved_token

    try:
        response = requests.get(_FINMIND_BASE_URL, params=params, timeout=15)
        response.raise_for_status()
        payload = response.json()
        data = payload.get("data", [])
        if not data:
            return frozenset()
        return frozenset(str(row["stock_id"]) for row in data if "stock_id" in row)
    except Exception:
        return frozenset()


def fetch_suspended_stocks(
    date: str,
    token: Optional[str] = None,
    use_heuristic: bool = False,
) -> frozenset:
    """
    Fetch stocks that were suspended from trading on the given date.

    FinMind does not provide a direct "suspended stocks" endpoint.
    When use_heuristic=True, fetches TaiwanStockPrice for the date and
    flags stocks with volume=0 as potentially suspended. This is expensive
    for large universes.

    Parameters
    ----------
    date : str
        Date string in "YYYY-MM-DD" format.
    token : str | None
        FinMind API token. Falls back to FINMIND_TOKEN env var if None.
    use_heuristic : bool
        When True, fetch price data and flag zero-volume stocks.
        When False (default), return empty frozenset without any API call.

    Returns
    -------
    frozenset[str]
        Set of stock_id strings that appear suspended on that date.
        Returns empty frozenset on any error or when use_heuristic=False.

    Notes
    -----
    Zero-volume on a given day may reflect a non-trading day rather than
    an actual suspension. Use this heuristic with caution and only on
    confirmed trading days.
    """
    if not use_heuristic:
        return frozenset()

    resolved_token = _get_token(token)
    params: dict = {
        "dataset": "TaiwanStockPrice",
        "start_date": date,
        "end_date": date,
    }
    if resolved_token:
        params["token"] = resolved_token

    try:
        response = requests.get(_FINMIND_BASE_URL, params=params, timeout=30)
        response.raise_for_status()
        payload = response.json()
        data = payload.get("data", [])
        if not data:
            return frozenset()
        suspended = frozenset(
            str(row["stock_id"])
            for row in data
            if "stock_id" in row and row.get("Trading_Volume", 1) == 0
        )
        return suspended
    except Exception:
        return frozenset()


def build_skip_set(
    date: str,
    token: Optional[str] = None,
    include_suspended: bool = False,
) -> frozenset:
    """
    Build the combined skip-set of stocks to exclude from scanning.

    Parameters
    ----------
    date : str
        Date string in "YYYY-MM-DD" format.
    token : str | None
        FinMind API token. Falls back to FINMIND_TOKEN env var if None.
    include_suspended : bool
        When True, also include heuristic-detected suspended stocks.

    Returns
    -------
    frozenset[str]
        Union of disposition stocks and (optionally) suspended stocks.
    """
    disposition = fetch_disposition_stocks(date, token)
    suspended = fetch_suspended_stocks(date, token, use_heuristic=True) if include_suspended else frozenset()
    return disposition | suspended


def filter_candidates(
    df: pd.DataFrame,
    skip_ids: frozenset,
    stock_id_col: str = "stock_id",
) -> pd.DataFrame:
    """
    Remove rows from df whose stock_id is in skip_ids.

    Parameters
    ----------
    df : pd.DataFrame
        Candidate stocks DataFrame.
    skip_ids : frozenset[str]
        Set of stock_id values to exclude.
    stock_id_col : str
        Column name containing the stock identifier. Default "stock_id".

    Returns
    -------
    pd.DataFrame
        Filtered DataFrame with disposition/suspended stocks removed.
        The original DataFrame is not modified.
    """
    if not skip_ids:
        return df.copy()

    mask = df[stock_id_col].astype(str).isin(skip_ids)
    removed_ids = sorted(df.loc[mask, stock_id_col].astype(str).unique())
    n_removed = len(removed_ids)

    if n_removed > 0:
        ids_str = " ".join(removed_ids)
        print(f"處置/暫停股過濾：移除 {n_removed} 支（{ids_str}）")

    return df[~mask].copy()


def is_under_disposition(
    stock_id: str,
    date: str,
    token: Optional[str] = None,
) -> bool:
    """
    Check whether a single stock is under disposition on the given date.

    Parameters
    ----------
    stock_id : str
        The stock identifier to check.
    date : str
        Date string in "YYYY-MM-DD" format.
    token : str | None
        FinMind API token. Falls back to FINMIND_TOKEN env var if None.

    Returns
    -------
    bool
        True if stock_id appears in the disposition set for that date.
    """
    return stock_id in fetch_disposition_stocks(date, token)


def format_skip_summary(skip_ids: frozenset) -> str:
    """
    Format a Discord-ready summary of excluded stocks.

    Parameters
    ----------
    skip_ids : frozenset[str]
        Set of excluded stock identifiers.

    Returns
    -------
    str
        Empty string if no stocks excluded.
        Lists individual IDs for 1–5 stocks.
        Shows aggregate count for more than 5 stocks.
    """
    if not skip_ids:
        return ""
    n = len(skip_ids)
    if n <= 5:
        return f"⚠️ 排除處置/暫停股：{' '.join(sorted(skip_ids))}"
    return f"⚠️ 排除處置/暫停股：{n} 支"
