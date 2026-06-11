"""
Tests for backtest_metrics.py

Tests all functions directly — no backtest.py infrastructure used.
"""

import math
import sys
import os

import pandas as pd
import pytest

# Ensure the project root is on the path so we can import backtest_metrics
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backtest_metrics import (
    sharpe_ratio,
    max_drawdown,
    calmar_ratio,
    win_rate,
    profit_factor,
    precision_at_k,
    recall_at_k,
    confusion_matrix_summary,
    trade_statistics,
    format_backtest_report,
)


# ---------------------------------------------------------------------------
# TestSharpeRatio
# ---------------------------------------------------------------------------


class TestSharpeRatio:
    def test_positive_returns(self):
        """Positive varying daily returns with rf=0 should yield positive Sharpe."""
        import numpy as np

        rng = np.random.default_rng(0)
        # Mean ~1%, small noise so std > 0
        returns = list(0.01 + rng.normal(0, 0.001, 252))
        result = sharpe_ratio(returns, risk_free_rate=0.0)
        assert result > 0

    def test_zero_std(self):
        """Constant returns → std == 0 → Sharpe returns 0.0."""
        returns = [0.005] * 100
        result = sharpe_ratio(returns)
        assert result == 0.0

    def test_empty_returns(self):
        """Empty input returns 0.0."""
        result = sharpe_ratio([])
        assert result == 0.0

    def test_higher_returns_higher_sharpe(self):
        """Higher mean return (same std) produces higher Sharpe."""
        import numpy as np

        rng = np.random.default_rng(42)
        noise = rng.normal(0, 0.01, 252)
        series1 = list(0.02 + noise)
        series2 = list(0.01 + noise)
        sharpe1 = sharpe_ratio(series1, risk_free_rate=0.0)
        sharpe2 = sharpe_ratio(series2, risk_free_rate=0.0)
        assert sharpe1 > sharpe2


# ---------------------------------------------------------------------------
# TestMaxDrawdown
# ---------------------------------------------------------------------------


class TestMaxDrawdown:
    def test_no_drawdown(self):
        """Monotonically increasing curve → 0.0 drawdown."""
        result = max_drawdown([100, 110, 120, 130])
        assert result == 0.0

    def test_known_drawdown(self):
        """Peak=100, trough=70 → drawdown=(100-70)/100=0.30."""
        # Equity: 100 → 80 → 90 → 70 → 110
        # Running max: 100, 100, 100, 100, 110
        # Drawdowns:    0,  0.20, 0.10, 0.30, 0
        result = max_drawdown([100, 80, 90, 70, 110])
        assert abs(result - 0.30) < 1e-9

    def test_empty(self):
        """Empty input returns 0.0."""
        result = max_drawdown([])
        assert result == 0.0

    def test_recovers_fully(self):
        """[100, 50, 100] → drawdown = (100-50)/100 = 0.50."""
        result = max_drawdown([100, 50, 100])
        assert abs(result - 0.50) < 1e-9


# ---------------------------------------------------------------------------
# TestWinRate
# ---------------------------------------------------------------------------


class TestWinRate:
    def test_all_wins(self):
        """All positive returns → win rate = 1.0."""
        assert win_rate([0.1, 0.2, 0.3]) == 1.0

    def test_all_losses(self):
        """All negative returns → win rate = 0.0."""
        assert win_rate([-0.1, -0.2]) == 0.0

    def test_mixed(self):
        """3 wins, 1 loss → win rate = 0.75."""
        assert win_rate([0.1, -0.1, 0.1, 0.1]) == 0.75

    def test_empty(self):
        """Empty input → 0.0."""
        assert win_rate([]) == 0.0


# ---------------------------------------------------------------------------
# TestPrecisionAtK
# ---------------------------------------------------------------------------


