from __future__ import annotations

import numpy as np
import pandas as pd


def add_ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def add_sma(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window=window, min_periods=window).mean()


def add_macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    ema_fast = add_ema(close, fast)
    ema_slow = add_ema(close, slow)
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    hist = macd_line - signal_line
    return pd.DataFrame({"macd": macd_line, "macd_signal": signal_line, "macd_hist": hist})


def add_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi.fillna(100).where(avg_gain.notna() | avg_loss.notna())


def add_adx(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = pd.Series(np.where((up_move > down_move) & (up_move > 0), up_move, 0.0), index=high.index)
    minus_dm = pd.Series(np.where((down_move > up_move) & (down_move > 0), down_move, 0.0), index=high.index)
    _pc = close.shift(1)
    tr = pd.Series(
        np.fmax(np.fmax((high - low).to_numpy(), (high - _pc).abs().to_numpy()), (low - _pc).abs().to_numpy()),
        index=high.index,
    )
    atr = tr.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    plus_di = 100 * plus_dm.ewm(alpha=1 / period, min_periods=period, adjust=False).mean() / atr
    minus_di = 100 * minus_dm.ewm(alpha=1 / period, min_periods=period, adjust=False).mean() / atr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()


def add_bollinger_bands(close: pd.Series, window: int = 20, num_std: float = 2.0) -> pd.DataFrame:
    sma = close.rolling(window=window, min_periods=window).mean()
    std = close.rolling(window=window, min_periods=window).std(ddof=0)
    upper = sma + num_std * std
    lower = sma - num_std * std
    band_width = (upper - lower).replace(0, np.nan)
    pct_b = (close - lower) / band_width
    bandwidth = band_width / sma.replace(0, np.nan)
    return pd.DataFrame({"bb_upper": upper, "bb_mid": sma, "bb_lower": lower, "bb_pct_b": pct_b, "bb_bandwidth": bandwidth})


def add_stochastic(high: pd.Series, low: pd.Series, close: pd.Series, k_period: int = 9, d_period: int = 3) -> pd.DataFrame:
    lowest_low = low.rolling(window=k_period, min_periods=k_period).min()
    highest_high = high.rolling(window=k_period, min_periods=k_period).max()
    hh_ll = (highest_high - lowest_low).replace(0, np.nan)
    k = 100 * (close - lowest_low) / hh_ll
    d = k.rolling(window=d_period, min_periods=d_period).mean()
    return pd.DataFrame({"stoch_k": k, "stoch_d": d})


def add_obv(close: pd.Series, volume: pd.Series) -> pd.Series:
    direction = np.sign(close.diff()).fillna(0)
    return (direction * volume).cumsum()


def add_atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    _pc = close.shift(1)
    tr = pd.Series(
        np.fmax(np.fmax((high - low).to_numpy(), (high - _pc).abs().to_numpy()), (low - _pc).abs().to_numpy()),
        index=high.index,
    )
    return tr.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()


def add_adx_atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.DataFrame:
    """Compute ADX and ATR together, sharing the True Range calculation."""
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = pd.Series(np.where((up_move > down_move) & (up_move > 0), up_move, 0.0), index=high.index)
    minus_dm = pd.Series(np.where((down_move > up_move) & (down_move > 0), down_move, 0.0), index=high.index)
    _pc = close.shift(1)
    tr = pd.Series(
        np.fmax(np.fmax((high - low).to_numpy(), (high - _pc).abs().to_numpy()), (low - _pc).abs().to_numpy()),
        index=high.index,
    )
    alpha = 1 / period
    atr = tr.ewm(alpha=alpha, min_periods=period, adjust=False).mean()
    plus_di = 100 * plus_dm.ewm(alpha=alpha, min_periods=period, adjust=False).mean() / atr
    minus_di = 100 * minus_dm.ewm(alpha=alpha, min_periods=period, adjust=False).mean() / atr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx = dx.ewm(alpha=alpha, min_periods=period, adjust=False).mean()
    return pd.DataFrame({"adx14": adx, "atr14": atr})


def consecutive_positive(series: pd.Series) -> pd.Series:
    positive = (series.fillna(0) > 0)
    # Each run of non-positive values starts a new group; cumsum within group counts the streak
    group_id = (~positive).cumsum()
    return positive.astype("int64").groupby(group_id).cumsum()


def add_mfi(high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series, period: int = 14) -> pd.Series:
    typical_price = (high + low + close) / 3
    raw_money_flow = typical_price * volume
    tp_change = typical_price.diff()
    positive_mf = raw_money_flow.where(tp_change > 0, 0.0)
    negative_mf = raw_money_flow.where(tp_change < 0, 0.0)
    pos_sum = positive_mf.rolling(window=period, min_periods=period).sum()
    neg_sum = negative_mf.rolling(window=period, min_periods=period).sum()
    mfi = 100 - (100 / (1 + pos_sum / neg_sum.replace(0, np.nan)))
    return mfi.fillna(50)


def add_ichimoku(high: pd.Series, low: pd.Series, tenkan_period: int = 9, kijun_period: int = 26, senkou_b_period: int = 52) -> pd.DataFrame:
    tenkan = (high.rolling(tenkan_period).max() + low.rolling(tenkan_period).min()) / 2
    kijun = (high.rolling(kijun_period).max() + low.rolling(kijun_period).min()) / 2
    senkou_a = ((tenkan + kijun) / 2).shift(kijun_period)
    senkou_b = ((high.rolling(senkou_b_period).max() + low.rolling(senkou_b_period).min()) / 2).shift(kijun_period)
    chikou = high.shift(-kijun_period)
    return pd.DataFrame({
        "ichi_tenkan": tenkan,
        "ichi_kijun": kijun,
        "ichi_senkou_a": senkou_a,
        "ichi_senkou_b": senkou_b,
        "ichi_chikou": chikou,
    })


def add_williams_r(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    highest_high = high.rolling(window=period, min_periods=period).max()
    lowest_low = low.rolling(window=period, min_periods=period).min()
    wr = -100 * (highest_high - close) / (highest_high - lowest_low).replace(0, np.nan)
    return wr


def add_cci(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 20) -> pd.Series:
    typical_price = (high + low + close) / 3
    sma_tp = typical_price.rolling(window=period, min_periods=period).mean()
    mean_dev = typical_price.rolling(window=period, min_periods=period).apply(
        lambda x: np.mean(np.abs(x - x.mean())), raw=True
    )
    return (typical_price - sma_tp) / (0.015 * mean_dev.replace(0, np.nan))


def add_lr_slope(close: pd.Series, window: int = 20) -> pd.Series:
    """Linear regression slope on log-price, returned as % per day.

    Fully vectorized via cumsum — no Python loop per window.
    For x=[0..n-1]: slope = (n*Sxy - Sx*Sy) / (n*Sxx - Sx^2)
    """
    n = window
    log_c = np.log(close.clip(lower=1e-9).to_numpy(dtype=float))
    nan_mask = np.isnan(log_c)
    safe = np.where(nan_mask, 0.0, log_c)
    pos = np.arange(len(log_c), dtype=float)

    # Precomputed x statistics (constant for fixed window)
    Sx: float = n * (n - 1) / 2
    Sxx: float = n * (n - 1) * (2 * n - 1) / 6
    denom: float = n * Sxx - Sx ** 2

    cum_y = np.concatenate([[0.0], np.cumsum(safe)])
    cum_py = np.concatenate([[0.0], np.cumsum(pos * safe)])
    cum_nan = np.concatenate([[0], np.cumsum(nan_mask.astype(int))])

    t = np.arange(n - 1, len(log_c))
    s = t - n + 1
    has_nan = (cum_nan[t + 1] - cum_nan[s]) > 0
    Sy = cum_y[t + 1] - cum_y[s]
    Sxy = (cum_py[t + 1] - cum_py[s]) - s * Sy
    slope = np.where(has_nan, np.nan, (n * Sxy - Sx * Sy) / denom * 100)

    result = np.full(len(log_c), np.nan)
    result[n - 1:] = slope
    return pd.Series(result, index=close.index)


def add_lr_slopes(close: pd.Series, windows: tuple[int, ...] = (20, 60)) -> pd.DataFrame:
    """Compute linear-regression slopes for multiple windows in one pass.

    Shares the log/cumsum prefix computation across all requested windows.
    """
    log_c = np.log(close.clip(lower=1e-9).to_numpy(dtype=float))
    nan_mask = np.isnan(log_c)
    safe = np.where(nan_mask, 0.0, log_c)
    pos = np.arange(len(log_c), dtype=float)

    cum_y = np.concatenate([[0.0], np.cumsum(safe)])
    cum_py = np.concatenate([[0.0], np.cumsum(pos * safe)])
    cum_nan = np.concatenate([[0], np.cumsum(nan_mask.astype(int))])

    cols: dict[str, np.ndarray] = {}
    for n in windows:
        Sx: float = n * (n - 1) / 2
        Sxx: float = n * (n - 1) * (2 * n - 1) / 6
        denom: float = n * Sxx - Sx ** 2
        t = np.arange(n - 1, len(log_c))
        s = t - n + 1
        has_nan = (cum_nan[t + 1] - cum_nan[s]) > 0
        Sy = cum_y[t + 1] - cum_y[s]
        Sxy = (cum_py[t + 1] - cum_py[s]) - s * Sy
        slope = np.where(has_nan, np.nan, (n * Sxy - Sx * Sy) / denom * 100)
        result = np.full(len(log_c), np.nan)
        result[n - 1:] = slope
        cols[f"lr_slope_{n}"] = result
    return pd.DataFrame(cols, index=close.index)
