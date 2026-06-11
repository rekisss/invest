"""
market_predictor.py – XGBoost market-direction predictor for TAIEX.

Features: TAIEX technicals + optional US market data (S&P500, VIX, DXY, NASDAQ)
fetched via yfinance (best-effort, degrades gracefully if unavailable).
"""
from __future__ import annotations

import sys
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd

try:
    from xgboost import XGBClassifier
    _DEPS_OK = True
except Exception:
    _DEPS_OK = False

try:
    import yfinance as yf
    _YF_OK = True
except Exception:
    _YF_OK = False


# ── US market data ─────────────────────────────────────────────────────────────

_US_TICKERS = {
    "sp500":   "^GSPC",
    "nasdaq":  "^IXIC",
    "sox":     "^SOX",
    "vix":     "^VIX",
    "dxy":     "DX-Y.NYB",
    "us10y":   "^TNX",
    "gold":    "GC=F",
    "oil":     "CL=F",
    "us2y":    "^IRX",
    "usdcny":  "CNY=X",
    "twd":     "TWD=X",
    "tsm_adr": "TSM",
    "nvda":    "NVDA",
    "jpy":     "JPY=X",
    "arkk":    "ARKK",
    "hyg":     "HYG",
}

# Stooq fallback symbols — Yahoo Finance blocks many datacenter IPs (e.g. GitHub
# Actions runners), Stooq's CSV endpoint doesn't require auth.
_STOOQ_SYMBOLS = {
    "sp500":   "^spx",
    "nasdaq":  "^ndq",
    "sox":     "^sox",
    "vix":     "^vix",
    "dxy":     "dx.f",
    "us10y":   "10yusy.b",
    "gold":    "gc.f",
    "oil":     "cl.f",
    "us2y":    "2yusy.b",
    "usdcny":  "usdcny",
    "twd":     "usdtwd",
    "tsm_adr": "tsm.us",
    "nvda":    "nvda.us",
    "jpy":     "usdjpy",
    "arkk":    "arkk.us",
    "hyg":     "hyg.us",
}

# FRED (Federal Reserve) series — not IP-blocked by any known provider.
# Covers macro indicators; SOX/individual stocks/ARKK/HYG unavailable on FRED.
_FRED_SERIES = {
    "sp500":  "SP500",
    "nasdaq": "NASDAQCOM",          # NASDAQ Composite
    "vix":    "VIXCLS",
    "us10y":  "DGS10",
    "us2y":   "DGS2",
    "gold":   "GOLDAMGBD228NLBM",
    "oil":    "DCOILWTICO",
    "jpy":    "DEXJPUS",
    "usdcny": "DEXCHUS",
}
_FRED_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv"


def _fetch_stooq_close(symbol: str, start_date: str, end_date: str) -> "pd.Series | None":
    """Fetch daily close prices from Stooq's free CSV endpoint. Returns None on failure."""
    import requests
    from io import StringIO

    url = (
        "https://stooq.com/q/d/l/"
        f"?s={symbol}&d1={start_date.replace('-', '')}&d2={end_date.replace('-', '')}&i=d"
    )
    resp = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    text = resp.text.strip()
    if not text.startswith("Date"):
        return None
    df = pd.read_csv(StringIO(text))
    if df.empty or "Close" not in df.columns:
        return None
    df["Date"] = pd.to_datetime(df["Date"])
    return pd.Series(df["Close"].values, index=df["Date"])


