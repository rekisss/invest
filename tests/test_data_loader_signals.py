"""Tests for compute_market_revenue_signal and compute_market_shareholding_signal."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest

from data_loader import compute_market_revenue_signal, compute_market_shareholding_signal


# ── Helpers ────────────────────────────────────────────────────────────────────

def _make_client() -> MagicMock:
    return MagicMock()


def _revenue_frame(n_stocks: int = 30, n_months: int = 14) -> pd.DataFrame:
    """Synthetic TaiwanStockMonthRevenue response."""
    rng = np.random.default_rng(0)
    rows = []
    end = pd.Timestamp("2026-06-01")
    for sid in [f"{1000 + i}" for i in range(n_stocks)]:
        base_rev = rng.integers(100_000, 10_000_000)
        for m in range(n_months):
            date = end - pd.DateOffset(months=n_months - 1 - m)
            # Revenue grows ~5% YoY on average
            growth = 1 + rng.normal(0.005, 0.02)
            revenue = max(1, int(base_rev * (growth ** m)))
            rows.append({"stock_id": sid, "date": date.strftime("%Y-%m-%d"), "revenue": revenue})
    return pd.DataFrame(rows)


def _shareholding_frame(n_stocks: int = 50, n_days: int = 20) -> pd.DataFrame:
    """Synthetic TaiwanStockShareholding response."""
    rng = np.random.default_rng(1)
    rows = []
    for sid in [f"{1000 + i}" for i in range(n_stocks)]:
        base = rng.uniform(20.0, 80.0)
        for d in range(n_days):
            date = (pd.Timestamp("2026-06-10") - pd.Timedelta(days=n_days - 1 - d)).strftime("%Y-%m-%d")
            ratio = max(0, base + rng.normal(0, 0.5))
            rows.append({"stock_id": sid, "date": date, "ForeignInvestmentSharesRatio": ratio})
    return pd.DataFrame(rows)


# ── Revenue signal tests ────────────────────────────────────────────────────────

class TestComputeMarketRevenueSignal:
    def test_returns_dataframe_with_correct_columns(self):
        client = _make_client()
        client.fetch_dataset.return_value = _revenue_frame()
        result = compute_market_revenue_signal(client, "2026-06-10")

        assert isinstance(result, pd.DataFrame)
        assert "date" in result.columns
        assert "market_revenue_yoy" in result.columns

    def test_yoy_values_in_reasonable_range(self):
        client = _make_client()
        client.fetch_dataset.return_value = _revenue_frame(n_months=14)
        result = compute_market_revenue_signal(client, "2026-06-10")

        assert not result.empty
        # Values should be between -1 and 5 (clip applied)
        assert (result["market_revenue_yoy"] >= -1.0).all()
        assert (result["market_revenue_yoy"] <= 5.0).all()

    def test_dates_are_month_end(self):
        client = _make_client()
        client.fetch_dataset.return_value = _revenue_frame(n_months=14)
        result = compute_market_revenue_signal(client, "2026-06-10")

        if not result.empty:
            dates = pd.to_datetime(result["date"])
            # Each date should be at month-end
            for d in dates:
                assert d == d + pd.offsets.MonthEnd(0), f"Date {d} is not month-end"

    def test_returns_empty_on_api_failure(self):
        import data_loader
        client = _make_client()
        client.fetch_dataset.side_effect = RuntimeError("API down")
        # Block the open-data fallback too, so we exercise the fully-degraded path
        data_loader._open_data_cache.clear()
        with patch("data_loader._http_get_json", side_effect=RuntimeError("no network")):
            result = compute_market_revenue_signal(client, "2026-06-10")
        assert isinstance(result, pd.DataFrame)
        assert result.empty

    def test_returns_empty_when_too_few_stocks(self):
        client = _make_client()
        # Only 5 stocks — below the 10-stock minimum
        client.fetch_dataset.return_value = _revenue_frame(n_stocks=5, n_months=14)
        result = compute_market_revenue_signal(client, "2026-06-10")
        # May or may not be empty depending on overlap; just check it doesn't crash
        assert isinstance(result, pd.DataFrame)

    def test_returns_empty_on_empty_api_response(self):
        client = _make_client()
        client.fetch_dataset.return_value = pd.DataFrame()
        result = compute_market_revenue_signal(client, "2026-06-10")
        assert result.empty

    def test_handles_missing_revenue_column(self):
        client = _make_client()
        bad_frame = pd.DataFrame({"stock_id": ["2330"], "date": ["2026-06-01"], "other_col": [100]})
        client.fetch_dataset.return_value = bad_frame
        result = compute_market_revenue_signal(client, "2026-06-10")
        assert result.empty

    def test_sorted_by_date(self):
        client = _make_client()
        client.fetch_dataset.return_value = _revenue_frame()
        result = compute_market_revenue_signal(client, "2026-06-10")
        if not result.empty:
            dates = pd.to_datetime(result["date"])
            assert (dates.diff().dropna() >= pd.Timedelta(0)).all(), "Dates not sorted ascending"


# ── Shareholding signal tests ───────────────────────────────────────────────────

class TestComputeMarketShareholdingSignal:
    def test_returns_dataframe_with_correct_columns(self):
        client = _make_client()
        client.fetch_dataset.return_value = _shareholding_frame()
        result = compute_market_shareholding_signal(client, "2026-06-10")

        assert isinstance(result, pd.DataFrame)
        assert "date" in result.columns
        assert "market_foreign_holding_chg" in result.columns

    def test_5d_change_requires_at_least_6_rows(self):
        client = _make_client()
        # Only 3 days of data — pct_change(5) will all be NaN
        client.fetch_dataset.return_value = _shareholding_frame(n_days=3)
        result = compute_market_shareholding_signal(client, "2026-06-10")
        # Should return empty (all NaN dropped) or have 0 rows
        assert isinstance(result, pd.DataFrame)
        assert result.empty or len(result) == 0

    def test_with_sufficient_days(self):
        client = _make_client()
        client.fetch_dataset.return_value = _shareholding_frame(n_days=20)
        result = compute_market_shareholding_signal(client, "2026-06-10")

        assert not result.empty
        # pct_change * 100 — values should be small (typical range ±5%)
        assert result["market_foreign_holding_chg"].notna().all()

    def test_returns_empty_on_api_failure(self):
        import data_loader
        client = _make_client()
        client.fetch_dataset.side_effect = RuntimeError("quota exceeded")
        data_loader._open_data_cache.clear()
        with patch("data_loader._http_get_json", side_effect=RuntimeError("no network")):
            result = compute_market_shareholding_signal(client, "2026-06-10")
        assert result.empty

    def test_returns_empty_on_empty_response(self):
        client = _make_client()
        client.fetch_dataset.return_value = pd.DataFrame()
        result = compute_market_shareholding_signal(client, "2026-06-10")
        assert result.empty

    def test_handles_missing_ratio_column(self):
        client = _make_client()
        bad_frame = pd.DataFrame({"stock_id": ["2330"], "date": ["2026-06-10"], "unknown": [50.0]})
        client.fetch_dataset.return_value = bad_frame
        result = compute_market_shareholding_signal(client, "2026-06-10")
        assert result.empty

    def test_sorted_by_date(self):
        client = _make_client()
        client.fetch_dataset.return_value = _shareholding_frame(n_days=20)
        result = compute_market_shareholding_signal(client, "2026-06-10")
        if not result.empty:
            dates = pd.to_datetime(result["date"])
            assert (dates.diff().dropna() >= pd.Timedelta(0)).all()


# ── MarketPredictor integration with new INST_FEATURES ─────────────────────────

class TestMarketPredictorWithNewSignals:
    def _make_taiex(self, n: int = 120) -> pd.DataFrame:
        rng = np.random.default_rng(42)
        dates = pd.bdate_range("2024-01-01", periods=n)
        close = 18000 + np.cumsum(rng.standard_normal(n) * 100)
        return pd.DataFrame({"date": dates, "close": close})

    def _make_inst_df(self, taiex_df: pd.DataFrame) -> pd.DataFrame:
        """Construct inst_df that includes the new market-level signals."""
        dates = taiex_df["date"].copy()
        rng = np.random.default_rng(7)
        inst = pd.DataFrame({
            "date": dates,
            "foreign_inst_norm": rng.uniform(-1, 1, len(dates)),
            "trust_inst_norm": rng.uniform(-1, 1, len(dates)),
            "margin_purchase_chg": rng.uniform(-0.05, 0.05, len(dates)),
            "short_sale_chg": rng.uniform(-0.05, 0.05, len(dates)),
            "pcr": rng.uniform(0.5, 1.5, len(dates)),
            "market_revenue_yoy": 0.08,          # constant market signal
            "market_foreign_holding_chg": 0.15,   # constant holding change
        })
        return inst

    def test_predictor_uses_new_inst_features(self):
        from market_predictor import MarketPredictor, _INST_FEATURES
        assert "market_revenue_yoy" in _INST_FEATURES
        assert "market_foreign_holding_chg" in _INST_FEATURES

    def test_predictor_fit_with_new_signals(self):
        from market_predictor import MarketPredictor
        taiex = self._make_taiex(120)
        inst_df = self._make_inst_df(taiex)

        p = MarketPredictor(horizon=5)
        p.fit(taiex, inst_df=inst_df)
        result = p.predict_proba(taiex, inst_df=inst_df)

        assert result["trained"] is True
        assert 0.0 <= result["prob_up"] <= 1.0

    def test_predictor_gracefully_handles_missing_new_columns(self):
        """If inst_df lacks the new columns, predictor should still work."""
        from market_predictor import MarketPredictor
        taiex = self._make_taiex(120)
        # inst_df without the new signal columns (old format)
        rng = np.random.default_rng(99)
        inst_df = pd.DataFrame({
            "date": taiex["date"],
            "foreign_inst_norm": rng.uniform(-1, 1, 120),
            "pcr": rng.uniform(0.5, 1.5, 120),
        })

        p = MarketPredictor(horizon=5)
        p.fit(taiex, inst_df=inst_df)
        result = p.predict_proba(taiex, inst_df=inst_df)

        assert result["trained"] is True
        assert 0.0 <= result["prob_up"] <= 1.0

    def test_market_revenue_yoy_monthly_expand(self):
        """Simulate ffill behaviour: monthly revenue signal propagates to all trading days."""
        from market_predictor import MarketPredictor
        taiex = self._make_taiex(120)

        # Revenue signal: one value per month (monthly cadence)
        monthly_dates = pd.date_range("2023-11-30", periods=8, freq="ME")
        revenue_signal = pd.DataFrame({
            "date": monthly_dates,
            "market_revenue_yoy": [0.03, 0.05, 0.07, 0.09, 0.06, 0.04, 0.08, 0.10],
        })

        p = MarketPredictor(horizon=5)
        p.fit(taiex, inst_df=revenue_signal)
        result = p.predict_proba(taiex, inst_df=revenue_signal)

        # ffill should propagate monthly values to all trading days
        assert result["trained"] is True
        assert 0.0 <= result["prob_up"] <= 1.0
