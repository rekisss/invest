from __future__ import annotations

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view


def add_ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def add_sma(series: pd.Series, window: int) -> pd.Series:
    arr = series.to_numpy(dtype=float)
    n = len(arr)
    nan_mask = np.isnan(arr)
    safe = np.where(nan_mask, 0.0, arr)
    cs = np.empty(n + 1, dtype=float); cs[0] = 0.0; np.cumsum(safe, out=cs[1:])
    nan_cs = np.empty(n + 1, dtype=np.int32); nan_cs[0] = 0; np.cumsum(nan_mask.view(np.int8), out=nan_cs[1:])
    result = np.full(n, np.nan)
    sums = cs[window:] - cs[:n - window + 1]
    has_nan = (nan_cs[window:] - nan_cs[:n - window + 1]) > 0
    result[window - 1:] = np.where(has_nan, np.nan, sums / window)
    return pd.Series(result, index=series.index)


def add_macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    macd_arr = (
        close.ewm(span=fast, adjust=False).mean().to_numpy(dtype=float)
        - close.ewm(span=slow, adjust=False).mean().to_numpy(dtype=float)
    )
    sig_arr = pd.Series(macd_arr).ewm(span=signal, adjust=False).mean().to_numpy(dtype=float)
    return pd.DataFrame(
        {"macd": macd_arr, "macd_signal": sig_arr, "macd_hist": macd_arr - sig_arr},
        index=close.index,
    )


def add_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = np.diff(close.to_numpy(dtype=float), prepend=np.nan)
    alpha = 1 / period
    ag = pd.Series(np.maximum(delta, 0.0)).ewm(alpha=alpha, min_periods=period, adjust=False).mean().to_numpy(dtype=float)
    al = pd.Series(np.maximum(-delta, 0.0)).ewm(alpha=alpha, min_periods=period, adjust=False).mean().to_numpy(dtype=float)
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
    plus_dm_arr = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm_arr = np.where((dn > up) & (dn > 0), dn, 0.0)
    _pc = np.empty_like(c)
    _pc[0] = np.nan
    _pc[1:] = c[:-1]
    tr_arr = np.fmax(np.fmax(h - l, np.abs(h - _pc)), np.abs(l - _pc))
    alpha = 1 / period
    atr_arr = pd.Series(tr_arr).ewm(alpha=alpha, min_periods=period, adjust=False).mean().to_numpy(dtype=float)
    pdm_arr = pd.Series(plus_dm_arr).ewm(alpha=alpha, min_periods=period, adjust=False).mean().to_numpy(dtype=float)
    mdm_arr = pd.Series(minus_dm_arr).ewm(alpha=alpha, min_periods=period, adjust=False).mean().to_numpy(dtype=float)
    safe_atr = np.where(atr_arr == 0, np.nan, atr_arr)
    pdi_arr = 100 * pdm_arr / safe_atr
    mdi_arr = 100 * mdm_arr / safe_atr
    sum_di = pdi_arr + mdi_arr
    dx_arr = np.where(sum_di == 0, np.nan, 100 * np.abs(pdi_arr - mdi_arr) / sum_di)
    return pd.Series(
        pd.Series(dx_arr).ewm(alpha=alpha, min_periods=period, adjust=False).mean().to_numpy(dtype=float),
        index=high.index,
    )