def _fetch_fred_close(series_id: str, start_date: str, end_date: str) -> "pd.Series | None":
    """Fetch a FRED time series as a pd.Series indexed by date. Returns None on failure."""
    import requests
    from io import StringIO
    try:
        resp = requests.get(
            _FRED_BASE,
            params={"id": series_id, "vintage_date": end_date},
            timeout=15,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        resp.raise_for_status()
        text = resp.text.strip()
        if not text.startswith("DATE"):
            return None
        df = pd.read_csv(StringIO(text))
        df.columns = [c.strip() for c in df.columns]
        val_col = next((c for c in df.columns if c != "DATE"), None)
        if val_col is None:
            return None
        df["DATE"] = pd.to_datetime(df["DATE"])
        df[val_col] = pd.to_numeric(df[val_col], errors="coerce")
        df = df[df["DATE"] >= start_date].dropna(subset=[val_col])
        if df.empty:
            return None
        return pd.Series(df[val_col].values, index=df["DATE"])
    except Exception:
        return None


def fetch_us_features(start_date: str, end_date: str) -> pd.DataFrame:
    """Download US market indicators via yfinance with Stooq + FRED fallbacks."""
    if not _YF_OK:
        return pd.DataFrame()
    try:
        end_dt = (datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=2)).strftime("%Y-%m-%d")

        col_frames: list[pd.Series] = []
        failed: list[str] = []
        for key, ticker in _US_TICKERS.items():
            try:
                df = yf.download(ticker, start=start_date, end=end_dt,
                                 progress=False, auto_adjust=True, threads=False)
                if df.empty:
                    failed.append(ticker)
                    continue
                close = df["Close"] if "Close" in df.columns else df.iloc[:, 0]
                col_frames.append(close.rename(key))
            except Exception:
                failed.append(ticker)

        # Stooq fallback for tickers Yahoo refused (datacenter-IP blocking)
        if failed:
            recovered: list[str] = []
            for key, ticker in _US_TICKERS.items():
                if ticker not in failed:
                    continue
                stooq_sym = _STOOQ_SYMBOLS.get(key)
                if not stooq_sym:
                    continue
                try:
                    close = _fetch_stooq_close(stooq_sym, start_date, end_dt)
                    if close is not None and not close.empty:
                        col_frames.append(close.rename(key))
                        recovered.append(ticker)
                except Exception:
                    pass
            failed = [t for t in failed if t not in recovered]
            if recovered:
                print(f"[ai] Stooq 後備補回 {len(recovered)} 個 ticker", file=sys.stderr)

        # FRED fallback — Federal Reserve open data, not IP-blocked.
        # Covers macro signals (VIX, yields, gold, oil, FX, NASDAQ); SOX/stocks unavailable.
        if failed:
            fred_recovered: list[str] = []
            for key, ticker in _US_TICKERS.items():
                if ticker not in failed:
                    continue
                fred_id = _FRED_SERIES.get(key)
                if not fred_id:
                    continue
                close = _fetch_fred_close(fred_id, start_date, end_dt)
                if close is not None and not close.empty:
                    col_frames.append(close.rename(key))
                    fred_recovered.append(ticker)
            failed = [t for t in failed if t not in fred_recovered]
            if fred_recovered:
                print(f"[ai] FRED 後備補回 {len(fred_recovered)} 個 ticker", file=sys.stderr)

        if failed:
            print(f"[ai] yfinance 跳過失敗 ticker: {failed}", file=sys.stderr)
        if not col_frames:
            return pd.DataFrame()

        closes = pd.concat(col_frames, axis=1)
        closes.index = pd.to_datetime(closes.index).tz_localize(None)
        closes.index.name = "date"
        result = closes.reset_index()

        for col in [c for c in _US_TICKERS if c in result.columns]:
            result[f"{col}_ret1"] = result[col].pct_change(1)
            result[f"{col}_ret5"] = result[col].pct_change(5)

        feat_cols = ["date"] + [c for c in result.columns if "_ret" in c or c == "vix"]
        result = result[[c for c in feat_cols if c in result.columns]]
        result["date"] = pd.to_datetime(result["date"]).dt.normalize()
        return result.dropna(how="all", subset=[c for c in result.columns if c != "date"])
    except Exception as exc:
        print(f"[ai] yfinance 整體失敗: {exc}", file=sys.stderr)
        return pd.DataFrame()


# ── TAIEX feature engineering ──────────────────────────────────────────────────

def _build_taiex_features(df: pd.DataFrame) -> pd.DataFrame:
    c = df["close"]
    for n in (1, 5, 10, 20, 60):
        df[f"ret_{n}d"] = c.pct_change(n)
    df["vol_10d"] = c.pct_change(1).rolling(10, min_periods=3).std()
    df["vol_20d"] = c.pct_change(1).rolling(20, min_periods=5).std()
    for n in (10, 20, 60, 120):
        ma = c.rolling(n, min_periods=1).mean()
        df[f"dist_ma{n}"] = (c - ma) / ma.replace(0, np.nan)
    df["above_ma60"] = (c > c.rolling(60, min_periods=1).mean()).astype(float)
    delta = c.diff()
    gain = delta.clip(lower=0).ewm(alpha=1/14, adjust=False).mean()
    loss = (-delta).clip(lower=0).ewm(alpha=1/14, adjust=False).mean()
    df["rsi14"] = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    macd = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()
    df["macd_hist"] = macd - macd.ewm(span=9, adjust=False).mean()
    return df


