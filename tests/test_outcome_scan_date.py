"""outcome_tracker TOP20 快照日錯位(2026-11)的回歸測試。

現場——這是同一支檔案的第二個日期錯位 bug(第一個見 test_outcome_realdate.py):

  outcome-tracker.yml 的 cron 寫 09:45 UTC,但 GitHub 實際執行會延遲到
  15:30~20:05 UTC 不等。只要跑在 16:00 UTC 之後(= CST 午夜之後),
  _today() 回的就是**隔天**,而掃描 CSV 的檔名用的是台股交易日,於是
  glob("batch_seq*_<隔天>.csv") 什麼都找不到 —— 印一行「無掃描資料」跳過,
  然後 exit 0。run 是綠的,資料卻整天沒進來。

  實測(GitHub Actions 的實際執行時間):
    2026-10-27 15:31 UTC → CST 23:31 → _today()=10-27 ✅ 有快照(最後一筆)
    2026-10-28 16:15 UTC → CST 隔天 00:15 → _today()=10-29 ❌ 開始漏
    2026-11-16 19:50 UTC → CST 隔天 03:50 → _today()=11-17 ❌
  自 10-28 起連續 14 個交易日全部漏掉,CSV 都還在、61 筆快照停在 10-27。

修正:快照日改以「掃描資料自己的日期」為準,並把最後一筆快照之後漏掉的
一次補齊(自癒)。main() 的 MI_INDEX 退路早就是「以資料日期寫入」,照同一慣例。
"""
from __future__ import annotations

import os

import pytest

import outcome_tracker as ot


@pytest.fixture
def scan_dir(tmp_path, monkeypatch):
    """造一個假的 output/full_scan,只放檔名(內容另外寫)。"""
    d = tmp_path / "full_scan"
    d.mkdir()
    monkeypatch.setattr(ot, "SCAN_DIR", str(d))
    return d


def _touch(d, date: str, rows: str = "") -> None:
    (d / f"batch_seq1_{date}.csv").write_text(
        rows or "stock_id,name,close,entry_score\n", encoding="utf-8",
    )


# ── _scan_dates ─────────────────────────────────────────────────────────────

def test_scan_dates_去重且升冪(scan_dir):
    for dt in ("2026-11-16", "2026-11-13", "2026-11-16"):
        _touch(scan_dir, dt)
    # 同一天多個 batch
    (scan_dir / "batch_seq2_2026-11-16.csv").write_text("x\n", encoding="utf-8")
    assert ot._scan_dates("2026-11-17") == ["2026-11-13", "2026-11-16"]


def test_scan_dates_不取晚於上界的(scan_dir):
    for dt in ("2026-11-13", "2026-11-16", "2026-11-17"):
        _touch(scan_dir, dt)
    assert ot._scan_dates("2026-11-16") == ["2026-11-13", "2026-11-16"]


def test_scan_dates_忽略檔名不合格式的(scan_dir):
    _touch(scan_dir, "2026-11-16")
    (scan_dir / "batch_seq1_不是日期.csv").write_text("x\n", encoding="utf-8")
    (scan_dir / "其他檔.csv").write_text("x\n", encoding="utf-8")
    assert ot._scan_dates("2026-11-30") == ["2026-11-16"]


def test_scan_dates_空目錄回空(scan_dir):
    assert ot._scan_dates("2026-11-16") == []


# ── _pending_scan_dates ─────────────────────────────────────────────────────

def test_回歸_時鐘已跨日仍要抓到當天的掃描(scan_dir):
    """核心案例:CST 已是 11-17,但最新掃描是 11-16 —— 不能什麼都不做。"""
    _touch(scan_dir, "2026-11-16")
    hist = [{"date": "2026-11-13", "stocks": []}]
    assert ot._pending_scan_dates(hist, "2026-11-17") == ["2026-11-16"]


def test_回歸_中斷後一次補齊漏掉的交易日(scan_dir):
    """10-27 之後漏掉的要全部補回來,不必人工一天一天跑 TRACK_DATE。"""
    gap = ["2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03"]
    _touch(scan_dir, "2026-10-27")
    for dt in gap:
        _touch(scan_dir, dt)
    hist = [{"date": "2026-10-27", "stocks": []}]
    assert ot._pending_scan_dates(hist, "2026-11-04") == gap


