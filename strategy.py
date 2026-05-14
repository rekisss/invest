from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from indicators import (
    add_adx, add_atr, add_bollinger_bands, add_cci, add_donchian_channel,
    add_ema, add_ichimoku, add_macd, add_mfi, add_obv, add_rsi, add_sma,
    add_stochastic, add_williams_r, consecutive_positive,
)


@dataclass
class StrategyConfig:
    macd_fast: int = 12
    macd_slow: int = 26
    macd_signal: int = 9
    ema_entry: int = 60
    ema_trend: int = 120
    ema_exit: int = 20
    volume_ma_window: int = 20
    volume_multiplier: float = 1.5
    rsi_period: int = 14
    rsi_threshold: float = 55.0
    adx_period: int = 14
    adx_threshold: float = 20.0
    bb_period: int = 20
    bb_std: float = 2.0
    kd_k_period: int = 9
    kd_d_period: int = 3
    obv_ma_window: int = 20
    invest_trust_buy_streak: int = 2
    breakout_window: int = 20
    swing_low_window: int = 10
    max_recent_rise_pct: float = 0.05
    min_amount_ma20: float = 50_000_000
    market_ma_window: int = 60
    relative_strength_window: int = 5
    foreign_buy_streak: int = 3
    stop_loss_pct: float = 0.05
    take_profit_pct: float = 0.10
    trailing_stop_pct: float = 0.07
    risk_per_trade: float = 0.01
    max_positions: int = 3
    max_new_positions_per_day: int = 1
    use_earnings_filter: bool = False
    earnings_lookback_days: int = 5
    next_day_fill: bool = False
    brokerage_fee_pct: float = 0.001425   # 0.1425% 手續費（買賣各收）
    transaction_tax_pct: float = 0.003    # 0.3% 證交稅（賣出時收）
    slippage_pct: float = 0.001           # 0.1% 滑點（買賣各收）
    use_atr_stop: bool = False            # Use ATR-based stop instead of fixed %
    atr_stop_multiplier: float = 2.0      # Stop at entry_price - N * ATR14
    max_holding_days: int = 0             # Force-exit after N calendar days (0 = disabled)
    max_positions_per_sector: int = 2     # Max simultaneous positions per industry category


def prepare_market_frame(market_df: pd.DataFrame, config: StrategyConfig) -> pd.DataFrame:
    market = market_df.copy()
    market = market.sort_values("date").reset_index(drop=True)
    market["market_ma20"] = add_sma(market["close"], 20)
    market["market_ma60"] = add_sma(market["close"], config.market_ma_window)
    market["market_ma120"] = add_sma(market["close"], 120)
    market["market_above_ma60"] = market["close"] > market["market_ma60"]
    market["market_return_5d"] = market["close"].pct_change(config.relative_strength_window)
    return market


def compute_market_regime(market: pd.DataFrame) -> str:
    """Return '牛市', '盤整', or '熊市' based on the latest market MA alignment."""
    if market.empty:
        return "未知"
    last = market.iloc[-1]
    close = float(last.get("close") or 0)
    ma20 = float(last.get("market_ma20") or 0)
    ma60 = float(last.get("market_ma60") or 0)
    ma120 = float(last.get("market_ma120") or 0)
    if close <= 0 or ma60 <= 0:
        return "未知"
    above_ma60 = close > ma60
    ma_bullish = ma20 > ma60 and (ma120 <= 0 or ma60 > ma120)
    ma_bearish = ma20 < ma60 and (ma120 <= 0 or ma60 < ma120)
    if above_ma60 and ma_bullish:
        return "牛市"
    if not above_ma60 and ma_bearish:
        return "熊市"
    return "盤整"


def _build_earnings_blocker(index: pd.Index, earnings_dates: pd.DataFrame | None, config: StrategyConfig) -> pd.Series:
    blocked = pd.Series(False, index=index)
    if not config.use_earnings_filter or earnings_dates is None or earnings_dates.empty:
        return blocked
    event_dates = pd.to_datetime(earnings_dates["date"], errors="coerce").dropna().sort_values()
    if event_dates.empty:
        return blocked
    for event_date in event_dates:
        prior_index = index[index < event_date]
        if len(prior_index) == 0:
            continue
        blocked.loc[prior_index[-config.earnings_lookback_days:]] = True
    return blocked


