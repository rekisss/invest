from __future__ import annotations

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view


def add_ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def add_sma(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window=window, min_periods=window).mean()


def add_macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    ema_fast = add_ema(close, fast)
    ema_slow = add_ema(close, slow)
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    macd_arr = macd_line.to_numpy(dtype=float)
    sig_arr = signal_line.to_numpy(dtype=float)
    return pd.DataFrame(
        {"macd": macd_arr, "macd_signal": sig_arr, "macd_hist": macd_arr - sig_arr},
        index=close.index,
    )


def add_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = np.diff(close.to_numpy(dtype=float), prepend=np.nan)
    gain = pd.Series(np.maximum(delta, 0.0), index=close.index)
    loss = pd.Series(np.maximum(-delta, 0.0), index=close.index)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    ag = avg_gain.to_numpy(dtype=float)
    al = avg_loss.to_numpy(dtype=float)
    has_data = np.isfinite(ag) | np.isfinite(al)
    safe_al = np.where(al == 0, np.nan, al)
    rsi = 100.0 - 100.0 / (1.0 + ag / safe_al)
    rsi = np.where(np.isnan(rsi) & has_data, 100.0, rsi)
    return pd.Series(np.where(has_data, rsi, np.nan), index=close.index)


def add_adx(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    h = high.to_numpy(dtype=float)
    l = low.to_numpy(dtype=float)
    c = close.to_numpy(dtype=float)
    up = np.diff(h, prepend=np.nan)
    dn = -np.diff(l, prepend=np.nan)
    plus_dm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=high.index)
    minus_dm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=high.index)
    _pc = np.empty_like(c)
    _pc[0] = np.nan
    _pc[1:] = c[:-1]
    tr = pd.Series(np.fmax(np.fmax(h - l, np.abs(h - _pc)), np.abs(l - _pc)), index=high.index)
    alpha = 1 / period
    atr = tr.ewm(alpha=alpha, min_periods=period, adjust=False).mean()
    plus_di = 100 * plus_dm.ewm(alpha=alpha, min_periods=period, adjust=False).mean() / atr
    minus_di = 100 * minus_dm.ewm(alpha=alpha, min_periods=period, adjust=False).mean() / atr
    pdi_arr = plus_di.to_numpy(dtype=float)
    mdi_arr = minus_di.to_numpy(dtype=float)
    sum_di = pdi_arr + mdi_arr
    dx_arr = np.where(sum_di == 0, np.nan, 100 * np.abs(pdi_arr - mdi_arr) / sum_di)
    dx = pd.Series(dx_arr, index=high.index)
    return dx.ewm(alpha=alpha, min_periods=period, adjust=False).mean()


def add_bollinger_bands(close: pd.Series, window: int = 20, num_std: float = 2.0) -> pd.DataFrame:
    roller = close.rolling(window=window, min_periods=window)
    sma = roller.mean()
    std = roller.std(ddof=0)
    upper = sma + num_std * std
    lower = sma - num_std * std
    sma_arr = sma.to_numpy(dtype=float)
    upper_arr = upper.to_numpy(dtype=float)
    lower_arr = lower.to_numpy(dtype=float)
    close_arr = close.to_numpy(dtype=float)
    bw = upper_arr - lower_arr
    safe_bw = np.where(bw == 0, np.nan, bw)
    pct_b = (close_arr - lower_arr) / safe_bw
    bandwidth = safe_bw / np.where(sma_arr == 0, np.nan, sma_arr)
    return pd.DataFrame(
        {"bb_upper": upper_arr, "bb_mid": sma_arr, "bb_lower": lower_arr,
         "bb_pct_b": pct_b, "bb_bandwidth": bandwidth},
        index=close.index,
    )


def add_stochastic(high: pd.Series, low: pd.Series, close: pd.Series, k_period: int = 9, d_period: int = 3) -> pd.DataFrame:
    lowest_low = low.rolling(window=k_period, min_periods=k_period).min()
    highest_high = high.rolling(window=k_period, min_periods=k_period).max()
    hh = highest_high.to_numpy(dtype=float)
    ll = lowest_low.to_numpy(dtype=float)
    c = close.to_numpy(dtype=float)
    safe_range = np.where(hh - ll == 0, np.nan, hh - ll)
    k = pd.Series(100 * (c - ll) / safe_range, index=close.index)
    d = k.rolling(window=d_period, min_periods=d_period).mean()
    return pd.DataFrame({"stoch_k": k, "stoch_d": d})


def add_obv(close: pd.Series, volume: pd.Series) -> pd.Series:
    c = close.to_numpy(dtype=float)
    v = volume.to_numpy(dtype=float)
    direction = np.empty_like(c)
    direction[0] = 0.0
    np.sign(c[1:] - c[:-1], out=direction[1:])
    return pd.Series(np.cumsum(direction * v), index=close.index)


def add_atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    h = high.to_numpy(dtype=float)
    l = low.to_numpy(dtype=float)
    c = close.to_numpy(dtype=float)
    _pc = np.empty_like(c)
    _pc[0] = np.nan
    _pc[1:] = c[:-1]
    tr = pd.Series(np.fmax(np.fmax(h - l, np.abs(h - _pc)), np.abs(l - _pc)), index=high.index)
    return tr.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()


