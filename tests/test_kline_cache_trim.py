"""
Tests for kline_fetch.py 的快取瘦身邏輯 (trim_daily_bars / merge_period_bars)

背景：output/kline_cache.json 在 2026-09 撞到 GitHub 單檔 100MiB 上限，
kline-fetch workflow 的 push 被擋掉，快取停在 2026-09-03。
這裡驗證裁切只會從「最舊」那端裁、增量抓取的接續錨點（最後一根）不受影響，
以及週/月 K 不會因為日 K 被裁而跟著消失。
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from kline_fetch import DAILY_KEEP_BARS, merge_period_bars, trim_daily_bars


def _bar(day: str, close: float = 100.0) -> dict:
    return {
        "time": day,
        "open": close,
        "high": close + 1,
        "low": close - 1,
        "close": close,
        "volume": 1000,
    }


def _series(n: int, start_day: int = 1) -> list[dict]:
    """產生 n 根連續日 K（用 2026-01-01 起算的序號當日期，方便斷言）。"""
    from datetime import date, timedelta

    base = date(2026, 1, 1)
    return [
        _bar((base + timedelta(days=start_day + i)).isoformat(), 100.0 + i)
        for i in range(n)
    ]


# ── trim_daily_bars ───────────────────────────────────────────────────────────
def test_trim_keeps_last_n_bars():
    bars = _series(500)
    out = trim_daily_bars(bars, keep=300)
    assert len(out) == 300


def test_trim_drops_from_the_old_end_only():
    """最後一根是增量抓取的接續錨點，絕對不能被裁掉。"""
    bars = _series(500)
    out = trim_daily_bars(bars, keep=300)
    assert out[-1] == bars[-1], "最新一根必須保留（增量 resume 的依據）"
    assert out[0] == bars[200], "應該從最舊那端裁"
    assert out == bars[-300:]


def test_trim_is_noop_when_already_short():
    bars = _series(120)
    assert trim_daily_bars(bars, keep=300) is bars


def test_trim_handles_empty_and_disabled():
    assert trim_daily_bars([], keep=300) == []
    bars = _series(500)
    assert trim_daily_bars(bars, keep=0) is bars
    assert trim_daily_bars(bars, keep=None) is bars


def test_default_keep_is_positive_and_above_backfill_threshold():
    """main() 用 len(cached_daily[sid]) < 30 判斷要不要整個重抓，
    裁完的根數必須遠大於 30，否則每天都會觸發 full backfill。"""
    assert DAILY_KEEP_BARS > 30


def test_trim_repeated_runs_are_stable():
    """模擬連續多天執行：每天併入新 bar 再裁，長度應維持在上限、且持續往前推。"""
    bars = _series(400)
    kept = trim_daily_bars(bars, keep=300)
    for i in range(10):
        kept = trim_daily_bars(kept + _series(1, start_day=401 + i), keep=300)
    assert len(kept) == 300
    assert kept[-1]["time"] == _series(1, start_day=410)[0]["time"]
    # 時間仍然是升冪且不重複
    times = [b["time"] for b in kept]
    assert times == sorted(times)
    assert len(set(times)) == len(times)


# ── merge_period_bars ─────────────────────────────────────────────────────────
def test_merge_keeps_old_periods_outside_trimmed_window():
    """日 K 被裁之後 resample 只剩近期區間，舊的週/月 K 必須從快取保留下來。"""
    old = [_bar("2024-01-01", 10), _bar("2024-02-01", 20), _bar("2024-03-01", 30)]
    new = [_bar("2024-03-01", 31), _bar("2024-04-01", 40)]
    out = merge_period_bars(old, new)
    assert [b["time"] for b in out] == ["2024-01-01", "2024-02-01", "2024-03-01", "2024-04-01"]


def test_merge_first_new_period_does_not_overwrite_cached_one():
    """新算出來的第一個區間可能只涵蓋半個月（日 K 被裁），保留快取裡完整的那筆。"""
    old = [_bar("2024-03-01", 30), _bar("2024-04-01", 40)]
    new = [_bar("2024-04-01", 99), _bar("2024-05-01", 50)]
    out = merge_period_bars(old, new)
    by_time = {b["time"]: b for b in out}
    assert by_time["2024-04-01"]["close"] == 40, "第一筆（可能不完整）不應覆蓋舊值"
    assert by_time["2024-05-01"]["close"] == 50, "後續區間以新算的為準"


def test_merge_later_new_periods_win():
    old = [_bar("2024-03-01", 30), _bar("2024-04-01", 40), _bar("2024-05-01", 1)]
    new = [_bar("2024-04-01", 99), _bar("2024-05-01", 55)]
    out = merge_period_bars(old, new)
    by_time = {b["time"]: b for b in out}
    assert by_time["2024-05-01"]["close"] == 55


def test_merge_sorted_and_tolerates_junk():
    old = [_bar("2024-05-01"), {"no_time": 1}, "not-a-dict", _bar("2024-01-01")]
    new = [_bar("2024-03-01"), {"time": None}]
    out = merge_period_bars(old, new)
    assert [b["time"] for b in out] == ["2024-01-01", "2024-03-01", "2024-05-01"]


def test_merge_with_empty_sides():
    assert merge_period_bars([], []) == []
    new = [_bar("2024-01-01")]
    assert merge_period_bars([], new) == new
    old = [_bar("2024-01-01")]
    assert merge_period_bars(old, []) == old
