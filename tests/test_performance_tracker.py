"""Tests for performance_tracker module."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pandas as pd
import pytest

from performance_tracker import (
    compute_period_stats,
    compute_pick_performance,
    format_performance_report,
    list_available_scan_dates,
    load_scan_picks,
    make_date_pairs,
    run_performance_analysis,
)


# ── Fixtures ───────────────────────────────────────────────────────────────────

def _write_batch_csv(scan_dir: Path, date: str, rows: list[dict]) -> None:
    df = pd.DataFrame(rows)
    df.to_csv(scan_dir / f"batch_seq1_{date}.csv", index=False, encoding="utf-8-sig")


def _make_scan_dir() -> tuple[tempfile.TemporaryDirectory, Path]:
    tmp = tempfile.TemporaryDirectory()
    scan_dir = Path(tmp.name)
    # Entry date picks
    _write_batch_csv(scan_dir, "2026-05-01", [
        {"stock_id": "2330", "name": "台積電", "entry_score": 1900.0, "close": 1000.0},
        {"stock_id": "2317", "name": "鴻海",   "entry_score": 1500.0, "close": 200.0},
        {"stock_id": "2454", "name": "聯發科", "entry_score": 1200.0, "close": 500.0},
    ])
    # Exit date — prices moved
    _write_batch_csv(scan_dir, "2026-05-08", [
        {"stock_id": "2330", "name": "台積電", "entry_score": 1800.0, "close": 1050.0},  # +5%
        {"stock_id": "2317", "name": "鴻海",   "entry_score": 1400.0, "close": 190.0},   # -5%
        {"stock_id": "2454", "name": "聯發科", "entry_score": 1100.0, "close": 520.0},   # +4%
    ])
    return tmp, scan_dir


class TestListAvailableScanDates:
    def test_finds_dates(self):
        tmp, scan_dir = _make_scan_dir()
        try:
            dates = list_available_scan_dates(scan_dir)
            assert "2026-05-01" in dates
            assert "2026-05-08" in dates
        finally:
            tmp.cleanup()

    def test_empty_dir_returns_empty(self, tmp_path):
        assert list_available_scan_dates(tmp_path) == []

    def test_dates_are_sorted(self):
        tmp, scan_dir = _make_scan_dir()
        try:
            dates = list_available_scan_dates(scan_dir)
            assert dates == sorted(dates)
        finally:
            tmp.cleanup()


class TestLoadScanPicks:
    def test_loads_top_n(self):
        tmp, scan_dir = _make_scan_dir()
        try:
            picks = load_scan_picks(scan_dir, "2026-05-01", top_n=2)
            assert len(picks) == 2
            # Should be sorted by entry_score descending
            assert str(picks.iloc[0]["stock_id"]) == "2330"
        finally:
            tmp.cleanup()

    def test_missing_date_returns_empty(self, tmp_path):
        df = load_scan_picks(tmp_path, "2099-01-01")
        assert df.empty

    def test_returns_dataframe(self):
        tmp, scan_dir = _make_scan_dir()
        try:
            picks = load_scan_picks(scan_dir, "2026-05-01")
            assert isinstance(picks, pd.DataFrame)
        finally:
            tmp.cleanup()


class TestComputePickPerformance:
    def test_computes_returns(self):
        tmp, scan_dir = _make_scan_dir()
        try:
            perf = compute_pick_performance(scan_dir, "2026-05-01", "2026-05-08", top_n=3)
            assert not perf.empty
            assert "return_pct" in perf.columns
            assert "hit" in perf.columns
        finally:
            tmp.cleanup()

    def test_winner_and_loser(self):
        tmp, scan_dir = _make_scan_dir()
        try:
            perf = compute_pick_performance(scan_dir, "2026-05-01", "2026-05-08", top_n=3)
            tsmc = perf[perf["stock_id"].astype(str) == "2330"].iloc[0]
            foxconn = perf[perf["stock_id"].astype(str) == "2317"].iloc[0]
            assert tsmc["return_pct"] == pytest.approx(5.0, abs=0.1)
            assert foxconn["return_pct"] == pytest.approx(-5.0, abs=0.1)
            assert tsmc["hit"]
            assert not foxconn["hit"]
        finally:
            tmp.cleanup()

    def test_missing_exit_date_returns_empty(self):
        tmp, scan_dir = _make_scan_dir()
        try:
            # Exit date has no CSV
            perf = compute_pick_performance(scan_dir, "2026-05-01", "2099-12-31", top_n=3)
            # return_pct should be NaN (no exit price found)
            assert perf["return_pct"].isna().all()
        finally:
            tmp.cleanup()

    def test_missing_entry_date_returns_empty(self, tmp_path):
        perf = compute_pick_performance(tmp_path, "2099-01-01", "2099-01-08")
        assert perf.empty


class TestComputePeriodStats:
    def _make_perf_df(self) -> pd.DataFrame:
        return pd.DataFrame({
            "stock_id":   ["2330", "2317", "2454"],
            "return_pct": [5.0, -3.0, 2.0],
        })

    def test_hit_rate(self):
        df = self._make_perf_df()
        stats = compute_period_stats(df, "2026-05-01", "2026-05-08")
        assert stats is not None
        assert stats.hit_rate == pytest.approx(66.7, abs=0.1)

    def test_avg_return(self):
        df = self._make_perf_df()
        stats = compute_period_stats(df, "2026-05-01", "2026-05-08")
        assert stats is not None
        expected = (5.0 + -3.0 + 2.0) / 3
        assert stats.avg_return == pytest.approx(expected, abs=0.01)

    def test_empty_df_returns_none(self):
        assert compute_period_stats(pd.DataFrame(), "2026-05-01", "2026-05-08") is None

    def test_all_nan_returns_none(self):
        df = pd.DataFrame({"return_pct": [float("nan"), float("nan")]})
        assert compute_period_stats(df, "2026-05-01", "2026-05-08") is None

    def test_best_worst(self):
        df = self._make_perf_df()
        stats = compute_period_stats(df, "2026-05-01", "2026-05-08")
        assert stats is not None
        assert stats.best == pytest.approx(5.0)
        assert stats.worst == pytest.approx(-3.0)


class TestMakeDatePairs:
    def test_basic_pairing(self):
        dates = ["2026-05-01", "2026-05-05", "2026-05-12"]
        pairs = make_date_pairs(dates, holding_days=7)
        # 2026-05-01 → 2026-05-12 (>= 7 days later)
        assert ("2026-05-01", "2026-05-12") in pairs

    def test_too_close_dates_skipped(self):
        dates = ["2026-05-01", "2026-05-03"]  # only 2 days apart
        pairs = make_date_pairs(dates, holding_days=7)
        assert len(pairs) == 0

    def test_single_date_returns_empty(self):
        assert make_date_pairs(["2026-05-01"], holding_days=5) == []

    def test_empty_returns_empty(self):
        assert make_date_pairs([], holding_days=5) == []


class TestRunPerformanceAnalysis:
    def test_returns_stats_and_combined(self):
        tmp, scan_dir = _make_scan_dir()
        try:
            stats, combined = run_performance_analysis(scan_dir, holding_days=5, top_n=3)
            assert isinstance(stats, list)
            assert isinstance(combined, pd.DataFrame)
        finally:
            tmp.cleanup()

    def test_empty_dir_returns_empty(self, tmp_path):
        stats, combined = run_performance_analysis(tmp_path, holding_days=5)
        assert stats == []
        assert combined.empty


class TestFormatPerformanceReport:
    def test_returns_string(self):
        tmp, scan_dir = _make_scan_dir()
        try:
            stats, combined = run_performance_analysis(scan_dir, holding_days=5, top_n=3)
            report = format_performance_report(stats, combined, top_n=3, holding_days=5)
            assert isinstance(report, str)
            assert len(report) > 0
        finally:
            tmp.cleanup()

    def test_no_data_message(self):
        report = format_performance_report([], pd.DataFrame(), top_n=20, holding_days=7)
        assert "尚無足夠歷史資料" in report

    def test_contains_hit_rate_when_data_present(self):
        from performance_tracker import PerformanceStats
        stats = [PerformanceStats(
            entry_date="2026-05-01", exit_date="2026-05-08",
            n_picks=3, n_with_exit=3, hit_rate=66.7, avg_return=1.33,
            avg_win=3.5, avg_loss=-3.0, best=5.0, worst=-3.0,
            sharpe_approx=0.8,
        )]
        combined = pd.DataFrame({"return_pct": [5.0, -3.0, 2.0]})
        report = format_performance_report(stats, combined)
        assert "勝率" in report
        assert "66.7" in report
