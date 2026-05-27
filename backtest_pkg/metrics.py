"""Backtest evaluation metrics.

All functions are pure — no external dependencies beyond numpy.
"""
from __future__ import annotations

import numpy as np


def confusion_matrix_summary(y_true: list | np.ndarray, y_pred: list | np.ndarray) -> dict:
    """Return precision, recall, F1, and accuracy for binary classification."""
    y_true = np.asarray(y_true, dtype=int)
    y_pred = np.asarray(y_pred, dtype=int)

    tp = int(((y_pred == 1) & (y_true == 1)).sum())
    fp = int(((y_pred == 1) & (y_true == 0)).sum())
    fn = int(((y_pred == 0) & (y_true == 1)).sum())
    tn = int(((y_pred == 0) & (y_true == 0)).sum())
    n = len(y_true)

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    accuracy = (tp + tn) / n if n > 0 else 0.0

    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "accuracy": round(accuracy, 4),
        "n": n,
    }


def sharpe_ratio(returns: list | np.ndarray, periods_per_year: int = 252, risk_free: float = 0.0) -> float:
    """Annualised Sharpe ratio from a sequence of periodic returns."""
    r = np.asarray(returns, dtype=float)
    if len(r) < 2:
        return 0.0
    excess = r - risk_free / periods_per_year
    std = excess.std(ddof=1)
    if std == 0:
        return 0.0
    return float((excess.mean() / std) * np.sqrt(periods_per_year))


def max_drawdown(equity_curve: list | np.ndarray) -> float:
    """Maximum drawdown as a positive fraction (0.20 = 20% drawdown)."""
    eq = np.asarray(equity_curve, dtype=float)
    if len(eq) == 0:
        return 0.0
    peak = np.maximum.accumulate(eq)
    drawdowns = (peak - eq) / np.where(peak == 0, 1, peak)
    return float(drawdowns.max())


def precision_recall_at_k(
    y_true: list | np.ndarray,
    y_scores: list | np.ndarray,
    k: int = 20,
) -> dict:
    """Precision and recall when only the top-k predictions by score are acted on."""
    y_true = np.asarray(y_true, dtype=int)
    y_scores = np.asarray(y_scores, dtype=float)

    top_k_idx = np.argsort(y_scores)[::-1][:k]
    y_pred = np.zeros(len(y_true), dtype=int)
    y_pred[top_k_idx] = 1

    result = confusion_matrix_summary(y_true, y_pred)
    result["k"] = k
    return result


def calmar_ratio(returns: list | np.ndarray, periods_per_year: int = 252) -> float:
    """Calmar ratio = annualised return / max drawdown."""
    r = np.asarray(returns, dtype=float)
    if len(r) == 0:
        return 0.0
    equity = np.cumprod(1 + r)
    mdd = max_drawdown(equity)
    ann_return = float((equity[-1] ** (periods_per_year / len(r))) - 1)
    return ann_return / mdd if mdd > 0 else 0.0


def win_rate(pnl_list: list | np.ndarray) -> float:
    """Fraction of trades with positive PnL."""
    pnl = np.asarray(pnl_list, dtype=float)
    if len(pnl) == 0:
        return 0.0
    return float((pnl > 0).mean())


def profit_factor(pnl_list: list | np.ndarray) -> float:
    """Gross profit / gross loss."""
    pnl = np.asarray(pnl_list, dtype=float)
    gross_profit = pnl[pnl > 0].sum()
    gross_loss = abs(pnl[pnl < 0].sum())
    return float(gross_profit / gross_loss) if gross_loss > 0 else float("inf")
