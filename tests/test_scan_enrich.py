"""Tests for scan_enrich module."""
from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from scan_enrich import (
    _find_latest_date,
    _load_all_batch_csvs,
    compute_crosssectional_signals,
    run_enrichment,
)


# ── Fixtures ───────────────────────────────────────────────────────────────────

def _write_batch(scan_dir: Path, seg: int, date: str, rows: list[dict]) -> None:
    pd.DataFrame(rows).to_csv(
        scan_dir / f"batch_seq{seg}_{date}.csv", index=False, encoding="utf-8-sig"
    )


def _make_scan_dir(date: str = "2026-06-11") -> tuple[tempfile.TemporaryDirectory, Path]:
    tmp = tempfile.TemporaryDirectory()
    d = Path(tmp.name)

    # Seg 0: semis
    _write_batch(d, 0, date, [
        {"stock_id": 2330, "name": "台積電", "entry_score": 1900.0, "close": 1000.0,
         "industry_category": "半導體", "above_ema60": 1, "volume_ratio": 2.5,
         "momentum_score": 80.0, "f_score": 7},
        {"stock_id": 2454, "name": "聯發科", "entry_score": 1600.0, "close": 500.0,
         "industry_category": "半導體", "above_ema60": 1, "volume_ratio": 1.8,
         "momentum_score": 65.0, "f_score": -1},
        {"stock_id": 2379, "name": "瑞昱",  "entry_score": 1200.0, "close": 300.0,
         "industry_category": "半導體", "above_ema60": 0, "volume_ratio": 1.0,
         "momentum_score": 40.0, "f_score": -1},
    ])
    # Seg 1: financials
    _write_batch(d, 1, date, [
        {"stock_id": 2882, "name": "國泰金", "entry_score": 1000.0, "close": 50.0,
         "industry_category": "金融", "above_ema60": 1, "volume_ratio": 1.2,
         "momentum_score": 55.0, "f_score": 5},
        {"stock_id": 2891, "name": "中信金", "entry_score": 900.0, "close": 30.0,
         "industry_category": "金融", "above_ema60": 0, "volume_ratio": 0.8,
         "momentum_score": 42.0, "f_score": 4},
    ])
    return tmp, d


class TestFindLatestDate:
    def test_finds_date(self):
        tmp, d = _make_scan_dir("2026-06-11")
        try:
            assert _find_latest_date(d) == "2026-06-11"
        finally:
            tmp.cleanup()

    def test_latest_of_multiple(self):
        tmp = tempfile.TemporaryDirectory()
        d = Path(tmp.name)
        try:
            for date in ["2026-06-09", "2026-06-11", "2026-06-10"]:
                _write_batch(d, 0, date, [{"stock_id": 1, "entry_score": 100}])
            assert _find_latest_date(d) == "2026-06-11"
        finally:
            tmp.cleanup()

    def test_empty_dir_returns_none(self, tmp_path):
        assert _find_latest_date(tmp_path) is None


class TestLoadAllBatchCsvs:
    def test_loads_and_dedupes(self):
        tmp, d = _make_scan_dir()
        try:
            df = _load_all_batch_csvs(d, "2026-06-11")
            assert not df.empty
            assert df["stock_id"].nunique() == len(df)  # no duplicates
        finally:
            tmp.cleanup()

    def test_returns_sorted_by_score(self):
        tmp, d = _make_scan_dir()
        try:
            df = _load_all_batch_csvs(d, "2026-06-11")
            scores = df["entry_score"].tolist()
            assert scores == sorted(scores, reverse=True)
        finally:
            tmp.cleanup()

    def test_missing_date_returns_empty(self, tmp_path):
        assert _load_all_batch_csvs(tmp_path, "2099-01-01").empty


