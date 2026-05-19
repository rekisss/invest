"""Tests for fundamentals.py — run with: python test_fundamentals.py"""
import numpy as np
import pandas as pd

from fundamentals import compute_f_score, _pivot


def _make_long(rows: list[dict]) -> pd.DataFrame:
    """Build a (date, type, value) DataFrame as FinMind would return."""
    return pd.DataFrame(rows)


def _income(date: str, net_income: float, revenue: float, gross: float) -> list[dict]:
    return [
        {"date": date, "type": "NetIncome",   "value": net_income},
        {"date": date, "type": "Revenue",      "value": revenue},
        {"date": date, "type": "GrossProfit",  "value": gross},
    ]


def _balance(date: str, total_assets: float, cur_assets: float, cur_liab: float,
             lt_debt: float, shares: float) -> list[dict]:
    return [
        {"date": date, "type": "TotalAssets",        "value": total_assets},
        {"date": date, "type": "CurrentAssets",      "value": cur_assets},
        {"date": date, "type": "CurrentLiabilities", "value": cur_liab},
        {"date": date, "type": "LongTermBorrowings", "value": lt_debt},
        {"date": date, "type": "ShareCapital",       "value": shares},
    ]


def _cashflow(date: str, ocf: float) -> list[dict]:
    return [{"date": date, "type": "CashFlowsFromOperatingActivities", "value": ocf}]


def test_high_quality_stock() -> None:
    """A fundamentally strong stock should score 8 or 9."""
    inc_rows: list[dict] = []
    bal_rows: list[dict] = []
    cf_rows: list[dict] = []

    # Two annual periods: prior year → current year (improving on all metrics)
    inc_rows += _income("2022-12-31", net_income=500, revenue=5000, gross=2000)
    inc_rows += _income("2023-12-31", net_income=700, revenue=6000, gross=2600)

    bal_rows += _balance("2022-12-31", total_assets=10000, cur_assets=3000, cur_liab=1500, lt_debt=2000, shares=1000)
    bal_rows += _balance("2023-12-31", total_assets=11000, cur_assets=3500, cur_liab=1400, lt_debt=1800, shares=1000)

    cf_rows += _cashflow("2022-12-31", ocf=600)
    cf_rows += _cashflow("2023-12-31", ocf=900)

    result = compute_f_score(_make_long(inc_rows), _make_long(bal_rows), _make_long(cf_rows))

    assert result["f_score"] != -1, "Should have enough data"
    assert result["f_score"] >= 7, f"Expected F-Score ≥ 7 for strong stock, got {result['f_score']}\n{result['f_detail']}"
    assert result["f_detail"]["F1_roa_positive"] == 1
    assert result["f_detail"]["F2_ocf_positive"] == 1


def test_weak_stock() -> None:
    """A deteriorating stock should score low."""
    inc_rows: list[dict] = []
    bal_rows: list[dict] = []
    cf_rows: list[dict] = []

    inc_rows += _income("2022-12-31", net_income=400, revenue=5000, gross=2000)
    inc_rows += _income("2023-12-31", net_income=-100, revenue=4000, gross=1400)  # loss, revenue down

    bal_rows += _balance("2022-12-31", total_assets=10000, cur_assets=3000, cur_liab=1000, lt_debt=1000, shares=1000)
    bal_rows += _balance("2023-12-31", total_assets=9000, cur_assets=2000, cur_liab=1800, lt_debt=1500, shares=1200)  # more debt, shares diluted

    cf_rows += _cashflow("2022-12-31", ocf=300)
    cf_rows += _cashflow("2023-12-31", ocf=-50)  # negative OCF

    result = compute_f_score(_make_long(inc_rows), _make_long(bal_rows), _make_long(cf_rows))

    assert result["f_score"] != -1, "Should have enough data"
    assert result["f_score"] <= 3, f"Expected F-Score ≤ 3 for weak stock, got {result['f_score']}\n{result['f_detail']}"
    assert result["f_detail"]["F1_roa_positive"] == 0
    assert result["f_detail"]["F2_ocf_positive"] == 0


def test_empty_data_returns_minus_one() -> None:
    result = compute_f_score(pd.DataFrame(), pd.DataFrame(), pd.DataFrame())
    assert result["f_score"] == -1, "Empty data must return -1"


def test_insufficient_balance_data() -> None:
    """Single balance sheet period is not enough for year-over-year comparisons."""
    inc_rows = _income("2023-12-31", net_income=500, revenue=5000, gross=2000)
    bal_rows = _balance("2023-12-31", total_assets=10000, cur_assets=3000, cur_liab=1000, lt_debt=500, shares=1000)
    cf_rows  = _cashflow("2023-12-31", ocf=600)
    result = compute_f_score(_make_long(inc_rows), _make_long(bal_rows), _make_long(cf_rows))
    # Only one balance sheet period — total_assets has only 1 non-NaN value after _last2
    assert result["f_score"] == -1, "Single period should return -1"


def test_pivot_wide_format() -> None:
    """_pivot should handle already-wide DataFrames (no type/value columns)."""
    df = pd.DataFrame({
        "date":        ["2023-03-31", "2023-06-30"],
        "NetIncome":   [100.0, 120.0],
        "Revenue":     [1000.0, 1100.0],
    })
    pivoted = _pivot(df)
    assert "NetIncome" in pivoted.columns
    assert len(pivoted) == 2


def test_f_score_range() -> None:
    """F-Score must always be in [0, 9] or -1."""
    inc_rows = _income("2022-12-31", 200, 3000, 1000) + _income("2023-12-31", 300, 3500, 1200)
    bal_rows = (
        _balance("2022-12-31", 8000, 2000, 800, 1000, 500)
        + _balance("2023-12-31", 9000, 2200, 750, 900, 500)
    )
    cf_rows = _cashflow("2022-12-31", 250) + _cashflow("2023-12-31", 350)
    result = compute_f_score(_make_long(inc_rows), _make_long(bal_rows), _make_long(cf_rows))
    score = result["f_score"]
    assert score == -1 or (0 <= score <= 9), f"F-Score {score} out of valid range"


if __name__ == "__main__":
    import traceback
    tests = [
        test_high_quality_stock,
        test_weak_stock,
        test_empty_data_returns_minus_one,
        test_insufficient_balance_data,
        test_pivot_wide_format,
        test_f_score_range,
    ]
    failed = []
    for fn in tests:
        try:
            fn()
            print(f"  ✅ {fn.__name__}")
        except Exception as exc:
            print(f"  ❌ {fn.__name__}: {exc}")
            traceback.print_exc()
            failed.append(fn.__name__)
    if failed:
        print(f"\n{len(failed)} test(s) FAILED: {failed}")
        raise SystemExit(1)
    print("\nAll tests passed.")
