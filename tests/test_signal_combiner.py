import pandas as pd
import pytest
from signal_combiner import (
    enrich_candidates, compute_final_score,
    top_candidates, summary_stats, format_enriched_summary
)

def _make_scan_df():
    return pd.DataFrame({
        "stock_id": ["2330", "2317", "2454", "6505", "2382"],
        "name": ["台積電", "鴻海", "聯發科", "台塑化", "廣達"],
        "entry_score": [1800.0, 1400.0, 1600.0, 1200.0, 1000.0],
        "limit_down_streak": [0, 0, 0, 0, 0],
        "industry_category": ["半導體", "電子零件", "半導體", "石化", "電腦"],
        "entry_signal": [True, True, True, False, False],
        "entry_reason": ["MACD金叉,外資連買", "KD金叉", "ADX強趨勢", "", ""],
    })


class TestEnrichCandidates:
    def test_returns_dataframe(self):
        result = enrich_candidates(_make_scan_df(), "2026-06-11")
        assert isinstance(result, pd.DataFrame)

    def test_adds_grade_column(self):
        result = enrich_candidates(_make_scan_df(), "2026-06-11")
        assert "grade" in result.columns

    def test_no_crash_on_minimal_df(self):
        minimal = pd.DataFrame({
            "stock_id": ["2330"],
            "entry_score": [1800.0],
        })
        # Should not raise
        result = enrich_candidates(minimal, "2026-06-11")
        assert isinstance(result, pd.DataFrame)

    def test_returns_copy(self):
        original = _make_scan_df()
        original_cols = set(original.columns)
        _ = enrich_candidates(original, "2026-06-11")
        # Original should not have gained new columns
        assert set(original.columns) == original_cols


class TestComputeFinalScore:
    def test_adds_final_score_column(self):
        df = enrich_candidates(_make_scan_df(), "2026-06-11")
        result = compute_final_score(df)
        assert "final_score" in result.columns

    def test_higher_base_higher_final(self):
        df = enrich_candidates(_make_scan_df(), "2026-06-11")
        result = compute_final_score(df)
        score_2330 = result.loc[result["stock_id"] == "2330", "final_score"].iloc[0]
        score_2382 = result.loc[result["stock_id"] == "2382", "final_score"].iloc[0]
        assert score_2330 > score_2382


class TestTopCandidates:
    def test_returns_top_n(self):
        df = enrich_candidates(_make_scan_df(), "2026-06-11")
        df_enriched = compute_final_score(df)
        result = top_candidates(df_enriched, n=3)
        assert len(result) == 3

    def test_sorted_descending(self):
        df = enrich_candidates(_make_scan_df(), "2026-06-11")
        df_enriched = compute_final_score(df)
        result = top_candidates(df_enriched, n=5)
        scores = result["final_score"].tolist()
        assert scores == sorted(scores, reverse=True)


class TestSummaryStats:
    def test_returns_dict(self):
        df = enrich_candidates(_make_scan_df(), "2026-06-11")
        result = summary_stats(df)
        assert isinstance(result, dict)

    def test_has_required_keys(self):
        df = enrich_candidates(_make_scan_df(), "2026-06-11")
        result = summary_stats(df)
        for key in ("n_total", "n_grade_a", "n_grade_b", "n_entry_signal", "avg_final_score"):
            assert key in result, f"Missing key: {key}"


class TestFormatEnrichedSummary:
    def test_returns_string(self):
        df = enrich_candidates(_make_scan_df(), "2026-06-11")
        df = compute_final_score(df)
        result = format_enriched_summary(df)
        assert isinstance(result, str)
        assert len(result) > 0

    def test_contains_header(self):
        df = enrich_candidates(_make_scan_df(), "2026-06-11")
        df = compute_final_score(df)
        result = format_enriched_summary(df)
        assert "最終候選" in result

    def test_empty_df_returns_empty(self):
        result = format_enriched_summary(pd.DataFrame())
        assert result == ""