def prepare_stock_signals(
    stock_info: dict[str, str],
    stock_df: pd.DataFrame,
    market_df: pd.DataFrame,
    institutional_df: pd.DataFrame,
    config: StrategyConfig,
    earnings_dates: pd.DataFrame | None = None,
) -> pd.DataFrame:
    frame = stock_df.copy()
    frame = frame.sort_values("date").reset_index(drop=True)
    frame["stock_id"] = stock_info["stock_id"]
    frame["name"] = stock_info["name"]
    frame["industry_category"] = stock_info.get("industry_category", "")

    macd = add_macd(frame["close"], config.macd_fast, config.macd_slow, config.macd_signal)
    frame = pd.concat([frame, macd], axis=1)
    frame["ema20"] = add_ema(frame["close"], config.ema_exit)
    frame["ema60"] = add_ema(frame["close"], config.ema_entry)
    frame["ema120"] = add_ema(frame["close"], config.ema_trend)
    frame["rsi14"] = add_rsi(frame["close"], config.rsi_period)
    frame["adx14"] = add_adx(frame["high"], frame["low"], frame["close"], config.adx_period)
    frame["atr14"] = add_atr(frame["high"], frame["low"], frame["close"], config.adx_period)
    frame["volume_ma20"] = add_sma(frame["volume"], config.volume_ma_window)
    frame["amount_ma20"] = add_sma(frame["amount"], 20)
    frame["close_20d_high"] = frame["close"].rolling(config.breakout_window).max().shift(1)
    frame["close_10d_low"] = frame["close"].rolling(config.swing_low_window).min().shift(1)
    frame["return_5d"] = frame["close"].pct_change(config.relative_strength_window)
    frame["day_return"] = frame["close"].pct_change(1)
    frame["prev_close"] = frame["close"].shift(1)
    frame["prev_volume_ratio"] = (frame["volume"] / frame["volume_ma20"]).shift(1)

    bb = add_bollinger_bands(frame["close"], config.bb_period, config.bb_std)
    frame = pd.concat([frame, bb], axis=1)
    kd = add_stochastic(frame["high"], frame["low"], frame["close"], config.kd_k_period, config.kd_d_period)
    frame = pd.concat([frame, kd], axis=1)
    frame["obv"] = add_obv(frame["close"], frame["volume"])
    frame["obv_ma"] = add_sma(frame["obv"], config.obv_ma_window)
    frame["williams_r"] = add_williams_r(frame["high"], frame["low"], frame["close"])
    frame["cci20"] = add_cci(frame["high"], frame["low"], frame["close"])
    dc = add_donchian_channel(frame["high"], frame["low"])
    frame = pd.concat([frame, dc], axis=1)
    frame["mfi14"] = add_mfi(frame["high"], frame["low"], frame["close"], frame["volume"])
    ichi = add_ichimoku(frame["high"], frame["low"])
    frame = pd.concat([frame, ichi], axis=1)

    institutional_missing = institutional_df.empty
    inst = institutional_df.copy()
    if inst.empty:
        inst = pd.DataFrame({"date": frame["date"], "foreign_net": 0, "invest_trust_net": 0, "dealer_net": 0})
    inst = inst.sort_values("date").drop_duplicates(subset=["date"])
    inst["foreign_buy_streak"] = consecutive_positive(inst["foreign_net"])
    inst["invest_trust_streak"] = consecutive_positive(inst["invest_trust_net"])
    inst["dealer_buy_streak"] = consecutive_positive(inst["dealer_net"])

    merge_inst_cols = ["date", "foreign_net", "foreign_buy_streak",
                       "invest_trust_net", "invest_trust_streak",
                       "dealer_net", "dealer_buy_streak"]
    merge_inst_cols = [c for c in merge_inst_cols if c in inst.columns]

    merged = frame.merge(
        market_df[["date", "market_ma60", "market_above_ma60", "market_return_5d"]],
        on="date", how="left",
    ).merge(inst[merge_inst_cols], on="date", how="left")

    for col in ["foreign_net", "foreign_buy_streak", "invest_trust_net", "invest_trust_streak", "dealer_net", "dealer_buy_streak"]:
        if col not in merged.columns:
            merged[col] = 0
    merged["foreign_net"] = merged["foreign_net"].fillna(0)
    merged["foreign_buy_streak"] = merged["foreign_buy_streak"].fillna(0)
    merged["invest_trust_net"] = merged["invest_trust_net"].fillna(0)
    merged["invest_trust_streak"] = merged["invest_trust_streak"].fillna(0)
    merged["dealer_net"] = merged["dealer_net"].fillna(0)
    merged["dealer_buy_streak"] = merged["dealer_buy_streak"].fillna(0)
    merged["relative_strength_5d"] = merged["return_5d"] - merged["market_return_5d"]

    # ── Core signals ──────────────────────────────────────────────────────────
    merged["macd_golden_cross"] = (
        (merged["macd"].shift(1) <= merged["macd_signal"].shift(1))
        & (merged["macd"] > merged["macd_signal"])
    )
    merged["hist_turn_positive"] = (merged["macd_hist"].shift(1) <= 0) & (merged["macd_hist"] > 0)
    merged["above_ema60"] = merged["close"] > merged["ema60"]
    merged["ema60_gt_ema120"] = merged["ema60"] > merged["ema120"]
    merged["volume_ratio"] = merged["volume"] / merged["volume_ma20"]
    merged["volume_break"] = merged["volume_ratio"] > config.volume_multiplier
    merged["rsi_strong"] = merged["rsi14"] > config.rsi_threshold
    merged["adx_trending"] = merged["adx14"] > config.adx_threshold
    merged["breakout_20d"] = merged["close"] > merged["close_20d_high"]
    merged["avoid_chase"] = merged["return_5d"] < config.max_recent_rise_pct
    merged["liquidity_ok"] = merged["amount_ma20"] > config.min_amount_ma20

    # ── Soft signals (籌碼 + 技術) ────────────────────────────────────────────
    merged["foreign_buy_3d"] = merged["foreign_buy_streak"] >= config.foreign_buy_streak
    if institutional_missing:
        merged["foreign_buy_3d"] = False

    merged["stronger_than_market"] = merged["relative_strength_5d"] > 0

    merged["kd_golden_cross"] = (
        (merged["stoch_k"].shift(1) <= merged["stoch_d"].shift(1))
        & (merged["stoch_k"] > merged["stoch_d"])
        & (merged["stoch_k"] < 80)
    )

    merged["obv_uptrend"] = merged["obv"] > merged["obv_ma"]

    merged["invest_trust_buy_2d"] = merged["invest_trust_streak"] >= config.invest_trust_buy_streak
    if institutional_missing:
        merged["invest_trust_buy_2d"] = False

    merged["dealer_buy_3d"] = merged["dealer_buy_streak"] >= 3
    if institutional_missing:
        merged["dealer_buy_3d"] = False

    # BB squeeze breakout: bandwidth was narrow (< median) and now price breaks above upper band
    bb_bandwidth_median = merged["bb_bandwidth"].rolling(window=60, min_periods=20).median()
    merged["bb_squeeze_breakout"] = (
        merged["bb_bandwidth"].shift(1) < bb_bandwidth_median.shift(1)
    ) & (merged["close"] > merged["bb_upper"])

    # Breakout confirmed with simultaneous volume surge (quality entry filter)
    merged["breakout_volume_confirm"] = merged["breakout_20d"] & merged["volume_break"]

    # Williams %R recovering from oversold (was below -80, now above -50)
    merged["williams_r_recovery"] = (
        (merged["williams_r"].shift(1) < -80)
        & (merged["williams_r"] > -50)
    )

    # CCI momentum: CCI crossed above +100 from below (strong bullish momentum)
    merged["cci_momentum"] = (
        (merged["cci20"].shift(1) < 100)
        & (merged["cci20"] >= 100)
    )

    # MFI > 50: money is flowing into the stock (volume-weighted buying pressure)
    merged["mfi_strong"] = merged["mfi14"] > 50

    # Price above Ichimoku cloud: bullish cloud confirmation (close > both senkou spans)
    cloud_top = merged[["ichi_senkou_a", "ichi_senkou_b"]].max(axis=1)
    merged["above_ichimoku_cloud"] = merged["close"] > cloud_top

    # ── Candlestick filters ───────────────────────────────────────────────────
    body = (merged["close"] - merged["open"]).abs()
    upper_shadow = merged["high"] - merged[["open", "close"]].max(axis=1)
    merged["long_upper_shadow"] = (body > 0) & (upper_shadow > body * 2)
    merged["open_high_close_low"] = (
        (merged["open"] > merged["prev_close"] * 1.02)
        & (merged["close"] < merged["open"])
    )
    merged["gap_chase_after_blowout"] = (
        (merged["prev_volume_ratio"] > config.volume_multiplier)
        & ((merged["open"] / merged["prev_close"]) - 1 > 0.03)
    )
    merged["earnings_blocked"] = _build_earnings_blocker(
        merged.set_index("date").index, earnings_dates, config,
    ).values

    hard_entry_columns = [
        "macd_golden_cross", "hist_turn_positive", "above_ema60", "ema60_gt_ema120",
        "volume_break", "rsi_strong", "breakout_20d", "market_above_ma60",
        "avoid_chase", "liquidity_ok",
    ]
    soft_entry_columns = [
        "foreign_buy_3d", "adx_trending", "stronger_than_market",
        "kd_golden_cross", "obv_uptrend", "invest_trust_buy_2d",
        "dealer_buy_3d", "bb_squeeze_breakout", "breakout_volume_confirm",
        "williams_r_recovery", "cci_momentum",
        "mfi_strong", "above_ichimoku_cloud",
    ]
    entry_columns = hard_entry_columns + soft_entry_columns
    merged["condition_count"] = merged[entry_columns].sum(axis=1)

    merged["skip_trade"] = (
        merged["long_upper_shadow"] | merged["open_high_close_low"]
        | merged["gap_chase_after_blowout"] | merged["earnings_blocked"]
    )
    merged["entry_signal"] = merged[hard_entry_columns].all(axis=1) & ~merged["skip_trade"]
    merged["entry_score"] = (
        merged["condition_count"] * 100
        + merged["relative_strength_5d"].fillna(-99) * 100
        + merged["volume_ratio"].fillna(0) * 10
        + merged["adx14"].fillna(0)
        + merged["foreign_buy_3d"].astype(int) * 25
        + merged["invest_trust_buy_2d"].astype(int) * 20
        + merged["dealer_buy_3d"].astype(int) * 15
        + merged["kd_golden_cross"].astype(int) * 20
        + merged["obv_uptrend"].astype(int) * 15
        + merged["adx_trending"].astype(int) * 15
        + merged["stronger_than_market"].astype(int) * 10
        + merged["bb_squeeze_breakout"].astype(int) * 30
        + merged["breakout_volume_confirm"].astype(int) * 20
        + merged["williams_r_recovery"].astype(int) * 15
        + merged["cci_momentum"].astype(int) * 15
        + merged["mfi_strong"].astype(int) * 10
        + merged["above_ichimoku_cloud"].astype(int) * 20
    )

    merged["macd_death_cross"] = (
        (merged["macd"].shift(1) >= merged["macd_signal"].shift(1))
        & (merged["macd"] < merged["macd_signal"])
    )
    merged["close_below_ema20"] = merged["close"] < merged["ema20"]
    merged["close_below_swing_low"] = merged["close"] < merged["close_10d_low"]
    merged["base_exit_signal"] = (
        merged["macd_death_cross"] | merged["close_below_ema20"] | merged["close_below_swing_low"]
    )

    _skip_cols = ["long_upper_shadow", "open_high_close_low", "gap_chase_after_blowout", "earnings_blocked"]
    _exit_cols = ["macd_death_cross", "close_below_ema20", "close_below_swing_low"]

    _entry_arr = merged[entry_columns].astype(bool).to_numpy()
    _skip_arr = merged[_skip_cols].astype(bool).to_numpy()
    _exit_arr = merged[_exit_cols].astype(bool).to_numpy()
    _ec = np.array(entry_columns)
    _sc = np.array(_skip_cols)
    _xc = np.array(_exit_cols)
    merged["entry_reason"] = [", ".join(_ec[row]) for row in _entry_arr]
    merged["skip_reason"] = [", ".join(_sc[row]) for row in _skip_arr]
    merged["base_exit_reason"] = [", ".join(_xc[row]) for row in _exit_arr]
    return merged


