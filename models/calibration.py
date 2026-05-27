"""Probability calibration wrapper to prevent overconfident predictions."""
from __future__ import annotations

import pickle
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


class CalibratedPredictor:
    """Wraps any sklearn-compatible estimator with probability calibration.

    Uses isotonic regression by default — empirically better for XGBoost
    than Platt scaling on small/medium datasets.
    """

    def __init__(self, base_model: Any, method: str = "isotonic", cv: int = 3):
        self.base_model = base_model
        self.method = method
        self.cv = cv
        self._calibrated: Any = None

    def fit(self, X: pd.DataFrame, y: pd.Series) -> "CalibratedPredictor":
        from sklearn.calibration import CalibratedClassifierCV

        self._calibrated = CalibratedClassifierCV(
            self.base_model, method=self.method, cv=self.cv
        )
        self._calibrated.fit(X, y)
        return self

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        if self._calibrated is None:
            raise RuntimeError("CalibratedPredictor has not been fitted yet.")
        return self._calibrated.predict_proba(X)

    def prob_up(self, X: pd.DataFrame) -> float:
        proba = self.predict_proba(X)
        return float(proba[0, 1])

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            pickle.dump(self, f)

    @classmethod
    def load(cls, path: str | Path) -> "CalibratedPredictor":
        with open(path, "rb") as f:
            return pickle.load(f)
