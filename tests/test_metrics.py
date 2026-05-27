"""Tests for backtest_pkg.metrics."""
import numpy as np
import pytest
from backtest_pkg.metrics import (
    confusion_matrix_summary,
    sharpe_ratio,
    max_drawdown,
    precision_recall_at_k,
    win_rate,
    profit_factor,
)


def test_confusion_matrix_perfect():
    cm = confusion_matrix_summary([1, 0, 1, 0], [1, 0, 1, 0])
    assert cm["accuracy"] == 1.0
    assert cm["precision"] == 1.0
    assert cm["recall"] == 1.0
    assert cm["f1"] == 1.0


def test_confusion_matrix_all_wrong():
    cm = confusion_matrix_summary([1, 1, 0, 0], [0, 0, 1, 1])
    assert cm["accuracy"] == 0.0
    assert cm["tp"] == 0
    assert cm["tn"] == 0


def test_sharpe_ratio_positive():
    import numpy as np
    rng = np.random.default_rng(42)
    returns = list(0.001 + rng.standard_normal(252) * 0.01)  # positive mean, nonzero std
    sr = sharpe_ratio(returns)
    assert sr > 0


def test_sharpe_ratio_zero_std():
    sr = sharpe_ratio([0.0])
    assert sr == 0.0


def test_max_drawdown():
    mdd = max_drawdown([100, 110, 90, 105, 85])
    assert abs(mdd - (110 - 85) / 110) < 1e-6


def test_max_drawdown_monotonic_up():
    mdd = max_drawdown([100, 110, 120, 130])
    assert mdd == 0.0


def test_precision_recall_at_k():
    y_true = [1, 0, 1, 0, 1]
    y_scores = [0.9, 0.8, 0.7, 0.6, 0.5]
    result = precision_recall_at_k(y_true, y_scores, k=3)
    assert result["k"] == 3
    assert result["tp"] == 2  # top-3 are idx 0,1,2; true positives at 0 and 2


def test_win_rate():
    assert win_rate([1.0, -0.5, 2.0, -1.0]) == 0.5


def test_profit_factor():
    pf = profit_factor([1.0, -0.5, 2.0, -1.0])
    assert abs(pf - 3.0 / 1.5) < 1e-6
