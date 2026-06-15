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
    "macd_golden_cross", "above_ema60", "ema60_gt_ema120",
    "volume_break", "rsi_strong", "breakout_20d", "market_above_ma60",
    "avoid_chase", "liquidity_ok",
]
_SOFT_ENTRY_COLS = [
    "hist_turn_positive",                                          # 原硬條件，降為軟條件
    "foreign_buy_3d", "adx_trending", "stronger_than_market",
    "kd_golden_cross", "obv_uptrend", "invest_trust_buy_2d",
    "dealer_buy_3d", "bb_squeeze_breakout", "breakout_volume_confirm",
    "williams_r_recovery", "cci_momentum",
    "mfi_strong", "above_ichimoku_cloud",
]
_ENTRY_COLS = _HARD_ENTRY_COLS + _SOFT_ENTRY_COLS
_ENTRY_COLS_ARR = np.array(_ENTRY_COLS)
_SKIP_COLS = ["long_upper_shadow", "open_high_close_low", "gap_chase_after_blowout", "earnings_blocked", "f_score_low"]
_SKIP_COLS_ARR = np.array(_SKIP_COLS)
_EXIT_COLS = ["macd_death_cross", "close_below_ema20", "close_below_swing_low"]
_EXIT_COLS_ARR = np.array(_EXIT_COLS)

# Weights for the boolean part of entry_score (order matches _SOFT_ENTRY_COLS)
_SOFT_SCORE_COLS = [
    "foreign_buy_3d", "invest_trust_buy_2d", "dealer_buy_3d",
    "hist_turn_positive",
    "kd_golden_cross", "obv_uptrend", "adx_trending", "stronger_than_market",
    "bb_squeeze_breakout", "breakout_volume_confirm",
    "williams_r_recovery", "cci_momentum", "mfi_strong", "above_ichimoku_cloud",
    "ma5_above_ma10",
]
_SOFT_SCORE_WEIGHTS = np.array([30, 35, 15, 25, 20, 15, 15, 10, 30, 20, 15, 15, 10, 20, 15], dtype=np.float64)

