"""
Tests for disposition_filter.py

Covers: filter_candidates, format_skip_summary, is_under_disposition,
        fetch_disposition_stocks, and build_skip_set.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

import disposition_filter


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_df(stock_ids: list[str]) -> pd.DataFrame:
    return pd.DataFrame({
        "stock_id": stock_ids,
        "close": [100.0] * len(stock_ids),
        "volume": [1000] * len(stock_ids),
    })


# ---------------------------------------------------------------------------
# TestFilterCandidates
# ---------------------------------------------------------------------------

class TestFilterCandidates:
    def test_removes_skip_ids(self):
        df = _make_df(["2330", "2317", "2454"])
        result = disposition_filter.filter_candidates(df, frozenset({"2317"}))
        assert "2317" not in result["stock_id"].values
        assert set(result["stock_id"].values) == {"2330", "2454"}

    def test_no_skip(self):
        df = _make_df(["2330", "2317", "2454"])
        result = disposition_filter.filter_candidates(df, frozenset())
        assert len(result) == len(df)
        assert set(result["stock_id"].values) == {"2330", "2317", "2454"}

    def test_all_skipped(self):
        df = _make_df(["2330", "2317", "2454"])
        result = disposition_filter.filter_candidates(
            df, frozenset({"2330", "2317", "2454"})
        )
        assert len(result) == 0
        assert list(result.columns) == list(df.columns)

    def test_preserves_other_columns(self):
        df = _make_df(["2330", "2317"])
        result = disposition_filter.filter_candidates(df, frozenset({"2317"}))
        assert "close" in result.columns
        assert "volume" in result.columns
        assert result.iloc[0]["close"] == 100.0

    def test_returns_copy_not_inplace(self):
        df = _make_df(["2330", "2317", "2454"])
        original_len = len(df)
        result = disposition_filter.filter_candidates(df, frozenset({"2317"}))
        # Original df must be unchanged
        assert len(df) == original_len
        assert len(result) == original_len - 1


# ---------------------------------------------------------------------------
# TestFormatSkipSummary
# ---------------------------------------------------------------------------

class TestFormatSkipSummary:
    def test_empty_returns_empty_string(self):
        assert disposition_filter.format_skip_summary(frozenset()) == ""

    def test_few_stocks_lists_them(self):
        result = disposition_filter.format_skip_summary(frozenset({"2330", "2317"}))
        assert "2330" in result
        assert "2317" in result
        assert "⚠️" in result

    def test_single_stock_listed(self):
        result = disposition_filter.format_skip_summary(frozenset({"2330"}))
        assert "2330" in result
        assert "⚠️" in result

    def test_exactly_five_stocks_lists_them(self):
        ids = frozenset({"1001", "1002", "1003", "1004", "1005"})
        result = disposition_filter.format_skip_summary(ids)
        for sid in ids:
            assert sid in result

    def test_many_stocks_shows_count(self):
        ids = frozenset({str(i) for i in range(10)})
        result = disposition_filter.format_skip_summary(ids)
        assert "10 支" in result
        assert "⚠️" in result

    def test_six_stocks_shows_count(self):
        ids = frozenset({"1001", "1002", "1003", "1004", "1005", "1006"})
        result = disposition_filter.format_skip_summary(ids)
        assert "6 支" in result


# ---------------------------------------------------------------------------
# TestIsUnderDisposition
# ---------------------------------------------------------------------------

class TestIsUnderDisposition:
    def test_returns_true_when_in_set(self, monkeypatch):
        monkeypatch.setattr(
            disposition_filter,
            "fetch_disposition_stocks",
            lambda date, token=None: frozenset({"2317"}),
        )
        assert disposition_filter.is_under_disposition("2317", "2026-06-01") is True

    def test_not_in_set(self, monkeypatch):
        monkeypatch.setattr(
            disposition_filter,
            "fetch_disposition_stocks",
            lambda date, token=None: frozenset({"2317"}),
        )
        assert disposition_filter.is_under_disposition("2330", "2026-06-01") is False

    def test_returns_bool_type(self, monkeypatch):
        monkeypatch.setattr(
            disposition_filter,
            "fetch_disposition_stocks",
            lambda date, token=None: frozenset({"2317"}),
        )
        result = disposition_filter.is_under_disposition("2317", "2026-06-01")
        assert isinstance(result, bool)

    def test_empty_disposition_set_returns_false(self, monkeypatch):
        monkeypatch.setattr(
            disposition_filter,
            "fetch_disposition_stocks",
            lambda date, token=None: frozenset(),
        )
        assert disposition_filter.is_under_disposition("2317", "2026-06-01") is False


# ---------------------------------------------------------------------------
# TestFetchDispositionStocks
# ---------------------------------------------------------------------------

class TestFetchDispositionStocks:
    def test_no_token_returns_empty(self, monkeypatch):
        """When FINMIND_TOKEN is absent and no token arg, should return frozenset without raising."""
        monkeypatch.delenv("FINMIND_TOKEN", raising=False)

        mock_response = MagicMock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"status": 200, "data": []}

        with patch("disposition_filter.requests.get", return_value=mock_response):
            result = disposition_filter.fetch_disposition_stocks("2026-06-01", token=None)

        assert isinstance(result, frozenset)
        assert result == frozenset()

    def test_returns_frozenset_type(self, monkeypatch):
        monkeypatch.delenv("FINMIND_TOKEN", raising=False)

        mock_response = MagicMock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {
            "status": 200,
            "data": [
                {
                    "stock_id": "2317",
                    "date": "2026-06-01",
                    "start_date": "2026-06-01",
                    "end_date": "2026-06-10",
                },
            ],
        }

        with patch("disposition_filter.requests.get", return_value=mock_response):
            result = disposition_filter.fetch_disposition_stocks("2026-06-01")

        assert isinstance(result, frozenset)
        assert "2317" in result

    def test_http_error_returns_empty(self, monkeypatch):
        monkeypatch.delenv("FINMIND_TOKEN", raising=False)

        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = Exception("HTTP 500")

        with patch("disposition_filter.requests.get", return_value=mock_response):
            result = disposition_filter.fetch_disposition_stocks("2026-06-01")

        assert result == frozenset()

    def test_missing_data_key_returns_empty(self, monkeypatch):
        monkeypatch.delenv("FINMIND_TOKEN", raising=False)

        mock_response = MagicMock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"status": 200}

        with patch("disposition_filter.requests.get", return_value=mock_response):
            result = disposition_filter.fetch_disposition_stocks("2026-06-01")

        assert result == frozenset()

    def test_token_passed_in_params(self, monkeypatch):
        monkeypatch.delenv("FINMIND_TOKEN", raising=False)

        mock_response = MagicMock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"status": 200, "data": []}

        with patch("disposition_filter.requests.get", return_value=mock_response) as mock_get:
            disposition_filter.fetch_disposition_stocks("2026-06-01", token="test-token")
            call_kwargs = mock_get.call_args.kwargs
            # token is always passed via the "params" keyword argument
            call_params = call_kwargs.get("params", {})
            assert call_params.get("token") == "test-token"


# ---------------------------------------------------------------------------
# TestBuildSkipSet
# ---------------------------------------------------------------------------

class TestBuildSkipSet:
    def test_combines_both_sets(self, monkeypatch):
        monkeypatch.setattr(
            disposition_filter,
            "fetch_disposition_stocks",
            lambda date, token=None: frozenset({"A"}),
        )
        monkeypatch.setattr(
            disposition_filter,
            "fetch_suspended_stocks",
            lambda date, token=None, use_heuristic=False: frozenset({"B"}),
        )
        result = disposition_filter.build_skip_set(
            "2026-06-01", include_suspended=True
        )
        assert "A" in result
        assert "B" in result

    def test_include_suspended_false_excludes(self, monkeypatch):
        monkeypatch.setattr(
            disposition_filter,
            "fetch_disposition_stocks",
            lambda date, token=None: frozenset({"A"}),
        )
        monkeypatch.setattr(
            disposition_filter,
            "fetch_suspended_stocks",
            lambda date, token=None, use_heuristic=False: frozenset({"B"}),
        )
        result = disposition_filter.build_skip_set(
            "2026-06-01", include_suspended=False
        )
        assert "A" in result
        assert "B" not in result

    def test_returns_frozenset(self, monkeypatch):
        monkeypatch.setattr(
            disposition_filter,
            "fetch_disposition_stocks",
            lambda date, token=None: frozenset(),
        )
        result = disposition_filter.build_skip_set("2026-06-01")
        assert isinstance(result, frozenset)

    def test_empty_when_both_empty(self, monkeypatch):
        monkeypatch.setattr(
            disposition_filter,
            "fetch_disposition_stocks",
            lambda date, token=None: frozenset(),
        )
        monkeypatch.setattr(
            disposition_filter,
            "fetch_suspended_stocks",
            lambda date, token=None, use_heuristic=False: frozenset(),
        )
        result = disposition_filter.build_skip_set(
            "2026-06-01", include_suspended=True
        )
        assert result == frozenset()
