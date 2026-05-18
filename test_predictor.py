"""Tests for market_predictor.py — run with: python test_predictor.py"""
import numpy as np
import pandas as pd

from market_predictor import MarketPredictor, fetch_us_features


def _make_taiex(n: int = 120, start: str = "2024-01-01") -> pd.DataFrame:
    rng = np.random.default_rng(42)
    dates = pd.bdate_range(start, periods=n)
    close = 18000 + np.cumsum(rng.standard_normal(n) * 100)
    return pd.DataFrame({"date": dates, "close": close})


def _make_us(taiex_df: pd.DataFrame, drop_every: int = 5) -> pd.DataFrame:
    """Return US features aligned to TAIEX dates, with some dates missing (simulating weekends/holidays)."""
    rows = taiex_df.copy()
    rows = rows.iloc[::drop_every]  # keep every Nth row to create gaps
    rows = rows.rename(columns={"close": "sp500_ret1"})
    rows["sp500_ret1"] = rows["sp500_ret1"].pct_change().fillna(0)
    rows["vix"] = 20.0
    rows["nasdaq_ret1"] = rows["sp500_ret1"] * 1.1
    rows["sox_ret1"] = rows["sp500_ret1"] * 1.2
    rows["dxy_ret1"] = -rows["sp500_ret1"] * 0.3
    rows["us10y_ret1"] = rows["sp500_ret1"] * 0.1
    rows["sp500_ret5"] = rows["sp500_ret1"].rolling(5, min_periods=1).sum()
    return rows[["date", "sp500_ret1", "sp500_ret5", "nasdaq_ret1", "vix",
                 "sox_ret1", "dxy_ret1", "us10y_ret1"]].reset_index(drop=True)


def test_merge_us_ffill() -> None:
    taiex = _make_taiex(20)
    # US data only has Mon/Wed/Fri (every 2nd TAIEX row)
    us = _make_us(taiex, drop_every=2)
    p = MarketPredictor()
    merged = p._merge_us(taiex.copy(), us)

    # Every row should have a non-NaN sp500_ret1 after ffill (except possibly the very first)
    non_nan = merged["sp500_ret1"].notna().sum()
    assert non_nan >= len(merged) - 1, f"Expected nearly all rows filled, got {non_nan}/{len(merged)}"
    # The first row may still be NaN if US data doesn't start on the same date
    assert merged["sp500_ret1"].iloc[1:].notna().all(), "ffill should fill all rows after the first US date"


def test_predictor_fit_predict() -> None:
    taiex = _make_taiex(120)
    p = MarketPredictor(horizon=5)
    p.fit(taiex)
    result = p.predict_proba(taiex)

    assert result["trained"] is True, f"Expected trained=True, got {result}"
    assert 0.0 <= result["prob_up"] <= 1.0, f"prob_up out of range: {result['prob_up']}"
    assert result["confidence"] in ("high", "medium", "low")
    assert result["label"] in ("看多", "偏多", "中性", "偏空", "看空")


def test_predictor_with_us_features() -> None:
    taiex = _make_taiex(120)
    us = _make_us(taiex, drop_every=1)
    p = MarketPredictor(horizon=5)
    p.fit(taiex, us)
    result = p.predict_proba(taiex, us)

    assert result["trained"] is True
    assert result["us_features"] is True, f"Expected us_features=True, got {result}"
    assert 0.0 <= result["prob_up"] <= 1.0


def test_predictor_insufficient_data() -> None:
    taiex = _make_taiex(10)  # too few rows
    p = MarketPredictor(horizon=5, min_train_rows=60)
    p.fit(taiex)
    result = p.predict_proba(taiex)

    assert result["trained"] is False, f"Expected trained=False with insufficient data, got {result}"


def test_fetch_us_features_returns_dataframe() -> None:
    result = fetch_us_features("2024-01-01", "2024-01-31")
    assert isinstance(result, pd.DataFrame), f"Expected DataFrame, got {type(result)}"
    # May be empty if yfinance is unavailable — that's acceptable
    if not result.empty:
        assert "date" in result.columns


if __name__ == "__main__":
    tests = [
        test_merge_us_ffill,
        test_predictor_fit_predict,
        test_predictor_with_us_features,
        test_predictor_insufficient_data,
        test_fetch_us_features_returns_dataframe,
    ]
    for fn in tests:
        fn()
        print(f"  ✅ {fn.__name__}")
    print("\nAll tests passed.")