_BREADTH_COLS = [
    "above_ema60", "ema60_gt_ema120", "market_above_ma60",
    "macd_golden_cross", "hist_turn_positive", "volume_break", "rsi_strong", "breakout_20d",
    "foreign_buy_3d", "adx_trending", "stronger_than_market",
    "kd_golden_cross", "obv_uptrend", "invest_trust_buy_2d",
    "dealer_buy_3d", "mfi_strong", "above_ichimoku_cloud",
]
_CANDIDATE_COLS = [
    "date", "stock_id", "name", "industry_category", "close",
    "condition_count", "entry_score", "momentum_score", "rsi14", "adx14", "atr14",
    "volume_ratio", "volume_ma20", "return_5d", "relative_strength_5d",
    "foreign_buy_streak", "invest_trust_streak", "dealer_buy_streak",
    "stoch_k", "stoch_d",
    "bb_pct_b", "bb_bandwidth", "obv_uptrend",
    "bb_squeeze_breakout", "breakout_volume_confirm",
    "mfi14", "mfi_strong", "above_ichimoku_cloud",
    "close_10d_low",
    "lr_slope_20", "lr_slope_60",
    "f_score",
    "revenue_yoy", "revenue_mom", "revenue_3m_yoy",
    "kd_level_score", "bb_level_signal",
    "gap_to_20d_high_pct", "breakout_proximity_score",
    "obv_strength", "foreign_buy_accel", "invest_trust_accel",
    "expected_hold_days", "momentum_decay_signal", "estimated_sl_days",
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
    f_score_min: int = 0                  # Minimum Piotroski F-Score (0 = disabled, 6 = recommended)


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
    f_score: int = -1,
    margin_df: pd.DataFrame | None = None,
    revenue_df: pd.DataFrame | None = None,
    shareholding_df: pd.DataFrame | None = None,
    insider_df: pd.DataFrame | None = None,
    buyback_ids: set | None = None,
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
    _vma20 = frame["volume_ma20"].to_numpy(dtype=float)
    _vr = np.nan_to_num(frame["volume"].to_numpy(dtype=float) / np.where(_vma20 > 0, _vma20, np.nan), nan=1.0)
    _pvr = np.empty_like(_vr); _pvr[0] = np.nan; _pvr[1:] = _vr[:-1]
    frame["return_5d"] = _r5d
    frame["day_return"] = _dr
    frame["prev_close"] = _pc
    frame["prev_volume_ratio"] = _pvr

    _bb = add_bollinger_bands(frame["close"], config.bb_period, config.bb_std)
    frame[_bb.columns] = _bb.values
    _stoch = add_stochastic(frame["high"], frame["low"], frame["close"], config.kd_k_period, config.kd_d_period)
    frame[_stoch.columns] = _stoch.values
    frame["sma5"]  = add_sma(frame["close"], 5)
    frame["sma10"] = add_sma(frame["close"], 10)
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

    # ── 融資餘額 ──────────────────────────────────────────────────────────────
    _margin_chg_5d = 0.0
    _short_ratio_val = 0.0
    if margin_df is not None and not margin_df.empty and "stock_id" in margin_df.columns:
        _sid_str = str(stock_info.get("stock_id", ""))
        _stk_mg = margin_df[margin_df["stock_id"].astype(str) == _sid_str].sort_values("date")
        if len(_stk_mg) >= 2 and "MarginPurchaseTodayBalance" in _stk_mg.columns:
            _mg_latest = float(_stk_mg["MarginPurchaseTodayBalance"].iloc[-1])
            _mg_prev5 = float(_stk_mg["MarginPurchaseTodayBalance"].iloc[max(0, len(_stk_mg) - 6)])
            _margin_chg_5d = round((_mg_latest - _mg_prev5) / max(_mg_prev5, 1) * 100, 2) if _mg_prev5 > 0 else 0.0
            if "ShortSaleTodayBalance" in _stk_mg.columns:
                _short_bal = float(_stk_mg["ShortSaleTodayBalance"].iloc[-1])
                _short_ratio_val = round(_short_bal / max(_mg_latest, 1) * 100, 2) if _mg_latest > 0 else 0.0
    merged["margin_change_5d"] = _margin_chg_5d
    merged["short_ratio"] = _short_ratio_val

    # ── 月營收 YoY/MoM/3m-YoY ────────────────────────────────────────────────
    _revenue_yoy = 0.0
    _revenue_mom = 0.0
    _revenue_3m_yoy = 0.0
    if revenue_df is not None and not revenue_df.empty and "stock_id" in revenue_df.columns:
        _sid_str = str(stock_info.get("stock_id", ""))
        _stk_rev = revenue_df[revenue_df["stock_id"].astype(str) == _sid_str].sort_values("date")
        if not _stk_rev.empty:
            _latest_rev = float(_stk_rev["revenue"].iloc[-1])
            _latest_rev_date = pd.Timestamp(_stk_rev["date"].iloc[-1])
            # YoY: same month one year ago (±31-day tolerance)
            _yoy_target = _latest_rev_date - pd.DateOffset(years=1)
            _yoy_window = _stk_rev[
                (_stk_rev["date"] >= _yoy_target - pd.Timedelta(days=15)) &
                (_stk_rev["date"] <= _yoy_target + pd.Timedelta(days=31))
            ]
            if not _yoy_window.empty:
                _yoy_rev = float(_yoy_window["revenue"].iloc[-1])
                if _yoy_rev > 0:
                    _revenue_yoy = round((_latest_rev - _yoy_rev) / _yoy_rev, 4)
            # MoM: previous month
            if len(_stk_rev) >= 2:
                _prev_rev = float(_stk_rev["revenue"].iloc[-2])
                if _prev_rev > 0:
                    _revenue_mom = round((_latest_rev - _prev_rev) / _prev_rev, 4)
            # 3-month cumulative YoY
            if len(_stk_rev) >= 3:
                _3m_sum = float(_stk_rev["revenue"].iloc[-3:].sum())
                _3m_start_date = pd.Timestamp(_stk_rev["date"].iloc[-3])
                _yoy_3m_start = _3m_start_date - pd.DateOffset(years=1) - pd.Timedelta(days=15)
                _yoy_3m_end = _latest_rev_date - pd.DateOffset(years=1) + pd.Timedelta(days=31)
                _yoy_3m_data = _stk_rev[
                    (_stk_rev["date"] >= _yoy_3m_start) &
                    (_stk_rev["date"] <= _yoy_3m_end)
                ]
                if len(_yoy_3m_data) >= 3:
                    _3m_yoy_sum = float(_yoy_3m_data["revenue"].iloc[-3:].sum())
                    if _3m_yoy_sum > 0:
                        _revenue_3m_yoy = round((_3m_sum - _3m_yoy_sum) / _3m_yoy_sum, 4)
    merged["revenue_yoy"] = _revenue_yoy
    merged["revenue_mom"] = _revenue_mom
    merged["revenue_3m_yoy"] = _revenue_3m_yoy

    # ── 外資持股比例 5 日變化 ─────────────────────────────────────────────────
    _foreign_holding_pct = 0.0
    _foreign_holding_chg5d = 0.0
    if shareholding_df is not None and not shareholding_df.empty and "stock_id" in shareholding_df.columns:
        _sid_str = str(stock_info.get("stock_id", ""))
        _stk_sh = shareholding_df[shareholding_df["stock_id"].astype(str) == _sid_str].sort_values("date")
        if len(_stk_sh) >= 2:
            _latest_pct = float(_stk_sh["ForeignInvestmentSharesRatio"].iloc[-1])
            _prev5_pct = float(_stk_sh["ForeignInvestmentSharesRatio"].iloc[max(0, len(_stk_sh) - 6)])
            _foreign_holding_pct = round(_latest_pct, 2)
            _foreign_holding_chg5d = round(_latest_pct - _prev5_pct, 2)
    merged["foreign_holding_pct"] = _foreign_holding_pct
    merged["foreign_holding_chg5d"] = _foreign_holding_chg5d

    # ── 董監持股異動（近 30 天淨買股數）────────────────────────────────────────
    _insider_net_30d = 0
    if insider_df is not None and not insider_df.empty and "stock_id" in insider_df.columns:
        _sid_str = str(stock_info.get("stock_id", ""))
        _stk_ins = insider_df[insider_df["stock_id"].astype(str) == _sid_str]
        if not _stk_ins.empty and "net_buy_amount" in _stk_ins.columns:
            _insider_net_30d = int(_stk_ins["net_buy_amount"].sum())
    merged["insider_net_30d"] = _insider_net_30d

    # ── 庫藏股買回 ───────────────────────────────────────────────────────────
    _sid_str = str(stock_info.get("stock_id", ""))
    _has_buyback = (buyback_ids is not None) and (_sid_str in buyback_ids)
    merged["has_buyback"] = _has_buyback

    # ── 跌停連續天數 ──────────────────────────────────────────────────────────
    # Taiwan daily limit ≈ 10%; use -9.5% threshold to account for rounding
    _dr_np = np.nan_to_num(merged["day_return"].to_numpy(dtype=float), nan=0.0)
    _is_ld = _dr_np <= -0.095
    _ld_streak = np.zeros(len(merged), dtype=np.int32)
    for _i in range(1, len(merged)):
        _ld_streak[_i] = (_ld_streak[_i - 1] + 1) if _is_ld[_i] else 0
    merged["limit_down_streak"] = _ld_streak

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
    _safe_vma20 = np.where(_vma20_arr > 0, _vma20_arr, np.nan)
    _vr_arr = np.nan_to_num(_vol_arr / _safe_vma20, nan=1.0)

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

    # MA5 above MA10: short-term trend confirmation (5-day SMA crossed above 10-day SMA)
    _sma5_arr  = merged["sma5"].to_numpy(dtype=float)
    _sma10_arr = merged["sma10"].to_numpy(dtype=float)
    merged["ma5_above_ma10"] = _sma5_arr > _sma10_arr

    # ── 新增評分信號（加法，不改現有欄位）────────────────────────────────────────
    # KD 梯度：超賣加分，超買扣分（比單純黃金交叉更細膩）
    merged["kd_level_score"] = np.where(
        _stoch_k_arr < 20, 20.0,
        np.where(_stoch_k_arr < 30, 10.0,
        np.where(_stoch_k_arr < 70,  0.0,
        np.where(_stoch_k_arr < 80, -10.0, -20.0))))

    # BB%B 梯度：下緣（超賣）加分，上緣（超買）扣分
    _bb_pct_b_arr = merged["bb_pct_b"].to_numpy(dtype=float)
    merged["bb_level_signal"] = np.where(
        _bb_pct_b_arr < 0.1, 25.0,
        np.where(_bb_pct_b_arr < 0.2, 12.0,
        np.where(_bb_pct_b_arr < 0.8,  0.0,
        np.where(_bb_pct_b_arr < 0.9, -12.0, -25.0))))

    # 距 20 日高點百分比：越接近突破點，趨勢訊號越強
    _safe_close_h20 = np.where(_close_arr > 0, _close_arr, np.nan)
    _gap_20d = np.nan_to_num(
        np.where(_h20_arr > 0, (_h20_arr - _close_arr) / _safe_close_h20 * 100, 999.0),
        nan=999.0,
    )
    merged["gap_to_20d_high_pct"] = _gap_20d
    merged["breakout_proximity_score"] = np.where(
        _gap_20d < 1.0, 25.0,
        np.where(_gap_20d < 2.0, 15.0,
        np.where(_gap_20d < 3.5,  8.0, 0.0)))

    # OBV 強度：OBV 偏離 MA 的 z-score（用 60 日滾動標準差正規化，封頂 ±2σ）
    _obv_diff = _obv_arr - _obv_ma_arr
    _obv_std_arr = pd.Series(_obv_arr).rolling(60, min_periods=20).std().to_numpy()
    _safe_obv_std = np.where(_obv_std_arr > 0, _obv_std_arr, np.nan)
    merged["obv_strength"] = np.clip(
        np.nan_to_num(_obv_diff / _safe_obv_std, nan=0.0), -2.0, 2.0
    )

    # 籌碼加速度：外資/投信連買天數今日比昨日多（籌碼強化中）
    _fb_prev = np.empty(_n, dtype=float); _fb_prev[0] = 0.0; _fb_prev[1:] = _fb_streak[:-1]
    _it_prev = np.empty(_n, dtype=float); _it_prev[0] = 0.0; _it_prev[1:] = _it_streak[:-1]
    merged["foreign_buy_accel"] = (_fb_streak > _fb_prev) & (_fb_streak >= 2)
    merged["invest_trust_accel"] = (_it_streak > _it_prev) & (_it_streak >= 2)

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

    # F-Score: constant per stock; -1 means "no data" (never blocks)
    merged["f_score"] = f_score
    f_score_blocked = (config.f_score_min > 0) and (f_score != -1) and (f_score < config.f_score_min)
    merged["f_score_low"] = f_score_blocked

    # Compute entry condition array once — shared for condition_count, entry_signal, and reason labels
    _entry_arr = merged[_ENTRY_COLS].to_numpy(dtype=bool)
    _cond_count = _entry_arr.sum(axis=1)
    merged["condition_count"] = _cond_count

    merged["skip_trade"] = (
        merged["long_upper_shadow"] | merged["open_high_close_low"]
        | merged["gap_chase_after_blowout"] | merged["earnings_blocked"]
        | merged["f_score_low"]
    )
    _n_hard = len(_HARD_ENTRY_COLS)
    merged["entry_signal"] = _entry_arr[:, :_n_hard].all(axis=1) & ~merged["skip_trade"].to_numpy(dtype=bool)

    _soft_matrix = merged[_SOFT_SCORE_COLS].to_numpy(dtype=np.float64)
    # posinf/neginf must be handled explicitly — nan_to_num only replaces NaN
    # when nan= is specified. DR stocks with near-zero base price can produce
    # inf return_5d, which propagates to entry_score as inf.
    _rs5d = _rs5d_arr.copy(); np.nan_to_num(_rs5d, nan=-99.0, posinf=10.0, neginf=-99.0, copy=False)
    _vol_ratio = _vr_arr.copy(); np.nan_to_num(_vol_ratio, nan=0.0, posinf=50.0, neginf=0.0, copy=False)
    _adx14 = _adx_arr.copy(); np.nan_to_num(_adx14, nan=0.0, posinf=100.0, neginf=0.0, copy=False)
    _rsi14 = _rsi_arr.copy(); np.nan_to_num(_rsi14, nan=50.0, posinf=100.0, neginf=0.0, copy=False)

    # ── 1. 硬性條件：× 60（上限 540），避免技術條件數量主宰模型 ──────────────
    _hard_score = _cond_count.astype(np.float64) * 60

    # ── 2. 相對大盤強度：分段計分（上限 100），替代不穩定的連續乘法 ──────────
    _rs_score = np.where(_rs5d > 0.10, 100.0,
                np.where(_rs5d > 0.05,  70.0,
                np.where(_rs5d > 0.02,  40.0,
                np.where(_rs5d > 0.00,  15.0, -30.0))))

    # ── 3. 量比：封頂 5 倍（上限 50），避免爆量股無限加分 ─────────────────────
    _vol_score = np.clip(_vol_ratio, 0.0, 5.0) * 10.0

    # ── 4. ADX：分段計分（上限 40），移除原始值直接加分避免重複 ──────────────
    _adx_score = np.where(_adx14 > 35, 40.0,
                 np.where(_adx14 > 25, 25.0,
                 np.where(_adx14 > 20, 10.0, 0.0)))

    # ── 5. 基本面加成 ──────────────────────────────────────────────────────────
    _f_bonus = 50.0 if f_score >= 7 else (25.0 if f_score >= 5 else 0.0)

    # ── 6. 融資籌碼加成 ────────────────────────────────────────────────────────
    _margin_bonus = 25.0 if _margin_chg_5d < -3.0 else (10.0 if _margin_chg_5d < -1.0 else 0.0)

    # ── 7. 月營收加成 ──────────────────────────────────────────────────────────
    _revenue_bonus = (
        40.0 if _revenue_yoy > 0.10 else
        (20.0 if _revenue_yoy > 0.00 else
         (-30.0 if _revenue_yoy < -0.10 else 0.0))
    )

    # ── 8a. 外資持股 5 日變化加成 ─────────────────────────────────────────────
    _fh_chg = _foreign_holding_chg5d
    _fh_bonus = 20.0 if _fh_chg > 1.0 else (10.0 if _fh_chg > 0.3 else (-15.0 if _fh_chg < -1.0 else 0.0))

    # ── 8b. 董監近 30 天淨買加成 ──────────────────────────────────────────────
    _insider_bonus = (
        20.0 if _insider_net_30d > 500_000 else
        (10.0 if _insider_net_30d > 100_000 else
         (-15.0 if _insider_net_30d < -500_000 else 0.0))
    )

    # ── 8c. 庫藏股護盤加成 ────────────────────────────────────────────────────
    _buyback_bonus = 15.0 if _has_buyback else 0.0

    # ── 9. 風險扣分 ────────────────────────────────────────────────────────────
    # RSI 過熱：已追高，短線回檔風險高
    _rsi_penalty = np.where(_rsi14 > 90, -80.0,
                   np.where(_rsi14 > 85, -60.0, 0.0))
    # MA20 乖離過大：避免追高（close 距離 EMA20 > 15%）
    _safe_ema20 = np.where(_ema20_arr > 0, _ema20_arr, np.nan)
    _dist_ma20 = np.nan_to_num((_close_arr - _safe_ema20) / _safe_ema20, nan=0.0)
    _dist_penalty = np.where(_dist_ma20 > 0.25, -60.0,
                    np.where(_dist_ma20 > 0.15, -40.0, 0.0))
    # 爆量長上影：放量卻收黑，出貨訊號
    _blowout_penalty = np.where(
        (merged["long_upper_shadow"].to_numpy(dtype=bool)) & (_vol_ratio > 2.0),
        -50.0, 0.0,
    )
    # 融資暴增：散戶追買，籌碼不乾淨
    _margin_chg_penalty = -40.0 if _margin_chg_5d > 20.0 else 0.0

    # ── 10. 新增梯度加成（純加法，不改現有邏輯）──────────────────────────────────
    _kd_bonus  = merged["kd_level_score"].to_numpy(dtype=float)
    _bb_bonus  = merged["bb_level_signal"].to_numpy(dtype=float)
    _bp_bonus  = merged["breakout_proximity_score"].to_numpy(dtype=float)
    # OBV z-score [-2,2] × 12 → 最多 ±24 分
    _obv_bonus = merged["obv_strength"].to_numpy(dtype=float) * 12.0
    # 籌碼加速：外資或投信連買天數今日增加 → +20 分（主力持續進場訊號）
    _accel_bonus = np.where(
        merged["foreign_buy_accel"].to_numpy(dtype=bool)
        | merged["invest_trust_accel"].to_numpy(dtype=bool),
        20.0, 0.0,
    )

    merged["entry_score"] = (
        _hard_score
        + _rs_score
        + _vol_score
        + _adx_score
        + _soft_matrix @ _SOFT_SCORE_WEIGHTS
        + _f_bonus
        + _margin_bonus
        + _revenue_bonus
        + _fh_bonus
        + _insider_bonus
        + _buyback_bonus
        + _rsi_penalty
        + _dist_penalty
        + _blowout_penalty
        + _margin_chg_penalty
        + _kd_bonus
        + _bb_bonus
        + _bp_bonus
        + _obv_bonus
        + _accel_bonus
    )

    # Momentum score (0-100): 量能 40% + 波動度 30% + 尾盤強度 30%
    _atr_arr = merged["atr14"].to_numpy(dtype=float)
    _vol_comp  = np.clip((_vr_arr - 1.0) * 50, 0, 100)          # volume ratio, centered at 1x
    _safe_close = np.where(_close_arr > 0, _close_arr, np.nan)
    _atr_pct   = np.nan_to_num(_atr_arr / _safe_close * 100, nan=0.0)
    _volat_comp = np.clip(_atr_pct * 5, 0, 100)                  # ATR% proxy for volatility
    _tail_comp  = np.clip((_rs5d_arr * 100 + 5) * 5, 0, 100)    # relative strength vs market
    merged["momentum_score"] = (
        _vol_comp * 0.40 + _volat_comp * 0.30 + _tail_comp * 0.30
    ).round(1)

    # ── 持股期間預測（純新增欄位，供出場參考）────────────────────────────────────
    # ADX + ATR 決定「強度×波動度」組合，估算最佳持股天數
    _atr_pct_h = np.nan_to_num(_atr_arr / np.where(_close_arr > 0, _close_arr, np.nan) * 100, nan=0.0)
    _hold_est = np.where((_adx14 > 30) & (_atr_pct_h > 2.0), 10,
                np.where((_adx14 > 25) & (_vr_arr > 1.8), 8,
                np.where(_adx14 > 20, 5, 3)))
    _hold_est = np.where(_atr_pct_h > 3.0, np.maximum(3, _hold_est - 2), _hold_est)
    _hold_est = np.where(_rs5d_arr > 0.05, _hold_est + 2, _hold_est)
    merged["expected_hold_days"] = _hold_est.astype(np.int32)

    # 動能衰減預警：5 日平均動能 > 2 日平均動能 = 近期強、最新開始弱
    _mom_2d = pd.Series(_rs5d_arr).rolling(2, min_periods=1).mean().to_numpy()
    _mom_5d = pd.Series(_rs5d_arr).rolling(5, min_periods=1).mean().to_numpy()
    merged["momentum_decay_signal"] = (_mom_5d > _mom_2d) & (_mom_5d > 0.02)

    # ATR 止損觸發預估天數（按 config.atr_stop_multiplier×ATR 止損距離÷日均波動估算）
    _sl_dist = _atr_arr * config.atr_stop_multiplier
    _daily_vol_est = np.where(_atr_arr > 0, _atr_arr / 1.5, np.nan)
    merged["estimated_sl_days"] = np.clip(
        np.nan_to_num(_sl_dist / _daily_vol_est, nan=20.0), 1, 20
    ).astype(np.int32)

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
    if _margin_chg_5d > 5.0:
        merged["skip_reason"] = merged["skip_reason"].apply(
            lambda x: (x + ", 融資暴增") if x else "融資暴增"
        )
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
