"""
Volume-based trading signal utilities.

Provides exit and confirmation signals based on volume patterns:
  - Volume collapse detection (exit signal when volume dries up)
  - Distribution day detection (high-volume down days)
  - Volume thrust confirmation (breakout quality filter)
  - Accumulation/distribution ratio

These are additive utilities that can be used alongside existing
indicators.py functions — no existing files are modified.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


# ── Volume collapse exit signal ────────────────────────────────────────────────

def volume_collapse_exit(
    close: pd.Series,
    volume: pd.Series,
    window: int = 20,
    collapse_ratio: float = 0.50,
    consecutive_days: int = 2,
) -> pd.Series:
    """Detect volume collapse as an exit trigger.

    Returns a boolean Series (True = exit signal on that day).

    Signal criteria:
      For each day, check if volume < collapse_ratio × MA(volume, window)
      for `consecutive_days` in a row AND price has risen from entry
      (i.e., only exit on volume collapse in uptrend, not during panic).

    Parameters
    ----------
    close : pd.Series
        Daily closing prices.
    volume : pd.Series
        Daily trading volume or value.
    window : int
        Rolling window for volume moving average.
    collapse_ratio : float
        Volume is considered collapsed if vol < collapse_ratio × vol_ma.
        Default 0.50 means less than 50% of average volume.
    consecutive_days : int
        Number of consecutive days of collapse required to trigger.
    """
    if len(close) < window + consecutive_days:
        return pd.Series(False, index=close.index)

    vol = pd.to_numeric(volume, errors="coerce").fillna(0.0)
    vol_ma = vol.rolling(window, min_periods=max(5, window // 2)).mean()
    is_low_vol = vol < (vol_ma * collapse_ratio)

    # Rolling count of consecutive low-volume days
    consec = is_low_vol.astype(int)
    for _ in range(consecutive_days - 1):
        consec = consec & is_low_vol.shift(1, fill_value=False).astype(int)
    collapse = consec.astype(bool)

    # Only trigger exit when price is above its 5-day low (not in freefall)
    price_not_crashing = close > close.rolling(5, min_periods=1).min()
    return collapse & price_not_crashing


# ── Distribution day detection ─────────────────────────────────────────────────

def distribution_days(
    close: pd.Series,
    volume: pd.Series,
    window_lookback: int = 25,
    price_drop_min: float = -0.002,
) -> pd.Series:
    """Count distribution days (high-volume selling) in a rolling window.

    A distribution day occurs when:
      - Close is lower than prior close by >= |price_drop_min| (default 0.2%)
      - Volume is higher than the prior day's volume

    Returns an integer Series: number of distribution days in last `window_lookback` days.
    Sustained distribution (>= 4 in 25 days) is a market top warning.
    """
    vol = pd.to_numeric(volume, errors="coerce").fillna(0.0)
    price_down = close.pct_change(1) <= price_drop_min
    vol_up = vol > vol.shift(1)
    dist_day = (price_down & vol_up).astype(int)
    return dist_day.rolling(window_lookback, min_periods=1).sum().astype(int)


# ── Volume thrust (breakout quality) ──────────────────────────────────────────

def volume_thrust_score(
    close: pd.Series,
    volume: pd.Series,
    breakout_window: int = 20,
    vol_window: int = 20,
) -> pd.Series:
    """Score breakout quality based on volume surge at new highs.

    Returns a float Series (0.0–100.0):
      0   = no breakout or breakout on low volume
      50  = breakout with average volume
      100 = breakout with 3× average volume

    Useful for confirming whether a breakout_20d signal has institutional backing.
    """
    close_n = pd.to_numeric(close, errors="coerce")
    vol_n = pd.to_numeric(volume, errors="coerce").fillna(0.0)
    vol_ma = vol_n.rolling(vol_window, min_periods=max(5, vol_window // 2)).mean()
    rolling_high = close_n.shift(1).rolling(breakout_window, min_periods=1).max()
    is_breakout = close_n > rolling_high
    vol_ratio = (vol_n / vol_ma.replace(0, np.nan)).fillna(0.0)
    # Scale: 1× = 50, 3× = 100, 0× = 0
    raw_score = (vol_ratio / 3.0 * 100.0).clip(0.0, 100.0)
    return pd.Series(
        np.where(is_breakout, raw_score, 0.0),
        index=close.index,
    )


# ── Accumulation / Distribution ratio ─────────────────────────────────────────

def accumulation_distribution_ratio(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    volume: pd.Series,
    window: int = 14,
) -> pd.Series:
    """Compute a simplified Accumulation/Distribution (A/D) ratio.

    Formula:
      money_flow_multiplier = ((close - low) - (high - close)) / (high - low)
      money_flow_volume = money_flow_multiplier × volume
      ad_ratio(n) = sum(positive MFV, n) / max(1, sum(negative MFV, n))

    Returns a float Series > 1.0 means net accumulation, < 1.0 means net distribution.
    """
    hi = pd.to_numeric(high, errors="coerce")
    lo = pd.to_numeric(low, errors="coerce")
    cl = pd.to_numeric(close, errors="coerce")
    vol = pd.to_numeric(volume, errors="coerce").fillna(0.0)

    hl_range = (hi - lo).replace(0, np.nan)
    mfm = ((cl - lo) - (hi - cl)) / hl_range
    mfv = mfm * vol

    pos = mfv.clip(lower=0)
    neg = (-mfv).clip(lower=0)
    pos_sum = pos.rolling(window, min_periods=1).sum()
    neg_sum = neg.rolling(window, min_periods=1).sum()

    return (pos_sum / neg_sum.replace(0, np.nan)).fillna(1.0)


# ── Thin float warning ─────────────────────────────────────────────────────────

def is_thin_float(
    volume_ma20: float,
    close: float,
    min_daily_value_twd: float = 30_000_000.0,
) -> bool:
    """Return True if the stock's liquidity is dangerously thin.

    A stock with daily traded value < min_daily_value_twd (default NT$30M)
    is considered illiquid — exits may be difficult without moving the price.
    """
    daily_value = volume_ma20 * close
    return daily_value < min_daily_value_twd