def compute_market_breadth(snapshot: pd.DataFrame) -> dict[str, object]:
    if snapshot.empty:
        return {}
    total = len(snapshot)
    breadth_cols = [
        "above_ema60", "ema60_gt_ema120", "market_above_ma60",
        "macd_golden_cross", "volume_break", "rsi_strong", "breakout_20d",
        "foreign_buy_3d", "adx_trending", "stronger_than_market",
        "kd_golden_cross", "obv_uptrend", "invest_trust_buy_2d",
        "dealer_buy_3d", "mfi_strong", "above_ichimoku_cloud",
    ]
    result: dict[str, object] = {"total_stocks": total}
    for col in breadth_cols:
        if col in snapshot.columns:
            pct = int(snapshot[col].fillna(False).sum() / total * 100)
            result[col] = pct
    entry_count = int(snapshot["entry_signal"].sum()) if "entry_signal" in snapshot.columns else 0
    result["entry_signal_count"] = entry_count
    result["entry_signal_pct"] = int(entry_count / total * 100)
    return result


def latest_signal_snapshot(signals_by_stock: dict[str, pd.DataFrame]) -> pd.DataFrame:
    rows: list[pd.Series] = []
    for frame in signals_by_stock.values():
        if frame.empty:
            continue
        rows.append(frame.sort_values("date").iloc[-1])
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows).sort_values(
        ["entry_signal", "condition_count", "entry_score"],
        ascending=[False, False, False],
    ).reset_index(drop=True)


