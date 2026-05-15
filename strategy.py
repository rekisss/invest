from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from indicators import (
    add_adx_atr, add_bollinger_bands, add_cci,
    add_ema, add_ichimoku_cloud, add_lr_slopes, add_macd, add_mfi, add_obv, add_rsi, add_sma,
    add_stochastic, add_williams_r, consecutive_positive,
)

# Module-level constants — column names never change, precomputed to avoid
# rebuilding on every prepare_stock_signals call (once per stock, ~70 per scan).
_HARD_ENTRY_COLS = [
    "macd_golden_cross", "hist_turn_positive", "above_ema60", "ema60_gt_ema120",
    "volume_break", "rsi_strong", "breakout_20d", "market_above_ma60",
    "avoid_chase", "liquidity_ok",
]
_SOFT_ENTRY_COLS = [
    "foreign_buy_3d", "adx_trending", "stronger_than_market",
    "kd_golden_cross", "obv_uptrend", "invest_trust_buy_2d",
    "dealer_buy_3d", "bb_squeeze_breakout", "breakout_volume_confirm",
    "williams_r_recovery", "cci_momentum",
    "mfi_strong", "above_ichimoku_cloud",
]
_ENTRY_COLS = _HARD_ENTRY_COLS + _SOFT_ENTRY_COLS
_ENTRY_COLS_ARR = np.array(_ENTRY_COLS)
_SKIP_COLS = ["long_upper_shadow", "open_high_close_low", "gap_chase_after_blowout", "earnings_blocked"]
_SKIP_COLS_ARR = np.array(_SKIP_COLS)
_EXIT_COLS = ["macd_death_cross", "close_below_ema20", "close_below_swing_low"]
_EXIT_COLS_ARR = np.array(_EXIT_COLS)

# Weights for the boolean part of entry_score (order matches _SOFT_ENTRY_COLS)
_SOFT_SCORE_COLS = [
    "foreign_buy_3d", "invest_trust_buy_2d", "dealer_buy_3d",
    "kd_golden_cross", "obv_uptrend", "adx_trending", "stronger_than_market",
    "bb_squeeze_breakout", "breakout_volume_confirm",
    "williams_r_recovery", "cci_momentum", "mfi_strong", "above_ichimoku_cloud",
]
_SOFT_SCORE_WEIGHTS = np.array([25, 20, 15, 20, 15, 15, 10, 30, 20, 15, 15, 10, 20], dtype=np.float64)

