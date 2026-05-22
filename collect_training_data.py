"""Collect historical training data for all Taiwan listed stocks using yfinance.

No FinMind API quota consumed. Downloads 1–5 years of OHLCV, computes the same
technical indicators as the invest system (indicators.py / strategy.py), adds
forward-return labels, and saves to a single CSV for ML training.

Usage:
    python collect_training_data.py --period 3y --output training_data
    python collect_training_data.py --period 3y --max-stocks 10   # quick test
"""
from __future__ import annotations

import argparse
import random
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import yfinance as yf

from indicators import (
    add_adx_atr, add_bollinger_bands, add_cci,
    add_ema, add_ichimoku_cloud, add_lr_slopes, add_macd,
    add_mfi, add_obv, add_rsi, add_sma, add_stochastic, add_williams_r,
)
from strategy import StrategyConfig, prepare_market_frame

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


# ── Stock list ────────────────────────────────────────────────────────────────

def get_stock_list() -> list[str]:
    """Return 4-digit Taiwan listed stock codes from TWSE ISIN page."""
    url = "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2"
    resp = requests.get(url, headers={"User-Agent": _UA}, timeout=15)
    resp.raise_for_status()
    df = pd.read_html(resp.text)[0]
    df.columns = df.iloc[0]
    df = df.iloc[1:].reset_index(drop=True)
    df["code"] = df["有價證券代號及名稱"].str.split("　").str[0]
    return df[df["code"].str.match(r"^\d{4}$")]["code"].tolist()


def get_stock_list_from_finmind() -> list[str]:
    """Fallback: get stock list from FinMind (consumes a small amount of quota)."""
    import os
    token = os.getenv("FINMIND_TOKEN", "")
    if not token:
        return []
    try:
        resp = requests.get(
            "https://api.finmindtrade.com/api/v4/data",
            params={"dataset": "TaiwanStockInfo", "token": token},
            timeout=30,
        )
        data = resp.json().get("data", [])
        return [r["stock_id"] for r in data
                if len(str(r.get("stock_id", ""))) == 4
                and str(r.get("stock_id", "")).isdigit()]
    except Exception:
        return []


# ── Market (TAIEX) ────────────────────────────────────────────────────────────

def download_market(period: str) -> pd.DataFrame:
    """Download TAIEX and return a frame ready for merging (with market_* columns)."""
    config = StrategyConfig()
    raw = yf.download("^TWII", period=period, progress=False, auto_adjust=True)
    if raw.empty:
        return pd.DataFrame()
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = [c[0] for c in raw.columns]
    mkt = (
        raw.reset_index()[["Date", "Close"]]
        .rename(columns={"Date": "date", "Close": "close"})
    )
    mkt["date"] = pd.to_datetime(mkt["date"]).dt.tz_localize(None).dt.normalize()
    return prepare_market_frame(mkt, config)


# ── Stock OHLCV download ──────────────────────────────────────────────────────

def _flatten_yf(raw: pd.DataFrame, yf_ticker: str, sid: str) -> pd.DataFrame | None:
    """Extract one stock's OHLCV from a possibly-MultiIndex yfinance result."""
    try:
        if isinstance(raw.columns, pd.MultiIndex):
            lvl0 = raw.columns.get_level_values(0)
            lvl1 = raw.columns.get_level_values(1)
            if yf_ticker in lvl0:
                # Old yfinance: (Ticker, Price)
                df = raw[yf_ticker].copy()
            elif yf_ticker in lvl1:
                # New yfinance >=0.2.38: (Price, Ticker)
                df = raw.xs(yf_ticker, axis=1, level=1).copy()
            else:
                return None
        else:
            df = raw.copy()

        df = df.dropna(how="all").reset_index()
        date_col = "Date" if "Date" in df.columns else df.columns[0]
        df = df.rename(columns={
            date_col: "date", "Open": "open", "High": "high",
            "Low": "low", "Close": "close", "Volume": "volume",
        })
        needed = {"date", "open", "high", "low", "close", "volume"}
        if not needed.issubset(df.columns):
            return None
        df = df[list(needed)].copy()
        df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None).dt.normalize()
        df = df.sort_values("date").reset_index(drop=True)
        return df
    except Exception:
        return None


