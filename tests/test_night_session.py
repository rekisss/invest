"""Tests for fetch_night_session — FinMind trading_session='after_market' handling."""
from __future__ import annotations

from unittest.mock import MagicMock

import pandas as pd
import pytest

from taiwan_futures import fetch_night_session


def _finmind_frame():
    """Realistic TaiwanFuturesDaily shape: day=position, night=after_market,
    night rows recorded under the previous trading day's date."""
    return pd.DataFrame({
        "date": ["2026-06-09", "2026-06-09", "2026-06-10", "2026-06-10", "2026-06-10"],
        "future_id": ["TX"] * 5,
        "contract_date": ["202606", "202606", "202606", "202607", "202606"],
        "open":  [22000.0, 22050.0, 22100.0, 22150.0, 22120.0],
        "max":   [22150.0, 22180.0, 22250.0, 22280.0, 22200.0],
        "min":   [21950.0, 22000.0, 22050.0, 22100.0, 22060.0],
        "close": [22080.0, 22110.0, 22200.0, 22230.0, 22150.0],
        "volume": [120000, 30000, 130000, 5000, 35000],
        "trading_session": ["position", "after_market", "position", "position", "after_market"],
    })


class TestFetchNightSession:
    def test_finds_after_market_row(self):
        client = MagicMock()
        client.fetch_dataset.return_value = _finmind_frame()
        result = fetch_night_session(client, "2026-06-11")
        assert result, "should find the after_market session"
        assert result["close"] == pytest.approx(22150.0)

    def test_change_vs_day_session_close(self):
        client = MagicMock()
        client.fetch_dataset.return_value = _finmind_frame()
        result = fetch_night_session(client, "2026-06-11")
        # night close 22150 vs same-date/contract day close 22200 = -50
        assert result["change"] == pytest.approx(-50.0)

    def test_uses_latest_night_date(self):
        client = MagicMock()
        client.fetch_dataset.return_value = _finmind_frame()
        result = fetch_night_session(client, "2026-06-11")
        # 06-10's night row (22150), not 06-09's (22110)
        assert result["close"] == pytest.approx(22150.0)

    def test_fetches_lookback_window(self):
        """start_date must be earlier than date_str — pre-market run has no
        row for 'today' yet."""
        client = MagicMock()
        client.fetch_dataset.return_value = _finmind_frame()
        fetch_night_session(client, "2026-06-11")
        kwargs = client.fetch_dataset.call_args.kwargs
        assert kwargs["start_date"] < "2026-06-11"
        assert kwargs["end_date"] == "2026-06-11"

    def test_empty_frame_returns_empty(self):
        client = MagicMock()
        client.fetch_dataset.return_value = pd.DataFrame()
        assert fetch_night_session(client, "2026-06-11") == {}

    def test_api_error_returns_empty(self):
        client = MagicMock()
        client.fetch_dataset.side_effect = RuntimeError("API down")
        assert fetch_night_session(client, "2026-06-11") == {}

    def test_no_session_column_returns_empty(self):
        client = MagicMock()
        client.fetch_dataset.return_value = pd.DataFrame({
            "date": ["2026-06-10"], "close": [22000.0],
        })
        assert fetch_night_session(client, "2026-06-11") == {}

    def test_only_day_sessions_returns_empty(self):
        df = _finmind_frame()
        df["trading_session"] = "position"
        client = MagicMock()
        client.fetch_dataset.return_value = df
        assert fetch_night_session(client, "2026-06-11") == {}

    def test_near_month_contract_by_volume(self):
        """When multiple night contracts exist for the same date, pick the
        highest-volume one (near month)."""
        df = _finmind_frame()
        far = df.iloc[[-1]].copy()
        far["contract_date"] = "202609"
        far["close"] = 99999.0
        far["volume"] = 100
        client = MagicMock()
        client.fetch_dataset.return_value = pd.concat([df, far], ignore_index=True)
        result = fetch_night_session(client, "2026-06-11")
        assert result["close"] == pytest.approx(22150.0)

    def test_last_hour_trend_present(self):
        client = MagicMock()
        client.fetch_dataset.return_value = _finmind_frame()
        result = fetch_night_session(client, "2026-06-11")
        assert result["last_hour_trend"] in ("↑ 偏強", "↓ 走弱", "—")