_BASE_FEATURES = [
    "ret_1d", "ret_5d", "ret_10d", "ret_20d", "ret_60d", "vol_10d", "vol_20d",
    "dist_ma10", "dist_ma20", "dist_ma60", "dist_ma120", "above_ma60",
    "rsi14", "macd_hist",
]
_US_FEATURES = [
    "sp500_ret1", "sp500_ret5", "nasdaq_ret1", "vix",
    "sox_ret1", "dxy_ret1", "us10y_ret1",
    "gold_ret1", "oil_ret1", "us2y_ret1", "usdcny_ret1", "twd_ret1",
    "tsm_adr_ret1", "nvda_ret1",
]

_FUTURES_FEATURES = [
    "futures_ret_1d", "futures_ret_5d", "futures_basis",
    "futures_oi_chg", "futures_vol_ratio", "foreign_futures_net",
]

_INST_FEATURES = [
    "foreign_inst_norm", "trust_inst_norm",
    "margin_purchase_chg", "short_sale_chg",
    "pcr",
]


# ── Predictor ─────────────────────────────────────────────────────────────────

@dataclass
class MarketPredictor:
    horizon: int = 5
    min_train_rows: int = 60
    _model: Any = field(default=None, init=False, repr=False)
    _medians: Any = field(default=None, init=False, repr=False)
    _feature_cols: list[str] = field(default_factory=list, init=False, repr=False)
    _trained: bool = field(default=False, init=False, repr=False)
    _us_available: bool = field(default=False, init=False, repr=False)

    def _merge_us(self, taiex_df: pd.DataFrame, us_df: pd.DataFrame) -> pd.DataFrame:
        if us_df.empty:
            return taiex_df
        taiex_df["date"] = pd.to_datetime(taiex_df["date"]).dt.normalize()
        us_df["date"] = pd.to_datetime(us_df["date"]).dt.normalize()
        merged = taiex_df.merge(us_df, on="date", how="left")
        us_cols = [c for c in merged.columns if c not in taiex_df.columns and c != "date"]
        if us_cols:
            merged[us_cols] = merged[us_cols].ffill()
        return merged

    def _merge_external(self, base_df: pd.DataFrame, ext_df: pd.DataFrame, feat_cols: list[str]) -> pd.DataFrame:
        """Left-join external features to base_df on date, forward-filling gaps."""
        if ext_df.empty:
            return base_df
        base_df = base_df.copy()
        ext = ext_df.copy()
        base_df["date"] = pd.to_datetime(base_df["date"]).dt.normalize()
        ext["date"] = pd.to_datetime(ext["date"]).dt.normalize()
        merged = base_df.merge(ext[["date"] + [c for c in feat_cols if c in ext.columns]], on="date", how="left")
        cols = [c for c in feat_cols if c in merged.columns]
        if cols:
            merged[cols] = merged[cols].ffill()
        return merged

    def fit(self, market_df: pd.DataFrame, us_df: pd.DataFrame | None = None,
            futures_df: pd.DataFrame | None = None,
            inst_df: pd.DataFrame | None = None) -> "MarketPredictor":
        if not _DEPS_OK:
            return self
        df = _build_taiex_features(market_df.copy().sort_values("date").reset_index(drop=True))
        if us_df is not None and not us_df.empty:
            df = self._merge_us(df, us_df)
            self._us_available = True
        if futures_df is not None and not futures_df.empty:
            df = self._merge_external(df, futures_df, _FUTURES_FEATURES)
        if inst_df is not None and not inst_df.empty:
            df = self._merge_external(df, inst_df, _INST_FEATURES)

        df["target"] = (df["close"].shift(-self.horizon) > df["close"]).astype(float)
        feat_cols = (
            _BASE_FEATURES
            + [c for c in _US_FEATURES if c in df.columns]
            + [c for c in _FUTURES_FEATURES if c in df.columns]
            + [c for c in _INST_FEATURES if c in df.columns]
        )
        df = df.dropna(subset=["target"])

        valid_cols = [c for c in feat_cols if c in df.columns and df[c].notna().sum() >= 20]
        # Replace inf before fillna — fillna only handles NaN, not inf
        df_finite = df[valid_cols].replace([np.inf, -np.inf], np.nan)
        df_clean = df_finite.fillna(df_finite.median())
        y = df.loc[df_clean.index, "target"].values if len(df_clean) < len(df) else df["target"].values

        if len(df_clean) < self.min_train_rows or len(np.unique(y)) < 2:
            return self

        self._feature_cols = valid_cols
        self._medians = df_clean.median()
        X = df_clean.values

        neg = int((y == 0).sum())
        pos = int((y == 1).sum())
        # Only boost the UP class when it's the minority; when UP is majority, spw=1.0
        spw = neg / pos if pos > 0 and neg > pos else 1.0

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            base_model = XGBClassifier(
                n_estimators=300, max_depth=4, learning_rate=0.05,
                subsample=0.8, colsample_bytree=0.8,
                scale_pos_weight=spw,
                eval_metric="logloss", verbosity=0, random_state=42,
            )
            # Apply isotonic calibration when enough data; prevents overconfident probabilities
            _use_calibration = len(X) >= 100
            if _use_calibration:
                try:
                    from models.calibration import CalibratedPredictor
                    _cal = CalibratedPredictor(base_model, method="isotonic", cv=3)
                    _cal.fit(pd.DataFrame(X, columns=valid_cols), pd.Series(y))
                    self._model = _cal
                    self._calibrated = True
                except Exception:
                    self._model = base_model.fit(X, y)
                    self._calibrated = False
            else:
                self._model = base_model.fit(X, y)
                self._calibrated = False

        self._trained = True
        return self

    def predict_proba(self, market_df: pd.DataFrame, us_df: pd.DataFrame | None = None,
                      futures_df: pd.DataFrame | None = None,
                      inst_df: pd.DataFrame | None = None) -> dict[str, Any]:
        default: dict[str, Any] = {
            "prob_up": 0.5, "confidence": "low", "label": "資料不足",
            "horizon": self.horizon, "trained": False, "us_features": False,
        }
        if not _DEPS_OK or not self._trained:
            return {**default, "label": "模組未安裝" if not _DEPS_OK else "訓練資料不足"}

        df = _build_taiex_features(market_df.copy().sort_values("date").reset_index(drop=True))
        if us_df is not None and not us_df.empty:
            df = self._merge_us(df, us_df)
        if futures_df is not None and not futures_df.empty:
            df = self._merge_external(df, futures_df, _FUTURES_FEATURES)
        if inst_df is not None and not inst_df.empty:
            df = self._merge_external(df, inst_df, _INST_FEATURES)

        row = df[self._feature_cols].iloc[[-1]].replace([np.inf, -np.inf], np.nan).fillna(self._medians)
        _row_df = pd.DataFrame(row.values, columns=self._feature_cols)
        _calibrated = getattr(self, "_calibrated", False)
        if _calibrated:
            prob = float(self._model.predict_proba(_row_df)[0, 1])
        else:
            prob = float(self._model.predict_proba(row.values)[0, 1])

        if prob >= 0.63:
            conf, label = "high", "看多"
        elif prob >= 0.53:
            conf, label = "medium", "偏多"
        elif prob <= 0.37:
            conf, label = "high", "看空"
        elif prob <= 0.47:
            conf, label = "medium", "偏空"
        else:
            conf, label = "low", "中性"

        return {
            "prob_up": prob, "confidence": conf, "label": label,
            "horizon": self.horizon, "trained": True,
            "us_features": self._us_available,
        }


