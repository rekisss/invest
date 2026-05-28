"""Tests for market_regime.classifier and market_regime.scenario."""
import pytest
from market_regime.classifier import MarketRegimeClassifier, RegimeLabel, classify_regime
from market_regime.scenario import generate_scenario


@pytest.fixture
def clf():
    return MarketRegimeClassifier()


def test_extreme_vol(clf):
    r = clf.classify(vix=32.0)
    assert r.label == RegimeLabel.EXTREME_VOL
    assert not r.tradeable
    assert r.confidence >= 0.8


def test_short_squeeze(clf):
    r = clf.classify(vix=22.0, futures_net=-46000, us_tech_strength=2.5, advance_ratio=0.55)
    assert r.label == RegimeLabel.SHORT_SQUEEZE
    assert r.tradeable


def test_strong_bull(clf):
    r = clf.classify(vix=13.0, us_tech_strength=3.5, advance_ratio=0.72, night_change=120, xgb_prob_up=0.70)
    assert r.label == RegimeLabel.STRONG_BULL
    assert r.win_rate_estimate >= 0.60


def test_strong_bear(clf):
    r = clf.classify(vix=20.0, us_tech_strength=-3.5, advance_ratio=0.25, xgb_prob_up=0.25)
    assert r.label == RegimeLabel.STRONG_BEAR
    assert r.win_rate_estimate <= 0.40


def test_range_bound_defaults(clf):
    r = clf.classify()  # all defaults
    assert r.label == RegimeLabel.RANGE_BOUND


def test_regime_has_reasoning(clf):
    r = clf.classify(vix=32.0)
    assert len(r.reasoning) > 0


def test_scenario_formats_discord():
    r = MarketRegimeClassifier().classify(vix=22.0, futures_net=-46000, us_tech_strength=2.5)
    s = generate_scenario(r.label, r.label_zh, r.win_rate_estimate, futures_net=-46000)
    disc = s.format_discord()
    assert "📊" in disc
    assert "📋" in disc
    assert "🎯" in disc


def test_convenience_function():
    r = classify_regime(vix=35.0)
    assert r.label == RegimeLabel.EXTREME_VOL