class TestComputeCrosssectionalSignals:
    def _make_df(self) -> pd.DataFrame:
        tmp, d = _make_scan_dir()
        try:
            return _load_all_batch_csvs(d, "2026-06-11")
        finally:
            tmp.cleanup()

    def test_adds_market_rs_rank(self):
        df = compute_crosssectional_signals(self._make_df())
        assert "market_rs_rank" in df.columns
        assert df["market_rs_rank"].between(0, 100).all()

    def test_top_stock_has_highest_rank(self):
        df = compute_crosssectional_signals(self._make_df())
        top_row = df.loc[df["entry_score"].idxmax()]
        assert top_row["market_rs_rank"] == pytest.approx(100.0, abs=1.0)

    def test_adds_sector_rs(self):
        df = compute_crosssectional_signals(self._make_df())
        assert "sector_rs" in df.columns
        # sector_rs is deviation from sector median — best in sector > 0
        best_semi = df[df["industry_category"] == "半導體"]["sector_rs"].max()
        assert best_semi > 0

    def test_sector_rs_rank_within_sector(self):
        df = compute_crosssectional_signals(self._make_df())
        assert "sector_rs_rank" in df.columns
        # Best stock in semi sector should have rank 100
        semi = df[df["industry_category"] == "半導體"]
        assert semi["sector_rs_rank"].max() == pytest.approx(100.0, abs=1.0)

    def test_sector_breadth_between_0_and_100(self):
        df = compute_crosssectional_signals(self._make_df())
        assert "sector_breadth_60" in df.columns
        assert df["sector_breadth_60"].between(0, 100).all()

    def test_semiconductor_breadth_correct(self):
        df = compute_crosssectional_signals(self._make_df())
        # Semi has 2/3 above EMA60 (2330 and 2454 have above_ema60=1, 2379=0)
        semi_rows = df[df["industry_category"] == "半導體"]
        # All stocks in a sector share the same breadth value
        breadth = semi_rows["sector_breadth_60"].iloc[0]
        assert breadth == pytest.approx(66.7, abs=1.0)

    def test_sector_vol_zscore(self):
        df = compute_crosssectional_signals(self._make_df())
        assert "sector_vol_zscore" in df.columns
        # 台積電 has highest volume_ratio (2.5) in semi → positive z-score
        tsmc = df[df["stock_id"].astype(str) == "2330"].iloc[0]
        assert tsmc["sector_vol_zscore"] > 0

    def test_sector_leader_flag(self):
        df = compute_crosssectional_signals(self._make_df())
        assert "is_sector_leader" in df.columns
        # 台積電 is top-1 in semi → leader
        tsmc = df[df["stock_id"].astype(str) == "2330"].iloc[0]
        assert tsmc["is_sector_leader"]

    def test_sector_stock_count(self):
        df = compute_crosssectional_signals(self._make_df())
        assert "sector_stock_count" in df.columns
        tsmc = df[df["stock_id"].astype(str) == "2330"].iloc[0]
        assert tsmc["sector_stock_count"] == 3

    def test_empty_df_returns_empty(self):
        result = compute_crosssectional_signals(pd.DataFrame())
        assert result.empty

    def test_no_sector_column_still_works(self):
        tmp, d = _make_scan_dir()
        try:
            df = _load_all_batch_csvs(d, "2026-06-11").drop(columns=["industry_category"])
            result = compute_crosssectional_signals(df)
            assert "market_rs_rank" in result.columns
            assert result["sector_rs"].isna().all()
        finally:
            tmp.cleanup()


class TestRunEnrichment:
    def test_enrichment_writes_new_columns(self):
        tmp, d = _make_scan_dir()
        try:
            run_enrichment(d, "2026-06-11", token="")
            # Read back and check new columns were added
            df = _load_all_batch_csvs(d, "2026-06-11")
            for col in ["market_rs_rank", "sector_rs", "sector_rs_rank",
                        "sector_breadth_60", "is_sector_leader", "sector_stock_count"]:
                assert col in df.columns, f"Missing column after enrichment: {col}"
        finally:
            tmp.cleanup()

    def test_enrichment_preserves_original_columns(self):
        tmp, d = _make_scan_dir()
        try:
            orig_df = _load_all_batch_csvs(d, "2026-06-11")
            orig_scores = orig_df.set_index("stock_id")["entry_score"].to_dict()
            run_enrichment(d, "2026-06-11", token="")
            enriched_df = _load_all_batch_csvs(d, "2026-06-11")
            for sid, orig_score in orig_scores.items():
                row = enriched_df[enriched_df["stock_id"] == sid]
                if not row.empty:
                    assert float(row.iloc[0]["entry_score"]) == pytest.approx(orig_score)
        finally:
            tmp.cleanup()

    def test_missing_date_exits(self, tmp_path):
        with pytest.raises(SystemExit):
            run_enrichment(tmp_path, "2099-01-01", token="")
