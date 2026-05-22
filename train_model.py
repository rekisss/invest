"""Train XGBoost classifier on historical training data.

Loads the latest parquet from training_data/, builds leak-safe features,
time-splits train/test, trains XGBoost, and saves the model to models/.

Usage:
    python train_model.py                           # auto-find latest parquet
    python train_model.py --data training_data/historical_3y_2026-05-22.parquet
    python train_model.py --target label_10d        # default: label_5d
"""
from __future__ import annotations

import argparse
import json
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import (
    classification_report, roc_auc_score,
    precision_score, recall_score,
)

# ── Features ──────────────────────────────────────────────────────────────────
# Scale-free (no normalization needed for tree models):
_FEATURE_COLS = [
    # Oscillators (0–100 or bounded range)
    "rsi14", "adx14", "stoch_k", "stoch_d",
    "williams_r", "cci20", "mfi14",
    # Volume & Bollinger (already relative)
    "volume_ratio", "bb_pct_b", "bb_bandwidth",
    # Return-based (already %)
    "return_5d", "relative_strength_5d", "market_return_5d",
    # LR slopes (% per day)
    "lr_slope_20", "lr_slope_60",
    # Normalized price features (computed below)
    "macd_hist_pct",   # macd_hist / close  — scale-independent
    "atr14_pct",       # atr14 / close      — volatility relative to price
    # Signal count
    "condition_count",
    # Boolean signals (0/1)
    "above_ichimoku_cloud", "obv_uptrend",
    "market_above_ma60", "breakout_20d",
    "macd_golden_cross", "hist_turn_positive",
    "above_ema60", "ema60_gt_ema120",
    "volume_break", "rsi_strong", "adx_trending",
    "kd_golden_cross", "bb_squeeze_breakout", "breakout_volume_confirm",
    "williams_r_recovery", "cci_momentum", "mfi_strong", "stronger_than_market",
]


def _add_derived(df: pd.DataFrame) -> pd.DataFrame:
    """Add scale-normalized MACD hist and ATR columns."""
    safe_close = df["close"].clip(lower=1e-9)
    df = df.copy()
    df["macd_hist_pct"] = df["macd_hist"] / safe_close
    df["atr14_pct"]     = df["atr14"]     / safe_close
    return df


def _find_latest_parquet(directory: str) -> Path:
    """Prefer features_*.parquet (clean split); fall back to historical_*.parquet."""
    d = Path(directory)
    feat_files = sorted(d.glob("features_*.parquet"))
    if feat_files:
        return feat_files[-1]
    hist_files = sorted(d.glob("historical_*.parquet"))
    if hist_files:
        return hist_files[-1]
    raise FileNotFoundError(f"No features_*.parquet or historical_*.parquet in {directory}")


def load_and_prepare(data_path: str | Path, target: str) -> tuple[pd.DataFrame, pd.Series, pd.Series]:
    """Load parquet, add derived features, drop rows without label.

    Supports two modes:
    - features_*.parquet → auto-loads matching labels_*.parquet and inner-joins
    - historical_*.parquet (legacy) → filters NaN labels inline
    Returns (X, y, dates).
    """
    p = Path(data_path)

    if p.name.startswith("features_"):
        label_path = p.parent / p.name.replace("features_", "labels_")
        if not label_path.exists():
            raise FileNotFoundError(f"Expected labels file not found: {label_path}")
        feat_df  = pd.read_parquet(p)
        label_df = pd.read_parquet(label_path)[["stock_id", "date", target]]
        df = feat_df.merge(label_df, on=["stock_id", "date"], how="inner")
        print(f"   Loaded features ({len(feat_df):,}) + labels ({len(label_df):,}) → joined {len(df):,} rows")
    else:
        df = pd.read_parquet(p)
        before = len(df)
        df = df.drop_duplicates(subset=["stock_id", "date"], keep="last")
        if len(df) < before:
            print(f"   去除重複 {before - len(df):,} 筆")
        df = df[df[target].notna()].reset_index(drop=True)

    df = df.sort_values(["date", "stock_id"]).reset_index(drop=True)
    df = _add_derived(df)

    missing = [c for c in _FEATURE_COLS if c not in df.columns]
    if missing:
        raise ValueError(f"Missing feature columns: {missing}")

    X = df[_FEATURE_COLS].copy()
    for col in X.select_dtypes(include="bool").columns:
        X[col] = X[col].astype(np.int8)
    X = X.fillna(0)

    y     = df[target].astype(int)
    dates = df["date"]
    return X, y, dates


