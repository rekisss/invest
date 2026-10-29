"""outcome_tracker 日期錯位修正(2026-10)的回歸測試。

現場:MI_INDEX 在 17:45 回的多半是前一交易日 → 紀錄日 D 的收盤其實是 D-1;
休市日也有紀錄、偶爾重複舊值;TOP20 報酬用「第 N 個快照」當 N 個交易日。
修正後以 FMTQIK(每列自帶日期)的真實交易日序列重建。
"""
from __future__ import annotations

import json

import pytest

import outcome_tracker as ot


# ── 日期 / FMTQIK 解析 ────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("115/10/27", "2026-10-27"),
    ("1151027", "2026-10-27"),
    ("2026-10-27", "2026-10-27"),
    ("20261027", "2026-10-27"),
    ("<b>115/01/05</b>", "2026-01-05"),
    ("", None),
    (None, None),
    ("115/13/40", None),
])
def test_parse_twse_date(raw, expected):
    assert ot._parse_twse_date(raw) == expected


def test_parse_fmtqik_locates_taiex_column_and_skips_return_index():
    payload = {
        "stat": "OK",
        "fields": ["日期", "成交股數", "成交金額", "成交筆數", "發行量加權股價報酬指數", "發行量加權股價指數", "漲跌點數"],
        "data": [
            ["115/10/22", "1", "1", "1", "90,000.00", "46,041.43", "-10"],
            ["115/10/23", "1", "1", "1", "90,100.00", "46,120.10", "78.67"],
            ["bad"],
        ],
    }
    assert ot.parse_fmtqik(payload) == {"2026-10-22": 46041.43, "2026-10-23": 46120.10}


def test_parse_fmtqik_handles_error_stat():
    assert ot.parse_fmtqik({"stat": "很抱歉，沒有符合條件的資料!"}) == {}
    assert ot.parse_fmtqik(None) == {}


def test_mi_index_returns_its_own_date():
    payload = json.dumps([{"日期": "1151027", "指數": "發行量加權股價指數", "收盤指數": "46,041.43",
                           "漲跌": "+", "漲跌點數": "12.00"}]).encode("utf-8")

    class _Resp:
        def read(self):
            return payload

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    from unittest.mock import patch
    with patch("urllib.request.urlopen", return_value=_Resp()):
        r = ot.fetch_taiex()
    assert r["date"] == "2026-10-27"
    assert r["close"] == 46041.43


# ── 序列快取 ─────────────────────────────────────────────────────────────────

def test_update_series_caches_complete_months(tmp_path, monkeypatch):
    monkeypatch.setattr(ot, "TAIEX_SERIES", str(tmp_path / "taiex_daily.json"))
    monkeypatch.setattr(ot.time, "sleep", lambda s: None)
    calls = []

    def fetch(ym):
        calls.append(ym)
        return {f"{ym[:4]}-{ym[4:]}-05": 100.0 + int(ym[4:])}

    s = ot.update_taiex_series("2026-10-28", "2026-07-01", fetch=fetch)
    assert calls == ["202607", "202608", "202609", "202610"]
    assert len(s) == 4
    calls.clear()
    ot.update_taiex_series("2026-10-28", "2026-07-01", fetch=fetch)
    # 已結束的月份不重抓;上個月與本月每次都抓
    assert calls == ["202609", "202610"]


def test_update_series_failed_month_is_retried(tmp_path, monkeypatch):
    monkeypatch.setattr(ot, "TAIEX_SERIES", str(tmp_path / "taiex_daily.json"))
    monkeypatch.setattr(ot.time, "sleep", lambda s: None)
    ot.update_taiex_series("2026-10-28", "2026-07-01", fetch=lambda ym: None if ym == "202607" else {})
    calls = []
    ot.update_taiex_series("2026-10-28", "2026-07-01", fetch=lambda ym: calls.append(ym) or {})
    assert "202607" in calls


# ── 重建打分紀錄 ─────────────────────────────────────────────────────────────

# 9/25(五)中秋休市
DAYS = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-26",
        "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05"]
DAYS.remove("2026-09-26")  # 週六
SERIES = {d: 1000.0 + 10 * i for i, d in enumerate(DAYS)}