def download_stocks_batch(tickers: list[str], period: str) -> dict[str, pd.DataFrame]:
    """Batch-download OHLCV for a list of stock IDs; return {stock_id: df}."""
    yf_tickers = [f"{t}.TW" for t in tickers]
    result: dict[str, pd.DataFrame] = {}
    if not yf_tickers:
        return result

    if len(yf_tickers) == 1:
        raw = yf.download(yf_tickers[0], period=period, progress=False, auto_adjust=True)
        df = _flatten_yf(raw, yf_tickers[0], tickers[0])
        if df is not None:
            result[tickers[0]] = df
        return result

    raw = yf.download(
        " ".join(yf_tickers), period=period,
        group_by="ticker", progress=False, auto_adjust=True,
    )
    if raw.empty:
        return result
    for yf_t, sid in zip(yf_tickers, tickers):
        df = _flatten_yf(raw, yf_t, sid)
        if df is not None:
            result[sid] = df
    return result


# ── Indicator & feature computation ──────────────────────────────────────────

def compute_features(df: pd.DataFrame, market: pd.DataFrame,
                     sid: str, config: StrategyConfig) -> pd.DataFrame:
    """Compute all technical indicators + strategy conditions + forward labels."""
    frame = df.copy()
    n = len(frame)
    if n < 130:
        return pd.DataFrame()

    # ── Indicators ────────────────────────────────────────────────────────────
    _macd = add_macd(frame["close"], config.macd_fast, config.macd_slow, config.macd_signal)
    frame[_macd.columns] = _macd.values
    frame["ema20"]  = add_ema(frame["close"], config.ema_exit)
    frame["ema60"]  = add_ema(frame["close"], config.ema_entry)
    frame["ema120"] = add_ema(frame["close"], config.ema_trend)
    frame["rsi14"]  = add_rsi(frame["close"], config.rsi_period)
    _adxatr = add_adx_atr(frame["high"], frame["low"], frame["close"], config.adx_period)
    frame[_adxatr.columns] = _adxatr.values
    frame["volume_ma20"] = add_sma(frame["volume"], config.volume_ma_window)

    # Approximate amount (TWD) = close × volume for liquidity filter
    frame["amount"]    = frame["close"] * frame["volume"]
    frame["amount_ma20"] = add_sma(frame["amount"], 20)

    _bb = add_bollinger_bands(frame["close"], config.bb_period, config.bb_std)
    frame[_bb.columns] = _bb.values
    _stoch = add_stochastic(frame["high"], frame["low"], frame["close"],
                            config.kd_k_period, config.kd_d_period)
    frame[_stoch.columns] = _stoch.values
    frame["obv"]    = add_obv(frame["close"], frame["volume"])
    frame["obv_ma"] = add_sma(frame["obv"], config.obv_ma_window)
    frame["williams_r"] = add_williams_r(frame["high"], frame["low"], frame["close"])
    frame["cci20"]  = add_cci(frame["high"], frame["low"], frame["close"])
    frame["mfi14"]  = add_mfi(frame["high"], frame["low"], frame["close"], frame["volume"])
    _ichi = add_ichimoku_cloud(frame["high"], frame["low"])
    frame[_ichi.columns] = _ichi.values
    _lr = add_lr_slopes(frame["close"], windows=(20, 60))
    frame[_lr.columns] = _lr.values

    # ── Returns & rolling stats ───────────────────────────────────────────────
    c_arr = frame["close"].to_numpy(dtype=float)
    w = config.relative_strength_window
    r5 = np.empty(n, dtype=float); r5[:w] = np.nan; r5[w:] = c_arr[w:] / c_arr[:-w] - 1
    frame["return_5d"] = r5

    _max20_raw = frame["close"].rolling(config.breakout_window).max().to_numpy(dtype=float)
    _s_max20 = np.empty(n, dtype=float); _s_max20[0] = np.nan; _s_max20[1:] = _max20_raw[:-1]
    frame["close_20d_high"] = _s_max20

    _vma20 = frame["volume_ma20"].to_numpy(dtype=float)
    _safe_vma20 = np.where(_vma20 > 0, _vma20, np.nan)
    frame["volume_ratio"] = np.nan_to_num(
        frame["volume"].to_numpy(dtype=float) / _safe_vma20, nan=1.0
    )

    # ── Merge market context ──────────────────────────────────────────────────
    mkt_cols = ["date", "market_ma60", "market_above_ma60", "market_return_5d"]
    if not market.empty and all(c in market.columns for c in mkt_cols):
        frame = frame.merge(market[mkt_cols], on="date", how="left")
    else:
        frame["market_ma60"]       = np.nan
        frame["market_above_ma60"] = False
        frame["market_return_5d"]  = np.nan
    frame["relative_strength_5d"] = frame["return_5d"] - frame["market_return_5d"]

    nn = len(frame)

    def _prev(arr: np.ndarray) -> np.ndarray:
        p = np.empty(nn, dtype=float); p[0] = np.nan; p[1:] = arr[:-1]; return p

    # Re-extract numpy arrays after merge (length may differ slightly)
    mc   = frame["macd"].to_numpy(dtype=float)
    ms   = frame["macd_signal"].to_numpy(dtype=float)
    mh   = frame["macd_hist"].to_numpy(dtype=float)
    sk   = frame["stoch_k"].to_numpy(dtype=float)
    sd   = frame["stoch_d"].to_numpy(dtype=float)
    bw   = frame["bb_bandwidth"].to_numpy(dtype=float)
    wr   = frame["williams_r"].to_numpy(dtype=float)
    cc   = frame["cci20"].to_numpy(dtype=float)
    cl   = frame["close"].to_numpy(dtype=float)
    e60  = frame["ema60"].to_numpy(dtype=float)
    e120 = frame["ema120"].to_numpy(dtype=float)
    vol  = frame["volume"].to_numpy(dtype=float)
    rsi  = frame["rsi14"].to_numpy(dtype=float)
    adx  = frame["adx14"].to_numpy(dtype=float)
    h20  = frame["close_20d_high"].to_numpy(dtype=float)
    r5d  = frame["return_5d"].to_numpy(dtype=float)
    ama  = frame["amount_ma20"].to_numpy(dtype=float)
    rs5  = frame["relative_strength_5d"].to_numpy(dtype=float)
    obv_v  = frame["obv"].to_numpy(dtype=float)
    obv_m  = frame["obv_ma"].to_numpy(dtype=float)
    mfi_v  = frame["mfi14"].to_numpy(dtype=float)
    bb_up  = frame["bb_upper"].to_numpy(dtype=float)
    op     = frame["open"].to_numpy(dtype=float)
    hi     = frame["high"].to_numpy(dtype=float)
    vr     = frame["volume_ratio"].to_numpy(dtype=float)

    bb_bw_med = (frame["bb_bandwidth"]
                 .rolling(window=60, min_periods=20).median()
                 .to_numpy(dtype=float))
    cloud_top = np.fmax(
        frame["ichi_senkou_a"].to_numpy(dtype=float),
        frame["ichi_senkou_b"].to_numpy(dtype=float),
    )

    p_mc, p_ms, p_mh = _prev(mc), _prev(ms), _prev(mh)
    p_sk, p_sd        = _prev(sk), _prev(sd)
    p_bw              = _prev(bw)
    p_wr              = _prev(wr)
    p_cc              = _prev(cc)
    p_cl              = _prev(cl)
    p_bbm             = _prev(bb_bw_med)
    safe_pvma20 = np.where(_prev(_vma20) > 0, _prev(_vma20), np.nan)
    p_vr = np.nan_to_num(_prev(vol) / safe_pvma20, nan=1.0)

    # ── Strategy conditions ───────────────────────────────────────────────────
    body         = np.abs(cl - op)
    upper_shadow = hi - np.maximum(cl, op)

    frame["macd_golden_cross"]      = (p_mc <= p_ms) & (mc > ms)
    frame["hist_turn_positive"]     = (p_mh <= 0) & (mh > 0)
    frame["above_ema60"]            = cl > e60
    frame["ema60_gt_ema120"]        = e60 > e120
    frame["volume_break"]           = vr > config.volume_multiplier
    frame["rsi_strong"]             = rsi > config.rsi_threshold
    frame["adx_trending"]           = adx > config.adx_threshold
    frame["breakout_20d"]           = cl > h20
    frame["avoid_chase"]            = r5d < config.max_recent_rise_pct
    frame["liquidity_ok"]           = ama > config.min_amount_ma20
    frame["stronger_than_market"]   = rs5 > 0
    frame["kd_golden_cross"]        = (p_sk <= p_sd) & (sk > sd) & (sk < 80)
    frame["obv_uptrend"]            = obv_v > obv_m
    frame["bb_squeeze_breakout"]    = (p_bw < p_bbm) & (cl > bb_up)
    frame["breakout_volume_confirm"]= frame["breakout_20d"] & frame["volume_break"]
    frame["williams_r_recovery"]    = (p_wr < -80) & (wr > -50)
    frame["cci_momentum"]           = (p_cc < 100) & (cc >= 100)
    frame["mfi_strong"]             = mfi_v > 50
    frame["above_ichimoku_cloud"]   = cl > cloud_top
    frame["long_upper_shadow"]      = (body > 0) & (upper_shadow > body * 2)
    frame["open_high_close_low"]    = (op > p_cl * 1.02) & (cl < op)
    frame["gap_chase_after_blowout"]= (p_vr > config.volume_multiplier) & ((op / p_cl - 1) > 0.03)

    # Institutional stubs (no FinMind data available)
    frame["foreign_buy_streak"]  = 0
    frame["invest_trust_streak"] = 0
    frame["dealer_buy_streak"]   = 0
    frame["foreign_buy_3d"]      = False
    frame["invest_trust_buy_2d"] = False
    frame["dealer_buy_3d"]       = False

    _hard = ["macd_golden_cross", "above_ema60", "ema60_gt_ema120",
             "volume_break", "rsi_strong", "breakout_20d"]
    _soft = ["hist_turn_positive", "adx_trending", "stronger_than_market",
             "kd_golden_cross", "obv_uptrend", "bb_squeeze_breakout",
             "breakout_volume_confirm", "williams_r_recovery",
             "cci_momentum", "mfi_strong", "above_ichimoku_cloud"]
    _skip_conds = ["long_upper_shadow", "open_high_close_low", "gap_chase_after_blowout"]

    frame["condition_count"] = frame[_hard + _soft].astype(int).sum(axis=1)
    _hard_met  = frame[_hard].all(axis=1)
    _soft_met  = frame[_soft].astype(int).sum(axis=1) >= 2
    _skip_met  = frame[_skip_conds].any(axis=1)
    frame["entry_signal"] = (_hard_met & _soft_met & ~_skip_met).astype(int)

    # ── Forward-return labels ─────────────────────────────────────────────────
    c_final = frame["close"].to_numpy(dtype=float)
    total   = len(frame)
    for lag, col in [(5, "forward_return_5d"), (10, "forward_return_10d"), (20, "forward_return_20d")]:
        fwd = np.full(total, np.nan)
        if total > lag:
            fwd[:-lag] = c_final[lag:] / c_final[:-lag] - 1
        frame[col] = fwd

    frame["label_5d"]  = np.where(frame["forward_return_5d"].notna(),
                                   (frame["forward_return_5d"]  > 0.03).astype(float), np.nan)
    frame["label_10d"] = np.where(frame["forward_return_10d"].notna(),
                                   (frame["forward_return_10d"] > 0.05).astype(float), np.nan)

    frame["stock_id"] = sid
    return frame


