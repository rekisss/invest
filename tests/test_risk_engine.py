"""Tests for risk_engine.monitor."""
import pytest
from risk_engine.monitor import RiskMonitor, RiskLevel


@pytest.fixture
def monitor():
    return RiskMonitor()


def test_low_risk_defaults(monitor):
    a = monitor.assess(vix=13.0, futures_net=5000, night_change=50)
    assert a.overall_level == RiskLevel.LOW
    assert a.suitable_for_trading
    assert not a.reduce_position


def test_high_risk_extreme_conditions(monitor):
    a = monitor.assess(vix=26.0, vix_change=4.0, futures_net=-46000, night_change=-220)
    assert a.overall_level in (RiskLevel.HIGH, RiskLevel.EXTREME)
    assert a.reduce_position


def test_extreme_vix(monitor):
    a = monitor.assess(vix=32.0)
    assert a.overall_level in (RiskLevel.HIGH, RiskLevel.EXTREME)
    assert a.reduce_position


def test_settlement_day(monitor):
    a = monitor.assess(trade_date="2026-05-20")
    # settlement should add a risk factor
    settlement_factor = any(f.name == "結算日" for f in a.risk_factors)
    assert settlement_factor


def test_recommendations_not_empty(monitor):
    a = monitor.assess(vix=20.0)
    assert len(a.recommendations) > 0


def test_discord_format(monitor):
    a = monitor.assess(vix=22.0, futures_net=-40000)
    disc = a.format_discord()
    assert "風險評估" in disc


def test_composite_score_range(monitor):
    a = monitor.assess(vix=35.0, futures_net=-50000, night_change=-300)
    assert 0.0 <= a.composite_score <= 1.0


def test_to_dict(monitor):
    a = monitor.assess()
    d = a.to_dict()
    assert "overall_level" in d
    assert "composite_score" in d
