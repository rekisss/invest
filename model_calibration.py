"""
Model probability calibration utilities.

Wraps sklearn's CalibratedClassifierCV to fix overconfident XGBoost predictions.
Also provides utilities to load existing pkl models, calibrate them, and save
the calibrated version — without modifying the original model files.

Standalone module — no existing files modified.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, List, Tuple


def load_model(model_path: str) -> object:
    """Load a pickled model from model_path.

    Tries joblib first; falls back to pickle if joblib is unavailable.
    Raises FileNotFoundError if the file does not exist.
    """
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model file not found: {model_path}")

    try:
        import joblib
        return joblib.load(model_path)
    except ImportError:
        import pickle
        with open(model_path, "rb") as f:
            return pickle.load(f)


def calibrate_model(
    base_model: Any,
    X_train,
    y_train,
    method: str = "isotonic",
    cv: int = 5,
) -> object:
    """Wrap base_model with CalibratedClassifierCV and fit on training data.

    Parameters
    ----------
    base_model : sklearn-compatible estimator
    X_train : array-like of shape (n_samples, n_features)
    y_train : array-like of shape (n_samples,)
    method : "isotonic" (default, better for larger datasets) or "sigmoid" (Platt scaling)
    cv : number of cross-validation folds

    Returns
    -------
    Fitted CalibratedClassifierCV instance.
    """
    from sklearn.calibration import CalibratedClassifierCV

    calibrated = CalibratedClassifierCV(base_model, method=method, cv=cv)
    calibrated.fit(X_train, y_train)
    return calibrated


def save_calibrated_model(calibrated_model: Any, output_path: str) -> None:
    """Save a calibrated model to output_path.

    Creates parent directories if they don't exist.
    Tries joblib first; falls back to pickle.
    """
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    try:
        import joblib
        joblib.dump(calibrated_model, str(path))
    except ImportError:
        import pickle
        with open(str(path), "wb") as f:
            pickle.dump(calibrated_model, f)


def calibrate_from_file(
    model_path: str,
    X_train,
    y_train,
    output_suffix: str = "_calibrated",
    method: str = "isotonic",
) -> str:
    """Load, calibrate, and save a model from a .pkl file.

    Parameters
    ----------
    model_path : path to the source .pkl model
    X_train, y_train : training data for calibration
    output_suffix : appended before .pkl extension in output filename
    method : calibration method passed to calibrate_model

    Returns
    -------
    Output path string on success, empty string on failure.
    """
    try:
        base_model = load_model(model_path)
        calibrated = calibrate_model(base_model, X_train, y_train, method=method)
        output_path = model_path.replace(".pkl", f"{output_suffix}.pkl")
        save_calibrated_model(calibrated, output_path)
        return output_path
    except Exception as exc:
        print(f"[calibrate_from_file] Warning: {exc}")
        return ""


def evaluate_calibration(y_true, y_proba, n_bins: int = 10) -> dict:
    """Compute calibration quality metrics.

    Parameters
    ----------
    y_true : array-like of true binary labels
    y_proba : array-like of predicted probabilities for the positive class
    n_bins : number of equal-width bins

    Returns
    -------
    dict with keys:
        brier_score, ece, n_bins, reliability_data
    """
    import numpy as np
    from sklearn.metrics import brier_score_loss

    y_true = np.asarray(y_true, dtype=float)
    y_proba = np.asarray(y_proba, dtype=float)

    brier = float(brier_score_loss(y_true, y_proba))

    # Expected Calibration Error
    bin_edges = np.linspace(0.0, 1.0, n_bins + 1)
    ece_sum = 0.0
    n_total = len(y_true)
    reliability_data: List[Tuple[float, float]] = []

    for i in range(n_bins):
        low, high = bin_edges[i], bin_edges[i + 1]
        # Include right edge in the last bin
        if i == n_bins - 1:
            mask = (y_proba >= low) & (y_proba <= high)
        else:
            mask = (y_proba >= low) & (y_proba < high)

        n_bin = int(mask.sum())
        if n_bin == 0:
            continue

        mean_pred = float(y_proba[mask].mean())
        frac_pos = float(y_true[mask].mean())
        reliability_data.append((mean_pred, frac_pos))
        ece_sum += (n_bin / n_total) * abs(mean_pred - frac_pos)

    return {
        "brier_score": brier,
        "ece": float(ece_sum),
        "n_bins": n_bins,
        "reliability_data": reliability_data,
    }


def calibration_summary(y_true, raw_proba, calibrated_proba) -> str:
    """Compare calibration quality before and after calibration.

    Returns a formatted report string.
    """
    before = evaluate_calibration(y_true, raw_proba)
    after = evaluate_calibration(y_true, calibrated_proba)

    b_before = before["brier_score"]
    b_after = after["brier_score"]
    b_improvement = (b_before - b_after) / b_before * 100 if b_before != 0 else 0.0

    e_before = before["ece"]
    e_after = after["ece"]
    e_improvement = (e_before - e_after) / e_before * 100 if e_before != 0 else 0.0

    sign_b = "+" if b_improvement >= 0 else ""
    sign_e = "+" if e_improvement >= 0 else ""

    report = (
        "🎯 模型校準報告\n"
        "─────────────────────────────\n"
        f"校準前 Brier Score：{b_before:.4f}\n"
        f"校準後 Brier Score：{b_after:.4f} (改善 {sign_b}{b_improvement:.1f}%)\n"
        f"校準前 ECE：        {e_before:.4f}\n"
        f"校準後 ECE：        {e_after:.4f} (改善 {sign_e}{e_improvement:.1f}%)\n"
        "─────────────────────────────"
    )
    return report