# ── Natural language analysis ──────────────────────────────────────────────────

def generate_analysis_text(pred: dict[str, Any], breadth: dict[str, object] | None = None) -> str:
    """Generate a short natural-language summary of the market outlook."""
    if not pred.get("trained"):
        return ""
    prob = pred["prob_up"]
    label = pred.get("label", "中性")
    conf = pred.get("confidence", "low")
    breadth = breadth or {}
    has_breadth = bool(breadth)

    reasons_bull: list[str] = []
    reasons_bear: list[str] = []
    risks: list[str] = []

    if has_breadth:
        above_ema = int(breadth.get("above_ema60", 0))
        foreign_buy = int(breadth.get("foreign_buy_3d", 0))
        macd_cross = int(breadth.get("macd_golden_cross", 0))
        volume_ok = int(breadth.get("volume_break", 0))
        regime = str(breadth.get("market_regime", ""))

        if above_ema >= 60:
            reasons_bull.append(f"多數個股站上 EMA60（{above_ema}%）")
        elif above_ema <= 30:
            reasons_bear.append(f"僅 {above_ema}% 個股站上均線，弱勢格局")

        if foreign_buy >= 50:
            reasons_bull.append(f"外資連買比例高（{foreign_buy}%）")
        elif foreign_buy <= 20:
            reasons_bear.append(f"外資偏向賣超（{foreign_buy}%）")

        if macd_cross >= 40:
            reasons_bull.append(f"MACD 黃金交叉比例回升（{macd_cross}%）")
        elif macd_cross <= 15:
            risks.append("MACD 未交叉比例偏高，反彈力道有限")

        if volume_ok <= 20:
            risks.append("成交量未放大，突破可靠性存疑")

        if regime == "熊市":
            risks.append("大盤仍處熊市格局，反彈宜謹慎")

    if prob >= 0.63:
        outlook = "整體偏多"
        opening = f"今日看多信心較強（{prob*100:.0f}%）"
    elif prob >= 0.53:
        outlook = "偏多但力道有限"
        opening = f"今日小幅偏多（{prob*100:.0f}%）"
    elif prob <= 0.37:
        outlook = "整體偏空"
        opening = f"今日看空信號明顯（{(1-prob)*100:.0f}%空方機率）"
    elif prob <= 0.47:
        outlook = "偏空但未確認"
        opening = f"今日略偏空（{(1-prob)*100:.0f}%空方機率）"
    else:
        outlook = "方向不明"
        opening = "今日多空力道均衡"

    lines = [f"📝 **AI 分析**｜{outlook}"]
    has_bullets = reasons_bull or reasons_bear or risks
    if has_bullets:
        lines.append(opening + ("，以下為支撐理由：" if reasons_bull else "，短期風險需留意："))
        for r in reasons_bull[:2]:
            lines.append(f"  ✅ {r}")
        for r in reasons_bear[:2]:
            lines.append(f"  ❌ {r}")
        for r in risks[:2]:
            lines.append(f"  ⚠️ {r}")
    else:
        lines.append(opening)

    if conf == "low":
        lines.append("  ℹ️ 信心偏低，建議觀望或輕倉")

    return "\n".join(lines)