_BREADTH_COLS = [
    "above_ema60", "ema60_gt_ema120", "market_above_ma60",
    "macd_golden_cross", "volume_break", "rsi_strong", "breakout_20d",
    "foreign_buy_3d", "adx_trending", "stronger_than_market",
    "kd_golden_cross", "obv_uptrend", "invest_trust_buy_2d",
    "dealer_buy_3d", "mfi_strong", "above_ichimoku_cloud",
]
_CANDIDATE_COLS = [
    "date", "stock_id", "name", "industry_category", "close",
    "condition_count", "entry_score", "rsi14", "adx14", "atr14",
    "volume_ratio", "volume_ma20", "return_5d", "relative_strength_5d",
    "foreign_buy_streak", "invest_trust_streak", "dealer_buy_streak",
    "stoch_k", "stoch_d",
    "bb_pct_b", "bb_bandwidth", "obv_uptrend",
    "bb_squeeze_breakout", "breakout_volume_confirm",
    "mfi14", "mfi_strong", "above_ichimoku_cloud",
    "close_10d_low",
    "lr_slope_20", "lr_slope_60",
    "entry_reason", "skip_reason",
]
_WATCH_COLS = [
    "date", "stock_id", "name", "industry_category", "close",
    "condition_count", "entry_score", "volume_ma20", "close_20d_high",
    "lr_slope_20", "lr_slope_60",
    "skip_reason", "entry_reason",
]


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
    _mc = market["close"].to_numpy(dtype=float)
    _w5 = config.relative_strength_window
    _mr5 = np.empty_like(_mc); _mr5[:_w5] = np.nan; _mr5[_w5:] = _mc[_w5:] / _mc[:-_w5] - 1
    market["market_return_5d"] = _mr5
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
    frame = stock_df.sort_values("date").reset_index(drop=True)
    frame["stock_id"] = stock_info["stock_id"]
    frame["name"] = stock_info["name"]
    frame["industry_category"] = stock_info.get("industry_category", "")

    _macd = add_macd(frame["close"], config.macd_fast, config.macd_slow, config.macd_signal)
    frame[_macd.columns] = _macd.values
    frame["ema20"] = add_ema(frame["close"], config.ema_exit)
    frame["ema60"] = add_ema(frame["close"], config.ema_entry)
    frame["ema120"] = add_ema(frame["close"], config.ema_trend)
    frame["rsi14"] = add_rsi(frame["close"], config.rsi_period)
    _adx_atr = add_adx_atr(frame["high"], frame["low"], frame["close"], config.adx_period)
    frame[_adx_atr.columns] = _adx_atr.values
    frame["volume_ma20"] = add_sma(frame["volume"], config.volume_ma_window)
    frame["amount_ma20"] = add_sma(frame["amount"], 20)
    _n_fr = len(frame)
    _max20 = frame["close"].rolling(config.breakout_window).max().to_numpy(dtype=float)
    _min10 = frame["close"].rolling(config.swing_low_window).min().to_numpy(dtype=float)
    _s_max20 = np.empty(_n_fr, dtype=float); _s_max20[0] = np.nan; _s_max20[1:] = _max20[:-1]
    _s_min10 = np.empty(_n_fr, dtype=float); _s_min10[0] = np.nan; _s_min10[1:] = _min10[:-1]
    frame["close_20d_high"] = _s_max20
    frame["close_10d_low"] = _s_min10
    _lr = add_lr_slopes(frame["close"], windows=(20, 60))
    frame[_lr.columns] = _lr.values
    _c = frame["close"].to_numpy(dtype=float)
    _w = config.relative_strength_window
    _r5d = np.empty_like(_c); _r5d[:_w] = np.nan; _r5d[_w:] = _c[_w:] / _c[:-_w] - 1
    _dr = np.empty_like(_c); _dr[0] = np.nan; _dr[1:] = _c[1:] / _c[:-1] - 1
    _pc = np.empty_like(_c); _pc[0] = np.nan; _pc[1:] = _c[:-1]
    _vr = frame["volume"].to_numpy(dtype=float) / frame["volume_ma20"].to_numpy(dtype=float)
    _pvr = np.empty_like(_vr); _pvr[0] = np.nan; _pvr[1:] = _vr[:-1]
    frame["return_5d"] = _r5d
    frame["day_return"] = _dr
    frame["prev_close"] = _pc
    frame["prev_volume_ratio"] = _pvr

    _bb = add_bollinger_bands(frame["close"], config.bb_period, config.bb_std)
    frame[_bb.columns] = _bb.values
    _stoch = add_stochastic(frame["high"], frame["low"], frame["close"], config.kd_k_period, config.kd_d_period)
    frame[_stoch.columns] = _stoch.values
    frame["obv"] = add_obv(frame["close"], frame["volume"])
    frame["obv_ma"] = add_sma(frame["obv"], config.obv_ma_window)
    frame["williams_r"] = add_williams_r(frame["high"], frame["low"], frame["close"])
    frame["cci20"] = add_cci(frame["high"], frame["low"], frame["close"])
    frame["mfi14"] = add_mfi(frame["high"], frame["low"], frame["close"], frame["volume"])
    _ichi = add_ichimoku_cloud(frame["high"], frame["low"])
    frame[_ichi.columns] = _ichi.values

    institutional_missing = institutional_df.empty
    if institutional_missing:
        inst = pd.DataFrame({"date": frame["date"], "foreign_net": 0, "invest_trust_net": 0, "dealer_net": 0})
    else:
        inst = institutional_df.sort_values("date").drop_duplicates(subset=["date"])
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

    _inst_fill_cols = ["foreign_net", "foreign_buy_streak", "invest_trust_net", "invest_trust_streak", "dealer_net", "dealer_buy_streak"]
    for col in _inst_fill_cols:
        if col not in merged.columns:
            merged[col] = 0.0
    merged[_inst_fill_cols] = merged[_inst_fill_cols].fillna(0)
    merged["relative_strength_5d"] = merged["return_5d"] - merged["market_return_5d"]

    # ── Core signals ──────────────────────────────────────────────────────────
    _n = len(merged)
    _macd_arr = merged["macd"].to_numpy(dtype=float)
    _macd_sig_arr = merged["macd_signal"].to_numpy(dtype=float)
    _macd_hist_arr = merged["macd_hist"].to_numpy(dtype=float)
    _stoch_k_arr = merged["stoch_k"].to_numpy(dtype=float)
    _stoch_d_arr = merged["stoch_d"].to_numpy(dtype=float)
    _bb_bw_arr = merged["bb_bandwidth"].to_numpy(dtype=float)
    _wr_arr = merged["williams_r"].to_numpy(dtype=float)
    _cci_arr = merged["cci20"].to_numpy(dtype=float)
    _p_macd = np.empty(_n, dtype=float); _p_macd[0] = np.nan; _p_macd[1:] = _macd_arr[:-1]
    _p_macd_sig = np.empty(_n, dtype=float); _p_macd_sig[0] = np.nan; _p_macd_sig[1:] = _macd_sig_arr[:-1]
    _p_macd_hist = np.empty(_n, dtype=float); _p_macd_hist[0] = np.nan; _p_macd_hist[1:] = _macd_hist_arr[:-1]
    _p_stoch_k = np.empty(_n, dtype=float); _p_stoch_k[0] = np.nan; _p_stoch_k[1:] = _stoch_k_arr[:-1]
    _p_stoch_d = np.empty(_n, dtype=float); _p_stoch_d[0] = np.nan; _p_stoch_d[1:] = _stoch_d_arr[:-1]
    _p_bb_bw = np.empty(_n, dtype=float); _p_bb_bw[0] = np.nan; _p_bb_bw[1:] = _bb_bw_arr[:-1]
    _p_wr = np.empty(_n, dtype=float); _p_wr[0] = np.nan; _p_wr[1:] = _wr_arr[:-1]
    _p_cci = np.empty(_n, dtype=float); _p_cci[0] = np.nan; _p_cci[1:] = _cci_arr[:-1]

    # Pre-extract numpy arrays — avoids pandas index-alignment overhead on every comparison
    _close_arr = merged["close"].to_numpy(dtype=float)
    _ema20_arr = merged["ema20"].to_numpy(dtype=float)
    _ema60_arr = merged["ema60"].to_numpy(dtype=float)
    _ema120_arr = merged["ema120"].to_numpy(dtype=float)
    _vol_arr = merged["volume"].to_numpy(dtype=float)
    _vma20_arr = merged["volume_ma20"].to_numpy(dtype=float)
    _rsi_arr = merged["rsi14"].to_numpy(dtype=float)
    _adx_arr = merged["adx14"].to_numpy(dtype=float)
    _h20_arr = merged["close_20d_high"].to_numpy(dtype=float)
    _r5d_arr = merged["return_5d"].to_numpy(dtype=float)
    _ama20_arr = merged["amount_ma20"].to_numpy(dtype=float)
    _rs5d_arr = merged["relative_strength_5d"].to_numpy(dtype=float)
    _obv_arr = merged["obv"].to_numpy(dtype=float)
    _obv_ma_arr = merged["obv_ma"].to_numpy(dtype=float)
    _mfi_arr = merged["mfi14"].to_numpy(dtype=float)
    _fb_streak = merged["foreign_buy_streak"].to_numpy(dtype=float)
    _it_streak = merged["invest_trust_streak"].to_numpy(dtype=float)
    _dl_streak = merged["dealer_buy_streak"].to_numpy(dtype=float)
    _s10d_arr = merged["close_10d_low"].to_numpy(dtype=float)
    _bb_upper_arr = merged["bb_upper"].to_numpy(dtype=float)
    _vr_arr = _vol_arr / _vma20_arr

    merged["macd_golden_cross"] = (_p_macd <= _p_macd_sig) & (_macd_arr > _macd_sig_arr)
    merged["hist_turn_positive"] = (_p_macd_hist <= 0) & (_macd_hist_arr > 0)
    merged["above_ema60"] = _close_arr > _ema60_arr
    merged["ema60_gt_ema120"] = _ema60_arr > _ema120_arr
    merged["volume_ratio"] = _vr_arr
    merged["volume_break"] = _vr_arr > config.volume_multiplier
    merged["rsi_strong"] = _rsi_arr > config.rsi_threshold
    merged["adx_trending"] = _adx_arr > config.adx_threshold
    merged["breakout_20d"] = _close_arr > _h20_arr
    merged["avoid_chase"] = _r5d_arr < config.max_recent_rise_pct
    merged["liquidity_ok"] = _ama20_arr > config.min_amount_ma20

    # ── Soft signals (籌碼 + 技術) ────────────────────────────────────────────
    merged["foreign_buy_3d"] = _fb_streak >= config.foreign_buy_streak
    if institutional_missing:
        merged["foreign_buy_3d"] = False

    merged["stronger_than_market"] = _rs5d_arr > 0

    merged["kd_golden_cross"] = (
        (_p_stoch_k <= _p_stoch_d)
        & (_stoch_k_arr > _stoch_d_arr)
        & (_stoch_k_arr < 80)
    )

    merged["obv_uptrend"] = _obv_arr > _obv_ma_arr

    merged["invest_trust_buy_2d"] = _it_streak >= config.invest_trust_buy_streak
    if institutional_missing:
        merged["invest_trust_buy_2d"] = False

    merged["dealer_buy_3d"] = _dl_streak >= 3
    if institutional_missing:
        merged["dealer_buy_3d"] = False

    # BB squeeze breakout: bandwidth was narrow (< median) and now price breaks above upper band
    bb_bandwidth_median = merged["bb_bandwidth"].rolling(window=60, min_periods=20).median()
    _bbm = bb_bandwidth_median.to_numpy(dtype=float)
    _bbm_prev = np.empty(_n, dtype=float); _bbm_prev[0] = np.nan; _bbm_prev[1:] = _bbm[:-1]
    merged["bb_squeeze_breakout"] = (_p_bb_bw < _bbm_prev) & (_close_arr > _bb_upper_arr)

    # Breakout confirmed with simultaneous volume surge (quality entry filter)
    merged["breakout_volume_confirm"] = merged["breakout_20d"] & merged["volume_break"]

    # Williams %R recovering from oversold (was below -80, now above -50)
    merged["williams_r_recovery"] = (_p_wr < -80) & (_wr_arr > -50)

    # CCI momentum: CCI crossed above +100 from below (strong bullish momentum)
    merged["cci_momentum"] = (_p_cci < 100) & (_cci_arr >= 100)

    # MFI > 50: money is flowing into the stock (volume-weighted buying pressure)
    merged["mfi_strong"] = _mfi_arr > 50

    # ── Candlestick filters (compute numpy arrays once; reuse for ichimoku) ──
    _open_arr = merged["open"].to_numpy(dtype=float)
    _high_arr = merged["high"].to_numpy(dtype=float)
    body = np.abs(_close_arr - _open_arr)
    upper_shadow = _high_arr - np.maximum(_close_arr, _open_arr)

    # Price above Ichimoku cloud: bullish cloud confirmation (close > both senkou spans)
    cloud_top = np.fmax(merged["ichi_senkou_a"].to_numpy(), merged["ichi_senkou_b"].to_numpy())
    merged["above_ichimoku_cloud"] = _close_arr > cloud_top
    _prev_close_arr = merged["prev_close"].to_numpy(dtype=float)
    _prev_vol_ratio_arr = merged["prev_volume_ratio"].to_numpy(dtype=float)
    merged["long_upper_shadow"] = (body > 0) & (upper_shadow > body * 2)
    merged["open_high_close_low"] = (
        (_open_arr > _prev_close_arr * 1.02)
        & (_close_arr < _open_arr)
    )
    merged["gap_chase_after_blowout"] = (
        (_prev_vol_ratio_arr > config.volume_multiplier)
        & ((_open_arr / _prev_close_arr) - 1 > 0.03)
    )
    merged["earnings_blocked"] = _build_earnings_blocker(
        pd.DatetimeIndex(merged["date"]), earnings_dates, config,
    ).values

    # Compute entry condition array once — shared for condition_count, entry_signal, and reason labels
    _entry_arr = merged[_ENTRY_COLS].to_numpy(dtype=bool)
    _cond_count = _entry_arr.sum(axis=1)
    merged["condition_count"] = _cond_count

    merged["skip_trade"] = (
        merged["long_upper_shadow"] | merged["open_high_close_low"]
        | merged["gap_chase_after_blowout"] | merged["earnings_blocked"]
    )
    _n_hard = len(_HARD_ENTRY_COLS)
    merged["entry_signal"] = _entry_arr[:, :_n_hard].all(axis=1) & ~merged["skip_trade"].to_numpy(dtype=bool)

    _soft_matrix = merged[_SOFT_SCORE_COLS].to_numpy(dtype=np.float64)
    _rs5d = _rs5d_arr.copy(); np.nan_to_num(_rs5d, nan=-99.0, copy=False)
    _vol_ratio = _vr_arr.copy(); np.nan_to_num(_vol_ratio, nan=0.0, copy=False)
    _adx14 = _adx_arr.copy(); np.nan_to_num(_adx14, nan=0.0, copy=False)
    merged["entry_score"] = (
        _cond_count.astype(np.float64) * 100
        + _rs5d * 100
        + _vol_ratio * 10
        + _adx14
        + _soft_matrix @ _SOFT_SCORE_WEIGHTS
    )

    merged["macd_death_cross"] = (
        (_p_macd >= _p_macd_sig)
        & (_macd_arr < _macd_sig_arr)
    )
    merged["close_below_ema20"] = _close_arr < _ema20_arr
    merged["close_below_swing_low"] = _close_arr < _s10d_arr
    merged["base_exit_signal"] = (
        merged["macd_death_cross"] | merged["close_below_ema20"] | merged["close_below_swing_low"]
    )

    _skip_arr = merged[_SKIP_COLS].to_numpy(dtype=bool)
    _exit_arr = merged[_EXIT_COLS].to_numpy(dtype=bool)

    def _sparse_reasons(arr: np.ndarray, labels: np.ndarray) -> list[str]:
        result = [""] * len(arr)
        for i in np.where(arr.any(axis=1))[0]:
            result[i] = ", ".join(labels[arr[i]])
        return result

    merged["entry_reason"] = _sparse_reasons(_entry_arr, _ENTRY_COLS_ARR)
    merged["skip_reason"] = _sparse_reasons(_skip_arr, _SKIP_COLS_ARR)
    merged["base_exit_reason"] = _sparse_reasons(_exit_arr, _EXIT_COLS_ARR)
    return merged