def rank_candidates(
    snapshot: pd.DataFrame,
    top_n: int = 20,
    max_price: float | None = None,
    prefer_lower_price: bool = False,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    if snapshot.empty:
        return pd.DataFrame(), pd.DataFrame()

    candidates = snapshot[snapshot["entry_signal"]].copy()
    watchlist = snapshot[~snapshot["entry_signal"]].copy()

    if max_price is not None:
        candidates = candidates[pd.to_numeric(candidates["close"], errors="coerce") <= max_price].copy()
        watchlist = watchlist[pd.to_numeric(watchlist["close"], errors="coerce") <= max_price].copy()

    candidate_columns = [
        "date", "stock_id", "name", "industry_category", "close",
        "condition_count", "entry_score", "rsi14", "adx14", "atr14",
        "volume_ratio", "volume_ma20", "return_5d", "relative_strength_5d",
        "foreign_buy_streak", "invest_trust_streak", "dealer_buy_streak",
        "stoch_k", "stoch_d",
        "bb_pct_b", "bb_bandwidth", "obv_uptrend",
        "bb_squeeze_breakout", "breakout_volume_confirm",
        "mfi14", "mfi_strong", "above_ichimoku_cloud",
        "entry_reason", "skip_reason",
    ]
    watch_columns = [
        "date", "stock_id", "name", "industry_category", "close",
        "condition_count", "entry_score", "volume_ma20", "skip_reason", "entry_reason",
    ]

    # Only keep columns that exist
    candidate_columns = [c for c in candidate_columns if c in snapshot.columns]
    watch_columns = [c for c in watch_columns if c in snapshot.columns]

    if prefer_lower_price:
        candidates = candidates.sort_values(["condition_count", "close", "entry_score"], ascending=[False, True, False]).head(top_n)
        watchlist = watchlist.sort_values(["condition_count", "close", "entry_score"], ascending=[False, True, False]).head(top_n)
    else:
        candidates = candidates.sort_values(["entry_score", "condition_count"], ascending=[False, False]).head(top_n)
        watchlist = watchlist.sort_values(["condition_count", "entry_score"], ascending=[False, False]).head(top_n)
    return candidates[candidate_columns], watchlist[watch_columns]
