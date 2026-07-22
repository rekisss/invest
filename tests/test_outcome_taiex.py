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