def test_rebuild_uses_real_dates_and_same_day_prediction():
    preds = [{"date": "2026-09-23", "xgb_prob_up": 0.7, "xgb_label": "看多"},
             {"date": "2026-09-24", "xgb_prob_up": 0.2, "xgb_label": "看空"}]
    # 舊紀錄:收盤晚一天(9/23 那筆存的是 9/22 的值),9/25 休市日也有一筆
    existing = [{"date": "2026-09-23", "taiex_close": SERIES["2026-09-22"], "taiex_name": "x"},
                {"date": "2026-09-25", "taiex_close": SERIES["2026-09-24"], "xgb_prob_up": 0.6}]
    out = {e["date"]: e for e in ot.rebuild_prediction_outcomes(SERIES, preds, existing)}

    d23 = out["2026-09-23"]
    assert d23["taiex_close"] == SERIES["2026-09-23"]
    assert d23["taiex_close_legacy"] == SERIES["2026-09-22"]
    assert d23["taiex_name"] == "x"                    # 其他欄位保留
    assert d23["actual_up"] is True and d23["hit"] is True
    assert d23["close_source"] == "TWSE FMTQIK"

    # 9/24 看空,但 9/24 收盤 > 9/23 → 未命中
    assert out["2026-09-24"]["hit"] is False

    # 休市日:保留、不計分
    d25 = out["2026-09-25"]
    assert d25["non_trading_day"] is True and d25["taiex_close"] is None
    assert d25["taiex_close_legacy"] == SERIES["2026-09-24"]
    assert d25["hit"] is None and d25["directional"] is False

    # 沒有當天預測的交易日:不借用前幾天的預測
    assert "xgb_prob_up" not in out["2026-09-29"]
    assert out["2026-09-29"]["hit"] is None


def test_rebuild_horizon_matches_training_target():
    preds = [{"date": "2026-09-23", "xgb_prob_up": 0.7}]
    out = {e["date"]: e for e in ot.rebuild_prediction_outcomes(SERIES, preds, [])}
    e = out["2026-09-23"]
    # base = 9/22(預測日前一交易日),target = base 之後第 5 個交易日
    # (9/23、9/24、9/29、9/30、10/01;跳過休市的 9/25)
    assert e["hit_h5_date"] == "2026-10-01"
    base, tgt = SERIES["2026-09-22"], SERIES["2026-10-01"]
    assert e["ret_h5"] == round((tgt - base) / base * 100, 2)
    assert e["hit_h5"] is True
    # 期距未到 → None
    late = ot.rebuild_prediction_outcomes(SERIES, [{"date": "2026-10-02", "xgb_prob_up": 0.7}], [])
    assert [x for x in late if x["date"] == "2026-10-02"][0]["hit_h5"] is None


def test_rebuild_neutral_prediction_not_scored_and_idempotent():
    preds = [{"date": "2026-09-23", "xgb_prob_up": 0.52}]
    first = ot.rebuild_prediction_outcomes(SERIES, preds, [])
    e = [x for x in first if x["date"] == "2026-09-23"][0]
    assert e["directional"] is False and e["hit"] is None and e["hit_h5"] is None
    assert "ret_h5" in e                                # 報酬照算,供 Brier/校準用
    assert ot.rebuild_prediction_outcomes(SERIES, preds, first) == first


def test_rebuild_leaves_records_outside_series_untouched():
    old = {"date": "2026-01-02", "taiex_close": 1.0, "hit": True}
    out = ot.rebuild_prediction_outcomes(SERIES, [], [old])
    assert old in out


def test_rebuild_does_not_mark_holidays_for_a_month_that_failed_to_fetch():
    # 9 月與 11 月有資料、10 月整個月抓取失敗 → 10 月的舊紀錄不能被判成休市
    series = {"2026-09-30": 100.0, "2026-11-02": 101.0}
    old = {"date": "2026-10-15", "taiex_close": 1.0, "hit": True}
    out = ot.rebuild_prediction_outcomes(series, [], [old])
    assert old in out


# ── TOP20 報酬 ───────────────────────────────────────────────────────────────

def test_top20_returns_follow_trading_calendar_and_keep_legacy():
    kline = {"A": {d: 100.0 + i for i, d in enumerate(DAYS)}}
    hist = [{"date": "2026-09-24", "stocks": [{"stock_id": "A", "close": 103.0, "ret_1d": 0.5}]}]
    w, c = ot.fill_top20_returns(hist, DAYS, "2026-10-05", kline, {})
    st = hist[0]["stocks"][0]
    # 9/24 的下一個交易日是 9/29(跳過休市的 9/25)
    assert st["ret_1d"] == round((kline["A"]["2026-09-29"] - 103.0) / 103.0, 4)
    assert st["ret_1d_legacy"] == 0.5
    assert st["ret_5d"] is not None or "ret_5d" not in st
    assert c >= 1 and w >= 1


