"""
Tests for foreign_holding.py

Covers:
- holding_change_bonus
- compute_holding_change
- format_holding_summary
- fetch_all_shareholding
"""
from __future__ import annotations

import math
import os

import pandas as pd
import pytest

from foreign_holding import (
    compute_holding_change,
    fetch_all_shareholding,
    format_holding_summary,
    get_latest_holding_signals,
    holding_change_bonus,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_linear_df(
    stock_id: str = "2330",
    n: int = 10,
    base: float = 45.0,
    step: float = 0.3,
) -> pd.DataFrame:
    """Return a DataFrame with linearly increasing HoldingSharesRatio."""
    dates = (
        pd.date_range("2026-06-01", periods=n, freq="B")
        .strftime("%Y-%m-%d")
        .tolist()
    )
    return pd.DataFrame(
        {
            "stock_id": [stock_id] * n,
            "date": dates,
            "HoldingSharesRatio": [base + i * step for i in range(n)],
        }
    )


def _make_holding_signals_df(
    stock_ids: list[str] | None = None,
) -> pd.DataFrame:
    """Return a minimal get_latest_holding_signals-style DataFrame."""
    if stock_ids is None:
        stock_ids = ["2330", "2454", "2317"]
    chg_values = [2.1, 1.5, -0.8]
    latest_values = [75.0, 60.0, 50.0]
    rows = {
        "foreign_holding_latest": latest_values,
        "foreign_holding_chg_5d": chg_values,
        "holding_bonus": [20, 20, -10],
    }
    df = pd.DataFrame(rows, index=stock_ids)
    df.index.name = "stock_id"
    return df


# ===========================================================================
# TestHoldingChangeBonus
# ===========================================================================

class TestHoldingChangeBonus:
    """Tests for holding_change_bonus()."""

    def test_large_increase(self):
        """Change > 1.0 pp → bonus of 20."""
        assert holding_change_bonus(2.5) == 20
        assert holding_change_bonus(1.01) == 20

    def test_small_increase(self):
        """Change in (0.3, 1.0] → bonus of 10."""
        assert holding_change_bonus(0.5) == 10
        assert holding_change_bonus(1.0) == 10  # exactly 1.0 is NOT > 1.0

    def test_flat(self):
        """Change of 0.0 → bonus of 0."""
        assert holding_change_bonus(0.0) == 0

    def test_small_decrease(self):
        """Change in [-1.0, -0.3) → bonus of -10."""
        assert holding_change_bonus(-0.5) == -10
        assert holding_change_bonus(-1.0) == -10  # exactly -1.0 → -10

    def test_large_decrease(self):
        """Change < -1.0 → bonus of -20."""
        assert holding_change_bonus(-1.5) == -20
        assert holding_change_bonus(-2.0) == -20

    def test_nan_returns_zero(self):
        """NaN input → 0."""
        assert holding_change_bonus(float("nan")) == 0

    def test_none_returns_zero(self):
        """None input → 0."""
        assert holding_change_bonus(None) == 0

    def test_boundary_just_above_03(self):
        """Change just above 0.3 → 10."""
        assert holding_change_bonus(0.31) == 10

    def test_boundary_exactly_negative_03(self):
        """Change of exactly -0.3 → 0 (boundary is inclusive on -0.3 side)."""
        assert holding_change_bonus(-0.3) == 0


# ===========================================================================
# TestComputeHoldingChange
# ===========================================================================

class TestComputeHoldingChange:
    """Tests for compute_holding_change()."""

    def test_computes_change(self):
        """DataFrame with stock 2330, 10 dates, linearly increasing → chg_5d nonzero."""
        df = _make_linear_df()
        result = compute_holding_change(df)
        assert not result.empty
        row = result[result["stock_id"] == "2330"].iloc[0]
        assert row["foreign_holding_chg_5d"] != 0.0

    def test_single_row_zero_change(self):
        """Only 1 data point → chg_5d = 0.0."""
        df = _make_linear_df(n=1)
        result = compute_holding_change(df)
        assert len(result) == 1
        assert result.iloc[0]["foreign_holding_chg_5d"] == 0.0

    def test_output_columns(self):
        """Result must have exactly the three required columns."""
        df = _make_linear_df()
        result = compute_holding_change(df)
        expected_cols = {"stock_id", "foreign_holding_latest", "foreign_holding_chg_5d"}
        assert set(result.columns) == expected_cols

    def test_empty_df_returns_empty(self):
        """Empty input DataFrame → empty output with correct columns."""
        empty = pd.DataFrame(columns=["stock_id", "date", "HoldingSharesRatio"])
        result = compute_holding_change(empty)
        assert result.empty
        assert set(result.columns) == {
            "stock_id",
            "foreign_holding_latest",
            "foreign_holding_chg_5d",
        }

    def test_latest_value_is_last_row(self):
        """foreign_holding_latest should equal the last HoldingSharesRatio value."""
        df = _make_linear_df(n=5, base=50.0, step=1.0)
        result = compute_holding_change(df)
        row = result[result["stock_id"] == "2330"].iloc[0]
        # base=50, step=1, n=5 → last value = 50 + 4*1 = 54
        assert row["foreign_holding_latest"] == pytest.approx(54.0)

    def test_multiple_stocks(self):
        """Multiple stock_ids → one row per stock in output."""
        df1 = _make_linear_df(stock_id="2330", n=10)
        df2 = _make_linear_df(stock_id="2454", n=10, base=30.0)
        combined = pd.concat([df1, df2], ignore_index=True)
        result = compute_holding_change(combined)
        assert set(result["stock_id"]) == {"2330", "2454"}

    def test_chg_5d_magnitude(self):
        """With 10 rows and step 0.3, the 5d change should be ~5 * 0.3 = 1.5."""
        df = _make_linear_df(n=10, base=45.0, step=0.3)
        result = compute_holding_change(df)
        chg = result[result["stock_id"] == "2330"].iloc[0]["foreign_holding_chg_5d"]
        # n=10, lookback=5 → ago_idx = max(0, 9-5)=4; latest_idx=9
        # HoldingSharesRatio[9]=45+9*0.3=47.7, [4]=45+4*0.3=46.2 → diff=1.5
        assert chg == pytest.approx(1.5, abs=0.01)


# ===========================================================================
# TestFormatHoldingSummary
# ===========================================================================

class TestFormatHoldingSummary:
    """Tests for format_holding_summary()."""

    def test_empty_returns_empty_string(self):
        """Empty DataFrame → empty string."""
        empty = pd.DataFrame(
            columns=["foreign_holding_latest", "foreign_holding_chg_5d", "holding_bonus"]
        )
        empty.index.name = "stock_id"
        assert format_holding_summary(empty) == ""

    def test_none_returns_empty_string(self):
        """None input → empty string."""
        assert format_holding_summary(None) == ""

    def test_contains_header(self):
        """Non-empty df → output contains '外資' or '持股'."""
        df = _make_holding_signals_df()
        result = format_holding_summary(df)
        assert "外資" in result or "持股" in result

    def test_returns_string(self):
        """Non-empty df → returns str."""
        df = _make_holding_signals_df()
        result = format_holding_summary(df)
        assert isinstance(result, str)
        assert len(result) > 0

    def test_missing_chg_column_returns_empty(self):
        """DataFrame without foreign_holding_chg_5d → empty string."""
        df = pd.DataFrame(
            {"foreign_holding_latest": [75.0]},
            index=pd.Index(["2330"], name="stock_id"),
        )
        assert format_holding_summary(df) == ""

    def test_all_nan_chg_returns_empty(self):
        """All NaN in foreign_holding_chg_5d → empty string."""
        df = pd.DataFrame(
            {
                "foreign_holding_latest": [75.0],
                "foreign_holding_chg_5d": [float("nan")],
                "holding_bonus": [0],
            },
            index=pd.Index(["2330"], name="stock_id"),
        )
        assert format_holding_summary(df) == ""

    def test_contains_stock_id(self):
        """The formatted string should mention at least one stock ID."""
        df = _make_holding_signals_df(["2330", "2454", "2317"])
        result = format_holding_summary(df)
        # At least one of these stock IDs should appear
        found = any(sid in result for sid in ["2330", "2454", "2317"])
        assert found

    def test_multiline_output(self):
        """Output should have at least 2 lines."""
        df = _make_holding_signals_df()
        result = format_holding_summary(df)
        assert "\n" in result


# ===========================================================================
# TestFetchAllShareholding
# ===========================================================================

class TestFetchAllShareholding:
    """Tests for fetch_all_shareholding()."""

    def test_no_token_returns_empty(self, monkeypatch):
        """No FINMIND_TOKEN in env → returns empty DataFrame (does not raise)."""
        monkeypatch.delenv("FINMIND_TOKEN", raising=False)
        result = fetch_all_shareholding("2026-06-01", token=None)
        assert isinstance(result, pd.DataFrame)

    def test_no_token_returns_correct_columns(self, monkeypatch):
        """Empty result from missing token has the expected columns."""
        monkeypatch.delenv("FINMIND_TOKEN", raising=False)
        result = fetch_all_shareholding("2026-06-01", token=None)
        assert set(result.columns) == {"stock_id", "date", "HoldingSharesRatio"}

    def test_no_token_result_is_empty(self, monkeypatch):
        """Empty result from missing token has zero rows."""
        monkeypatch.delenv("FINMIND_TOKEN", raising=False)
        result = fetch_all_shareholding("2026-06-01", token=None)
        assert result.empty

    def test_empty_token_string_returns_empty(self):
        """Explicitly passing empty string token → returns empty DataFrame."""
        result = fetch_all_shareholding("2026-06-01", token="")
        assert isinstance(result, pd.DataFrame)
        assert result.empty

    def test_bad_token_returns_empty_df_not_raises(self):
        """An invalid token that causes an HTTP error → returns empty DataFrame."""
        result = fetch_all_shareholding("2026-06-01", token="invalid_token_xyz")
        assert isinstance(result, pd.DataFrame)
        # May or may not be empty depending on network; must not raise
