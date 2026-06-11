"""Tests for monthly_revenue module."""
from __future__ import annotations

import math
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest


# ---------------------------------------------------------------------------
# TestRevenueScoreBonus
# ---------------------------------------------------------------------------

class TestRevenueScoreBonus:
    def test_high_growth_gt20(self):
        from monthly_revenue import revenue_score_bonus
        assert revenue_score_bonus(0.25) == 50

    def test_growth_gt10(self):
        from monthly_revenue import revenue_score_bonus
        assert revenue_score_bonus(0.15) == 40

    def test_positive_growth(self):
        from monthly_revenue import revenue_score_bonus
        assert revenue_score_bonus(0.05) == 20

    def test_mild_decline(self):
        from monthly_revenue import revenue_score_bonus
        assert revenue_score_bonus(-0.05) == 0

    def test_severe_decline(self):
        from monthly_revenue import revenue_score_bonus
        assert revenue_score_bonus(-0.15) == -30

    def test_nan_returns_zero(self):
        from monthly_revenue import revenue_score_bonus
        assert revenue_score_bonus(float("nan")) == 0

    def test_none_returns_zero(self):
        from monthly_revenue import revenue_score_bonus
        assert revenue_score_bonus(None) == 0


# ---------------------------------------------------------------------------
# TestComputeRevenueSignals
# ---------------------------------------------------------------------------

def _make_revenue_df() -> pd.DataFrame:
    """Build a DataFrame for 2330 covering Jan–Dec 2024 and Jan 2025."""
    rows = []
    # Jan–Dec 2024 with revenue = 100 each
    for month in range(1, 13):
        rows.append({
            "stock_id": "2330",
            "date": f"2024-{month:02d}-01",
            "revenue": 100.0,
        })
    # Jan 2025: revenue = 120 → YoY = (120 - 100) / 100 = 0.20
    # Dec 2024 revenue = 100 → MoM = (120 - 100) / 100 = 0.10  (but Dec is last of 2024)
    # Override Dec 2024 to be 100 explicitly (already set above)
    rows.append({
        "stock_id": "2330",
        "date": "2025-01-01",
        "revenue": 120.0,
    })
    return pd.DataFrame(rows)


class TestComputeRevenueSignals:
    def test_yoy_computed_correctly(self):
        from monthly_revenue import compute_revenue_signals
        df = _make_revenue_df()
        result = compute_revenue_signals(df)
        jan25 = result[result["date"] == "2025-01-01"]
        assert len(jan25) == 1
        yoy = jan25.iloc[0]["revenue_yoy"]
        assert not math.isnan(yoy)
        assert abs(yoy - 0.20) < 1e-9

    def test_mom_computed_correctly(self):
        from monthly_revenue import compute_revenue_signals
        df = _make_revenue_df()
        result = compute_revenue_signals(df)
        # Jan 2025 MoM: prev month is Dec 2024 (revenue=100), Jan 2025=120
        # MoM = (120 - 100) / 100 = 0.20
        jan25 = result[result["date"] == "2025-01-01"]
        mom = jan25.iloc[0]["revenue_mom"]
        assert not math.isnan(mom)
        assert abs(mom - 0.20) < 1e-9

    def test_empty_df_returns_empty(self):
        from monthly_revenue import compute_revenue_signals
        empty = pd.DataFrame(columns=["stock_id", "date", "revenue"])
        result = compute_revenue_signals(empty)
        assert result.empty

    def test_output_columns_present(self):
        from monthly_revenue import compute_revenue_signals
        df = _make_revenue_df()
        result = compute_revenue_signals(df)
        for col in ("stock_id", "date", "revenue", "revenue_yoy", "revenue_mom", "revenue_3m_yoy"):
            assert col in result.columns


# ---------------------------------------------------------------------------
# TestFormatRevenueSummary
# ---------------------------------------------------------------------------

def _make_signals_df() -> pd.DataFrame:
    """Build a small signals DataFrame suitable for format_revenue_summary."""
    data = {
        "revenue": [200_000_000.0, 150_000_000.0],
        "revenue_yoy": [0.152, 0.085],
        "revenue_mom": [0.031, -0.012],
        "revenue_3m_yoy": [0.10, 0.05],
        "revenue_bonus": [40, 20],
    }
    idx = pd.Index(["2330", "2317"], name="stock_id")
    return pd.DataFrame(data, index=idx)


class TestFormatRevenueSummary:
    def test_returns_string(self):
        from monthly_revenue import format_revenue_summary
        df = _make_signals_df()
        result = format_revenue_summary(df, top_n=2)
        assert isinstance(result, str)
        assert len(result) > 0

    def test_contains_yoy_label(self):
        from monthly_revenue import format_revenue_summary
        df = _make_signals_df()
        result = format_revenue_summary(df, top_n=2)
        assert "YoY" in result

    def test_empty_df_returns_empty_string(self):
        from monthly_revenue import format_revenue_summary
        empty = pd.DataFrame(
            columns=["revenue", "revenue_yoy", "revenue_mom", "revenue_3m_yoy", "revenue_bonus"]
        )
        empty.index.name = "stock_id"
        result = format_revenue_summary(empty)
        assert result == ""


# ---------------------------------------------------------------------------
# TestFetchMonthlyRevenue
# ---------------------------------------------------------------------------

class TestFetchMonthlyRevenue:
    def test_no_token_returns_empty(self, monkeypatch):
        """Without a token, fetch_monthly_revenue returns empty DataFrame silently."""
        from monthly_revenue import fetch_monthly_revenue
        monkeypatch.delenv("FINMIND_TOKEN", raising=False)
        result = fetch_monthly_revenue("2025-01-01", "2025-02-01", token=None)
        assert isinstance(result, pd.DataFrame)
        assert result.empty

    def test_returns_dataframe(self, monkeypatch):
        """With a mocked requests.get, verify correct DataFrame shape and types."""
        sample_response = {
            "status": 200,
            "data": [
                {"stock_id": "2330", "date": "2025-01-01", "revenue": 200000000},
                {"stock_id": "2330", "date": "2025-02-01", "revenue": 210000000},
            ],
        }

        mock_resp = MagicMock()
        mock_resp.raise_for_status.return_value = None
        mock_resp.json.return_value = sample_response

        with patch("monthly_revenue.requests.get", return_value=mock_resp):
            from monthly_revenue import fetch_monthly_revenue
            result = fetch_monthly_revenue("2025-01-01", "2025-02-28", token="fake_token")

        assert isinstance(result, pd.DataFrame)
        assert len(result) == 2
        assert list(result.columns) == ["stock_id", "date", "revenue"]
        assert result["revenue"].dtype == float
        assert result.iloc[0]["stock_id"] == "2330"
        assert result.iloc[0]["revenue"] == 200_000_000.0