class TestPrecisionAtK:
    def test_perfect_precision(self):
        """Top-3 scores correspond to all 3 positives → precision=1.0."""
        y_true = [1, 1, 1, 0, 0]
        y_scores = [0.9, 0.8, 0.7, 0.6, 0.5]
        result = precision_at_k(y_true, y_scores, k=3)
        assert result == 1.0

    def test_zero_precision(self):
        """Top-3 by score are all negatives → precision=0.0."""
        y_true = [0, 0, 0, 1, 1]
        y_scores = [0.9, 0.8, 0.7, 0.6, 0.5]
        result = precision_at_k(y_true, y_scores, k=3)
        assert result == 0.0

    def test_k_zero(self):
        """k=0 → 0.0."""
        y_true = [1, 1, 0]
        y_scores = [0.9, 0.8, 0.7]
        result = precision_at_k(y_true, y_scores, k=0)
        assert result == 0.0


# ---------------------------------------------------------------------------
# TestConfusionMatrixSummary
# ---------------------------------------------------------------------------


class TestConfusionMatrixSummary:
    def test_perfect_classifier(self):
        """Predictions match ground truth exactly."""
        y_true = [1, 1, 0, 0]
        y_pred = [1, 1, 0, 0]
        result = confusion_matrix_summary(y_true, y_pred)
        assert result["tp"] == 2
        assert result["fp"] == 0
        assert result["tn"] == 2
        assert result["fn"] == 0
        assert result["precision"] == 1.0
        assert result["recall"] == 1.0
        assert result["accuracy"] == 1.0

    def test_all_wrong(self):
        """Predictions are completely wrong → precision = 0.0."""
        y_true = [1, 1, 0, 0]
        y_pred = [0, 0, 1, 1]
        result = confusion_matrix_summary(y_true, y_pred)
        assert result["precision"] == 0.0
        assert result["recall"] == 0.0
        assert result["tp"] == 0
        assert result["fn"] == 2

    def test_threshold_applied(self):
        """Probabilities are binarized using the threshold."""
        y_true = [1, 1, 0, 0]
        y_pred = [0.8, 0.6, 0.3, 0.2]
        result = confusion_matrix_summary(y_true, y_pred, threshold=0.5)
        # 0.8 >= 0.5 → 1, 0.6 >= 0.5 → 1, 0.3 < 0.5 → 0, 0.2 < 0.5 → 0
        assert result["tp"] == 2
        assert result["fp"] == 0
        assert result["tn"] == 2
        assert result["fn"] == 0


# ---------------------------------------------------------------------------
# TestTradeStatistics
# ---------------------------------------------------------------------------


class TestTradeStatistics:
    def test_basic_stats(self):
        """Basic returns: 3 wins, 2 losses → n_trades=5, win_rate=0.6."""
        returns = [0.05, 0.03, -0.02, 0.04, -0.01]
        df = pd.DataFrame({"trade_return": returns})
        result = trade_statistics(df)
        assert result["n_trades"] == 5
        assert abs(result["win_rate"] - 0.6) < 1e-9

    def test_empty_df(self):
        """Empty DataFrame returns a dict of zeros."""
        df = pd.DataFrame({"trade_return": []})
        result = trade_statistics(df)
        assert result["n_trades"] == 0
        assert result["win_rate"] == 0.0
        assert result["profit_factor"] == 0.0

    def test_profit_factor(self):
        """wins=[0.1, 0.1], losses=[-0.05, -0.05] → profit_factor=2.0."""
        returns = [0.1, 0.1, -0.05, -0.05]
        df = pd.DataFrame({"trade_return": returns})
        result = trade_statistics(df)
        assert abs(result["profit_factor"] - 2.0) < 1e-6


# ---------------------------------------------------------------------------
# TestFormatBacktestReport
# ---------------------------------------------------------------------------


class TestFormatBacktestReport:
    def _sample_stats(self):
        returns = [0.05, 0.03, -0.02, 0.04, -0.01, 0.02, -0.03, 0.06]
        df = pd.DataFrame({"trade_return": returns})
        return trade_statistics(df)

    def test_returns_string(self):
        """format_backtest_report returns a non-empty string."""
        stats = self._sample_stats()
        report = format_backtest_report(stats)
        assert isinstance(report, str)
        assert len(report) > 0

    def test_contains_winrate(self):
        """Output contains the '勝率' label."""
        stats = self._sample_stats()
        report = format_backtest_report(stats)
        assert "勝率" in report
