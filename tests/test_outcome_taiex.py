"""fetch_taiex 的 schema 韌性測試(2026-07 診斷:欄位名對不上 → 真實命中率
從未累積)。用真實 TWSE MI_INDEX 欄位名重現「修好」狀態,並釘住三個易碎點:
名稱定位、避開總報酬指數、避開漲跌百分比欄。
"""
from __future__ import annotations

import json
from contextlib import contextmanager
from unittest.mock import patch

import outcome_tracker as ot


@contextmanager
def _mock_twse(rows):
    payload = json.dumps(rows).encode("utf-8")

    class _Resp:
        def read(self):
            return payload

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    with patch("urllib.request.urlopen", return_value=_Resp()):
        yield


# 現行 TWSE MI_INDEX 真實欄位名(指數 / 收盤指數 / 漲跌點數 / 漲跌百分比)
_REAL_ROWS = [
    {"指數": "寶島股價指數", "收盤指數": "23,000.00", "漲跌點數": "100.00", "漲跌百分比": "0.44"},
    {"指數": "發行量加權股價報酬指數", "收盤指數": "40,000.00", "漲跌點數": "-200.00", "漲跌百分比": "-0.50"},
    {"指數": "發行量加權股價指數", "收盤指數": "22,500.50", "漲跌點數": "-150.30", "漲跌百分比": "-0.66"},
]


def test_parses_current_twse_schema():
    with _mock_twse(_REAL_ROWS):
        r = ot.fetch_taiex()
    assert r is not None, "現行 TWSE 欄位名應可解析(舊碼在此回 None → 命中率永遠 0)"
    assert r["close"] == 22500.50
    assert r["change"] == -150.30
    # prev = 22500.50 - (-150.30) = 22650.80 → pct 為負
    assert r["pct"] is not None and r["pct"] < 0


def test_ignores_total_return_index():
    """只可命中『發行量加權股價指數』,不可誤取『…股價報酬指數』(值 40000)。"""
    with _mock_twse(_REAL_ROWS):
        r = ot.fetch_taiex()
    assert r["close"] == 22500.50


def test_survives_field_rename_english_keys():
    """欄位改成英文鍵也要能解析(模糊比對的重點)。"""
    rows = [{"Name": "發行量加權股價指數", "ClosingIndex": "22,000.0",
             "Change": "-50.0", "ChangePercent": "-0.23"}]
    with _mock_twse(rows):
        r = ot.fetch_taiex()
    assert r is not None
    assert r["close"] == 22000.0
    assert r["change"] == -50.0  # 不可誤取 ChangePercent


def test_returns_none_on_holiday_empty():
    with _mock_twse([]):
        assert ot.fetch_taiex() is None


# ── 2026-08 真實命中率虛高 bug 的回歸測試 ────────────────────────────────────
# 根因:MI_INDEX 的「漲跌點數」只有幅度,正負號在獨立的「漲跌(+/-)」欄。
# 舊碼只讀點數 → change 恆為正 → actual_up 每天都 True → 命中率虛高
# (現場顯示 80%,實際 0/4)。以下把三個環節都釘住。

def test_applies_sign_from_separate_updown_column():
    """漲跌點數只有幅度時,必須套用獨立方向欄的負號。"""
    rows = [{"指數": "發行量加權股價指數", "收盤指數": "22,500.50",
             "漲跌(+/-)": "-", "漲跌點數": "150.30", "漲跌百分比": "0.66"}]
    with _mock_twse(rows):
        r = ot.fetch_taiex()
    assert r["change"] == -150.30, "方向欄為『-』時,漲跌必須是負的(舊碼會回 +150.30)"


def test_sign_column_accepts_green_red_and_arrows():
    """方向欄可能是 ▼/▲ 或帶顏色的 HTML(台股慣例 綠=跌)。"""
    for marker, expected in [("▼", -150.30), ("▲", 150.30),
                             ("<p style='color:green'>-</p>", -150.30)]:
        rows = [{"指數": "發行量加權股價指數", "收盤指數": "22,500.50",
                 "漲跌": marker, "漲跌點數": "150.30"}]
        with _mock_twse(rows):
            r = ot.fetch_taiex()
        assert r["change"] == expected, f"方向標記 {marker!r} 解析錯誤"


def test_rejects_implausible_daily_move():
    """單日漲跌 >15% 視為解析錯誤 → change 回 None(改由收盤差判方向)。"""
    rows = [{"指數": "發行量加權股價指數", "收盤指數": "40,000.00",
             "漲跌點數": "9000.00"}]
    with _mock_twse(rows):
        r = ot.fetch_taiex()
    assert r is not None and r["change"] is None


