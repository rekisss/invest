"""
Tests for /home/user/invest/alert_rules.py

Run with:  pytest tests/test_alert_rules.py -v
"""
from __future__ import annotations

import sys
import os

# Ensure the project root is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
import pandas as pd

from alert_rules import (
    AlertLevel,
    check_stop_loss,
    check_momentum_drop,
    check_institutional_reversal,
    evaluate_position,
    format_portfolio_alerts,
    screen_portfolio,
)


# ---------------------------------------------------------------------------
# TestCheckStopLoss
# ---------------------------------------------------------------------------

class TestCheckStopLoss:
    """Tests for check_stop_loss()."""

    def test_triggers_exit(self):
        """Price below stop should return EXIT."""
        assert check_stop_loss(95, 100) == AlertLevel.EXIT

    def test_ok_above_stop(self):
        """Price above stop should return OK."""
        assert check_stop_loss(105, 100) == AlertLevel.OK

    def test_exactly_at_stop(self):
        """Price exactly at stop should return EXIT."""
        assert check_stop_loss(100, 100) == AlertLevel.EXIT


# ---------------------------------------------------------------------------
# TestCheckMomentumDrop
# ---------------------------------------------------------------------------

class TestCheckMomentumDrop:
    """Tests for check_momentum_drop()."""

    def test_no_drop(self):
        """A 5% drop should return OK (below 20% threshold)."""
        # entry=1000, current=950 → drop = 50/1000 = 5%
        assert check_momentum_drop(1000, 950) == AlertLevel.OK

    def test_watch_level(self):
        """A 25% drop should return WATCH (above 20% but below 35%)."""
        # entry=1000, current=750 → drop = 250/1000 = 25%
        assert check_momentum_drop(1000, 750) == AlertLevel.WATCH

    def test_exit_level(self):
        """A 40% drop should return EXIT (above 35%)."""
        # entry=1000, current=600 → drop = 400/1000 = 40%
        assert check_momentum_drop(1000, 600) == AlertLevel.EXIT


# ---------------------------------------------------------------------------
# TestCheckInstitutionalReversal
# ---------------------------------------------------------------------------

class TestCheckInstitutionalReversal:
    """Tests for check_institutional_reversal()."""

    def test_ok_both_positive(self):
        """Both positive streaks should return OK."""
        assert check_institutional_reversal(3, 2) == AlertLevel.OK

    def test_watch_one_negative(self):
        """One negative streak should return WATCH."""
        assert check_institutional_reversal(-1, 2) == AlertLevel.WATCH

    def test_exit_both_negative(self):
        """Both streaks < -2 should return EXIT."""
        assert check_institutional_reversal(-3, -3) == AlertLevel.EXIT


# ---------------------------------------------------------------------------
# TestEvaluatePosition
# ---------------------------------------------------------------------------

class TestEvaluatePosition:
    """Tests for evaluate_position()."""

    def _breach_position(self):
        """Position where stop-loss is breached."""
        position = {
            "stock_id": "2317",
            "entry_price": 1000.0,
            "stop_price": 960.0,
            "entry_score": 800.0,
        }
        current_data = {
            "close": 950.0,          # below stop_price → EXIT
            "entry_score": 780.0,
            "foreign_buy_streak": 1,
            "invest_trust_streak": 1,
            "volume_ratio": 1.0,
            "bb_pct_b": 0.4,
        }
        return position, current_data

    def _ok_position(self):
        """Position where everything looks healthy."""
        position = {
            "stock_id": "2454",
            "entry_price": 500.0,
            "stop_price": 460.0,
            "entry_score": 800.0,
        }
        current_data = {
            "close": 520.0,          # above stop
            "entry_score": 790.0,    # tiny drop, well within thresholds
            "foreign_buy_streak": 3,
            "invest_trust_streak": 2,
            "volume_ratio": 1.5,
            "bb_pct_b": 0.4,
        }
        return position, current_data

    def test_should_exit_on_stop_breach(self):
        """A stop-loss breach should set should_exit=True."""
        position, current_data = self._breach_position()
        result = evaluate_position(position, current_data)
        assert result["should_exit"] is True

    def test_ok_position(self):
        """A healthy position should have should_exit=False and should_watch=False."""
        position, current_data = self._ok_position()
        result = evaluate_position(position, current_data)
        assert result["should_exit"] is False
        assert result["should_watch"] is False

    def test_returns_required_keys(self):
        """Result must contain all required keys."""
        position, current_data = self._ok_position()
        result = evaluate_position(position, current_data)
        for key in ("stock_id", "overall_level", "alerts", "should_exit", "should_watch"):
            assert key in result, f"Missing key: {key}"

    def test_alerts_in_chinese(self):
        """Alert messages should contain Chinese characters when triggered."""
        position, current_data = self._breach_position()
        result = evaluate_position(position, current_data)
        # At least one alert must be present and contain Chinese
        assert len(result["alerts"]) > 0
        combined = " ".join(result["alerts"])
        # Check for any CJK character (U+4E00–U+9FFF range)
        has_chinese = any("一" <= ch <= "鿿" for ch in combined)
        assert has_chinese, f"Expected Chinese characters in alerts, got: {combined}"


# ---------------------------------------------------------------------------
# TestFormatPortfolioAlerts
# ---------------------------------------------------------------------------

class TestFormatPortfolioAlerts:
    """Tests for format_portfolio_alerts()."""

    def _make_df(self, rows):
        """Create a minimal alert DataFrame."""
        return pd.DataFrame(
            rows,
            columns=["stock_id", "overall_level", "alerts", "should_exit", "should_watch"],
        )

    def test_empty_when_all_ok(self):
        """All-OK portfolio should return empty string."""
        df = self._make_df([
            {"stock_id": "2330", "overall_level": AlertLevel.OK, "alerts": "",
             "should_exit": False, "should_watch": False},
            {"stock_id": "2317", "overall_level": AlertLevel.OK, "alerts": "",
             "should_exit": False, "should_watch": False},
        ])
        assert format_portfolio_alerts(df) == ""

    def test_exit_appears_first(self):
        """EXIT stock should appear before WATCH stock in formatted output."""
        df = self._make_df([
            # WATCH comes first in the DataFrame rows, but EXIT should still
            # appear first in the formatted output.
            {"stock_id": "2454", "overall_level": AlertLevel.WATCH,
             "alerts": "動能下滑", "should_exit": False, "should_watch": True},
            {"stock_id": "2317", "overall_level": AlertLevel.EXIT,
             "alerts": "止損觸發", "should_exit": True, "should_watch": False},
        ])
        output = format_portfolio_alerts(df)
        exit_pos = output.find("2317")
        watch_pos = output.find("2454")
        assert exit_pos != -1, "EXIT stock 2317 not found in output"
        assert watch_pos != -1, "WATCH stock 2454 not found in output"
        assert exit_pos < watch_pos, (
            "EXIT stock should appear before WATCH stock in output"
        )

    def test_contains_exit_emoji(self):
        """EXIT-level alerts should contain the 🚨 emoji."""
        df = self._make_df([
            {"stock_id": "2317", "overall_level": AlertLevel.EXIT,
             "alerts": "止損觸發", "should_exit": True, "should_watch": False},
        ])
        output = format_portfolio_alerts(df)
        assert "🚨" in output, f"Expected 🚨 in EXIT output, got:\n{output}"
