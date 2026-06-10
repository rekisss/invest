"""Tests for wave-3 predict enhancements: JPY/ARKK/HYG tickers, disposition count."""
from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest


# ── _US_TICKERS / _US_FEATURES completeness ───────────────────────────────────

class TestUSTickers:
    def test_jpy_in_tickers(self):
        from market_predictor import _US_TICKERS
        assert "jpy" in _US_TICKERS, "JPY ticker missing from _US_TICKERS"

    def test_arkk_in_tickers(self):
        from market_predictor import _US_TICKERS
        assert "arkk" in _US_TICKERS

    def test_hyg_in_tickers(self):
        from market_predictor import _US_TICKERS
        assert "hyg" in _US_TICKERS

    def test_jpy_ret1_in_us_features(self):
        from market_predictor import _US_FEATURES
        assert "jpy_ret1" in _US_FEATURES

    def test_arkk_ret1_in_us_features(self):
        from market_predictor import _US_FEATURES
        assert "arkk_ret1" in _US_FEATURES

    def test_hyg_ret1_in_us_features(self):
        from market_predictor import _US_FEATURES
        assert "hyg_ret1" in _US_FEATURES

    def test_predictor_trains_with_new_us_features(self):
        """MarketPredictor should train successfully when new US features are present."""
        from market_predictor import MarketPredictor
        rng = np.random.default_rng(42)
        n = 120
        dates = pd.bdate_range("2024-01-01", periods=n)
        close = 20000 + np.cumsum(rng.standard_normal(n) * 100)
        taiex = pd.DataFrame({"date": dates, "close": close})

        # Synthetic US features including new tickers
        us_df = pd.DataFrame({
            "date": dates,
            "sp500_ret1": rng.normal(0, 0.01, n),
            "sp500_ret5": rng.normal(0, 0.02, n),
            "nasdaq_ret1": rng.normal(0, 0.012, n),
            "vix": rng.uniform(15, 25, n),
            "sox_ret1": rng.normal(0, 0.015, n),
            "dxy_ret1": rng.normal(0, 0.005, n),
            "us10y_ret1": rng.normal(0, 0.003, n),
            "jpy_ret1": rng.normal(0, 0.008, n),    # new
            "arkk_ret1": rng.normal(0, 0.025, n),   # new
            "hyg_ret1": rng.normal(0, 0.004, n),    # new
        })

        p = MarketPredictor(horizon=5)
        p.fit(taiex, us_df)
        result = p.predict_proba(taiex, us_df)

        assert result["trained"] is True
        assert 0.0 <= result["prob_up"] <= 1.0

    def test_predictor_degrades_gracefully_without_new_features(self):
        """If new tickers aren't in us_df, predictor still works."""
        from market_predictor import MarketPredictor
        rng = np.random.default_rng(7)
        n = 120
        dates = pd.bdate_range("2024-01-01", periods=n)
        close = 20000 + np.cumsum(rng.standard_normal(n) * 100)
        taiex = pd.DataFrame({"date": dates, "close": close})

        # Old-format US features without new tickers
        us_df = pd.DataFrame({
            "date": dates,
            "sp500_ret1": rng.normal(0, 0.01, n),
            "nasdaq_ret1": rng.normal(0, 0.012, n),
            "vix": rng.uniform(15, 25, n),
        })

        p = MarketPredictor(horizon=5)
        p.fit(taiex, us_df)
        result = p.predict_proba(taiex, us_df)

        assert result["trained"] is True
        assert 0.0 <= result["prob_up"] <= 1.0


# ── Disposition stocks signal ─────────────────────────────────────────────────

class TestDispositionStocksSignal:
    def test_fetch_disposition_returns_set(self):
        from data_loader import fetch_disposition_stocks
        client = MagicMock()
        client.fetch_dataset.return_value = pd.DataFrame({
            "stock_id": ["1234", "5678", "9012"],
            "date": ["2026-06-01"] * 3,
        })
        result = fetch_disposition_stocks(client, "2026-06-10")
        assert isinstance(result, set)
        assert len(result) >= 1

    def test_fetch_disposition_returns_empty_set_on_failure(self):
        from data_loader import fetch_disposition_stocks
        client = MagicMock()
        client.fetch_dataset.side_effect = RuntimeError("API error")
        result = fetch_disposition_stocks(client, "2026-06-10")
        assert isinstance(result, set)
        assert len(result) == 0


# ── Claude insight with wave-3 signals ────────────────────────────────────────

class TestClaudeInsightWave3:
    def _capture_prompt(self, market_data: dict, tech: dict | None = None) -> str:
        import claude_insight
        captured = []

        class _FakeContent:
            text = "・test1\n・test2\n・test3"

        class _FakeMsg:
            content = [_FakeContent()]

        class _FakeMessages:
            def create(self, **kwargs):
                msgs = kwargs.get("messages", [{}])
                captured.append(msgs[0].get("content", "") if msgs else "")
                return _FakeMsg()

        class _FakeAnthropicClient:
            messages = _FakeMessages()

        fake_anthropic = types.ModuleType("anthropic")
        fake_anthropic.Anthropic = lambda api_key=None: _FakeAnthropicClient()  # type: ignore[attr-defined]
        with patch.dict(sys.modules, {"anthropic": fake_anthropic}):
            with patch.dict("os.environ", {"PREMARKET_AI_KEY": "sk-test-key"}):
                claude_insight.generate_premarket_insight(market_data, tech)

        return captured[0] if captured else ""

    def test_jpy_in_prompt(self):
        md = {"xgb_prob_up": 0.55, "vix": 18, "jpy_ret": 0.008}
        prompt = self._capture_prompt(md)
        assert "日圓" in prompt

    def test_arkk_in_prompt(self):
        md = {"xgb_prob_up": 0.60, "vix": 16, "arkk_ret": -0.032}
        prompt = self._capture_prompt(md)
        assert "ARKK" in prompt

    def test_disposition_warning_in_prompt(self):
        md = {"xgb_prob_up": 0.45, "vix": 22, "disposition_count": 15}
        prompt = self._capture_prompt(md)
        assert "處置股" in prompt or "15" in prompt

    def test_disposition_zero_not_noisy(self):
        md = {"xgb_prob_up": 0.50, "vix": 19, "disposition_count": 0}
        prompt = self._capture_prompt(md)
        assert "處置股" not in prompt