# ── Claude scenario analysis ───────────────────────────────────────────────────

def generate_scenario_analysis(market_data: dict) -> str:
    """Rule-based TX scenario analysis from structured market data.

    Evaluates US market, night session, and capital flow signals to output
    a 5-line qualitative scenario without any external API dependency.
    """
    import math as _math

    def _f(path: str, default: float = float("nan")) -> float:
        keys = path.split(".")
        node: Any = market_data
        for k in keys:
            if not isinstance(node, dict):
                return default
            node = node.get(k)
        try:
            v = float(node)  # type: ignore[arg-type]
            return default if (_math.isnan(v) or _math.isinf(v)) else v
        except (TypeError, ValueError):
            return default

    sox        = _f("us_market.sox_ret")
    tsm_adr    = _f("us_market.tsm_adr_ret")
    nvda       = _f("us_market.nvda_ret")
    nasdaq     = _f("us_market.nasdaq_ret")
    vix        = _f("us_market.vix")
    night_chg  = _f("night_session.change") if market_data.get("night_session") else float("nan")
    night_trend = (market_data.get("night_session") or {}).get("last_hour_trend", "—")
    fut_net    = _f("foreign_capital.futures_net")
    pcr        = _f("foreign_capital.pcr")
    prob_up    = _f("xgb_prob_up", 0.5)

    # ── 訊號計分（+1 多方、-1 空方）─────────────────────────────────────────
    bull_score = 0
    bear_score = 0
    risk_notes: list[str] = []

    # 費半 / TSM ADR / NVDA（台股最強連動）
    if not _math.isnan(sox):
        if sox >= 0.025:
            bull_score += 2
        elif sox >= 0.01:
            bull_score += 1
        elif sox <= -0.02:
            bear_score += 2
        elif sox <= -0.01:
            bear_score += 1

    if not _math.isnan(tsm_adr):
        if tsm_adr >= 0.03:
            bull_score += 2
        elif tsm_adr >= 0.01:
            bull_score += 1
        elif tsm_adr <= -0.02:
            bear_score += 2
        elif tsm_adr <= -0.01:
            bear_score += 1

    if not _math.isnan(nvda):
        if nvda >= 0.03:
            bull_score += 1
        elif nvda <= -0.03:
            bear_score += 1

    # VIX 恐慌指數
    if not _math.isnan(vix):
        if vix >= 30:
            bear_score += 2
            risk_notes.append("VIX 恐慌指數偏高，波動劇烈謹慎操作")
        elif vix >= 22:
            bear_score += 1
            risk_notes.append("VIX 偏高，注意假突破風險")

    # 夜盤變化
    if not _math.isnan(night_chg):
        if night_chg >= 100:
            bull_score += 1
        elif night_chg <= -100:
            bear_score += 1

    # 夜盤末段走向
    if "走弱" in night_trend:
        bear_score += 1
        risk_notes.append("夜盤末段收弱，追價動能不足")
    elif "偏強" in night_trend:
        bull_score += 1

    # 外資期貨未平倉
    if not _math.isnan(fut_net):
        if fut_net >= 10000:
            bull_score += 1
        elif fut_net <= -10000:
            bear_score += 1

    # PCR
    if not _math.isnan(pcr):
        if pcr >= 1.3:
            bull_score += 1
        elif pcr <= 0.7:
            bear_score += 1
            risk_notes.append("PCR 偏低，空方籌碼偏多")

    # XGBoost 預測
    if prob_up >= 0.6:
        bull_score += 1
    elif prob_up <= 0.4:
        bear_score += 1

    # ── 判斷今日偏向 ───────────────────────────────────────────────────────
    net = bull_score - bear_score
    if vix >= 30 and not _math.isnan(vix):
        bias = "偏空（高波動警戒）"
    elif net >= 3:
        bias = "偏多"
    elif net >= 1:
        bias = "小幅偏多"
    elif net <= -3:
        bias = "偏空"
    elif net <= -1:
        bias = "小幅偏空"
    else:
        bias = "震盪"

    # ── 劇本判斷 ──────────────────────────────────────────────────────────
    strong_us = (not _math.isnan(sox) and sox >= 0.02) or (not _math.isnan(tsm_adr) and tsm_adr >= 0.025)
    night_up  = not _math.isnan(night_chg) and night_chg >= 50
    night_down = not _math.isnan(night_chg) and night_chg <= -50
    night_weak_end = "走弱" in night_trend

    if strong_us and night_up and not night_weak_end:
        scenario = "開高走高（美股強勢 + 夜盤正面）"
    elif strong_us and night_weak_end:
        scenario = "開高走低（美股強但夜盤末段收弱，追價力道不足）"
    elif strong_us and not night_up and not night_down:
        scenario = "開高震盪（美股偏強，等待現貨確認）"
    elif night_down and not strong_us:
        scenario = "開低走低（夜盤弱勢）"
    elif night_down and strong_us:
        scenario = "開低走高（夜盤跌但美股相對強，注意低接）"
    elif net >= 2:
        scenario = "溫和偏多，無明顯跳空"
    elif net <= -2:
        scenario = "溫和偏空，無明顯跳空"
    else:
        scenario = "方向不明，區間震盪"

    # ── 市場類型分類 ───────────────────────────────────────────────────────
    heavy_short = not _math.isnan(fut_net) and fut_net <= -35000
    extreme_short = not _math.isnan(fut_net) and fut_net <= -45000
    if not _math.isnan(vix) and vix >= 30:
        mkt_type = "⚡ 極端波動日"
    elif abs(net) >= 4 and strong_us and not night_weak_end:
        mkt_type = "🔥 強趨勢日"
    elif heavy_short and strong_us and night_weak_end:
        mkt_type = "⚠️ 假突破日（軋空風險）"
    elif net <= -2 and not _math.isnan(night_chg) and night_chg <= -100:
        mkt_type = "📉 開低走低（偏空趨勢）"
    elif net >= 2 and not _math.isnan(night_chg) and night_chg >= 100:
        mkt_type = "📈 開高走高（偏多趨勢）"
    elif (not _math.isnan(vix) and vix >= 22) or (not _math.isnan(fut_net) and abs(fut_net) >= 30000):
        mkt_type = "🔄 多空雙巴日"
    else:
        mkt_type = "😴 低波動震盪日"

    # ── 主力劇本 ──────────────────────────────────────────────────────────
    if not _math.isnan(fut_net):
        fut_net_str = f"{int(fut_net):+,}"
        if fut_net <= -40000 and net >= 0:
            main_scenario = (
                f"外資空單 {fut_net_str} 口（極重），若開盤未大跌可能先軋空拉高，"
                "之後再轉弱，禁止追多反彈"
            )
        elif fut_net <= -30000 and net < 0:
            main_scenario = (
                f"外資空單 {fut_net_str} 口，大方向偏空。"
                "早盤小幅反彈屬空方回補，非真正轉多，等 ORB 確認再做空"
            )
        elif fut_net >= 20000 and net > 0:
            main_scenario = (
                f"外資多單 {fut_net_str} 口，偏多格局。"
                "回測支撐低接，避免追高"
            )
        elif net >= 3:
            main_scenario = "多方訊號強，趨勢做多，但留意過熱後的急跌洗盤"
        elif net <= -3:
            main_scenario = "空方訊號強，趨勢做空，反彈視為加碼機會"
        else:
            main_scenario = "多空訊號混雜，區間操作為主，等突破確認再順勢"
    else:
        main_scenario = "外資籌碼資料不足，依技術面操作"

    # ── 最佳策略 ──────────────────────────────────────────────────────────
    if not _math.isnan(vix) and vix >= 28:
        best_strategy = "不交易（VIX 過高，波動難控）"
    elif "假突破" in mkt_type:
        best_strategy = "反彈至 VWAP 附近做空 / 等開盤15分鐘觀察方向"
    elif "開高走低" in scenario:
        best_strategy = "等開高後回測 ORB 低點確認做空"
    elif net >= 3 and not night_weak_end:
        best_strategy = "ORB 上破即做多，回測 ORB 高點加碼"
    elif net <= -3:
        best_strategy = "ORB 下破即做空，反彈 VWAP 附近加空"
    else:
        best_strategy = "觀察開盤15分鐘，等 ORB 突破方向再進場"

    # ── 危險訊號 ──────────────────────────────────────────────────────────
    dangers: list[str] = []
    if extreme_short:
        dangers.append(f"軋空風險極高（外資空單 {int(fut_net):,} 口）")
    elif heavy_short:
        dangers.append(f"軋空風險（外資空單 {int(fut_net):,} 口過重）")
    if not _math.isnan(vix) and vix >= 25:
        dangers.append(f"VIX {vix:.0f} 偏高，注意假突破洗盤")
    if not _math.isnan(pcr) and pcr > 1.5:
        dangers.append(f"PCR {pcr:.2f} 恐慌偏高，留意技術反彈")
    if not _math.isnan(night_chg) and abs(night_chg) > 200:
        dir_str = "向上" if night_chg > 0 else "向下"
        dangers.append(f"夜盤缺口 {int(night_chg):+} 點（{dir_str}跳空過大，易反轉）")
    if not dangers:
        dangers.append("無重大警示，正常操作")
    danger_str = " · ".join(dangers)

    # ── 禁止交易條件 ──────────────────────────────────────────────────────
    forbidden: list[str] = []
    if not _math.isnan(vix) and vix >= 28:
        forbidden.append("禁止 ORB 策略（VIX 過高）")
    if not _math.isnan(night_chg) and abs(night_chg) > 200:
        dir_str = "多" if night_chg > 0 else "空"
        forbidden.append(f"禁止追{dir_str}缺口超過 200 點")
    if fut_net <= -40000 and not _math.isnan(fut_net):
        forbidden.append("禁止反彈高點追多（軋空陷阱）")
    if not forbidden:
        forbidden.append("無特別限制")
    forbidden_str = " · ".join(forbidden)

    # ── 勝率估計 ──────────────────────────────────────────────────────────
    win_base = 50 + net * 6
    if "趨勢" in mkt_type:
        win_base += 8
    if "雙巴" in mkt_type or "假突破" in mkt_type:
        win_base -= 10
    if not _math.isnan(vix) and vix >= 28:
        win_base -= 8
    win_rate = max(30, min(72, round(win_base)))
    direction_label = "偏多" if net > 0 else "偏空" if net < 0 else "中性"

    # ── ORB 建議（向後相容）───────────────────────────────────────────────
    if not _math.isnan(vix) and vix >= 28:
        orb = "不交易（波動過大）"
    elif "開高走低" in scenario or "假突破" in scenario:
        orb = "做回測（小心開高走低）"
    elif net >= 3 and not night_weak_end:
        orb = "做突破（多方強勢格局）"
    elif net <= -3:
        orb = "做空突破（空方格局）"
    else:
        orb = "觀察開盤15分鐘再決策"

    # ── 風險提示 ──────────────────────────────────────────────────────────
    if not risk_notes:
        if abs(net) <= 1:
            risk_notes.append("多空訊號不明確，輕倉觀察")
        elif net >= 3:
            risk_notes.append("訊號偏多但避免追高，等回測確認")
        else:
            risk_notes.append("訊號偏空，注意反彈陷阱")

    lines = [
        f"📊 市場類型：{mkt_type}",
        f"📋 主力劇本：{main_scenario}",
        f"🎯 最佳策略：{best_strategy}",
        f"⚡ 危險訊號：{danger_str}",
        f"🚫 禁止交易：{forbidden_str}",
        f"📈 勝率估計：{direction_label}策略 ~{win_rate}%",
    ]
    return "\n".join(lines)