def time_split(X: pd.DataFrame, y: pd.Series, dates: pd.Series,
               test_ratio: float = 0.2) -> tuple:
    """Split on time: last `test_ratio` of unique dates go to test set."""
    unique_dates = sorted(dates.unique())
    cutoff_idx   = int(len(unique_dates) * (1 - test_ratio))
    cutoff_date  = unique_dates[cutoff_idx]

    train_mask = dates < cutoff_date
    test_mask  = dates >= cutoff_date

    print(f"   Train: {train_mask.sum():,} rows  ({dates[train_mask].min().date()} ~ {dates[train_mask].max().date()})")
    print(f"   Test : {test_mask.sum():,} rows  ({dates[test_mask].min().date()} ~ {dates[test_mask].max().date()})")
    return (X[train_mask], X[test_mask],
            y[train_mask], y[test_mask])


def train(X_train: pd.DataFrame, y_train: pd.Series) -> xgb.XGBClassifier:
    neg = (y_train == 0).sum()
    pos = (y_train == 1).sum()
    scale_pos_weight = neg / max(pos, 1)
    print(f"   Class balance — pos: {pos}, neg: {neg}, scale_pos_weight: {scale_pos_weight:.2f}")

    model = xgb.XGBClassifier(
        n_estimators=400,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        scale_pos_weight=scale_pos_weight,
        eval_metric="auc",
        early_stopping_rounds=30,
        random_state=42,
        n_jobs=-1,
        verbosity=0,
    )
    model.fit(
        X_train, y_train,
        eval_set=[(X_train, y_train)],
        verbose=False,
    )
    return model


def evaluate(model: xgb.XGBClassifier, X_test: pd.DataFrame, y_test: pd.Series) -> dict:
    proba = model.predict_proba(X_test)[:, 1]
    pred  = (proba >= 0.5).astype(int)

    auc       = roc_auc_score(y_test, proba)
    precision = precision_score(y_test, pred, zero_division=0)
    recall    = recall_score(y_test, pred, zero_division=0)

    print(f"\n   Test AUC-ROC  : {auc:.4f}")
    print(f"   Precision@0.5 : {precision:.4f}")
    print(f"   Recall@0.5    : {recall:.4f}")
    print()
    print(classification_report(y_test, pred, target_names=["下跌/持平", "漲>3%"]))

    # Top-10 features by importance
    importance = pd.Series(
        model.feature_importances_, index=_FEATURE_COLS
    ).sort_values(ascending=False)
    print("   Top-10 feature importances:")
    for feat, imp in importance.head(10).items():
        print(f"      {feat:<35} {imp:.4f}")

    return {"auc": auc, "precision": precision, "recall": recall}


def save_model(model: xgb.XGBClassifier, target: str,
               metrics: dict, out_dir: str = "models") -> Path:
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    model_path   = out_path / f"xgb_{target}.pkl"
    metrics_path = out_path / f"xgb_{target}_metrics.json"
    features_path = out_path / f"xgb_{target}_features.json"

    with open(model_path, "wb") as f:
        pickle.dump(model, f)

    with open(metrics_path, "w") as f:
        json.dump(metrics, f, indent=2)

    with open(features_path, "w") as f:
        json.dump(_FEATURE_COLS, f, indent=2)

    print(f"\n   Model saved : {model_path}")
    print(f"   Metrics     : {metrics_path}")
    print(f"   Features    : {features_path}")
    return model_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Train XGBoost on historical stock data")
    parser.add_argument("--data",   default="",
                        help="path to parquet file (default: auto-find latest in training_data/)")
    parser.add_argument("--target", default="label_5d",
                        choices=["label_5d", "label_10d"],
                        help="target column (default: label_5d)")
    parser.add_argument("--test-ratio", type=float, default=0.2,
                        help="fraction of dates used as test set (default: 0.2)")
    parser.add_argument("--output", default="models",
                        help="directory to save model (default: models/)")
    args = parser.parse_args()

    data_path = Path(args.data) if args.data else _find_latest_parquet("training_data")
    print(f"{'='*55}")
    print(f"  Training XGBoost — target: {args.target}")
    print(f"  Data: {data_path}")
    print(f"{'='*55}\n")

    print("📋 載入資料...")
    X, y, dates = load_and_prepare(data_path, args.target)
    print(f"   Total rows : {len(X):,}")
    print(f"   Features   : {len(_FEATURE_COLS)}")
    print(f"   Positive % : {y.mean():.1%}\n")

    print("✂️  時間序列切分...")
    X_tr, X_te, y_tr, y_te = time_split(X, y, dates, args.test_ratio)

    print("\n🤖 訓練模型...")
    model = train(X_tr, y_tr)
    print(f"   Best iteration: {model.best_iteration}")

    print("\n📊 測試集評估...")
    metrics = evaluate(model, X_te, y_te)

    print("\n💾 儲存模型...")
    save_model(model, args.target, metrics, args.output)

    print(f"\n{'='*55}")
    print("✅  完成！")
    print(f"{'='*55}")


if __name__ == "__main__":
    main()
