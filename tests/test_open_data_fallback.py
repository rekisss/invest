"""Tests for TWSE/TPEx/MOPS open-data fallbacks (sponsor-only FinMind datasets)."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

import data_loader
from data_loader import (
    _opendata_disposition_stocks,
    _opendata_market_revenue_signal,
    _opendata_market_shareholding_signal,
    _opendata_monthly_revenue,
    _opendata_shareholding,
    fetch_all_monthly_revenue,
    fetch_all_shareholding,
    fetch_disposition_stocks,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    data_loader._open_data_cache.clear()
    yield
    data_loader._open_data_cache.clear()


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(data_loader.time, "sleep", lambda *_: None)


# ── Synthetic payloads ─────────────────────────────────────────────────────────

TWSE_PUNISH_ROWS = [
    # Active disposition (period end in the future relative to 2026-06-10 → ROC 1150610)
    {"編號": "1", "公告日期": "1150601", "證券代號": "2014", "證券名稱": "中鴻",
     "處置起訖時間": "1150601~1150615"},
    # Expired disposition — must be excluded
    {"編號": "2", "公告日期": "1150401", "證券代號": "3661", "證券名稱": "世芯",
     "處置起訖時間": "1150401~1150420"},
]

TPEX_PUNISH_ROWS = [
    {"SecuritiesCompanyCode": "6488", "CompanyName": "環球晶",
     "DispositionPeriod": "1150605~1150620"},
]

MOPS_REVENUE_ROWS = [
    {"公司代號": "2330", "公司名稱": "台積電", "資料年月": "11505",
     "營業收入-當月營收": "250,000,000", "營業收入-上月營收": "240,000,000",
     "營業收入-去年當月營收": "200,000,000", "營業收入-去年同月增減(%)": "25.0"},
    {"公司代號": "2317", "公司名稱": "鴻海", "資料年月": "11505",
     "營業收入-當月營收": "500,000,000", "營業收入-上月營收": "520,000,000",
     "營業收入-去年當月營收": "480,000,000", "營業收入-去年同月增減(%)": "4.17"},
] + [
    {"公司代號": f"{1100 + i}", "公司名稱": f"測試{i}", "資料年月": "11505",
     "營業收入-當月營收": "1,000,000", "營業收入-上月營收": "900,000",
     "營業收入-去年當月營收": "950,000", "營業收入-去年同月增減(%)": "5.26"}
    for i in range(12)
]

QFIIS_PAYLOAD = {
    "stat": "OK",
    "fields": ["證券代號", "證券名稱", "國際證券辨識號碼", "發行股數",
               "外資及陸資尚可投資股數", "全體外資及陸資持有股數",
               "外資及陸資尚可投資比率", "全體外資及陸資持股比率", "法令投資上限比率"],
    "data": [
        ["2330", "台積電", "TW0002330008", "25,930,380,458", "x", "y", "22.0", "77.97", "100"],
        ["2317", "鴻海", "TW0002317005", "13,862,000,000", "x", "y", "55.0", "45.12", "100"],
    ],
}


def _fake_http(url, params=None):
    if "punish" in url:
        return TWSE_PUNISH_ROWS
    if "disposal" in url:
        return TPEX_PUNISH_ROWS
    if "t187ap05" in url:
        return MOPS_REVENUE_ROWS
    if "MI_QFIIS" in url:
        return QFIIS_PAYLOAD
    raise RuntimeError(f"unexpected url {url}")


# ── Disposition fallback ──────────────────────────────────────────────────────

class TestDispositionFallback:
    def test_active_dispositions_included_expired_excluded(self):
        with patch("data_loader._http_get_json", side_effect=_fake_http):
            result = _opendata_disposition_stocks("2026-06-10")
        assert "2014" in result          # active TWSE
        assert "6488" in result          # active TPEx
        assert "3661" not in result      # expired

    def test_finmind_failure_triggers_fallback(self):
        client = MagicMock()
        client.fetch_dataset.side_effect = RuntimeError("status=400 level register")
        with patch("data_loader._http_get_json", side_effect=_fake_http):
            result = fetch_disposition_stocks(client, "2026-06-10")
        assert result == {"2014", "6488"}

    def test_network_failure_returns_empty_set(self):
        with patch("data_loader._http_get_json", side_effect=RuntimeError("down")):
            result = _opendata_disposition_stocks("2026-06-10")
        assert result == set()


# ── Monthly revenue fallback ──────────────────────────────────────────────────

class TestMonthlyRevenueFallback:
    def test_synthesizes_three_rows_per_stock(self):
        with patch("data_loader._http_get_json", side_effect=_fake_http):
            frame = _opendata_monthly_revenue()
        tsmc = frame[frame["stock_id"] == "2330"].sort_values("date")
        assert len(tsmc) == 3
        # ROC 11505 → 2026-05; month ends: 2025-05-31, 2026-04-30, 2026-05-31
        assert list(tsmc["date"]) == [
            pd.Timestamp("2025-05-31"), pd.Timestamp("2026-04-30"), pd.Timestamp("2026-05-31"),
        ]
        assert list(tsmc["revenue"]) == [200_000_000, 240_000_000, 250_000_000]

    def test_yoy_and_mom_computable_from_synthesized_rows(self):
        """The exact lookup pattern strategy.py uses must find YoY and MoM rows."""
        with patch("data_loader._http_get_json", side_effect=_fake_http):
            frame = _opendata_monthly_revenue()
        stk = frame[frame["stock_id"] == "2330"].sort_values("date")
        latest, latest_date = float(stk["revenue"].iloc[-1]), pd.Timestamp(stk["date"].iloc[-1])
        target = latest_date - pd.DateOffset(years=1)
        window = stk[(stk["date"] >= target - pd.Timedelta(days=15)) &
                     (stk["date"] <= target + pd.Timedelta(days=31))]
        assert not window.empty
        yoy = (latest - float(window["revenue"].iloc[-1])) / float(window["revenue"].iloc[-1])
        assert yoy == pytest.approx(0.25)
        mom = (latest - float(stk["revenue"].iloc[-2])) / float(stk["revenue"].iloc[-2])
        assert mom == pytest.approx(250 / 240 - 1, rel=1e-6)

    def test_finmind_failure_triggers_fallback(self):
        client = MagicMock()
        client.fetch_dataset.side_effect = RuntimeError("status=400 level register")
        with patch("data_loader._http_get_json", side_effect=_fake_http):
            frame = fetch_all_monthly_revenue(client, "2026-06-10")
        assert not frame.empty
        assert set(frame.columns) == {"stock_id", "date", "revenue"}

    def test_market_signal_uses_yoy_pct_median(self):
        with patch("data_loader._http_get_json", side_effect=_fake_http):
            sig = _opendata_market_revenue_signal()
        assert len(sig) == 1
        assert sig["date"].iloc[0] == pd.Timestamp("2026-05-31")
        # Median of [25.0, 4.17, 5.26×12] / 100 = 0.0526
        assert sig["market_revenue_yoy"].iloc[0] == pytest.approx(0.0526, abs=1e-4)

    def test_network_failure_returns_empty(self):
        with patch("data_loader._http_get_json", side_effect=RuntimeError("down")):
            assert _opendata_monthly_revenue().empty
            assert _opendata_market_revenue_signal().empty


# ── Shareholding fallback ─────────────────────────────────────────────────────

class TestShareholdingFallback:
    def test_parses_qfiis_ratio_column(self):
        with patch("data_loader._http_get_json", side_effect=_fake_http):
            frame = _opendata_shareholding("2026-06-10", lookback=10)
        assert not frame.empty
        assert set(frame.columns) == {"stock_id", "date", "ForeignInvestmentSharesRatio"}
        tsmc = frame[frame["stock_id"] == "2330"]
        assert (tsmc["ForeignInvestmentSharesRatio"] == 77.97).all()

    def test_finmind_failure_triggers_fallback(self):
        client = MagicMock()
        client.fetch_dataset.side_effect = RuntimeError("status=400 level register")
        with patch("data_loader._http_get_json", side_effect=_fake_http):
            frame = fetch_all_shareholding(client, "2026-06-10", lookback=10)
        assert not frame.empty
        assert "ForeignInvestmentSharesRatio" in frame.columns

    def test_market_signal_structure(self):
        with patch("data_loader._http_get_json", side_effect=_fake_http):
            sig = _opendata_market_shareholding_signal("2026-06-10")
        # Constant ratios across days → 5d change = 0, but structure must hold
        if not sig.empty:
            assert "market_foreign_holding_chg" in sig.columns
            assert (sig["market_foreign_holding_chg"] == 0).all()

    def test_network_failure_returns_empty(self):
        with patch("data_loader._http_get_json", side_effect=RuntimeError("down")):
            assert _opendata_shareholding("2026-06-10", lookback=10).empty
            assert _opendata_market_shareholding_signal("2026-06-10").empty


# ── ROC date helpers ──────────────────────────────────────────────────────────

class TestRocHelpers:
    def test_roc_ym(self):
        assert data_loader._roc_ym_to_month_end("11505") == pd.Timestamp("2026-05-31")
        assert data_loader._roc_ym_to_month_end("114/12") == pd.Timestamp("2025-12-31")
        assert data_loader._roc_ym_to_month_end("bad") is None

    def test_roc_date(self):
        assert data_loader._roc_date_to_ts("1150615") == pd.Timestamp("2026-06-15")
        assert data_loader._roc_date_to_ts("115/06/15") == pd.Timestamp("2026-06-15")
        assert data_loader._roc_date_to_ts("x") is None

    def test_to_float(self):
        assert data_loader._to_float("1,234.5") == 1234.5
        assert data_loader._to_float("") == 0.0
        assert data_loader._to_float("n/a") == 0.0