def compute_market_breadth(snapshot: pd.DataFrame) -> dict[str, object]:
    if snapshot.empty:
        return {}
    total = len(snapshot)
    result: dict[str, object] = {"total_stocks": total}
    available = [c for c in _BREADTH_COLS if c in snapshot.columns]
    if available:
        pcts = (snapshot[available].fillna(False).sum() / total * 100).astype(int)
        result.update(pcts.to_dict())
    entry_count = int(snapshot["entry_signal"].sum()) if "entry_signal" in snapshot.columns else 0
    result["entry_signal_count"] = entry_count
    result["entry_signal_pct"] = int(entry_count / total * 100)
    return result


def latest_signal_snapshot(signals_by_stock: dict[str, pd.DataFrame]) -> pd.DataFrame:
    last_rows = [frame.iloc[[-1]] for frame in signals_by_stock.values() if not frame.empty]
    if not last_rows:
        return pd.DataFrame()
    return pd.concat(last_rows, ignore_index=True).sort_values(
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

    candidate_columns = [c for c in _CANDIDATE_COLS if c in snapshot.columns]
    watch_columns = [c for c in _WATCH_COLS if c in snapshot.columns]

    if prefer_lower_price:
        candidates = candidates.sort_values(["condition_count", "close", "entry_score"], ascending=[False, True, False]).head(top_n)
        watchlist = watchlist.sort_values(["condition_count", "close", "entry_score"], ascending=[False, True, False]).head(top_n)
    else:
        candidates = candidates.sort_values(["entry_score", "condition_count"], ascending=[False, False]).head(top_n)
        watchlist = watchlist.sort_values(["condition_count", "entry_score"], ascending=[False, False]).head(top_n)
    return candidates[candidate_columns], watchlist[watch_columns]
