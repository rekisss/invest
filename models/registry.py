"""Model registry: versioned save/load with metadata sidecar."""
from __future__ import annotations

import json
import pickle
from datetime import datetime
from pathlib import Path
from typing import Any


_DEFAULT_DIR = Path("models")


def save_model(model: Any, name: str, metadata: dict | None = None, model_dir: Path | str | None = None) -> Path:
    """Pickle model and write a JSON sidecar with version metadata.

    Args:
        model:      Any picklable model object.
        name:       Logical name (e.g. "market_xgb", "stock_xgb").
        metadata:   Extra dict (AUC, feature count, training date, etc.).
        model_dir:  Directory to write to (defaults to ./models/).

    Returns:
        Path of the saved .pkl file.
    """
    d = Path(model_dir) if model_dir else _DEFAULT_DIR
    d.mkdir(parents=True, exist_ok=True)

    pkl_path = d / f"{name}.pkl"
    meta_path = d / f"{name}.meta.json"

    with open(pkl_path, "wb") as f:
        pickle.dump(model, f)

    meta = {
        "name": name,
        "saved_at": datetime.now().isoformat(),
        **(metadata or {}),
    }
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

    return pkl_path


def load_model(name: str, model_dir: Path | str | None = None) -> Any:
    """Load a pickled model. Raises FileNotFoundError if not found."""
    d = Path(model_dir) if model_dir else _DEFAULT_DIR
    pkl_path = d / f"{name}.pkl"

    if not pkl_path.exists():
        raise FileNotFoundError(f"Model '{name}' not found at {pkl_path}")

    with open(pkl_path, "rb") as f:
        return pickle.load(f)


def model_metadata(name: str, model_dir: Path | str | None = None) -> dict:
    """Return the metadata sidecar for a saved model, or {} if not found."""
    d = Path(model_dir) if model_dir else _DEFAULT_DIR
    meta_path = d / f"{name}.meta.json"
    if not meta_path.exists():
        return {}
    return json.loads(meta_path.read_text(encoding="utf-8"))