def add_bollinger_bands(close: pd.Series, window: int = 20, num_std: float = 2.0) -> pd.DataFrame:
    close_arr = close.to_numpy(dtype=float)
    n = len(close_arr)
    cs1 = np.empty(n + 1); cs1[0] = 0.0; np.cumsum(close_arr, out=cs1[1:])
    cs2 = np.empty(n + 1); cs2[0] = 0.0; np.cumsum(close_arr * close_arr, out=cs2[1:])
    sma_arr = np.full(n, np.nan)
    std_arr = np.full(n, np.nan)
    sum1 = cs1[window:] - cs1[:n - window + 1]
    sum2 = cs2[window:] - cs2[:n - window + 1]
    m = sum1 / window
    sma_arr[window - 1:] = m
    std_arr[window - 1:] = np.sqrt(np.maximum(sum2 / window - m * m, 0.0))
    upper_arr = sma_arr + num_std * std_arr
    lower_arr = sma_arr - num_std * std_arr
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
    hh = high.rolling(window=k_period, min_periods=k_period).max().to_numpy(dtype=float)
    ll = low.rolling(window=k_period, min_periods=k_period).min().to_numpy(dtype=float)
    c = close.to_numpy(dtype=float)
    safe_range = np.where(hh - ll == 0, np.nan, hh - ll)
    k_arr = 100 * (c - ll) / safe_range
    nk = len(k_arr)
    nan_k = np.isnan(k_arr)
    safe_k = np.where(nan_k, 0.0, k_arr)
    kcs = np.empty(nk + 1); kcs[0] = 0.0; np.cumsum(safe_k, out=kcs[1:])
    nan_kcs = np.empty(nk + 1, dtype=np.int32); nan_kcs[0] = 0; np.cumsum(nan_k.view(np.int8), out=nan_kcs[1:])
    d_arr = np.full(nk, np.nan)
    ksums = kcs[d_period:] - kcs[:nk - d_period + 1]
    d_has_nan = (nan_kcs[d_period:] - nan_kcs[:nk - d_period + 1]) > 0
    d_arr[d_period - 1:] = np.where(d_has_nan, np.nan, ksums / d_period)
    return pd.DataFrame({"stoch_k": k_arr, "stoch_d": d_arr}, index=close.index)


def add_obv(close: pd.Series, volume: pd.Series) -> pd.Series:
    c = close.to_numpy(dtype=float)
    v = volume.to_numpy(dtype=float)
    direction = np.empty_like(c)
    direction[0] = 0.0
    np.sign(c[1:] - c[:-1], out=direction[1:])
    np.multiply(direction, v, out=direction)
    return pd.Series(np.cumsum(direction), index=close.index)


def add_atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    h = high.to_numpy(dtype=float)
    l = low.to_numpy(dtype=float)
    c = close.to_numpy(dtype=float)
    _pc = np.empty_like(c)
    _pc[0] = np.nan
    _pc[1:] = c[:-1]
    tr_arr = np.fmax(np.fmax(h - l, np.abs(h - _pc)), np.abs(l - _pc))
    return pd.Series(
        pd.Series(tr_arr).ewm(alpha=1 / period, min_periods=period, adjust=False).mean().to_numpy(dtype=float),
        index=high.index,
    )


def add_adx_atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.DataFrame:
    """Compute ADX and ATR together, sharing the True Range calculation."""
    h = high.to_numpy(dtype=float)
    l = low.to_numpy(dtype=float)
    c = close.to_numpy(dtype=float)
    up = np.diff(h, prepend=np.nan)
    dn = -np.diff(l, prepend=np.nan)
    plus_dm_arr = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm_arr = np.where((dn > up) & (dn > 0), dn, 0.0)
    _pc = np.empty_like(c)
    _pc[0] = np.nan
    _pc[1:] = c[:-1]
    tr_arr = np.fmax(np.fmax(h - l, np.abs(h - _pc)), np.abs(l - _pc))
    alpha = 1 / period
    atr_arr = pd.Series(tr_arr).ewm(alpha=alpha, min_periods=period, adjust=False).mean().to_numpy(dtype=float)
    pdm_arr = pd.Series(plus_dm_arr).ewm(alpha=alpha, min_periods=period, adjust=False).mean().to_numpy(dtype=float)
    mdm_arr = pd.Series(minus_dm_arr).ewm(alpha=alpha, min_periods=period, adjust=False).mean().to_numpy(dtype=float)
    safe_atr = np.where(atr_arr == 0, np.nan, atr_arr)
    pdi_arr = 100 * pdm_arr / safe_atr
    mdi_arr = 100 * mdm_arr / safe_atr
    sum_di = pdi_arr + mdi_arr
    dx_arr = np.where(sum_di == 0, np.nan, 100 * np.abs(pdi_arr - mdi_arr) / sum_di)
    adx_arr = pd.Series(dx_arr).ewm(alpha=alpha, min_periods=period, adjust=False).mean().to_numpy(dtype=float)
    return pd.DataFrame({"adx14": adx_arr, "atr14": atr_arr}, index=high.index)


