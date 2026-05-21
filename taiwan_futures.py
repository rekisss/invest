"""taiwan_futures.py – Taiwan Futures (台指期/TX) feature module.

Fetches daily OHLCV and institutional position data from FinMind,
computes ML features, and formats a Discord summary block.
All functions degrade gracefully on API failure.
"""
from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

import numpy as np
import pandas as pd

if TYPE_CHECKING:
    from data_loader import FinMindClient


def _sf(v: Any, default: float = float("nan")) -> float:
    if v is None:
        return default
    try:
        f = float(v)
        return default if (math.isnan(f) or math.isinf(f)) else f
    except (ValueError, TypeError):
        return default


# ── FinMind fetchers ──────────────────────────────────────────────────────────

def fetch_futures_daily(
    client: "FinMindClient",
    start_date: str,
    end_date: str,
    code: str = "TX",
) -> pd.DataFrame:
    """Fetch Taiwan Futures daily OHLCV (台指期). Returns empty DataFrame on failure."""
    try:
        frame = client.fetch_dataset(
            "TaiwanFuturesDaily",
            data_id=code,
            start_date=start_date,
            end_date=end_date,
        )
    except Exception as exc:
        print(f"[futures] TaiwanFuturesDaily 取得失敗（graceful skip）: {exc}")
        return pd.DataFrame()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.copy()
    frame.columns = [c.lower().strip() for c in frame.columns]
    rename = {"max": "high", "min": "low", "trading_volume": "volume"}
    frame = frame.rename(columns={k: v for k, v in rename.items() if k in frame.columns})

    for col in ("open", "high", "low", "close", "volume"):
        if col in frame.columns:
            frame[col] = pd.to_numeric(frame[col], errors="coerce")

    # open_interest may appear under different names
    for oi_col in ("open_interest", "open_interest_balance"):
        if oi_col in frame.columns:
            frame["open_interest"] = pd.to_numeric(frame[oi_col], errors="coerce")
            break

    frame["date"] = pd.to_datetime(frame["date"])

    # Multiple contract months per date → keep front month (highest volume)
    if "contract_date" in frame.columns and "volume" in frame.columns:
        frame = (
            frame.sort_values(["date", "volume"], ascending=[True, False])
            .drop_duplicates(subset=["date"])
        )
    else:
        frame = frame.drop_duplicates(subset=["date"])

    return frame.sort_values("date").reset_index(drop=True)


def fetch_futures_institutional(
    client: "FinMindClient",
    start_date: str,
    end_date: str,
    code: str = "TX",
) -> pd.DataFrame:
    """Fetch Taiwan Futures foreign investor net position (外資淨多單). Returns empty on failure."""
    try:
        frame = client.fetch_dataset(
            "TaiwanFuturesInstitutionalInvestors",
            data_id=code,
            start_date=start_date,
            end_date=end_date,
        )
    except Exception as exc:
        print(f"[futures] TaiwanFuturesInstitutionalInvestors 取得失敗（graceful skip）: {exc}")
        return pd.DataFrame()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.copy()
    frame.columns = [c.lower().strip() for c in frame.columns]
    frame["date"] = pd.to_datetime(frame["date"])

    # Find the institution-type column
    id_col = next(
        (c for c in frame.columns if c in ("institutional_investors", "identity_type", "name")),
        None,
    )
    if id_col is None:
        return pd.DataFrame()

    foreign = frame[frame[id_col].astype(str).str.contains("外資|Foreign", na=False)].copy()
    if foreign.empty:
        return pd.DataFrame()

    # long OI − short OI = net long contracts
    long_col  = next((c for c in foreign.columns if "long" in c and ("interest" in c or "balance" in c)), None)
    short_col = next((c for c in foreign.columns if "short" in c and ("interest" in c or "balance" in c)), None)

    if long_col and short_col:
        foreign["foreign_futures_net"] = (
            pd.to_numeric(foreign[long_col],  errors="coerce").fillna(0)
            - pd.to_numeric(foreign[short_col], errors="coerce").fillna(0)
        )
    else:
        net_col = next((c for c in foreign.columns if "net" in c), None)
        if net_col is None:
            return pd.DataFrame()
        foreign["foreign_futures_net"] = pd.to_numeric(foreign[net_col], errors="coerce")

    return (
        foreign[["date", "foreign_futures_net"]]
        .drop_duplicates(subset=["date"])
        .sort_values("date")
        .reset_index(drop=True)
    )


# ── Feature engineering ───────────────────────────────────────────────────────

def build_futures_features(
    market_df: pd.DataFrame,
    futures_df: pd.DataFrame,
    inst_df: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """
    Compute futures-based ML features aligned to spot (TAIEX) dates.
    Returns DataFrame: date + feature columns.
    """
    if futures_df.empty:
        return pd.DataFrame()

    f = futures_df.copy().sort_values("date")
    close = f["close"]

    f["futures_ret_1d"] = close.pct_change(1)
    f["futures_ret_5d"] = close.pct_change(5)

    if "open_interest" in f.columns:
        f["futures_oi_chg"] = f["open_interest"].pct_change(1)
    else:
        f["futures_oi_chg"] = np.nan

    if "volume" in f.columns:
        vol5 = f["volume"].rolling(5, min_periods=1).mean()
        f["futures_vol_ratio"] = f["volume"] / vol5.replace(0, np.nan)
    else:
        f["futures_vol_ratio"] = np.nan

    # Basis = (futures close − spot close) / spot close
    if not market_df.empty:
        spot = market_df[["date", "close"]].copy()
        spot["date"] = pd.to_datetime(spot["date"])
        f = f.merge(spot.rename(columns={"close": "_spot"}), on="date", how="left")
        f["futures_basis"] = (f["close"] - f["_spot"]) / f["_spot"].replace(0, np.nan)
        f = f.drop(columns=["_spot"])
    else:
        f["futures_basis"] = np.nan

    if inst_df is not None and not inst_df.empty:
        inst = inst_df.copy()
        inst["date"] = pd.to_datetime(inst["date"])
        f = f.merge(inst[["date", "foreign_futures_net"]], on="date", how="left")
        f["foreign_futures_net"] = f["foreign_futures_net"].ffill()

    feat_cols = ["date"] + [c for c in (
        "futures_ret_1d", "futures_ret_5d", "futures_basis",
        "futures_oi_chg", "futures_vol_ratio", "foreign_futures_net",
    ) if c in f.columns]

    return f[feat_cols].reset_index(drop=True)


# ── Discord formatter ─────────────────────────────────────────────────────────

def format_futures_block(futures_df: pd.DataFrame) -> str:
    """Format latest futures snapshot as a Discord block. Returns '' if no data."""
    if futures_df.empty:
        return ""

    row = futures_df.iloc[-1]
    parts: list[str] = []

    basis = _sf(row.get("futures_basis"))
    if not math.isnan(basis):
        sign = "+" if basis >= 0 else ""
        parts.append(f"期現差 `{sign}{basis*100:.2f}%`")

    oi_chg = _sf(row.get("futures_oi_chg"))
    if not math.isnan(oi_chg):
        arrow = "↑" if oi_chg >= 0 else "↓"
        parts.append(f"未平倉 {arrow} `{oi_chg*100:+.1f}%`")

    net = _sf(row.get("foreign_futures_net"))
    if not math.isnan(net):
        sign = "+" if net >= 0 else ""
        parts.append(f"外資淨 `{sign}{int(net)}口`")

    if not parts:
        return ""

    return "📊 **台指期（近月）**\n   " + " | ".join(parts)
