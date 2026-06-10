"""Tests for the Stooq fallback used when Yahoo Finance blocks datacenter IPs."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pandas as pd
import pytest


_CSV_OK = """Date,Open,High,Low,Close,Volume
2026-06-08,6000.1,6050.2,5990.0,6040.5,1000000
2026-06-09,6040.5,6080.0,6030.1,6075.3,1100000
2026-06-10,6075.3,6100.0,6060.0,6090.8,1200000
"""


def _mock_response(text: str, status: int = 200):
    resp = MagicMock()
    resp.text = text
    resp.status_code = status
    resp.raise_for_status = MagicMock()
    return resp


class TestFetchStooqClose:
    def test_parses_csv_to_series(self):
        from market_predictor import _fetch_stooq_close
        with patch("requests.get", return_value=_mock_response(_CSV_OK)):
            s = _fetch_stooq_close("^spx", "2026-06-01", "2026-06-10")
        assert s is not None
        assert len(s) == 3
        assert s.iloc[-1] == pytest.approx(6090.8)
        assert isinstance(s.index, pd.DatetimeIndex)

    def test_returns_none_on_no_data(self):
        from market_predictor import _fetch_stooq_close
        with patch("requests.get", return_value=_mock_response("No data")):
            s = _fetch_stooq_close("xxx.us", "2026-06-01", "2026-06-10")
        assert s is None

    def test_returns_none_on_empty_body(self):
        from market_predictor import _fetch_stooq_close
        with patch("requests.get", return_value=_mock_response("")):
            s = _fetch_stooq_close("^spx", "2026-06-01", "2026-06-10")
        assert s is None

    def test_url_contains_symbol_and_dates(self):
        from market_predictor import _fetch_stooq_close
        with patch("requests.get", return_value=_mock_response(_CSV_OK)) as mock_get:
            _fetch_stooq_close("tsm.us", "2026-06-01", "2026-06-10")
        url = mock_get.call_args[0][0]
        assert "s=tsm.us" in url
        assert "d1=20260601" in url
        assert "d2=20260610" in url


class TestStooqSymbolMap:
    def test_every_us_ticker_has_stooq_fallback(self):
        from market_predictor import _US_TICKERS, _STOOQ_SYMBOLS
        missing = set(_US_TICKERS) - set(_STOOQ_SYMBOLS)
        assert not missing, f"tickers without Stooq fallback: {missing}"


class TestFetchUsFeaturesFallback:
    def test_stooq_rescues_yahoo_failures(self):
        """When yfinance returns empty for every ticker, Stooq fallback fills in."""
        import market_predictor
        empty_df = pd.DataFrame()
        with patch.object(market_predictor.yf, "download", return_value=empty_df):
            with patch("requests.get", return_value=_mock_response(_CSV_OK)):
                result = market_predictor.fetch_us_features("2026-06-01", "2026-06-10")
        assert not result.empty
        assert "sp500_ret1" in result.columns
        assert "vix" in result.columns

    def test_all_sources_fail_returns_empty(self):
        import market_predictor
        empty_df = pd.DataFrame()
        with patch.object(market_predictor.yf, "download", return_value=empty_df):
            with patch("requests.get", side_effect=ConnectionError("blocked")):
                result = market_predictor.fetch_us_features("2026-06-01", "2026-06-10")
        assert result.empty
