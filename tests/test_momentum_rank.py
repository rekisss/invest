import math
import sys
import os

import numpy as np
import pandas as pd
import pytest

# Ensure the parent directory is on the path so momentum_rank can be imported
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from momentum_rank import (
    compute_price_momentum,
    compute_composite_momentum,
    rank_by_momentum,
    absolute_momentum_filter,
    cross_sectional_rs,
    momentum_score_to_bonus,
    format_momentum_report,
)


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _make_prices(n_stocks: int = 3, n_days: int = 300, trend: float = 0.001) -> pd.DataFrame:
    """Generate a synthetic rising price DataFrame."""
    rng = np.random.default_rng(42)
    stock_ids = [f"stock_{i}" for i in range(n_stocks)]
    # Start at 100, apply daily multiplicative trend + small noise
    returns = trend + rng.normal(0, 0.005, size=(n_days, n_stocks))
    prices = 100 * np.cumprod(1 + returns, axis=0)
    dates = pd.date_range("2022-01-01", periods=n_days, freq="B")
    return pd.DataFrame(prices, index=dates, columns=stock_ids)


# ---------------------------------------------------------------------------
# TestComputePriceMomentum
# ---------------------------------------------------------------------------

class TestComputePriceMomentum:
    def test_basic_output(self):
        prices = _make_prices(n_stocks=3, n_days=300)
        result = compute_price_momentum(prices)
        assert isinstance(result, pd.DataFrame)
        for col in ("mom_1m", "mom_3m", "mom_6m", "mom_12m"):
            assert col in result.columns, f"Missing column: {col}"

    def test_uptrend_positive_momentum(self):
        # Strictly rising prices → all momentum values should be positive
        prices = _make_prices(n_stocks=3, n_days=300, trend=0.002)
        result = compute_price_momentum(prices)
        for col in ("mom_1m", "mom_3m", "mom_6m", "mom_12m"):
            assert (result[col].dropna() > 0).all(), f"{col} should be positive in uptrend"

    def test_insufficient_data_nan(self):
        # Only 30 rows → 6M (126d) and 12M (252d) lookbacks require more data
        prices = _make_prices(n_stocks=3, n_days=30, trend=0.001)
        result = compute_price_momentum(prices)
        assert result["mom_6m"].isna().all(), "mom_6m should be NaN with 30 rows"
        assert result["mom_12m"].isna().all(), "mom_12m should be NaN with 30 rows"

    def test_index_is_stock_ids(self):
        prices = _make_prices(n_stocks=3, n_days=300)
        result = compute_price_momentum(prices)
        assert list(result.index) == list(prices.columns)


# ---------------------------------------------------------------------------
# TestComputeCompositeMomentum
# ---------------------------------------------------------------------------

class TestComputeCompositeMomentum:
    def test_returns_series(self):
        prices = _make_prices(n_stocks=5, n_days=300)
        mom_df = compute_price_momentum(prices)
        result = compute_composite_momentum(mom_df)
        assert isinstance(result, pd.Series)

    def test_range_0_to_1(self):
        prices = _make_prices(n_stocks=5, n_days=300)
        mom_df = compute_price_momentum(prices)
        result = compute_composite_momentum(mom_df)
        valid = result.dropna()
        assert (valid >= 0).all() and (valid <= 1).all(), "Scores must be in [0, 1]"

    def test_higher_momentum_higher_score(self):
        # Build two groups: one with high momentum, one with low
        prices_high = _make_prices(n_stocks=3, n_days=300, trend=0.005)
        prices_low = _make_prices(n_stocks=3, n_days=300, trend=-0.001)
        # Rename columns so they don't clash
        prices_high.columns = ["h0", "h1", "h2"]
        prices_low.columns = ["l0", "l1", "l2"]
        prices = pd.concat([prices_high, prices_low], axis=1)
        mom_df = compute_price_momentum(prices)
        composite = compute_composite_momentum(mom_df)
        # All high-trend stocks should rank above all low-trend stocks
        high_scores = composite[["h0", "h1", "h2"]]
        low_scores = composite[["l0", "l1", "l2"]]
        assert high_scores.mean() > low_scores.mean(), (
            "High-momentum stocks should have higher composite score"
        )


# ---------------------------------------------------------------------------
# TestAbsoluteMomentumFilter
# ---------------------------------------------------------------------------

class TestAbsoluteMomentumFilter:
    def test_returns_bool_series(self):
        prices = _make_prices(n_stocks=3, n_days=300)
        benchmark = prices.iloc[:, 0]  # use first stock as benchmark
        result = absolute_momentum_filter(prices, benchmark)
        assert result.dtype == bool, "Result should be a boolean Series"

    def test_outperformer_true(self):
        # Stock with 50% annual return vs benchmark with 10%
        n = 300
        dates = pd.date_range("2022-01-01", periods=n, freq="B")
        # Stock: 50% total return over 252 days
        stock_prices = pd.Series(
            np.linspace(100, 150, n), index=dates, name="winner"
        )
        prices = stock_prices.to_frame()
        # Benchmark: 10% total return over 252 days
        benchmark = pd.Series(np.linspace(100, 110, n), index=dates)
        result = absolute_momentum_filter(prices, benchmark)
        assert result["winner"] is True or result["winner"] == True

    def test_underperformer_false(self):
        n = 300
        dates = pd.date_range("2022-01-01", periods=n, freq="B")
        # Stock: only 5% return
        stock_prices = pd.Series(
            np.linspace(100, 105, n), index=dates, name="loser"
        )
        prices = stock_prices.to_frame()
        # Benchmark: 20% return
        benchmark = pd.Series(np.linspace(100, 120, n), index=dates)
        result = absolute_momentum_filter(prices, benchmark)
        assert result["loser"] is False or result["loser"] == False

    def test_empty_benchmark_all_true(self):
        prices = _make_prices(n_stocks=3, n_days=300)
        benchmark = pd.Series([], dtype=float)
        result = absolute_momentum_filter(prices, benchmark)
        assert result.all(), "All should be True with empty benchmark"


# ---------------------------------------------------------------------------
# TestMomentumScoreToBonus
# ---------------------------------------------------------------------------

class TestMomentumScoreToBonus:
    def test_top_score(self):
        assert momentum_score_to_bonus(0.95) == 50

    def test_mid_score(self):
        assert momentum_score_to_bonus(0.60) == 10

    def test_low_score(self):
        assert momentum_score_to_bonus(0.20) == -20

    def test_nan_returns_zero(self):
        assert momentum_score_to_bonus(float("nan")) == 0


# ---------------------------------------------------------------------------
# TestFormatMomentumReport
# ---------------------------------------------------------------------------

class TestFormatMomentumReport:
    def _make_ranked_df(self, n: int = 5) -> pd.DataFrame:
        prices = _make_prices(n_stocks=n, n_days=300)
        return rank_by_momentum(prices, top_n=n)

    def test_returns_string(self):
        ranked_df = self._make_ranked_df()
        result = format_momentum_report(ranked_df)
        assert isinstance(result, str) and len(result) > 0

    def test_contains_header(self):
        ranked_df = self._make_ranked_df()
        result = format_momentum_report(ranked_df)
        assert "動能排行榜" in result

    def test_empty_df_returns_empty(self):
        empty_df = pd.DataFrame(
            columns=["stock_id", "composite_momentum", "mom_1m", "mom_3m", "mom_6m", "mom_12m"]
        )
        result = format_momentum_report(empty_df)
        assert result == ""
