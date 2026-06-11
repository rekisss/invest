"""
Monthly revenue signal utilities (TaiwanStockMonthRevenue).

Standalone module — no existing files modified.
Uses FinMind API directly (same endpoint as data_loader.py but independent).
"""
from __future__ import annotations

import math
import os
from datetime import date, timedelta
from typing import Optional

import pandas as pd
import requests


FINMIND_API_URL = "https://api.finmindtrade.com/api/v4/data"


def fetch_monthly_revenue(
    start_date: str,
    end_date: str,
    token: Optional[str] = None,
) -> pd.DataFrame:
    """Fetch Taiwan monthly revenue data from FinMind API.

    Parameters
    ----------
    start_date : str
        Start date in YYYY-MM-DD format.
    end_date : str
        End date in YYYY-MM-DD format.
    token : str, optional
        FinMind API token. Falls back to FINMIND_TOKEN env var.

    Returns
    -------
    pd.DataFrame
        Columns: stock_id (str), date (str), revenue (float).
        Empty DataFrame on failure.
    """
    api_token = token or os.getenv("FINMIND_TOKEN", "")
    if not api_token:
        return pd.DataFrame(columns=["stock_id", "date", "revenue"])

    params: dict = {
        "dataset": "TaiwanStockMonthRevenue",
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
            return pd.DataFrame(columns=["stock_id", "date", "revenue"])

        df = pd.DataFrame(data)
        # Ensure required columns exist
        required = {"stock_id", "date", "revenue"}
        missing = required - set(df.columns)
        if missing:
            return pd.DataFrame(columns=["stock_id", "date", "revenue"])

        df = df[["stock_id", "date", "revenue"]].copy()
        df["stock_id"] = df["stock_id"].astype(str)
        df["date"] = df["date"].astype(str)
        df["revenue"] = df["revenue"].astype(float)
        df = df.sort_values(["stock_id", "date"]).reset_index(drop=True)
        return df

    except Exception:
        return pd.DataFrame(columns=["stock_id", "date", "revenue"])


def compute_revenue_signals(df: pd.DataFrame) -> pd.DataFrame:
    """Compute YoY, MoM, and 3-month YoY revenue growth signals.

    Parameters
    ----------
    df : pd.DataFrame
        DataFrame with columns: stock_id, date, revenue (as float).

    Returns
    -------
    pd.DataFrame
        Original columns plus: revenue_yoy, revenue_mom, revenue_3m_yoy.
        All growth rates as decimals (e.g., 0.15 for 15%).
    """
    if df.empty:
        empty = df.copy()
        for col in ("revenue_yoy", "revenue_mom", "revenue_3m_yoy"):
            empty[col] = pd.Series(dtype=float)
        return empty

    result_frames = []

    for stock_id, group in df.groupby("stock_id", sort=False):
        g = group.copy().sort_values("date").reset_index(drop=True)
        n = len(g)

        revenue_yoy = [float("nan")] * n
        revenue_mom = [float("nan")] * n
        revenue_3m_yoy = [float("nan")] * n

        # Build a date→index lookup for year-ago lookups
        date_to_idx: dict[str, int] = {row["date"]: i for i, row in g.iterrows()}

        for i in range(n):
            current_rev = g.at[i, "revenue"]
            current_date = g.at[i, "date"]

            # --- MoM ---
            if i > 0:
                prev_rev = g.at[i - 1, "revenue"]
                if prev_rev != 0.0:
                    revenue_mom[i] = (current_rev - prev_rev) / prev_rev

            # --- YoY: same month last year ---
            # Build year-ago date string (same month, year-1)
            try:
                d = date.fromisoformat(current_date[:10])
                yago_date = date(d.year - 1, d.month, d.day).isoformat()
            except ValueError:
                yago_date = None

            if yago_date and yago_date in date_to_idx:
                yago_idx = date_to_idx[yago_date]
                yago_rev = g.at[yago_idx, "revenue"]
                if yago_rev != 0.0:
                    revenue_yoy[i] = (current_rev - yago_rev) / yago_rev

            # --- 3M YoY: sum of last 3 months vs same 3 months last year ---
            if i >= 2:
                # Current 3-month window: indices i-2, i-1, i
                curr_3m = g.at[i - 2, "revenue"] + g.at[i - 1, "revenue"] + current_rev

                # Corresponding year-ago 3-month window
                try:
                    d0 = date.fromisoformat(g.at[i - 2, "date"][:10])
                    d1 = date.fromisoformat(g.at[i - 1, "date"][:10])
                    d2 = date.fromisoformat(current_date[:10])
                    yago_d0 = date(d0.year - 1, d0.month, d0.day).isoformat()
                    yago_d1 = date(d1.year - 1, d1.month, d1.day).isoformat()
                    yago_d2 = date(d2.year - 1, d2.month, d2.day).isoformat()
                except ValueError:
                    yago_d0 = yago_d1 = yago_d2 = None

                if (
                    yago_d0 and yago_d1 and yago_d2
                    and yago_d0 in date_to_idx
                    and yago_d1 in date_to_idx
                    and yago_d2 in date_to_idx
                ):
                    prev_3m = (
                        g.at[date_to_idx[yago_d0], "revenue"]
                        + g.at[date_to_idx[yago_d1], "revenue"]
                        + g.at[date_to_idx[yago_d2], "revenue"]
                    )
                    if prev_3m != 0.0:
                        revenue_3m_yoy[i] = (curr_3m - prev_3m) / prev_3m

        g["revenue_yoy"] = revenue_yoy
        g["revenue_mom"] = revenue_mom
        g["revenue_3m_yoy"] = revenue_3m_yoy
        result_frames.append(g)

    if not result_frames:
        out = df.copy()
        for col in ("revenue_yoy", "revenue_mom", "revenue_3m_yoy"):
            out[col] = float("nan")
        return out

    return pd.concat(result_frames, ignore_index=True)


def revenue_score_bonus(revenue_yoy: Optional[float]) -> int:
    """Convert a YoY revenue growth rate into an integer score bonus.

    Parameters
    ----------
    revenue_yoy : float or None
        Year-over-year revenue growth as a decimal (e.g., 0.15 for 15%).

    Returns
    -------
    int
        Score bonus: 50 / 40 / 20 / 0 / -30 depending on growth tier.
        Returns 0 for NaN or None input.
    """
    if revenue_yoy is None:
        return 0
    try:
        if math.isnan(revenue_yoy):
            return 0
    except TypeError:
        return 0

    if revenue_yoy > 0.20:
        return 50
    if revenue_yoy > 0.10:
        return 40
    if revenue_yoy > 0.00:
        return 20
    if revenue_yoy > -0.10:
        return 0
    return -30


def get_latest_revenue_signals(
    stock_ids: Optional[list[str]] = None,
    as_of_date: Optional[str] = None,
    token: Optional[str] = None,
) -> pd.DataFrame:
    """Fetch and compute the latest revenue signals per stock.

    Fetches the last 14 months of data, computes signals, and returns
    the most recent row per stock_id.

    Parameters
    ----------
    stock_ids : list[str], optional
        If provided, filter results to these stock IDs.
    as_of_date : str, optional
        Reference date in YYYY-MM-DD format. Defaults to today.
    token : str, optional
        FinMind API token. Falls back to FINMIND_TOKEN env var.

    Returns
    -------
    pd.DataFrame
        Indexed by stock_id with columns:
        revenue, revenue_yoy, revenue_mom, revenue_3m_yoy, revenue_bonus (int).
    """
    if as_of_date is None:
        end_dt = date.today()
    else:
        end_dt = date.fromisoformat(as_of_date)

    # Go back 14 months to ensure enough data for 3M YoY (needs 15 months total,
    # but 14 is sufficient for the rolling window with typical availability).
    start_dt = end_dt - timedelta(days=14 * 31)
    start_date = start_dt.isoformat()
    end_date = end_dt.isoformat()

    df = fetch_monthly_revenue(start_date, end_date, token=token)

    if df.empty:
        empty = pd.DataFrame(
            columns=["revenue", "revenue_yoy", "revenue_mom", "revenue_3m_yoy", "revenue_bonus"]
        )
        empty.index.name = "stock_id"
        return empty

    if stock_ids is not None:
        df = df[df["stock_id"].isin(stock_ids)].copy()

    if df.empty:
        empty = pd.DataFrame(
            columns=["revenue", "revenue_yoy", "revenue_mom", "revenue_3m_yoy", "revenue_bonus"]
        )
        empty.index.name = "stock_id"
        return empty

    signals = compute_revenue_signals(df)

    # Latest row per stock_id
    latest = (
        signals.sort_values("date")
        .groupby("stock_id", sort=False)
        .last()
        .reset_index()
    )

    latest["revenue_bonus"] = latest["revenue_yoy"].apply(revenue_score_bonus).astype(int)
    latest = latest.set_index("stock_id")

    return latest[["revenue", "revenue_yoy", "revenue_mom", "revenue_3m_yoy", "revenue_bonus"]]


def format_revenue_summary(df: pd.DataFrame, top_n: int = 5) -> str:
    """Format the top revenue movers as a Discord-ready string.

    Parameters
    ----------
    df : pd.DataFrame
        Output of get_latest_revenue_signals (indexed by stock_id).
    top_n : int
        Number of top stocks to display.

    Returns
    -------
    str
        Discord-formatted summary, or empty string if df is empty or
        has no valid revenue_yoy data.
    """
    if df.empty:
        return ""

    if "revenue_yoy" not in df.columns or df["revenue_yoy"].isna().all():
        return ""

    ranked = df.dropna(subset=["revenue_yoy"]).sort_values("revenue_yoy", ascending=False)
    top = ranked.head(top_n)

    if top.empty:
        return ""

    lines = [f"📊 月營收動能 TOP {top_n}"]
    for rank, (stock_id, row) in enumerate(top.iterrows(), start=1):
        yoy = row["revenue_yoy"]
        mom = row.get("revenue_mom", float("nan"))
        bonus = int(row.get("revenue_bonus", revenue_score_bonus(yoy)))

        yoy_pct = f"{yoy * 100:+.1f}%"
        if mom is not None and not (isinstance(mom, float) and math.isnan(mom)):
            mom_pct = f"{mom * 100:+.1f}%"
        else:
            mom_pct = "N/A"

        bonus_str = f"+{bonus}" if bonus >= 0 else str(bonus)
        lines.append(
            f"{rank}. {stock_id} YoY {yoy_pct} MoM {mom_pct} 加分 {bonus_str}"
        )

    return "\n".join(lines)