def test_repair_history_fixes_inflated_hits():
    """用現場的壞資料重現:actual_up 全 True、hit 4/5 → 校正為 0/4。"""
    recs = [
        {"date": "2026-07-22", "xgb_prob_up": 0.222, "taiex_close": 44232.87, "actual_up": True, "hit": False},
        {"date": "2026-07-23", "xgb_prob_up": 0.508, "taiex_close": 44825.78, "actual_up": True, "hit": None},
        {"date": "2026-07-24", "xgb_prob_up": 0.508, "taiex_close": 44850.81, "actual_up": True, "hit": None},
        {"date": "2026-07-27", "xgb_prob_up": 0.567, "taiex_close": 43654.84, "actual_up": True, "hit": True},
        {"date": "2026-07-28", "xgb_prob_up": 0.615, "taiex_close": 43634.19, "actual_up": True, "hit": True},
        {"date": "2026-07-29", "xgb_prob_up": 0.582, "taiex_close": 41603.36, "actual_up": True, "hit": True},
        {"date": "2026-07-30", "xgb_prob_up": 0.58,  "taiex_close": 40039.18, "actual_up": True, "hit": True},
    ]
    ot.repair_history(recs)
    by = {e["date"]: e for e in recs}
    # 指數這四天連跌,模型卻連四天偏多 → 全部未命中
    for d in ("2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30"):
        assert by[d]["actual_up"] is False and by[d]["hit"] is False, f"{d} 應為下跌且未命中"
    assert by["2026-07-27"]["taiex_change"] < 0, "漲跌必須帶回負號"
    scored = [e for e in recs if e["hit"] is not None]
    assert sum(1 for e in scored if e["hit"]) == 0 and len(scored) == 4
    # 首筆無前一日可比 → 不可打分(不猜方向)
    assert by["2026-07-22"]["actual_up"] is None and by["2026-07-22"]["hit"] is None


def test_repair_history_keeps_correct_calls():
    """方向正確的預測不可被誤改成未命中。"""
    recs = [
        {"date": "2026-07-01", "xgb_prob_up": 0.60, "taiex_close": 100.0},
        {"date": "2026-07-02", "xgb_prob_up": 0.62, "taiex_close": 105.0},  # 偏多且漲 → hit
        {"date": "2026-07-03", "xgb_prob_up": 0.30, "taiex_close": 102.0},  # 偏空且跌 → hit
        {"date": "2026-07-04", "xgb_prob_up": 0.52, "taiex_close": 110.0},  # 中性 → 不計分
    ]
    ot.repair_history(recs)
    by = {e["date"]: e for e in recs}
    assert by["2026-07-02"]["hit"] is True
    assert by["2026-07-03"]["hit"] is True
    assert by["2026-07-04"]["hit"] is None


def test_score_prediction_uses_prev_close_not_change_column(tmp_path, monkeypatch):
    """打分的方向必須來自「與前一交易日收盤相比」,不可信任漲跌欄。

    餵一個**故意給錯**的 change(正值),但收盤其實比前一日低 → 偏多預測應判未命中。
    """
    pred_out = tmp_path / "prediction_outcomes.json"
    hist = tmp_path / "prediction_history.json"
    hist.write_text(json.dumps([{"date": "2026-07-28", "xgb_prob_up": 0.615, "xgb_label": "偏多"}]),
                    encoding="utf-8")
    # 既有紀錄:前一交易日收盤 43654.84
    pred_out.write_text(json.dumps([
        {"date": "2026-07-27", "xgb_prob_up": 0.567, "taiex_close": 43654.84}
    ]), encoding="utf-8")
    monkeypatch.setattr(ot, "PRED_OUT", str(pred_out))
    monkeypatch.setattr(ot, "PRED_HISTORY", str(hist))

    # 收盤 43634.19 < 前一日 43654.84 → 實際是跌;但 change 故意給 +20.65(舊 bug 的樣子)
    ot.score_prediction("2026-07-28", {"close": 43634.19, "change": 20.65, "pct": 0.0005})

    recs = json.loads(pred_out.read_text(encoding="utf-8"))
    today = [e for e in recs if e["date"] == "2026-07-28"][0]
    assert today["actual_up"] is False, "收盤低於前一日 → 必須判為跌(不可採信 change 的正號)"
    assert today["hit"] is False, "偏多預測遇到下跌 → 未命中"
    assert today["taiex_change"] < 0, "漲跌應以收盤差重算為負值"


# ── 期距不符的回歸測試 ────────────────────────────────────────────────────────
# MarketPredictor(horizon=5) 預測的是「5 個交易日後漲逾 0.3%」,不是隔天。
# 過去用隔天結果打分,等於拿五天後的預報去對一小時後的天氣。

def _closes(seq):
    """把收盤序列轉成 outcome 紀錄(含方向性預測機率)。"""
    return [{"date": f"2026-07-{i+1:02d}", "taiex_close": c, "xgb_prob_up": p}
            for i, (c, p) in enumerate(seq)]