def consecutive_positive(series: pd.Series) -> pd.Series:
    raw = series.to_numpy(dtype=float)
    arr = np.where(np.isnan(raw) | (raw <= 0), np.int64(0), np.int64(1))
    cumsum = np.cumsum(arr)
    running_max_reset = np.maximum.accumulate(np.where(arr == 0, cumsum, np.int64(0)))
    return pd.Series(arr * (cumsum - running_max_reset), index=series.index)


def add_mfi(high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series, period: int = 14) -> pd.Series:
    h = high.to_numpy(dtype=float)
    l = low.to_numpy(dtype=float)
    c = close.to_numpy(dtype=float)
    tp = (h + l + c) / 3.0
    rmf = tp * volume.to_numpy(dtype=float)
    tp_diff = np.diff(tp, prepend=np.nan)
    pos_mf = np.where(tp_diff > 0, rmf, 0.0)
    neg_mf = np.where(tp_diff < 0, rmf, 0.0)
    n = len(tp)
    pos_cs = np.empty(n + 1); pos_cs[0] = 0.0; np.cumsum(pos_mf, out=pos_cs[1:])
    neg_cs = np.empty(n + 1); neg_cs[0] = 0.0; np.cumsum(neg_mf, out=neg_cs[1:])
    pos_sum = np.full(n, np.nan); pos_sum[period - 1:] = pos_cs[period:] - pos_cs[:n - period + 1]
    neg_sum = np.full(n, np.nan); neg_sum[period - 1:] = neg_cs[period:] - neg_cs[:n - period + 1]
    safe_neg = np.where(neg_sum == 0, np.nan, neg_sum)
    mfi = 100.0 - 100.0 / (1.0 + pos_sum / safe_neg)
    return pd.Series(np.where(np.isnan(mfi), 50.0, mfi), index=close.index)


def add_ichimoku(high: pd.Series, low: pd.Series, tenkan_period: int = 9, kijun_period: int = 26, senkou_b_period: int = 52) -> pd.DataFrame:
    tk_h = high.rolling(tenkan_period).max().to_numpy(dtype=float)
    tk_l = low.rolling(tenkan_period).min().to_numpy(dtype=float)
    kj_h = high.rolling(kijun_period).max().to_numpy(dtype=float)
    kj_l = low.rolling(kijun_period).min().to_numpy(dtype=float)
    tenkan_arr = (tk_h + tk_l) / 2.0
    kijun_arr = (kj_h + kj_l) / 2.0
    sb_raw = (high.rolling(senkou_b_period).max().to_numpy(dtype=float) + low.rolling(senkou_b_period).min().to_numpy(dtype=float)) / 2.0
    sa_raw = (tenkan_arr + kijun_arr) / 2.0
    n = len(sa_raw)
    k = kijun_period
    senkou_a_arr = np.full(n, np.nan)
    senkou_b_arr = np.full(n, np.nan)
    if n > k:
        senkou_a_arr[k:] = sa_raw[:-k]
        senkou_b_arr[k:] = sb_raw[:-k]
    chikou_arr = np.full(n, np.nan)
    if n > k:
        chikou_arr[:n - k] = high.to_numpy(dtype=float)[k:]
    return pd.DataFrame({
        "ichi_tenkan": tenkan_arr,
        "ichi_kijun": kijun_arr,
        "ichi_senkou_a": senkou_a_arr,
        "ichi_senkou_b": senkou_b_arr,
        "ichi_chikou": chikou_arr,
    }, index=high.index)


