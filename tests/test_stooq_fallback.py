"""Tests for the Stooq and FRED fallbacks used when Yahoo Finance blocks datacenter IPs."""
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


_FRED_CSV_VIX = """DATE,VIXCLS
2026-06-06,18.50
2026-06-07,19.10
2026-06-08,20.00
2026-06-09,20.50
2026-06-10,21.00
"""

_FRED_CSV_SP500 = """DATE,SP500
2026-06-06,5400.0
2026-06-07,5420.0
2026-06-08,5390.0
2026-06-09,5410.0
2026-06-10,5430.0
"""


class TestStooqSymbolMap:
    def test_every_us_ticker_has_stooq_fallback(self):
        from market_predictor import _US_TICKERS, _STOOQ_SYMBOLS
        missing = set(_US_TICKERS) - set(_STOOQ_SYMBOLS)
        assert not missing, f"tickers without Stooq fallback: {missing}"

    def test_fred_series_covers_major_macros(self):
        from market_predictor import _FRED_SERIES
        for key in ("sp500", "vix", "us10y", "us2y", "gold", "oil", "jpy", "usdcny"):
            assert key in _FRED_SERIES, f"{key} missing from _FRED_SERIES"


class TestFetchFredClose:
    def test_parses_fred_csv(self):
        from market_predictor import _fetch_fred_close
        with patch("requests.get", return_value=_mock_response(_FRED_CSV_VIX)):
            s = _fetch_fred_close("VIXCLS", "2026-06-01", "2026-06-10")
        assert s is not None
        assert len(s) == 5
        assert s.iloc[-1] == pytest.approx(21.0)

    def test_returns_none_on_non_date_header(self):
        from market_predictor import _fetch_fred_close
        with patch("requests.get", return_value=_mock_response("Error: No data found")):
            s = _fetch_fred_close("VIXCLS", "2026-06-01", "2026-06-10")
        assert s is None

    def test_returns_none_on_network_error(self):
        from market_predictor import _fetch_fred_close
        with patch("requests.get", side_effect=ConnectionError("blocked")):
            s = _fetch_fred_close("VIXCLS", "2026-06-01", "2026-06-10")
        assert s is None


class TestFetchUsFeaturesFallback:
    def _fred_router(self, url, params=None, **kwargs):
        """Route FRED requests to synthetic CSV based on series id."""
        series = (params or {}).get("id", "")
        if series == "VIXCLS":
            return _mock_response(_FRED_CSV_VIX)
        return _mock_response(_FRED_CSV_SP500)

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

    def test_fred_rescues_when_stooq_also_fails(self):
        """When both yfinance and stooq fail, FRED fills in macro indicators."""
        import market_predictor
        empty_df = pd.DataFrame()

        def _stooq_blocked(url, **kwargs):
            if "stooq" in url:
                raise ConnectionError("stooq blocked")
            return self._fred_router(url, **kwargs)

        with patch.object(market_predictor.yf, "download", return_value=empty_df):
            with patch("requests.get", side_effect=_stooq_blocked):
                result = market_predictor.fetch_us_features("2026-06-01", "2026-06-10")
        assert not result.empty
        assert "vix" in result.columns        # FRED VIXCLS → vix column
        assert "vix_ret1" in result.columns

    def test_all_sources_fail_returns_empty(self):
        import market_predictor
        empty_df = pd.DataFrame()
        with patch.object(market_predictor.yf, "download", return_value=empty_df):
            with patch("requests.get", side_effect=ConnectionError("blocked")):
                result = market_predictor.fetch_us_features("2026-06-01", "2026-06-10")
        assert result.empty
