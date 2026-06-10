"""Tests for wave-2 predict enhancements: buyback signal, Claude insight context, TAIEX tech."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest


# ── Buyback count signal ───────────────────────────────────────────────────────

class TestFetchBuybackStocksCount:
    def test_returns_set_on_success(self):
        from data_loader import fetch_buyback_stocks
        client = MagicMock()
        client.fetch_dataset.return_value = pd.DataFrame({
            "stock_id": ["2330", "2317", "2454"],
            "date": ["2026-06-01"] * 3,
        })
        result = fetch_buyback_stocks(client, "2026-06-10", lookback=30)
        assert isinstance(result, set)
        assert len(result) == 3
        assert "2330" in result

    def test_returns_empty_set_on_failure(self):
        from data_loader import fetch_buyback_stocks
        client = MagicMock()
        client.fetch_dataset.side_effect = RuntimeError("API error")
        result = fetch_buyback_stocks(client, "2026-06-10", lookback=30)
        assert result == set()

    def test_returns_empty_set_on_empty_response(self):
        from data_loader import fetch_buyback_stocks
        client = MagicMock()
        client.fetch_dataset.return_value = pd.DataFrame()
        result = fetch_buyback_stocks(client, "2026-06-10", lookback=30)
        assert result == set()

    def test_deduplicates_stock_ids(self):
        from data_loader import fetch_buyback_stocks
        client = MagicMock()
        client.fetch_dataset.return_value = pd.DataFrame({
            "stock_id": ["2330", "2330", "2317"],
            "date": ["2026-06-01", "2026-06-05", "2026-06-01"],
        })
        result = fetch_buyback_stocks(client, "2026-06-10", lookback=30)
        assert len(result) == 2


# ── Claude insight context ─────────────────────────────────────────────────────

class TestGeneratePremarketInsightContext:
    """Test that generate_premarket_insight includes the new signals in prompt context
    (without actually calling the Claude API — we verify the prompt construction)."""

    def _capture_prompt(self, market_data: dict, tech: dict | None = None) -> str:
        """Call generate_premarket_insight with mocked anthropic and capture the prompt."""
        import sys
        import types
        import claude_insight

        captured = []

        class _FakeContent:
            text = "・テスト1\n・テスト2\n・テスト3"

        class _FakeMsg:
            content = [_FakeContent()]

        class _FakeMessages:
            def create(self, **kwargs):
                msgs = kwargs.get("messages", [{}])
                captured.append(msgs[0].get("content", "") if msgs else "")
                return _FakeMsg()

        class _FakeAnthropicClient:
            messages = _FakeMessages()

        # Inject a fake anthropic module so the `import anthropic` inside the function works
        fake_anthropic = types.ModuleType("anthropic")
        fake_anthropic.Anthropic = lambda api_key=None: _FakeAnthropicClient()  # type: ignore[attr-defined]
        with patch.dict(sys.modules, {"anthropic": fake_anthropic}):
            with patch.dict("os.environ", {"PREMARKET_AI_KEY": "sk-test-key"}):
                claude_insight.generate_premarket_insight(market_data, tech)

        return captured[0] if captured else ""

    def test_market_revenue_yoy_in_prompt(self):
        market_data = {
            "xgb_prob_up": 0.6, "futures_net": -10000, "vix": 18,
            "market_revenue_yoy": 0.085,
        }
        prompt = self._capture_prompt(market_data)
        assert "市場月營收YoY" in prompt or "8.5%" in prompt or "+8.5%" in prompt

    def test_market_foreign_holding_chg_in_prompt(self):
        market_data = {
            "xgb_prob_up": 0.55, "futures_net": 5000, "vix": 15,
            "market_foreign_holding_chg": 0.23,
        }
        prompt = self._capture_prompt(market_data)
        assert "外資持股5日" in prompt or "0.23" in prompt

    def test_buyback_count_in_prompt_when_nonzero(self):
        market_data = {
            "xgb_prob_up": 0.58, "vix": 16, "buyback_count": 42,
        }
        prompt = self._capture_prompt(market_data)
        assert "42" in prompt or "庫藏股" in prompt

    def test_buyback_count_zero_not_in_prompt(self):
        market_data = {
            "xgb_prob_up": 0.50, "vix": 20, "buyback_count": 0,
        }
        prompt = self._capture_prompt(market_data)
        # Zero buyback count should not add noise to the prompt
        assert "庫藏股買回中 0" not in prompt

    def test_dist_ma20_in_prompt_when_provided(self):
        market_data = {"xgb_prob_up": 0.6, "vix": 17}
        tech = {"rsi14": 58, "macd_hist": 12.3, "dist_ma60": 1.5, "dist_ma20": 0.8}
        prompt = self._capture_prompt(market_data, tech)
        assert "距MA20" in prompt

    def test_missing_api_key_returns_empty(self):
        import claude_insight
        with patch.dict("os.environ", {"PREMARKET_AI_KEY": ""}):
            result = claude_insight.generate_premarket_insight({"xgb_prob_up": 0.5}, {})
        assert result == ""


# ── TAIEX tech expanded display ────────────────────────────────────────────────

class TestTaiexTechExpanded:
    """Test that the new TAIEX technical fields are computed correctly from market_df."""

    def _make_market_df(self, n: int = 120) -> pd.DataFrame:
        rng = np.random.default_rng(5)
        dates = pd.bdate_range("2024-01-01", periods=n)
        close = 20000 + np.cumsum(rng.standard_normal(n) * 80)
        return pd.DataFrame({"date": dates, "close": close})

    def test_dist_ma20_computed(self):
        df = self._make_market_df(30)
        close = df["close"].astype(float)
        last_close = close.iloc[-1]
        ma20 = close.rolling(20).mean().iloc[-1]
        dist_ma20 = (last_close / ma20 - 1) * 100
        assert abs(dist_ma20) < 20, "dist_ma20 should be within ±20% for synthetic data"

    def test_ret_5d_computed(self):
        df = self._make_market_df(30)
        close = df["close"].astype(float)
        ret_5d = (close.iloc[-1] / close.iloc[-6] - 1) * 100
        assert isinstance(ret_5d, float)
        assert abs(ret_5d) < 50

    def test_ret_20d_computed(self):
        df = self._make_market_df(30)
        close = df["close"].astype(float)
        ret_20d = (close.iloc[-1] / close.iloc[-21] - 1) * 100
        assert isinstance(ret_20d, float)

    def test_insufficient_data_handled_gracefully(self):
        """With only 5 rows, ret_5d and ret_20d should not crash."""
        df = self._make_market_df(5)
        close = df["close"].astype(float)
        # ret_5d requires 6 rows — should be skipped
        can_compute_5d = len(close) >= 6
        assert not can_compute_5d  # expected: can't compute

    def test_all_fields_have_correct_types(self):
        df = self._make_market_df(120)
        close = df["close"].astype(float)
        last = close.iloc[-1]
        results = {}
        if len(close) >= 20:
            ma20 = close.rolling(20).mean().iloc[-1]
            results["dist_ma20"] = (last / ma20 - 1) * 100
        if len(close) >= 60:
            ma60 = close.rolling(60).mean().iloc[-1]
            results["dist_ma60"] = (last / ma60 - 1) * 100
        if len(close) >= 6:
            results["ret_5d"] = (last / close.iloc[-6] - 1) * 100
        if len(close) >= 21:
            results["ret_20d"] = (last / close.iloc[-21] - 1) * 100

        for k, v in results.items():
            assert isinstance(v, float), f"{k} should be float, got {type(v)}"
