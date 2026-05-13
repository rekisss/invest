from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from indicators import add_adx, add_ema, add_macd, add_rsi, add_sma, consecutive_positive


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


def prepare_market_frame(market_df: pd.DataFrame, config: StrategyConfig) -> pd.DataFrame:
    market = market_df.copy()
    market = market.sort_values("date").reset_index(drop=True)
    market["market_ma60"] = add_sma(market["close"], config.market_ma_window)
    market["market_above_ma60"] = market["close"] > market["market_ma60"]
    market["market_return_5d"] = market["close"].pct_change(config.relative_strength_window)
    return market


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
        blocked_dates = prior_index[-config.earnings_lookback_days:]
        blocked.loc[blocked_dates] = True
    return blocked


def prepare_stock_signals(
    stock_info: dict[str, str],
    stock_df: pd.DataFrame,
    market_df: pd.DataFrame,
    foreign_df: pd.DataFrame,
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
    frame["volume_ma20"] = add_sma(frame["volume"], config.volume_ma_window)
    frame["amount_ma20"] = add_sma(frame["amount"], 20)
    frame["close_20d_high"] = frame["close"].rolling(config.breakout_window).max().shift(1)
    frame["close_10d_low"] = frame["close"].rolling(config.swing_low_window).min().shift(1)
    frame["return_5d"] = frame["close"].pct_change(config.relative_strength_window)
    frame["day_return"] = frame["close"].pct_change(1)
    frame["prev_close"] = frame["close"].shift(1)
    frame["prev_volume_ratio"] = (frame["volume"] / frame["volume_ma20"]).shift(1)

    foreign_data_missing = foreign_df.empty
    foreign = foreign_df.copy()
    if foreign.empty:
        foreign = pd.DataFrame({"date": frame["date"], "foreign_net": 0})
    foreign = foreign.sort_values("date").drop_duplicates(subset=["date"])
    foreign["foreign_buy_streak"] = consecutive_positive(foreign["foreign_net"])

    merged = frame.merge(
        market_df[["date", "market_ma60", "market_above_ma60", "market_return_5d"]],
        on="date",
        how="left",
    ).merge(
        foreign[["date", "foreign_net", "foreign_buy_streak"]],
        on="date",
        how="left",
    )

    merged["foreign_net"] = merged["foreign_net"].fillna(0)
    merged["foreign_buy_streak"] = merged["foreign_buy_streak"].fillna(0)
    merged["relative_strength_5d"] = merged["return_5d"] - merged["market_return_5d"]

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
    merged["foreign_buy_3d"] = merged["foreign_buy_streak"] >= config.foreign_buy_streak
    if foreign_data_missing:
        merged["foreign_buy_3d"] = False
    merged["avoid_chase"] = merged["return_5d"] < config.max_recent_rise_pct
    merged["liquidity_ok"] = merged["amount_ma20"] > config.min_amount_ma20
    merged["stronger_than_market"] = merged["relative_strength_5d"] > 0

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
        merged.set_index("date").index,
        earnings_dates,
        config,
    ).values

    hard_entry_columns = [
        "macd_golden_cross",
        "hist_turn_positive",
        "above_ema60",
        "ema60_gt_ema120",
        "volume_break",
        "rsi_strong",
        "breakout_20d",
        "market_above_ma60",
        "avoid_chase",
        "liquidity_ok",
    ]
    soft_entry_columns = [
        "foreign_buy_3d",
        "adx_trending",
        "stronger_than_market",
    ]
    entry_columns = hard_entry_columns + soft_entry_columns
    merged["condition_count"] = merged[entry_columns].sum(axis=1)

    merged["skip_trade"] = (
        merged["long_upper_shadow"]
        | merged["open_high_close_low"]
        | merged["gap_chase_after_blowout"]
        | merged["earnings_blocked"]
    )
    merged["entry_signal"] = merged[hard_entry_columns].all(axis=1) & ~merged["skip_trade"]
    merged["entry_score"] = (
        merged["condition_count"] * 100
        + merged["relative_strength_5d"].fillna(-99) * 100
        + merged["volume_ratio"].fillna(0) * 10
        + merged["adx14"].fillna(0)
        + merged["foreign_buy_3d"].astype(int) * 25
        + merged["adx_trending"].astype(int) * 20
        + merged["stronger_than_market"].astype(int) * 15
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

    def _build_all_reasons(row: pd.Series) -> pd.Series:
        return pd.Series({
            "entry_reason": ", ".join(c for c in entry_columns if bool(row[c])),
            "skip_reason": ", ".join(c for c in _skip_cols if bool(row[c])),
            "base_exit_reason": ", ".join(c for c in _exit_cols if bool(row[c])),
        })

    merged[["entry_reason", "skip_reason", "base_exit_reason"]] = merged.apply(_build_all_reasons, axis=1)

    return merged


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
        "date",
        "stock_id",
        "name",
        "industry_category",
        "close",
        "condition_count",
        "entry_score",
        "rsi14",
        "adx14",
        "volume_ratio",
        "volume_ma20",
        "return_5d",
        "relative_strength_5d",
        "foreign_buy_streak",
        "entry_reason",
        "skip_reason",
    ]
    watch_columns = [
        "date",
        "stock_id",
        "name",
        "industry_category",
        "close",
        "condition_count",
        "entry_score",
        "volume_ma20",
        "skip_reason",
        "entry_reason",
    ]

    if prefer_lower_price:
        candidates = candidates.sort_values(
            ["condition_count", "close", "entry_score"],
            ascending=[False, True, False],
        ).head(top_n)
        watchlist = watchlist.sort_values(
            ["condition_count", "close", "entry_score"],
            ascending=[False, True, False],
        ).head(top_n)
    else:
        candidates = candidates.sort_values(["entry_score", "condition_count"], ascending=[False, False]).head(top_n)
        watchlist = watchlist.sort_values(["condition_count", "entry_score"], ascending=[False, False]).head(top_n)
    return candidates[candidate_columns], watchlist[watch_columns]