def format_us_block(us_df: "pd.DataFrame") -> str:
    """Format latest US market snapshot as a Discord block. Returns '' if no data."""
    if us_df is None or us_df.empty:
        return ""
    row = us_df.iloc[-1]

    def _pct(col: str) -> str:
        v = row.get(col)
        if v is None or (hasattr(v, "__float__") and __import__("math").isnan(float(v))):
            return "N/A"
        return f"{float(v)*100:+.1f}%"

    def _val(col: str, decimals: int = 1) -> str:
        v = row.get(col)
        if v is None or (hasattr(v, "__float__") and __import__("math").isnan(float(v))):
            return "N/A"
        return f"{float(v):.{decimals}f}"

    line1_parts = []
    for label, col in [("S&P", "sp500_ret1"), ("NASDAQ", "nasdaq_ret1"), ("SOX", "sox_ret1")]:
        line1_parts.append(f"{label} `{_pct(col)}`")
    line2_parts = []
    for label, col in [("TSM ADR", "tsm_adr_ret1"), ("NVDA", "nvda_ret1")]:
        line2_parts.append(f"{label} `{_pct(col)}`")
    line2_parts.append(f"VIX `{_val('vix', 1)}`")

    lines = ["📊 **美股（昨收）**", "   " + " | ".join(line1_parts), "   " + " | ".join(line2_parts)]
    return "\n".join(lines)