def test_top20_skips_paths_with_limit_breaking_jumps():
    k = {d: 100.0 for d in DAYS}
    k["2026-09-29"] = 33.0                                  # 減資/髒資料
    hist = [{"date": "2026-09-24", "stocks": [{"stock_id": "A", "close": 100.0, "ret_1d": -0.67}]}]
    ot.fill_top20_returns(hist, DAYS, "2026-10-05", {"A": k}, {})
    st = hist[0]["stocks"][0]
    assert "ret_1d" not in st and st["ret_1d_legacy"] == -0.67


def test_top20_uses_scan_close_for_today():
    hist = [{"date": "2026-10-02", "stocks": [{"stock_id": "B", "close": 50.0}]}]
    ot.fill_top20_returns(hist, DAYS, "2026-10-05", {}, {"B": 51.0})
    assert hist[0]["stocks"][0]["ret_1d"] == 0.02


# ── main 的退路 ──────────────────────────────────────────────────────────────

def _setup_paths(tmp_path, monkeypatch):
    for name, fn in [("PRED_OUT", "po.json"), ("PRED_HISTORY", "ph.json"), ("TOP20_OUT", "t20.json"),
                     ("TAIEX_SERIES", "series.json"), ("KLINE_CACHE", "kline.json")]:
        monkeypatch.setattr(ot, name, str(tmp_path / fn))
    (tmp_path / "ph.json").write_text(json.dumps([{"date": "2026-10-27", "xgb_prob_up": 0.7}]), encoding="utf-8")
    monkeypatch.setattr(ot, "_load_closes", lambda d: {})
    monkeypatch.setattr(ot, "_top20", lambda d: [])
    monkeypatch.setattr(ot.time, "sleep", lambda s: None)
    monkeypatch.setenv("TRACK_DATE", "2026-10-28")


def test_main_fallback_writes_under_mi_index_own_date(tmp_path, monkeypatch):
    _setup_paths(tmp_path, monkeypatch)
    monkeypatch.setattr(ot, "_fetch_fmtqik_month", lambda ym: None)
    monkeypatch.setattr(ot, "update_taiex_series",
                        lambda today, earliest, fetch=None: {})
    monkeypatch.setattr(ot, "fetch_taiex", lambda: {"date": "2026-10-27", "close": 100.0, "change": 1.0, "pct": 0.01})
    ot.main()
    recs = json.loads((tmp_path / "po.json").read_text(encoding="utf-8"))
    assert [e["date"] for e in recs] == ["2026-10-27"]


def test_main_fallback_refuses_to_guess_without_date(tmp_path, monkeypatch):
    _setup_paths(tmp_path, monkeypatch)
    monkeypatch.setattr(ot, "update_taiex_series", lambda today, earliest, fetch=None: {})
    monkeypatch.setattr(ot, "fetch_taiex", lambda: {"date": None, "close": 100.0, "change": 1.0, "pct": 0.01})
    ot.main()
    assert not (tmp_path / "po.json").exists()


def test_main_rebuilds_from_series_and_backs_up(tmp_path, monkeypatch):
    _setup_paths(tmp_path, monkeypatch)
    (tmp_path / "po.json").write_text(json.dumps([{"date": "2026-10-27", "taiex_close": 1.0}]), encoding="utf-8")
    monkeypatch.setattr(ot, "update_taiex_series",
                        lambda today, earliest, fetch=None: {"2026-10-23": 99.0, "2026-10-27": 100.0, "2026-10-29": 1.0})
    ot.main()
    recs = {e["date"]: e for e in json.loads((tmp_path / "po.json").read_text(encoding="utf-8"))}
    assert recs["2026-10-27"]["taiex_close"] == 100.0
    assert recs["2026-10-27"]["hit"] is True
    assert "2026-10-29" not in recs                       # 未來日期(> TRACK_DATE)不採用
    raw = json.loads((tmp_path / "po_raw.json").read_text(encoding="utf-8"))
    assert raw == [{"date": "2026-10-27", "taiex_close": 1.0}]
