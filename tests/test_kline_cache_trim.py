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

from kline_fetch import (
    CACHE_FAIL_MIB,
    CACHE_WARN_MIB,
    DAILY_KEEP_BARS,
    MONTHLY_KEEP_BARS,
    WEEKLY_KEEP_BARS,
    merge_period_bars,
    trim_daily_bars,
    trim_period_bars,
)


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


# ── 週/月 K 的上限 (2026-11) ───────────────────────────────────────────────────
#
# 日 K 自 2026-09 起就有 DAILY_KEEP_BARS 把關,但週/月 K 當時刻意不裁
# (merge_period_bars 的用意是「裁日 K 不要連累週/月 K」),於是它們成了整個檔案
# 裡唯一無界成長的部分。實測 2026-11-16 的 kline_cache.json(67.7 MiB/1562 檔):
#     日 K 44.6 MiB (65.8%) 平均 297.9 根 ← 有上限
#     週 K 18.6 MiB (27.5%) 平均 122.7 根 ← 無上限,2024-06 起一路累積
#     月 K  4.5 MiB ( 6.7%) 平均  29.5 根 ← 無上限
# 合計每年約 +9.7 MiB → 約 3 年後再次撞上 100 MiB,2026-09 的故障會重演。


def test_trim_period_從最舊那端裁():
    """最新一根會被新資料覆蓋更新,不能動尾端。"""
    bars = [_bar(f"2024-{m:02d}-01", float(m)) for m in range(1, 13)]
    out = trim_period_bars(bars, 3)
    assert [b["time"] for b in out] == ["2024-10-01", "2024-11-01", "2024-12-01"]
    assert out[-1] is bars[-1], "最後一根必須原封不動"


def test_trim_period_比上限短就不動():
    bars = [_bar("2024-01-01"), _bar("2024-02-01")]
    assert trim_period_bars(bars, 10) == bars
    assert trim_period_bars(bars, 2) == bars


def test_trim_period_上限為零或None代表不裁():
    bars = [_bar(f"2024-{m:02d}-01") for m in range(1, 13)]
    assert trim_period_bars(bars, 0) == bars
    assert trim_period_bars(bars, None) == bars
    assert trim_period_bars(bars, -5) == bars


def test_trim_period_空陣列不丟例外():
    assert trim_period_bars([], 10) == []


def test_上限必須高於目前實際用量_才不會真的少給資料():
    """上限的用意是「封住無界成長」,不是拿少給資料換檔案大小。

    2026-11-16 實測的平均值是週 122.7 根、月 29.5 根;上限訂在其上,
    所以導入當下一根都不會被裁(已用真實快取驗證:週 0 根、月 0 根)。
    """
    assert WEEKLY_KEEP_BARS > 123, "週 K 上限不可低於目前實際平均,否則會真的砍掉資料"
    assert MONTHLY_KEEP_BARS > 30, "月 K 上限不可低於目前實際平均"


def test_週K上限不可低於前端最大可選根數():
    """StockDetailModal 的根數選擇器是 60/120/250/全。

    250 以目前的資料量本來就是灰的(totalBarsAvail >= n 才可選),
    但 120 必須留得住 —— 上限低於 120 會讓那個按鈕也變灰。
    """
    assert WEEKLY_KEEP_BARS >= 120


def test_合併後再裁_順序不可顛倒():
    """先裁再合併會把「日 K 還完整時算出來的」舊區間丟掉,上限也對不到最新那批。"""
    old = [_bar(f"2024-{m:02d}-01", float(m)) for m in range(1, 13)]
    new = [_bar("2025-01-01", 99.0)]
    merged = merge_period_bars(old, new)
    kept = trim_period_bars(merged, 3)
    assert [b["time"] for b in kept] == ["2024-11-01", "2024-12-01", "2025-01-01"]


# ── 檔案大小守門 ──────────────────────────────────────────────────────────────
#
# 2026-09 的守門只有 logger.warning,workflow 照樣 exit 0 → 沒人看到,
# 快取停更 41 天。現在超過 CACHE_FAIL_MIB 會讓 main() 回傳 1。


def test_守門門檻的相對關係():
    assert CACHE_WARN_MIB < CACHE_FAIL_MIB, "警戒線要在失敗線之前"
    assert CACHE_FAIL_MIB < 100, (
        "失敗線必須在 GitHub 的 100 MiB 硬上限之前 —— "
        "等到超過 100 才失敗,push 已經被擋掉了"
    )
    assert CACHE_WARN_MIB >= 80, "警戒線太低會天天狼來了"


def test_天花板估算要留在警戒線以下():
    """每檔都到上限時的最壞情況,必須明顯低於 CACHE_WARN_MIB。

    一根 bar 的 JSON 約 96~103 bytes(實測)。用 1800 檔估(目前 1562,留成長空間)。
    """
    stocks = 1800
    mib = (
        DAILY_KEEP_BARS * stocks * 96
        + WEEKLY_KEEP_BARS * stocks * 102
        + MONTHLY_KEEP_BARS * stocks * 103
    ) / 1024 / 1024
    assert mib < CACHE_WARN_MIB, (
        f"最壞情況約 {mib:.0f} MiB,已超過警戒線 {CACHE_WARN_MIB} MiB —— "
        f"把 DAILY/WEEKLY/MONTHLY_KEEP_BARS 調小"
    )
