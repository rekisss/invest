"""
Tests for risk_manager.py — position sizing and risk management utilities.
"""

import sys
import os

# Ensure the project root is importable regardless of where pytest is invoked from.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from risk_manager import (
    kelly_position_size,
    atr_stop_loss,
    risk_reward_ratio,
    position_size_from_risk,
    portfolio_heat,
    suggest_position_size,
    format_position_suggestion,
)


# ---------------------------------------------------------------------------
# TestKellyPositionSize
# ---------------------------------------------------------------------------


class TestKellyPositionSize:
    def test_basic_kelly(self):
        """win_rate=0.6, avg_win=0.05, avg_loss=0.03 → positive fraction."""
        result = kelly_position_size(
            win_rate=0.6, avg_win_pct=0.05, avg_loss_pct=0.03, kelly_fraction=0.5
        )
        assert result > 0.0
        assert result <= 0.20

    def test_negative_edge(self):
        """Negative Kelly edge (expected value < 0) → 0.0."""
        result = kelly_position_size(
            win_rate=0.3, avg_win_pct=0.02, avg_loss_pct=0.10, kelly_fraction=0.5
        )
        assert result == 0.0

    def test_max_cap(self):
        """Very high Kelly value is clamped to 0.20."""
        # win_rate=0.99, avg_win=0.50, avg_loss=0.01 → extremely high full-Kelly
        result = kelly_position_size(
            win_rate=0.99, avg_win_pct=0.50, avg_loss_pct=0.01, kelly_fraction=1.0
        )
        assert result == pytest.approx(0.20)

    def test_invalid_zero_win(self):
        """avg_win_pct=0 (division by zero guard) → 0.0."""
        result = kelly_position_size(
            win_rate=0.6, avg_win_pct=0.0, avg_loss_pct=0.03, kelly_fraction=0.5
        )
        assert result == 0.0


# ---------------------------------------------------------------------------
# TestAtrStopLoss
# ---------------------------------------------------------------------------


class TestAtrStopLoss:
    def test_basic(self):
        """entry=1000, atr=20, mult=2.5 → 1000 - 50 = 950.0."""
        result = atr_stop_loss(entry_price=1000.0, atr=20.0, atr_multiplier=2.5)
        assert result == pytest.approx(950.0)

    def test_zero_atr(self):
        """atr=0 → 0.0."""
        result = atr_stop_loss(entry_price=1000.0, atr=0.0)
        assert result == 0.0

    def test_min_stop_cap(self):
        """Very wide ATR is capped so stop >= entry * 0.80."""
        # entry=100, atr=30, mult=2.5 → raw stop = 100 - 75 = 25, capped at 80
        result = atr_stop_loss(entry_price=100.0, atr=30.0, atr_multiplier=2.5)
        assert result >= 80.0


# ---------------------------------------------------------------------------
# TestRiskRewardRatio
# ---------------------------------------------------------------------------


class TestRiskRewardRatio:
    def test_2to1(self):
        """entry=100, stop=95, target=110 → (10)/(5) = 2.0."""
        result = risk_reward_ratio(entry_price=100.0, stop_price=95.0, target_price=110.0)
        assert result == pytest.approx(2.0)

    def test_zero_risk(self):
        """stop >= entry → 0.0."""
        result = risk_reward_ratio(entry_price=100.0, stop_price=100.0, target_price=110.0)
        assert result == 0.0

        result_above = risk_reward_ratio(entry_price=100.0, stop_price=105.0, target_price=110.0)
        assert result_above == 0.0


# ---------------------------------------------------------------------------
# TestPositionSizeFromRisk
# ---------------------------------------------------------------------------


class TestPositionSizeFromRisk:
    def test_basic(self):
        """
        portfolio=1_000_000, risk=0.01, entry=100, stop=95
        dollar_risk = 10_000, risk_per_share = 5 → 2000 shares.
        """
        result = position_size_from_risk(
            portfolio_value=1_000_000,
            risk_per_trade_pct=0.01,
            entry_price=100.0,
            stop_price=95.0,
        )
        assert result == 2000

    def test_stop_above_entry(self):
        """stop >= entry → 0 shares."""
        result = position_size_from_risk(
            portfolio_value=1_000_000,
            risk_per_trade_pct=0.01,
            entry_price=100.0,
            stop_price=100.0,
        )
        assert result == 0

        result_above = position_size_from_risk(
            portfolio_value=1_000_000,
            risk_per_trade_pct=0.01,
            entry_price=100.0,
            stop_price=105.0,
        )
        assert result_above == 0

    def test_floors_to_int(self):
        """Result is always an integer."""
        result = position_size_from_risk(
            portfolio_value=1_000_000,
            risk_per_trade_pct=0.01,
            entry_price=100.0,
            stop_price=97.0,
        )
        assert isinstance(result, int)


# ---------------------------------------------------------------------------
# TestPortfolioHeat
# ---------------------------------------------------------------------------


class TestPortfolioHeat:
    def test_single_position(self):
        """entry=100, stop=90, shares=100, portfolio=100_000 → 1000/100000 = 0.01."""
        positions = [{"entry_price": 100.0, "stop_price": 90.0, "shares": 100}]
        result = portfolio_heat(positions, portfolio_value=100_000.0)
        assert result == pytest.approx(0.01)

    def test_empty_positions(self):
        """No positions → 0.0."""
        result = portfolio_heat([], portfolio_value=100_000.0)
        assert result == 0.0


# ---------------------------------------------------------------------------
# TestSuggestPositionSize
# ---------------------------------------------------------------------------


class TestSuggestPositionSize:
    def _suggestion(self, entry_score, entry_price=1000.0, atr14=20.0):
        return suggest_position_size(
            entry_score=entry_score,
            atr14=atr14,
            entry_price=entry_price,
            portfolio_value=1_000_000.0,
            base_risk_pct=0.01,
        )

    def test_returns_required_keys(self):
        """Result dict has all required keys."""
        result = self._suggestion(entry_score=1500)
        required_keys = {"grade", "stop_price", "target_price", "shares", "risk_pct", "risk_reward"}
        assert required_keys.issubset(result.keys())

    def test_grade_A_higher_risk(self):
        """entry_score >= 1800 → grade 'A'."""
        result = self._suggestion(entry_score=2000)
        assert result["grade"] == "A"

    def test_grade_D_lower_risk(self):
        """entry_score < 1000 → grade 'D'."""
        result = self._suggestion(entry_score=500)
        assert result["grade"] == "D"

    def test_stop_below_entry(self):
        """stop_price must be below entry_price."""
        result = self._suggestion(entry_score=1500, entry_price=1000.0, atr14=20.0)
        assert result["stop_price"] < 1000.0


# ---------------------------------------------------------------------------
# TestFormatPositionSuggestion
# ---------------------------------------------------------------------------


class TestFormatPositionSuggestion:
    def _make_suggestion(self):
        return suggest_position_size(
            entry_score=1900,
            atr14=20.0,
            entry_price=960.0,
            portfolio_value=1_000_000.0,
            base_risk_pct=0.01,
        )

    def test_returns_string(self):
        """Output is a non-empty string."""
        suggestion = self._make_suggestion()
        result = format_position_suggestion("2330", "台積電", suggestion)
        assert isinstance(result, str)
        assert len(result) > 0

    def test_contains_stock_id(self):
        """Output contains the stock_id."""
        suggestion = self._make_suggestion()
        result = format_position_suggestion("2330", "台積電", suggestion)
        assert "2330" in result
