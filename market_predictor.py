"""
market_predictor.py – XGBoost market-direction predictor for Taiwan TAIEX.

Uses only data already fetched by the scanner (TAIEX history + breadth metrics)
so it adds zero extra API calls.  When scikit-learn / xgboost are not installed
the module degrades gracefully and returns a neutral result.

Public API
----------
MarketPredictor.fit(market_df, breadth_history)
MarketPredictor.predict_proba(market_df, breadth_history) -> dict
format_prediction_block(pred_dict) -> str   (Discord markdown)
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

# Optional heavy deps — graceful degradation if absent
try:
    from xgboost import XGBClassifier
    from sklearn.calibration import CalibratedClassifierCV
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.preprocessing import StandardScaler
    _DEPS_OK = True
except ImportError:
    _DEPS_OK = False


# ── Feature engineering ────────────────────────────────────────────────────────

def _pct_change(series: pd.Series, n: int) -> pd.Series:
    return series.pct_change(n).replace([np.inf, -np.inf], np.nan)


def _rolling_std(series: pd.Series, n: int) -> pd.Series:
    return series.rolling(n, min_periods=max(1, n // 2)).std()


def build_market_features(market_df: pd.DataFrame, breadth_history: pd.DataFrame | None = None) -> pd.DataFrame:
    """
    Build feature matrix from TAIEX daily OHLCV + optional breadth history.

    market_df columns expected: date, close  (open/high/low/volume optional)
    breadth_history columns expected: date + any numeric breadth columns
        e.g. pct_above_ema60, pct_macd_gc, pct_foreign_buy, etc.
    """
    df = market_df.copy().sort_values("date").reset_index(drop=True)
    c = df["close"]

    # Price momentum
    for n in (1, 3, 5, 10, 20, 60):
        df[f"ret_{n}d"] = _pct_change(c, n)

    # Volatility
    df["vol_5d"]  = _rolling_std(_pct_change(c, 1), 5)
    df["vol_20d"] = _rolling_std(_pct_change(c, 1), 20)

    # Moving averages
    for n in (5, 10, 20, 60):
        ma = c.rolling(n, min_periods=1).mean()
        df[f"above_ma{n}"] = (c > ma).astype(float)
        df[f"dist_ma{n}"]  = (c - ma) / ma.replace(0, np.nan)

    # RSI-14 (simplified)
    delta = c.diff()
    gain = delta.clip(lower=0).ewm(alpha=1/14, adjust=False).mean()
    loss = (-delta).clip(lower=0).ewm(alpha=1/14, adjust=False).mean()
    df["rsi14"] = 100 - 100 / (1 + gain / loss.replace(0, np.nan))

    # MACD signal
    ema12 = c.ewm(span=12, adjust=False).mean()
    ema26 = c.ewm(span=26, adjust=False).mean()
    macd  = ema12 - ema26
    sig   = macd.ewm(span=9, adjust=False).mean()
    df["macd_hist"]       = macd - sig
    df["macd_above_zero"] = (macd > 0).astype(float)
    df["macd_gc"]         = ((macd > sig) & (macd.shift(1) <= sig.shift(1))).astype(float)

    # Drawdown from 20-day high
    high20 = c.rolling(20, min_periods=1).max()
    df["dd_from_high20"] = (c - high20) / high20.replace(0, np.nan)

    # Volume ratio (if available)
    if "volume" in df.columns:
        vol = pd.to_numeric(df["volume"], errors="coerce")
        vol_ma20 = vol.rolling(20, min_periods=1).mean()
        df["volume_ratio"] = vol / vol_ma20.replace(0, np.nan)
    else:
        df["volume_ratio"] = np.nan

    # Merge breadth history if provided
    if breadth_history is not None and not breadth_history.empty:
        bh = breadth_history.copy()
        bh["date"] = pd.to_datetime(bh["date"])
        df["date"] = pd.to_datetime(df["date"])
        numeric_cols = bh.select_dtypes(include="number").columns.tolist()
        df = df.merge(bh[["date"] + numeric_cols], on="date", how="left")

    return df


def _feature_cols(df: pd.DataFrame) -> list[str]:
    """Return the list of numeric feature columns (excluding target and metadata)."""
    skip = {"date", "close", "open", "high", "low", "volume", "amount", "target"}
    return [c for c in df.columns if c not in skip and pd.api.types.is_numeric_dtype(df[c])]


def _add_target(df: pd.DataFrame, horizon: int = 5) -> pd.DataFrame:
    """Binary target: 1 if close[t+horizon] > close[t], else 0."""
    df = df.copy()
    df["target"] = (df["close"].shift(-horizon) > df["close"]).astype(float)
    return df


# ── Predictor class ────────────────────────────────────────────────────────────

@dataclass
class MarketPredictor:
    """
    Thin wrapper around XGBoost + isotonic calibration for market direction.

    Usage::
        pred = MarketPredictor()
        pred.fit(market_df)                   # train on full history
        result = pred.predict_proba(market_df) # predict latest bar
    """
    horizon: int = 5                        # predict N-day forward return
    min_train_rows: int = 120               # minimum bars needed to train
    _model: Any = field(default=None, init=False, repr=False)
    _scaler: Any = field(default=None, init=False, repr=False)
    _feature_names: list[str] = field(default_factory=list, init=False, repr=False)
    _trained: bool = field(default=False, init=False, repr=False)

    def fit(
        self,
        market_df: pd.DataFrame,
        breadth_history: pd.DataFrame | None = None,
    ) -> "MarketPredictor":
        if not _DEPS_OK:
            return self
        feat_df = build_market_features(market_df, breadth_history)
        feat_df = _add_target(feat_df, self.horizon)
        feat_df = feat_df.dropna(subset=["target"])

        cols = _feature_cols(feat_df)
        X = feat_df[cols].copy()
        y = feat_df["target"].values

        # Drop columns that are entirely NaN
        valid_cols = [c for c in cols if X[c].notna().sum() >= self.min_train_rows // 2]
        X = X[valid_cols].fillna(X[valid_cols].median())

        if len(X) < self.min_train_rows or len(np.unique(y)) < 2:
            return self

        self._feature_names = valid_cols

        scaler = StandardScaler()
        X_s = scaler.fit_transform(X)

        base = XGBClassifier(
            n_estimators=300,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            min_child_weight=3,
            gamma=0.1,
            reg_alpha=0.1,
            reg_lambda=1.0,
            use_label_encoder=False,
            eval_metric="logloss",
            verbosity=0,
            random_state=42,
        )
        tscv = TimeSeriesSplit(n_splits=3)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model = CalibratedClassifierCV(base, cv=tscv, method="isotonic")
            model.fit(X_s, y)

        self._model = model
        self._scaler = scaler
        self._trained = True
        return self

    def predict_proba(
        self,
        market_df: pd.DataFrame,
        breadth_history: pd.DataFrame | None = None,
    ) -> dict[str, Any]:
        """
        Return dict with keys:
            prob_up      – float 0-1, probability that next `horizon` days close > today
            confidence   – "high" / "medium" / "low"
            label        – short Chinese label
            horizon      – int (days)
            trained      – bool
            n_features   – int
        """
        default = {
            "prob_up": 0.5,
            "confidence": "low",
            "label": "資料不足",
            "horizon": self.horizon,
            "trained": False,
            "n_features": 0,
        }
        if not _DEPS_OK or not self._trained:
            return {**default, "label": "模組未安裝" if not _DEPS_OK else "訓練資料不足"}

        feat_df = build_market_features(market_df, breadth_history)
        feat_df = feat_df.dropna(subset=["ret_1d"])  # need at least 1 bar of returns

        row = feat_df.iloc[[-1]][self._feature_names].copy()
        row = row.fillna(feat_df[self._feature_names].median())
        X_s = self._scaler.transform(row)

        prob = float(self._model.predict_proba(X_s)[0, 1])

        if prob >= 0.65:
            conf, label = "high",   "看多"
        elif prob >= 0.55:
            conf, label = "medium", "偏多"
        elif prob <= 0.35:
            conf, label = "high",   "看空"
        elif prob <= 0.45:
            conf, label = "medium", "偏空"
        else:
            conf, label = "low",    "中性"

        return {
            "prob_up": prob,
            "confidence": conf,
            "label": label,
            "horizon": self.horizon,
            "trained": True,
            "n_features": len(self._feature_names),
        }


# ── Discord formatter ──────────────────────────────────────────────────────────

_CONF_EMOJI = {"high": "🟢", "medium": "🟡", "low": "⚪"}
_LABEL_EMOJI = {"看多": "📈", "偏多": "↗", "看空": "📉", "偏空": "↘", "中性": "→"}


def format_prediction_block(pred: dict[str, Any]) -> str:
    """Return a single Discord markdown line for the AI prediction."""
    if not pred.get("trained"):
        return ""
    prob = pred["prob_up"]
    label = pred.get("label", "中性")
    conf = pred.get("confidence", "low")
    horizon = pred.get("horizon", 5)
    conf_emoji = _CONF_EMOJI.get(conf, "⚪")
    dir_emoji = _LABEL_EMOJI.get(label, "→")
    prob_pct = f"{prob * 100:.0f}%"
    return (
        f"🤖 **AI預測** ({horizon}日) {dir_emoji} `{label}` · 看多概率 `{prob_pct}` {conf_emoji}"
    )
