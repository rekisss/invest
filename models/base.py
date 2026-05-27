"""Base protocol for all predictors in the system."""
from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

import numpy as np
import pandas as pd


@runtime_checkable
class Predictor(Protocol):
    """Minimal interface every model must implement."""

    def fit(self, X: pd.DataFrame, y: pd.Series) -> "Predictor": ...

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        """Return shape (n_samples, 2) with [prob_down, prob_up]."""
        ...

    def save(self, path: str | Path) -> None: ...

    @classmethod
    def load(cls, path: str | Path) -> "Predictor": ...