def add_ichimoku_cloud(high: pd.Series, low: pd.Series, tenkan_period: int = 9, kijun_period: int = 26, senkou_b_period: int = 52) -> pd.DataFrame:
    """Return only the two cloud boundary spans (senkou A and B), skipping tenkan/kijun/chikou."""
    tk_h = high.rolling(tenkan_period).max().to_numpy(dtype=float)
    tk_l = low.rolling(tenkan_period).min().to_numpy(dtype=float)
    kj_h = high.rolling(kijun_period).max().to_numpy(dtype=float)
    kj_l = low.rolling(kijun_period).min().to_numpy(dtype=float)
    sa_raw = (tk_h + tk_l + kj_h + kj_l) / 4.0
    sb_raw = (high.rolling(senkou_b_period).max().to_numpy(dtype=float) + low.rolling(senkou_b_period).min().to_numpy(dtype=float)) / 2.0
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
    tp = (high.to_numpy(dtype=float) + low.to_numpy(dtype=float) + close.to_numpy(dtype=float)) / 3.0
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
    raw = close.to_numpy(dtype=float)
    log_c = np.log(np.where(np.isnan(raw) | (raw < 1e-9), np.nan, raw))
    nan_mask = np.isnan(log_c)
    safe = np.where(nan_mask, 0.0, log_c)
    pos = np.arange(len(log_c), dtype=float)

    Sx: float = n * (n - 1) / 2
    Sxx: float = n * (n - 1) * (2 * n - 1) / 6
    denom: float = n * Sxx - Sx ** 2

    m = len(safe)
    cum_y = np.empty(m + 1); cum_y[0] = 0.0; np.cumsum(safe, out=cum_y[1:])
    cum_py = np.empty(m + 1); cum_py[0] = 0.0; np.cumsum(pos * safe, out=cum_py[1:])
    cum_nan = np.empty(m + 1, dtype=np.int32); cum_nan[0] = 0; np.cumsum(nan_mask.view(np.int8), out=cum_nan[1:])

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
    raw = close.to_numpy(dtype=float)
    log_c = np.log(np.where(np.isnan(raw) | (raw < 1e-9), np.nan, raw))
    nan_mask = np.isnan(log_c)
    safe = np.where(nan_mask, 0.0, log_c)
    pos = np.arange(len(log_c), dtype=float)

    cum_y = np.empty(len(safe) + 1); cum_y[0] = 0.0; np.cumsum(safe, out=cum_y[1:])
    cum_py = np.empty(len(safe) + 1); cum_py[0] = 0.0; np.cumsum(pos * safe, out=cum_py[1:])
    cum_nan_arr = np.empty(len(nan_mask) + 1, dtype=np.int32); cum_nan_arr[0] = 0; np.cumsum(nan_mask.view(np.int8), out=cum_nan_arr[1:])

    cols: dict[str, np.ndarray] = {}
    for n in windows:
        Sx: float = n * (n - 1) / 2
        Sxx: float = n * (n - 1) * (2 * n - 1) / 6
        denom: float = n * Sxx - Sx ** 2
        t = np.arange(n - 1, len(log_c))
        s = t - n + 1
        has_nan = (cum_nan_arr[t + 1] - cum_nan_arr[s]) > 0
        Sy = cum_y[t + 1] - cum_y[s]
        Sxy = (cum_py[t + 1] - cum_py[s]) - s * Sy
        slope = np.where(has_nan, np.nan, (n * Sxy - Sx * Sy) / denom * 100)
        result = np.full(len(log_c), np.nan)
        result[n - 1:] = slope
        cols[f"lr_slope_{n}"] = result
    return pd.DataFrame(cols, index=close.index)