# ── Discord formatter ──────────────────────────────────────────────────────────

_CONF_EMOJI = {"high": "🟢", "medium": "🟡", "low": "⚪"}
_LABEL_EMOJI = {"看多": "📈", "偏多": "↗", "看空": "📉", "偏空": "↘", "中性": "→"}


def format_prediction_block(
    pred: dict[str, Any],
    breadth: dict[str, object] | None = None,
    *,
    futures_block: str = "",
    news_block: str = "",
    calendar_block: str = "",
    us_block: str = "",
    night_block: str = "",
    chipset_block: str = "",
    taiex_block: str = "",
    scenario_block: str = "",
) -> str:
    if not pred.get("trained"):
        return ""
    prob = pred["prob_up"]
    label = pred.get("label", "中性")
    conf = pred.get("confidence", "low")
    horizon = pred.get("horizon", 5)
    us_tag = " 🌐" if pred.get("us_features") else ""
    prob_pct = f"{prob * 100:.0f}%"
    bull_bar = int(prob * 10)
    bear_bar = 10 - bull_bar
    bar = "█" * bull_bar + "░" * bear_bar

    lines = [
        f"🤖 **AI預測** ({horizon}日){us_tag}  {_LABEL_EMOJI.get(label, '→')} "
        f"`{label}` · 多方 `{prob_pct}` {_CONF_EMOJI.get(conf, '⚪')}",
        f"   `{bar}` 空方 `{(1-prob)*100:.0f}%`",
    ]
    if us_block:
        lines.append("")
        lines.append(us_block)
    if night_block:
        lines.append("")
        lines.append(night_block)
    if chipset_block:
        lines.append("")
        lines.append(chipset_block)
    if taiex_block:
        lines.append("")
        lines.append(taiex_block)
    if futures_block:
        lines.append("")
        lines.append(futures_block)
    if scenario_block:
        lines.append("")
        lines.append(scenario_block)
    if news_block:
        lines.append("")
        lines.append(news_block)
    if calendar_block:
        lines.append("")
        lines.append(calendar_block)
    return "\n".join(lines)
