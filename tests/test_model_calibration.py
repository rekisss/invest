"""
Tests for /home/user/invest/model_calibration.py

Run with:  pytest tests/test_model_calibration.py -v
"""
from __future__ import annotations

import sys
import os

# Ensure the project root is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
import numpy as np

from model_calibration import evaluate_calibration, calibration_summary, load_model


# ---------------------------------------------------------------------------
# TestEvaluateCalibration
# ---------------------------------------------------------------------------

class TestEvaluateCalibration:
    """Tests for evaluate_calibration()."""

    def _make_perfect_data(self):
        y_true = [1] * 50 + [0] * 50
        y_proba = [0.9] * 50 + [0.1] * 50
        return y_true, y_proba

    def test_perfect_calibration(self):
        """Well-separated predictions should yield a low Brier score."""
        y_true, y_proba = self._make_perfect_data()
        result = evaluate_calibration(y_true, y_proba)
        assert result["brier_score"] < 0.1, (
            f"Expected brier_score < 0.1, got {result['brier_score']}"
        )

    def test_returns_required_keys(self):
        """Result dict must contain all required keys."""
        y_true, y_proba = self._make_perfect_data()
        result = evaluate_calibration(y_true, y_proba)
        for key in ("brier_score", "ece", "n_bins", "reliability_data"):
            assert key in result, f"Missing key: {key}"

    def test_reliability_data_length(self):
        """reliability_data length must be <= n_bins (empty bins are skipped)."""
        y_true, y_proba = self._make_perfect_data()
        n_bins = 10
        result = evaluate_calibration(y_true, y_proba, n_bins=n_bins)
        assert len(result["reliability_data"]) <= n_bins, (
            f"Expected len(reliability_data) <= {n_bins}, "
            f"got {len(result['reliability_data'])}"
        )
        assert result["n_bins"] == n_bins

    def test_bad_calibration_high_brier(self):
        """Inverted predictions should yield a high Brier score (> 0.5)."""
        y_true = [1, 0, 1, 0]
        y_proba = [0.1, 0.9, 0.1, 0.9]
        result = evaluate_calibration(y_true, y_proba)
        assert result["brier_score"] > 0.5, (
            f"Expected brier_score > 0.5, got {result['brier_score']}"
        )


# ---------------------------------------------------------------------------
# TestCalibrationSummary
# ---------------------------------------------------------------------------

class TestCalibrationSummary:
    """Tests for calibration_summary()."""

    def _data(self):
        rng = np.random.default_rng(42)
        y_true = rng.integers(0, 2, size=200)
        # Raw: overconfident (push towards extremes)
        raw_proba = np.where(y_true == 1, 0.95, 0.05).astype(float)
        raw_proba += rng.normal(0, 0.05, size=200)
        raw_proba = np.clip(raw_proba, 0.0, 1.0)
        # Calibrated: predictions closer to true fraction (~0.5)
        calibrated_proba = np.where(y_true == 1, 0.65, 0.35).astype(float)
        calibrated_proba += rng.normal(0, 0.05, size=200)
        calibrated_proba = np.clip(calibrated_proba, 0.0, 1.0)
        return y_true, raw_proba, calibrated_proba

    def test_returns_string(self):
        """calibration_summary must return a non-empty string."""
        y_true, raw, cal = self._data()
        result = calibration_summary(y_true, raw, cal)
        assert isinstance(result, str)
        assert len(result) > 0

    def test_shows_improvement(self):
        """When calibrated is better than raw, '改善' should appear in output."""
        # Construct a clear improvement scenario
        n = 200
        y_true = np.array([1] * n + [0] * n)
        # Raw: very overconfident
        raw_proba = np.array([0.99] * n + [0.01] * n, dtype=float)
        # Calibrated: moderate predictions (lower Brier)
        calibrated_proba = np.array([0.75] * n + [0.25] * n, dtype=float)

        result = calibration_summary(y_true, raw_proba, calibrated_proba)
        assert "改善" in result, (
            f"Expected '改善' in summary when calibrated is better.\nGot:\n{result}"
        )


# ---------------------------------------------------------------------------
# TestLoadModel
# ---------------------------------------------------------------------------

class TestLoadModel:
    """Tests for load_model()."""

    def test_file_not_found(self):
        """load_model must raise FileNotFoundError for a non-existent path."""
        with pytest.raises(FileNotFoundError):
            load_model("/tmp/this_file_does_not_exist_ever_xyz.pkl")
