"""Taiwan Market Structure Engine.

Fetches and analyses:
- TAIEX price structure (MA60 deviation, RSI, volume)
- Taiwan Futures institutional positioning
- Night session data
- Advance/decline ratio (breadth)
- Key sector strength (AI, semis)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import pandas as pd


@dataclass
class TaiwanStructure:
    """Validated snapshot of Taiwan market structure."""

    # Metadata
    trade_date: str = ""
    fetched_at: str = ""
    missing_fields: list[str] = field(default_factory=list)

    # TAIEX price
    taiex_close: float = 0.0
    taiex_ret_1d: float = 0.0
    taiex_ret_5d: float = 0.0
    taiex_ma60: float = 0.0
    taiex_dist_ma60: float = 0.0   # (close - ma60) / ma60
    taiex_rsi14: float = 50.0
    taiex_vol_ratio: float = 1.0   # vs 20-day avg

    # Taiwan Futures
    futures_net: int = 0           # foreign investor net position (contracts)
    futures_net_chg: int = 0       # 1-day change
    night_change: float = 0.0      # night session pts vs prev close
    night_change_pct: float = 0.0

    # Breadth
    advance_count: int = 0
    decline_count: int = 0
    advance_ratio: float = 0.5

    # Institutional (market-level)
    foreign_net_buy: float = 0.0   # NT$ hundred millions
    trust_net_buy: float = 0.0
    dealer_net_buy: float = 0.0
    total_inst_net: float = 0.0

    # Regime helpers
    above_ma60: bool = True
    strong_volume: bool = False
    institutional_buying: bool = False

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}

    def is_valid(self) -> bool:
        return len(self.missing_fields) < 4


def fetch_taiwan_structure(
    finmind_client=None,
    end_date: str | None = None,
    use_cache: bool = True,
) -> TaiwanStructure:
    """Fetch Taiwan market structure with graceful degradation on data failures."""
    struct = TaiwanStructure(
        trade_date=end_date or datetime.now().strftime("%Y-%m-%d"),
        fetched_at=datetime.now().isoformat(),
    )
    missing: list[str] = []

    if finmind_client is None:
        struct.missing_fields = ["all_finmind"]
        return struct

    # TAIEX price
    try:
        from data_loader import fetch_market_index
        taiex_df = fetch_market_index(finmind_client, end_date=end_date, lookback_days=120)
        if taiex_df is not None and not taiex_df.empty:
            df = taiex_df.sort_values("date").tail(120)
            closes = df["close"] if "close" in df.columns else df.iloc[:, -1]

            struct.taiex_close = float(closes.iloc[-1])
            if len(closes) >= 2:
                struct.taiex_ret_1d = float((closes.iloc[-1] - closes.iloc[-2]) / closes.iloc[-2])
            if len(closes) >= 5:
                struct.taiex_ret_5d = float((closes.iloc[-1] - closes.iloc[-5]) / closes.iloc[-5])
            if len(closes) >= 60:
                struct.taiex_ma60 = float(closes.iloc[-60:].mean())
                struct.taiex_dist_ma60 = float((closes.iloc[-1] - struct.taiex_ma60) / struct.taiex_ma60)
                struct.above_ma60 = closes.iloc[-1] > struct.taiex_ma60

            # Volume ratio
            if "volume" in df.columns and len(df) >= 20:
                avg_vol = df["volume"].iloc[-20:].mean()
                struct.taiex_vol_ratio = float(df["volume"].iloc[-1] / avg_vol) if avg_vol > 0 else 1.0
                struct.strong_volume = struct.taiex_vol_ratio > 1.3

            # RSI-14
            if len(closes) >= 15:
                delta = closes.diff().dropna()
                gain = delta.clip(lower=0).rolling(14).mean()
                loss = (-delta.clip(upper=0)).rolling(14).mean()
                rs = gain.iloc[-1] / loss.iloc[-1] if loss.iloc[-1] != 0 else 99
                struct.taiex_rsi14 = float(100 - 100 / (1 + rs))
    except Exception as e:
        missing.append(f"taiex:{e!s:.40}")

    # Taiwan Futures institutional
    try:
        from taiwan_futures import fetch_futures_institutional
        fut_inst = fetch_futures_institutional(finmind_client, end_date=end_date)
        if fut_inst is not None and not fut_inst.empty:
            struct.futures_net = int(fut_inst.get("net_oi", pd.Series([0])).iloc[-1])
            if len(fut_inst) >= 2:
                struct.futures_net_chg = struct.futures_net - int(fut_inst.get("net_oi", pd.Series([0])).iloc[-2])
    except Exception as e:
        missing.append(f"futures_inst:{e!s:.40}")

    # Night session
    try:
        from taiwan_futures import fetch_night_session
        night = fetch_night_session(finmind_client, trade_date=end_date)
        if night:
            struct.night_change = float(night.get("change", 0))
            struct.night_change_pct = float(night.get("change_pct", 0))
    except Exception as e:
        missing.append(f"night:{e!s:.40}")

    # Market-level institutional flows
    try:
        from data_loader import fetch_market_institutional
        inst_df = fetch_market_institutional(finmind_client, end_date=end_date)
        if inst_df is not None and not inst_df.empty:
            row = inst_df.iloc[-1]
            struct.foreign_net_buy = float(row.get("Foreign_Investors_net", 0)) / 1e8
            struct.trust_net_buy = float(row.get("Investment_Trust_net", 0)) / 1e8
            struct.dealer_net_buy = float(row.get("Dealer_net", 0)) / 1e8
            struct.total_inst_net = struct.foreign_net_buy + struct.trust_net_buy + struct.dealer_net_buy
            struct.institutional_buying = struct.total_inst_net > 0
    except Exception as e:
        missing.append(f"inst:{e!s:.40}")

    struct.missing_fields = missing
    return struct