def test_已經快照過的不重複(scan_dir):
    _touch(scan_dir, "2026-11-16")
    hist = [{"date": "2026-11-16", "stocks": []}]
    assert ot._pending_scan_dates(hist, "2026-11-17") == []


def test_不回補早於既有起點的日子(scan_dir):
    """早於資料集起點的掃描日刻意不碰 —— 那會改變資料集的起點,不是修 bug。"""
    for dt in ("2026-05-26", "2026-06-01", "2026-07-03", "2026-07-06"):
        _touch(scan_dir, dt)
    hist = [{"date": "2026-07-03", "stocks": []}]
    assert ot._pending_scan_dates(hist, "2026-07-06") == ["2026-07-06"]


def test_第一次執行只取最新一天_不回頭建整個歷史(scan_dir):
    for dt in ("2026-11-12", "2026-11-13", "2026-11-16"):
        _touch(scan_dir, dt)
    assert ot._pending_scan_dates([], "2026-11-17") == ["2026-11-16"]


def test_沒有任何掃描檔回空_不丟例外(scan_dir):
    assert ot._pending_scan_dates([], "2026-11-17") == []
    assert ot._pending_scan_dates([{"date": "2026-11-16"}], "2026-11-17") == []


def test_hist_裡有壞資料也不丟例外(scan_dir):
    _touch(scan_dir, "2026-11-16")
    hist = [{"date": None}, {}, {"date": "2026-11-13", "stocks": []}]
    assert ot._pending_scan_dates(hist, "2026-11-17") == ["2026-11-16"]


# ── track_top20 端到端 ──────────────────────────────────────────────────────

ROWS = (
    "stock_id,name,close,entry_score\n"
    "2330,台積電,1000,90\n"
    "2317,鴻海,200,80\n"
)


def test_回歸_時鐘跨日時_track_top20_仍然寫入快照(scan_dir, tmp_path, monkeypatch):
    """修正前:_today() 是 11-17、CSV 是 11-16 → 完全不寫入。"""
    _touch(scan_dir, "2026-11-16", ROWS)
    out = tmp_path / "top20_history.json"
    monkeypatch.setattr(ot, "TOP20_OUT", str(out))
    monkeypatch.setattr(ot, "_backup_once", lambda *a, **k: None)
    monkeypatch.setattr(ot, "_load_kline_closes", lambda: {})

    ot.track_top20("2026-11-17")          # 時鐘已跨日

    hist = ot._load_json(str(out), [])
    assert [s["date"] for s in hist] == ["2026-11-16"], "必須以資料日期存檔"
    assert {s["stock_id"] for s in hist[0]["stocks"]} == {"2330", "2317"}


def test_track_top20_補齊多天且冪等(scan_dir, tmp_path, monkeypatch):
    """已經有歷史時,中間漏掉的要一次補齊;重跑不得重複。

    注意必須先 seed 一筆既有快照 —— 歷史是空的會走「第一次執行只取最新一天」
    那條路(見 test_第一次執行只取最新一天_不回頭建整個歷史)。
    """
    for dt in ("2026-11-12", "2026-11-13", "2026-11-16"):
        _touch(scan_dir, dt, ROWS)
    out = tmp_path / "top20_history.json"
    out.write_text('[{"date": "2026-11-12", "stocks": []}]', encoding="utf-8")
    monkeypatch.setattr(ot, "TOP20_OUT", str(out))
    monkeypatch.setattr(ot, "_backup_once", lambda *a, **k: None)
    monkeypatch.setattr(ot, "_load_kline_closes", lambda: {})

    ot.track_top20("2026-11-17")
    first = [s["date"] for s in ot._load_json(str(out), [])]
    assert first == ["2026-11-12", "2026-11-13", "2026-11-16"], "漏掉的兩天要補回來"

    ot.track_top20("2026-11-17")          # 再跑一次不得重複
    assert [s["date"] for s in ot._load_json(str(out), [])] == first


def test_track_top20_沒有掃描檔時不丟例外(scan_dir, tmp_path, monkeypatch):
    out = tmp_path / "top20_history.json"
    monkeypatch.setattr(ot, "TOP20_OUT", str(out))
    monkeypatch.setattr(ot, "_backup_once", lambda *a, **k: None)
    monkeypatch.setattr(ot, "_load_kline_closes", lambda: {})
    ot.track_top20("2026-11-17")
    assert ot._load_json(str(out), []) == []
