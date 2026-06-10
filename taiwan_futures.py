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


# ── Night session ────────────────────────────────────────────────────────────

def fetch_night_session(
    client: "FinMindClient",
    date_str: str,
    code: str = "TX",
) -> dict:
    """Fetch TX night session summary for the given trade date.

    Returns dict(close, change, high, low, last_hour_trend) or empty dict on failure.
    The night session relevant to trade date D starts 15:00 on the previous
    trading day, and FinMind records it under that previous day's date with
    trading_session="after_market" — so we must look back several days, not
    just at date_str (which has no data yet when running pre-market).
    """
    try:
        start = (pd.Timestamp(date_str) - pd.Timedelta(days=5)).strftime("%Y-%m-%d")
        frame = client.fetch_dataset(
            "TaiwanFuturesDaily",
            data_id=code,
            start_date=start,
            end_date=date_str,
        )
    except Exception as exc:
        print(f"[futures] 夜盤資料取得失敗（graceful skip）: {exc}")
        return {}

    if frame.empty:
        return {}

    frame = frame.copy()
    frame.columns = [c.lower().strip() for c in frame.columns]
    frame["date"] = pd.to_datetime(frame["date"])

    # FinMind splits sessions via trading_session: "position" (day) /
    # "after_market" (night). Keep night/夜 patterns for other variants.
    session_col = next(
        (c for c in frame.columns if "session" in c or "夜盤" in c),
        None,
    )
    if session_col is None:
        return {}
    night_mask = frame[session_col].astype(str).str.contains(
        "after_market|night|夜", case=False, na=False
    )
    night_rows = frame[night_mask]
    if night_rows.empty:
        return {}
    latest_date = night_rows["date"].max()
    night_rows = night_rows[night_rows["date"] == latest_date]
    if "volume" in night_rows.columns and len(night_rows) > 1:
        # Multiple contracts per date — highest volume = near-month contract
        vol = pd.to_numeric(night_rows["volume"], errors="coerce").fillna(0)
        row = night_rows.loc[vol.idxmax()]
    else:
        row = night_rows.iloc[-1]

    def _n(col: str) -> float:
        v = row.get(col)
        if v is None:
            return float("nan")
        try:
            f = float(v)
            return f if not (math.isnan(f) or math.isinf(f)) else float("nan")
        except (ValueError, TypeError):
            return float("nan")

    rename = {"max": "high", "min": "low"}
    for old, new in rename.items():
        if old in row.index and new not in row.index:
            row = row.rename({old: new})

    close = _n("close")
    high  = _n("high")
    low   = _n("low")
    if math.isnan(close):
        return {}

    # Change vs same-date day-session close (the natural baseline for the
    # night move); fall back to night open if no day row is available
    change = float("nan")
    try:
        day_rows = frame[~night_mask & (frame["date"] == latest_date)]
        if "contract_date" in frame.columns and "contract_date" in row.index:
            day_rows = day_rows[day_rows["contract_date"] == row["contract_date"]]
        if not day_rows.empty:
            day_close = pd.to_numeric(day_rows["close"], errors="coerce").dropna()
            if not day_close.empty:
                change = close - float(day_close.iloc[-1])
    except Exception:
        pass
    open_ = _n("open")
    if math.isnan(change) and not math.isnan(open_):
        change = close - open_

    # last_hour_trend: compare close to high — if close is near high it's up
    last_hour_trend = "—"
    if not math.isnan(high) and not math.isnan(low) and high != low:
        pct_from_high = (high - close) / (high - low)
        last_hour_trend = "↓ 走弱" if pct_from_high > 0.4 else "↑ 偏強"

    return {
        "close": close,
        "change": change,
        "high": high,
        "low": low,
        "last_hour_trend": last_hour_trend,
    }


def format_night_session_block(night: dict) -> str:
    """Format night session dict as a Discord line. Returns '' if night is empty."""
    if not night or math.isnan(_sf(night.get("close"))):
        return ""
    close = int(_sf(night["close"]))
    change = _sf(night.get("change"))
    trend = night.get("last_hour_trend", "—")
    change_str = f"漲 `{change:+.0f}`" if not math.isnan(change) else ""
    parts = [f"收 `{close:,}`"]
    if change_str:
        parts.append(change_str)
    parts.append(f"末段 `{trend}`")
    return "🌙 **夜盤**  " + " · ".join(parts)


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