def test_horizon_scoring_uses_fifth_trading_day():
    """偏多預測 + 5 日後上漲 → hit_h5 為 True(即使隔天是跌的)。"""
    # 隔天先跌,但第 5 個交易日明顯高於起點
    recs = _closes([(100.0, 0.65), (98.0, 0.5), (97.0, 0.5),
                    (99.0, 0.5), (101.0, 0.5), (105.0, 0.5)])
    ot.score_horizon_hits(recs)
    first = recs[0]
    assert first["hit_h5"] is True, "5 日後 105 > 100×1.003 → 偏多預測應命中"
    assert first["hit_h5_date"] == "2026-07-06"
    assert first["ret_h5"] == 5.0


def test_horizon_scoring_marks_miss_when_lower_after_five_days():
    recs = _closes([(100.0, 0.65), (101.0, 0.5), (102.0, 0.5),
                    (101.0, 0.5), (99.0, 0.5), (95.0, 0.5)])
    ot.score_horizon_hits(recs)
    assert recs[0]["hit_h5"] is False, "5 日後 95 < 起點 → 偏多預測未命中"


def test_horizon_scoring_leaves_immature_records_unscored():
    """尚未滿 5 個交易日的預測不可打分(之後補),不能拿來充數。"""
    recs = _closes([(100.0, 0.65), (101.0, 0.7), (102.0, 0.3)])
    ot.score_horizon_hits(recs)
    assert all(e["hit_h5"] is None for e in recs), "期距未到一律不打分"


def test_horizon_scoring_skips_neutral_predictions():
    recs = _closes([(100.0, 0.52), (101.0, 0.5), (102.0, 0.5),
                    (103.0, 0.5), (104.0, 0.5), (110.0, 0.5)])
    ot.score_horizon_hits(recs)
    assert recs[0]["hit_h5"] is None, "|prob-0.5|<=0.05 為中性,不計分"


def test_horizon_scoring_respects_up_threshold():
    """漲幅未達 0.3% 不算上漲(與訓練時的 target 定義一致)。"""
    recs = _closes([(100.0, 0.65), (100.0, 0.5), (100.0, 0.5),
                    (100.0, 0.5), (100.0, 0.5), (100.2, 0.5)])
    ot.score_horizon_hits(recs)
    assert recs[0]["hit_h5"] is False, "+0.2% 未達 0.3% 門檻 → 不算上漲"


# ── 自我 code review 抓到的回歸 ────────────────────────────────────────────────

def test_horizon_skips_when_records_are_missing():
    """「第 N 筆紀錄」≠「第 N 個交易日」:中間缺紀錄時不可硬打分。

    造 6 筆紀錄但日期橫跨三週(等於中間漏了很多天)→ 跨距遠超 5 個工作日,
    應拒絕打分而不是回報一個用錯期間算出來的命中。
    """
    recs = [{"date": d, "taiex_close": c, "xgb_prob_up": p} for d, c, p in [
        ("2026-07-01", 100.0, 0.65), ("2026-07-02", 101.0, 0.5), ("2026-07-03", 102.0, 0.5),
        ("2026-07-06", 103.0, 0.5), ("2026-07-07", 104.0, 0.5), ("2026-07-31", 130.0, 0.5),
    ]]
    ot.score_horizon_hits(recs)
    first = recs[0]
    assert first["hit_h5"] is None, "跨距過長(缺紀錄)時必須放棄打分"
    assert first["hit_h5_span_bdays"] > 5 + ot.SPAN_TOLERANCE


def test_horizon_scores_when_span_is_within_tolerance():
    """正常連續交易日(跨距 5 個工作日)照常打分。"""
    recs = [{"date": d, "taiex_close": c, "xgb_prob_up": p} for d, c, p in [
        ("2026-07-01", 100.0, 0.65), ("2026-07-02", 98.0, 0.5), ("2026-07-03", 97.0, 0.5),
        ("2026-07-06", 99.0, 0.5), ("2026-07-07", 101.0, 0.5), ("2026-07-08", 105.0, 0.5),
    ]]
    ot.score_horizon_hits(recs)
    assert recs[0]["hit_h5"] is True
    assert recs[0]["hit_h5_span_bdays"] == 5


def test_sign_strips_html_before_reading_direction():
    """方向欄帶 HTML 時,屬性裡的連字號不可被誤判成「跌」。"""
    assert ot._sign({"漲跌(+/-)": "<p style='font-weight:600;text-align:left'>+</p>"}) == 1
    assert ot._sign({"漲跌(+/-)": "<p style='color:green'>-</p>"}) == -1


def test_sign_returns_none_for_unrecognised_marker():
    """認不出來要回 None,不能回 0(abs(chg)*0 會把有效漲跌歸零)。"""
    assert ot._sign({"漲跌(+/-)": "?"}) is None
    assert ot._sign({"漲跌(+/-)": ""}) is None
