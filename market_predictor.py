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
}


def fetch_us_features(start_date: str, end_date: str) -> pd.DataFrame:
    """Download US market indicators via yfinance. Returns empty DataFrame on failure."""
    if not _YF_OK:
        return pd.DataFrame()
    try:
        end_dt = (datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=2)).strftime("%Y-%m-%d")

        # Download each ticker individually so one failure doesn't drop all features
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

        if failed:
            print(f"[ai] yfinance 跳過失敗 ticker: {failed}", file=sys.stderr)
        if not col_frames:
            return pd.DataFrame()

        closes = pd.concat(col_frames, axis=1)
        closes.index = pd.to_datetime(closes.index).tz_localize(None)
        closes.index.name = "date"
        result = closes.reset_index()

        # Compute 1-day returns and 5-day returns for each
        for col in [c for c in _US_TICKERS if c in result.columns]:
            result[f"{col}_ret1"] = result[col].pct_change(1)
            result[f"{col}_ret5"] = result[col].pct_change(5)

        # Keep only derived features + date (drop raw prices to save memory)
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
    for n in (1, 5, 10, 20):
        df[f"ret_{n}d"] = c.pct_change(n)
    df["vol_10d"] = c.pct_change(1).rolling(10, min_periods=3).std()
    for n in (10, 20, 60):
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
    "ret_1d", "ret_5d", "ret_10d", "ret_20d", "vol_10d",
    "dist_ma10", "dist_ma20", "dist_ma60", "above_ma60",
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

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self._model = XGBClassifier(
                n_estimators=100, max_depth=3, learning_rate=0.1,
                subsample=0.8, colsample_bytree=0.8,
                eval_metric="logloss", verbosity=0, random_state=42,
            ).fit(X, y)

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
    """Call Claude API with structured market JSON → qualitative TX scenario text.

    Returns empty string if ANTHROPIC_API_KEY is not set or on any failure.
    """
    import json
    import os
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return ""
    try:
        import anthropic
        _client = anthropic.Anthropic(api_key=api_key)
        prompt = (
            "你是專業台指期交易員。根據以下市場資料：\n"
            f"{json.dumps(market_data, ensure_ascii=False, indent=2)}\n\n"
            "請輸出（簡短5行）：\n"
            "1. 今日偏多/偏空/震盪\n"
            "2. 最可能劇本：開高走高 / 開高走低 / 開低走高 / 開低走低\n"
            "3. ORB 建議：做突破 / 做回測 / 不交易\n"
            "4. 關鍵支撐壓力（2個點位）\n"
            "5. 風險提示（1句話）\n"
            "格式：純文字，每項一行，不加 markdown 符號。"
        )
        msg = _client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text.strip()
    except Exception as exc:
        print(f"[ai] Claude 劇本分析失敗（graceful skip）: {exc}", file=sys.stderr)
        return ""


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
    if futures_block:
        lines.append("")
        lines.append(futures_block)
    analysis = generate_analysis_text(pred, breadth)
    if analysis:
        lines.append("")
        lines.append(analysis)
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