# ── Output column order ───────────────────────────────────────────────────────

_OUTPUT_COLS = [
    "date", "stock_id",
    # Price
    "open", "high", "low", "close", "volume", "amount",
    # Trend
    "ema20", "ema60", "ema120", "lr_slope_20", "lr_slope_60",
    # Momentum
    "macd", "macd_signal", "macd_hist", "rsi14", "adx14", "atr14",
    "stoch_k", "stoch_d", "williams_r", "cci20", "mfi14",
    # Volume & BB
    "volume_ratio", "volume_ma20", "amount_ma20",
    "bb_pct_b", "bb_bandwidth", "bb_upper", "bb_mid", "bb_lower",
    # Ichimoku
    "ichi_senkou_a", "ichi_senkou_b", "above_ichimoku_cloud",
    # OBV
    "obv", "obv_ma", "obv_uptrend",
    # Returns & market context
    "return_5d", "relative_strength_5d",
    "market_above_ma60", "market_return_5d",
    # Rolling breakout
    "close_20d_high", "breakout_20d",
    # Conditions
    "condition_count", "entry_signal",
    "macd_golden_cross", "hist_turn_positive",
    "above_ema60", "ema60_gt_ema120", "volume_break", "rsi_strong",
    "adx_trending", "kd_golden_cross", "bb_squeeze_breakout",
    "breakout_volume_confirm", "williams_r_recovery", "cci_momentum",
    "mfi_strong", "stronger_than_market",
    "long_upper_shadow", "open_high_close_low", "gap_chase_after_blowout",
    # Institutional stubs
    "foreign_buy_streak", "invest_trust_streak", "dealer_buy_streak",
    # Labels
    "forward_return_5d", "forward_return_10d", "forward_return_20d",
    "label_5d", "label_10d",
]


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Collect historical ML training data via yfinance")
    parser.add_argument("--period",     default="3y",
                        help="yfinance period: 1y / 2y / 3y / 5y (default: 3y)")
    parser.add_argument("--batch-size", type=int, default=100,
                        help="stocks per yfinance download batch (default: 100)")
    parser.add_argument("--output",     default="training_data",
                        help="output directory (default: training_data)")
    parser.add_argument("--max-stocks", type=int, default=0,
                        help="limit to first N stocks — for quick testing (0 = all)")
    parser.add_argument("--tickers",      default="",
                        help="comma-separated stock IDs to use instead of auto-fetching list "
                             "(e.g. 2330,2317,0050)")
    parser.add_argument("--skip-market", action="store_true",
                        help="skip TAIEX download (market context columns will be NaN)")
    parser.add_argument("--format",      default="parquet",
                        choices=["csv", "parquet", "both"],
                        help="輸出格式（預設 parquet，比 CSV 小 5–8 倍，可直接 commit 進 GitHub）")
    args = parser.parse_args()

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    config  = StrategyConfig()

    # 1. Stock list
    if args.tickers:
        tickers = [t.strip() for t in args.tickers.split(",") if t.strip()]
        print(f"📋 使用手動指定清單：{len(tickers)} 支")
    else:
        print("📋 取得台股上市清單（TWSE）...")
        tickers = []
        try:
            tickers = get_stock_list()
            print(f"   共 {len(tickers)} 支")
        except Exception as exc:
            print(f"   TWSE 取得失敗（{exc}），改用 FinMind fallback...")
            tickers = get_stock_list_from_finmind()
            if tickers:
                print(f"   FinMind 取得 {len(tickers)} 支")
            else:
                print("❌ 無法取得股票清單（請用 --tickers 手動指定，或在環境變數設定 FINMIND_TOKEN）")
                sys.exit(1)

    if args.max_stocks > 0:
        tickers = tickers[:args.max_stocks]
        print(f"   ⚠️  測試模式：只取前 {len(tickers)} 支")

    # 2. Market data
    market: pd.DataFrame
    if args.skip_market:
        print("\n📈 略過大盤資料（--skip-market）")
        market = pd.DataFrame(columns=["date", "market_ma60", "market_above_ma60", "market_return_5d"])
    else:
        print(f"\n📈 下載大盤資料（^TWII, period={args.period}）...")
        try:
            market = download_market(args.period)
        except Exception as exc:
            print(f"❌ 大盤下載失敗：{exc}")
            sys.exit(1)
        if market.empty:
            print("❌ 大盤資料為空")
            sys.exit(1)
        print(f"   大盤 {len(market)} 個交易日（{market['date'].min().date()} ~ {market['date'].max().date()}）")

    # 3. Batch download + feature computation
    total_batches = (len(tickers) + args.batch_size - 1) // args.batch_size
    all_frames: list[pd.DataFrame] = []
    t_start = time.time()

    for i in range(0, len(tickers), args.batch_size):
        batch      = tickers[i : i + args.batch_size]
        batch_num  = i // args.batch_size + 1
        print(f"\n⬇️  批次 {batch_num}/{total_batches}（{i+1}–{i+len(batch)}/{len(tickers)}）", flush=True)

        stock_data = download_stocks_batch(batch, args.period)
        print(f"   取得 {len(stock_data)}/{len(batch)} 支資料", flush=True)

        ok = skip = 0
        for sid, df in stock_data.items():
            feat = compute_features(df, market, sid, config)
            if not feat.empty:
                # Keep only defined output columns that exist
                keep = [c for c in _OUTPUT_COLS if c in feat.columns]
                all_frames.append(feat[keep])
                ok += 1
            else:
                skip += 1
        print(f"   指標計算：{ok} 支 ✅  {skip} 支略過（資料不足 130 列）", flush=True)

        if i + args.batch_size < len(tickers):
            time.sleep(random.uniform(0.5, 1.5))

    if not all_frames:
        print("\n❌ 沒有任何可用資料")
        sys.exit(1)

    # 4. Save
    print("\n💾 合併並儲存...", flush=True)
    combined  = pd.concat(all_frames, ignore_index=True)

    # Dedup: same stock × same date should appear only once
    before = len(combined)
    combined = combined.drop_duplicates(subset=["stock_id", "date"], keep="last")
    dropped = before - len(combined)
    if dropped:
        print(f"   去除重複筆數：{dropped:,}（重複 stock_id + date）")

    today_str = date.today().strftime("%Y-%m-%d")
    saved: list[Path] = []

    if args.format in ("parquet", "both"):
        # ── Combined parquet (backward compat) ──────────────────────────────
        out_parquet = out_dir / f"historical_{args.period}_{today_str}.parquet"
        combined.to_parquet(out_parquet, index=False, engine="pyarrow", compression="snappy")
        saved.append(out_parquet)
        print(f"   Parquet：{out_parquet}  ({out_parquet.stat().st_size // 1024 / 1024:.1f} MB)")

        # ── features_*.parquet — no labels or forward returns ────────────────
        _LABEL_COLS = [
            "forward_return_5d", "forward_return_10d", "forward_return_20d",
            "label_5d", "label_10d",
        ]
        feat_cols   = [c for c in combined.columns if c not in _LABEL_COLS]
        features_df = combined[feat_cols]
        feat_path   = out_dir / f"features_{args.period}_{today_str}.parquet"
        features_df.to_parquet(feat_path, index=False, engine="pyarrow", compression="snappy")
        saved.append(feat_path)
        print(f"   Features：{feat_path}  ({feat_path.stat().st_size // 1024 / 1024:.1f} MB)"
              f"  [{len(feat_cols)} 欄，無 label/forward_return]")

        # ── labels_*.parquet — labels only, NaN rows removed ─────────────────
        labels_df = (
            combined[["stock_id", "date"] + _LABEL_COLS]
            .dropna(subset=["label_5d"])
            .reset_index(drop=True)
        )
        label_path = out_dir / f"labels_{args.period}_{today_str}.parquet"
        labels_df.to_parquet(label_path, index=False, engine="pyarrow", compression="snappy")
        saved.append(label_path)
        print(f"   Labels ：{label_path}  ({label_path.stat().st_size // 1024 / 1024:.1f} MB)"
              f"  [{len(labels_df):,} 筆，NaN label 已移除]")

    if args.format in ("csv", "both"):
        out_csv = out_dir / f"historical_{args.period}_{today_str}.csv"
        combined.to_csv(out_csv, index=False, encoding="utf-8-sig")
        saved.append(out_csv)
        print(f"   CSV：{out_csv}  ({out_csv.stat().st_size // 1024 / 1024:.1f} MB)")

    # Summary stats
    total     = len(combined)
    n_stocks  = combined["stock_id"].nunique()
    n_labeled = int(combined["label_5d"].notna().sum())
    pos_rate  = float((combined["label_5d"].dropna() == 1).mean())
    elapsed   = time.time() - t_start

    print(f"\n{'='*50}")
    print(f"✅  完成！（{elapsed:.0f} 秒）")
    print(f"   總筆數    ：{total:>10,}  ({n_stocks} 支股票)")
    print(f"   有標籤筆數：{n_labeled:>10,}")
    print(f"   label_5d 正樣本比例：{pos_rate:.1%}")
    for p in saved:
        print(f"   輸出：{p}")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
