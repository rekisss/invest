"""
market_predictor.py – Lightweight XGBoost market-direction predictor for TAIEX.

Uses only TAIEX history already fetched by the scanner — zero extra API calls.
Degrades gracefully when xgboost/sklearn are not installed.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

try:
    from xgboost import XGBClassifier
    _DEPS_OK = True
except ImportError:
    _DEPS_OK = False


# ── Feature engineering ────────────────────────────────────────────────────────

def _build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute a small set of momentum/trend features from TAIEX close prices."""
    c = df["close"]

    # Momentum (5 features)
    for n in (1, 5, 10, 20):
        df[f"ret_{n}d"] = c.pct_change(n)
    df["vol_10d"] = c.pct_change(1).rolling(10, min_periods=3).std()

    # Trend vs moving averages (4 features)
    for n in (10, 20, 60):
        ma = c.rolling(n, min_periods=1).mean()
        df[f"dist_ma{n}"] = (c - ma) / ma.replace(0, np.nan)
    df["above_ma60"] = (c > c.rolling(60, min_periods=1).mean()).astype(float)

    # RSI-14 (1 feature)
    delta = c.diff()
    gain = delta.clip(lower=0).ewm(alpha=1/14, adjust=False).mean()
    loss = (-delta).clip(lower=0).ewm(alpha=1/14, adjust=False).mean()
    df["rsi14"] = 100 - 100 / (1 + gain / loss.replace(0, np.nan))

    # MACD histogram (1 feature)
    macd = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()
    df["macd_hist"] = macd - macd.ewm(span=9, adjust=False).mean()

    return df


_FEATURE_COLS = [
    "ret_1d", "ret_5d", "ret_10d", "ret_20d", "vol_10d",
    "dist_ma10", "dist_ma20", "dist_ma60", "above_ma60",
    "rsi14", "macd_hist",
]


# ── Predictor ─────────────────────────────────────────────────────────────────

@dataclass
class MarketPredictor:
    horizon: int = 5
    min_train_rows: int = 60
    _model: Any = field(default=None, init=False, repr=False)
    _medians: Any = field(default=None, init=False, repr=False)
    _trained: bool = field(default=False, init=False, repr=False)

    def fit(self, market_df: pd.DataFrame) -> "MarketPredictor":
        if not _DEPS_OK:
            return self
        df = _build_features(market_df.copy().sort_values("date").reset_index(drop=True))
        df["target"] = (df["close"].shift(-self.horizon) > df["close"]).astype(float)
        df = df.dropna(subset=["target"] + _FEATURE_COLS)
        if len(df) < self.min_train_rows or df["target"].nunique() < 2:
            return self

        self._medians = df[_FEATURE_COLS].median()
        X = df[_FEATURE_COLS].fillna(self._medians).values
        y = df["target"].values

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self._model = XGBClassifier(
                n_estimators=100,
                max_depth=3,
                learning_rate=0.1,
                subsample=0.8,
                colsample_bytree=0.8,
                eval_metric="logloss",
                verbosity=0,
                random_state=42,
            ).fit(X, y)

        self._trained = True
        return self

    def predict_proba(self, market_df: pd.DataFrame) -> dict[str, Any]:
        default: dict[str, Any] = {
            "prob_up": 0.5, "confidence": "low", "label": "資料不足",
            "horizon": self.horizon, "trained": False,
        }
        if not _DEPS_OK or not self._trained:
            return {**default, "label": "模組未安裝" if not _DEPS_OK else "訓練資料不足"}

        df = _build_features(market_df.copy().sort_values("date").reset_index(drop=True))
        row = df[_FEATURE_COLS].iloc[[-1]].fillna(self._medians)
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

        return {"prob_up": prob, "confidence": conf, "label": label,
                "horizon": self.horizon, "trained": True}


# ── Discord formatter ──────────────────────────────────────────────────────────

_CONF_EMOJI = {"high": "🟢", "medium": "🟡", "low": "⚪"}
_LABEL_EMOJI = {"看多": "📈", "偏多": "↗", "看空": "📉", "偏空": "↘", "中性": "→"}


def format_prediction_block(pred: dict[str, Any]) -> str:
    if not pred.get("trained"):
        return ""
    prob = pred["prob_up"]
    label = pred.get("label", "中性")
    conf = pred.get("confidence", "low")
    horizon = pred.get("horizon", 5)
    prob_pct = f"{prob * 100:.0f}%"
    return (
        f"🤖 **AI預測** ({horizon}日) {_LABEL_EMOJI.get(label, '→')} "
        f"`{label}` · 看多概率 `{prob_pct}` {_CONF_EMOJI.get(conf, '⚪')}"
    )
