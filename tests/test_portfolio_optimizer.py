"""Tests for portfolio_optimizer module."""
from __future__ import annotations

import pandas as pd
import pytest

from portfolio_optimizer import (
    format_portfolio_report,
    portfolio_summary,
    suggest_portfolio,
)


def _make_candidates(n: int = 5) -> pd.DataFrame:
    return pd.DataFrame({
        "stock_id":          [f"20{i:02d}" for i in range(n)],
        "name":              [f"股票{i}"   for i in range(n)],
        "grade":             ["A", "A", "B", "B", "C"][:n],
        "entry_score":       [1800.0, 1600.0, 1400.0, 1200.0, 1000.0][:n],
        "close":             [500.0,  300.0,  200.0,  100.0,   50.0][:n],
        "atr14":             [10.0,    6.0,    4.0,    2.0,    1.0][:n],
        "industry_category": ["半導體", "半導體", "金融", "金融", "電子"][:n],
    })


class TestSuggestPortfolio:
    def test_returns_dataframe(self):
        df = suggest_portfolio(_make_candidates())
        assert isinstance(df, pd.DataFrame)

    def test_non_empty_for_valid_candidates(self):
        df = suggest_portfolio(_make_candidates(), portfolio_value=1_000_000)
        assert not df.empty

    def test_required_columns_present(self):
        df = suggest_portfolio(_make_candidates())
        for col in ["stock_id", "close", "stop_price", "shares", "position_value", "weight_pct"]:
            assert col in df.columns, f"Missing column: {col}"

    def test_empty_input_returns_empty(self):
        df = suggest_portfolio(pd.DataFrame())
        assert df.empty

    def test_respects_max_positions(self):
        candidates = _make_candidates(5)
        df = suggest_portfolio(candidates, max_positions=2, portfolio_value=10_000_000)
        assert len(df) <= 2

    def test_excludes_x_grade(self):
        candidates = _make_candidates(3)
        candidates.loc[0, "grade"] = "X"
        df = suggest_portfolio(candidates)
        assert "X" not in df["grade"].values

    def test_excludes_below_min_grade(self):
        candidates = _make_candidates(5)
        df = suggest_portfolio(candidates, min_grade="B")
        assert "C" not in df["grade"].values
        assert "D" not in df["grade"].values

    def test_weight_pct_sums_reasonable(self):
        df = suggest_portfolio(_make_candidates(), portfolio_value=1_000_000)
        total_weight = df["weight_pct"].sum()
        assert total_weight <= 100.0
        assert total_weight > 0.0

    def test_position_value_le_max_single(self):
        portfolio_value = 1_000_000
        max_single = 0.15
        df = suggest_portfolio(_make_candidates(), portfolio_value=portfolio_value, max_single_pct=max_single)
        assert (df["position_value"] <= portfolio_value * max_single + 1).all()

    def test_sector_cap_respected(self):
        # 2 semi stocks should be capped at 30% total sector weight
        candidates = _make_candidates(5)
        df = suggest_portfolio(
            candidates, portfolio_value=1_000_000,
            max_sector_pct=0.30, max_single_pct=0.20
        )
        if "sector" in df.columns:
            semi_weight = df[df["sector"] == "半導體"]["weight_pct"].sum()
            assert semi_weight <= 31.0  # 1% tolerance for rounding

    def test_stop_price_below_close(self):
        df = suggest_portfolio(_make_candidates())
        assert (df["stop_price"] < df["close"]).all()

    def test_shares_positive(self):
        df = suggest_portfolio(_make_candidates(), portfolio_value=1_000_000)
        assert (df["shares"] > 0).all()

    def test_no_grade_column_still_works(self):
        candidates = _make_candidates().drop(columns=["grade"])
        df = suggest_portfolio(candidates, portfolio_value=1_000_000, min_grade="C")
        # Without grade column, no grade filtering is applied
        assert isinstance(df, pd.DataFrame)

    def test_zero_close_excluded(self):
        candidates = _make_candidates(3)
        candidates.loc[0, "close"] = 0.0
        df = suggest_portfolio(candidates, portfolio_value=1_000_000)
        assert "2000" not in df["stock_id"].values


class TestPortfolioSummary:
    def test_empty_allocation(self):
        summary = portfolio_summary(pd.DataFrame(), portfolio_value=1_000_000)
        assert summary["n_positions"] == 0
        assert summary["cash"] == 1_000_000

    def test_invested_and_cash_sum_to_portfolio(self):
        df = suggest_portfolio(_make_candidates(), portfolio_value=1_000_000)
        summary = portfolio_summary(df, portfolio_value=1_000_000)
        assert abs(summary["total_invested"] + summary["cash"] - 1_000_000) <= 1  # rounding

    def test_n_positions_matches_df(self):
        df = suggest_portfolio(_make_candidates(), portfolio_value=5_000_000)
        summary = portfolio_summary(df, portfolio_value=5_000_000)
        assert summary["n_positions"] == len(df)


class TestFormatPortfolioReport:
    def test_returns_string(self):
        df = suggest_portfolio(_make_candidates(), portfolio_value=1_000_000)
        report = format_portfolio_report(df, portfolio_value=1_000_000)
        assert isinstance(report, str)
        assert len(report) > 0

    def test_contains_stock_ids(self):
        candidates = _make_candidates(3)
        df = suggest_portfolio(candidates, portfolio_value=5_000_000)
        report = format_portfolio_report(df, portfolio_value=5_000_000)
        for sid in df["stock_id"].tolist():
            assert sid in report

    def test_empty_allocation_message(self):
        report = format_portfolio_report(pd.DataFrame(), portfolio_value=1_000_000)
        assert "無符合條件" in report

    def test_contains_sector_breakdown(self):
        df = suggest_portfolio(_make_candidates(), portfolio_value=5_000_000)
        report = format_portfolio_report(df, portfolio_value=5_000_000)
        assert "類股分配" in report