def add_adx_atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.DataFrame:
    """Compute ADX and ATR together, sharing the True Range calculation."""
    h = high.to_numpy(dtype=float)
    l = low.to_numpy(dtype=float)
    c = close.to_numpy(dtype=float)
    up = np.diff(h, prepend=np.nan)
    dn = -np.diff(l, prepend=np.nan)
    plus_dm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=high.index)
    minus_dm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=high.index)
    _pc = np.empty_like(c)
    _pc[0] = np.nan
    _pc[1:] = c[:-1]
    tr = pd.Series(np.fmax(np.fmax(h - l, np.abs(h - _pc)), np.abs(l - _pc)), index=high.index)
    alpha = 1 / period
    atr = tr.ewm(alpha=alpha, min_periods=period, adjust=False).mean()
    plus_di = 100 * plus_dm.ewm(alpha=alpha, min_periods=period, adjust=False).mean() / atr
    minus_di = 100 * minus_dm.ewm(alpha=alpha, min_periods=period, adjust=False).mean() / atr
    pdi_arr = plus_di.to_numpy(dtype=float)
    mdi_arr = minus_di.to_numpy(dtype=float)
    sum_di = pdi_arr + mdi_arr
    dx = pd.Series(
        np.where(sum_di == 0, np.nan, 100 * np.abs(pdi_arr - mdi_arr) / sum_di),
        index=high.index,
    )
    adx = dx.ewm(alpha=alpha, min_periods=period, adjust=False).mean()
    return pd.DataFrame({"adx14": adx, "atr14": atr})


def consecutive_positive(series: pd.Series) -> pd.Series:
    positive = (series.fillna(0) > 0)
    # Each run of non-positive values starts a new group; cumsum within group counts the streak
    group_id = (~positive).cumsum()
    return positive.astype("int64").groupby(group_id).cumsum()


def add_mfi(high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series, period: int = 14) -> pd.Series:
    typical_price = (high + low + close) / 3
    tp = typical_price.to_numpy(dtype=float)
    rmf = (typical_price * volume).to_numpy(dtype=float)
    tp_diff = np.diff(tp, prepend=np.nan)
    pos_mf = pd.Series(np.where(tp_diff > 0, rmf, 0.0), index=close.index)
    neg_mf = pd.Series(np.where(tp_diff < 0, rmf, 0.0), index=close.index)
    pos_sum = pos_mf.rolling(window=period, min_periods=period).sum().to_numpy(dtype=float)
    neg_sum = neg_mf.rolling(window=period, min_periods=period).sum().to_numpy(dtype=float)
    safe_neg = np.where(neg_sum == 0, np.nan, neg_sum)
    mfi = 100.0 - 100.0 / (1.0 + pos_sum / safe_neg)
    return pd.Series(np.where(np.isnan(mfi), 50.0, mfi), index=close.index)


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


def add_ichimoku_cloud(high: pd.Series, low: pd.Series, tenkan_period: int = 9, kijun_period: int = 26, senkou_b_period: int = 52) -> pd.DataFrame:
    """Return only the two cloud boundary spans (senkou A and B), skipping tenkan/kijun/chikou."""
    tenkan = (high.rolling(tenkan_period).max() + low.rolling(tenkan_period).min()) / 2
    kijun = (high.rolling(kijun_period).max() + low.rolling(kijun_period).min()) / 2
    sa_raw = ((tenkan + kijun) / 2).to_numpy(dtype=float)
    sb_raw = ((high.rolling(senkou_b_period).max() + low.rolling(senkou_b_period).min()) / 2).to_numpy(dtype=float)
    n = len(sa_raw)
    k = kijun_period
    senkou_a = np.full(n, np.nan)
    senkou_b = np.full(n, np.nan)
    if n > k:
        senkou_a[k:] = sa_raw[:-k]
        senkou_b[k:] = sb_raw[:-k]
    return pd.DataFrame({"ichi_senkou_a": senkou_a, "ichi_senkou_b": senkou_b}, index=high.index)


def add_williams_r(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    hh = high.rolling(window=period, min_periods=period).max().to_numpy(dtype=float)
    ll = low.rolling(window=period, min_periods=period).min().to_numpy(dtype=float)
    c = close.to_numpy(dtype=float)
    safe_range = np.where(hh - ll == 0, np.nan, hh - ll)
    return pd.Series(-100 * (hh - c) / safe_range, index=close.index)


def add_cci(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 20) -> pd.Series:
    tp = ((high + low + close) / 3).to_numpy(dtype=float)
    n = len(tp)
    result = np.full(n, np.nan)
    if n >= period:
        wins = sliding_window_view(tp, period)
        means = wins.mean(axis=1)
        mad = np.abs(wins - means[:, np.newaxis]).mean(axis=1)
        denom = 0.015 * np.where(mad == 0, np.nan, mad)
        result[period - 1:] = (tp[period - 1:] - means) / denom
    return pd.Series(result, index=close.index)


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
