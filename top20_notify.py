#!/usr/bin/env python3
"""每日 TOP 20 Discord 通知 (standalone, read-only).

背景：舊架構由 `main.py --mode aggregate`（full_market_aggregate.yml, 20:30 CST）彙整
批次結果、發「🌙 全市場掃描 TOP N」到 Discord。2026-06-22 移除該 workflow 後這個
總榜通知就消失了——因為 aggregate 模式彙整完會「刪除當日 batch CSV」，而新的
9 段平行架構裡那些 CSV 是網頁前端 (build-data.mjs) 與掃描完整度檢查的資料來源，
不能刪。

本工具用「只讀不刪」方式把 TOP 20 Discord 通知補回來：
  - 直接讀 output/full_scan/batch_seq*_<date>.csv（9 段掃描的原始輸出）
  - 依 entry_score 排序、同股票取最高分，取前 20 名發 Discord
  - 不寫入、不刪除任何檔案；不 import 任何現有掃描程式（stdlib only）

排程跑在收盤後掃描與自癒輪全部結束之後（見 top20-notify.yml）。
"""

from __future__ import annotations

import csv
import glob
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

SCAN_DIR = os.path.join("output", "full_scan")
TOP_N = 20
DISCORD_LIMIT = 1900  # Discord 單則上限 2000，留 buffer


def _taipei_today() -> str:
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")


def _f(v, default=None):
    """Best-effort float."""
    try:
        x = float(v)
        if x != x or x in (float("inf"), float("-inf")):
            return default
        return x
    except (TypeError, ValueError):
        return default


def _load_rows(date: str) -> tuple[list[dict], int]:
    """讀當日所有分段 CSV，回傳 (rows, seg_count)。"""
    paths = sorted(glob.glob(os.path.join(SCAN_DIR, f"batch_seq*_{date}.csv")))
    rows: list[dict] = []
    for p in paths:
        try:
            with open(p, "r", encoding="utf-8-sig", newline="") as fh:
                for r in csv.DictReader(fh):
                    rows.append(r)
        except Exception as exc:  # noqa: BLE001
            print(f"[top20] 略過 {os.path.basename(p)}: {exc}")
    return rows, len(paths)


def _rank(rows: list[dict]) -> list[dict]:
    """同股票取最高 entry_score，過濾壞價格，依分數排序。"""
    best: dict[str, dict] = {}
    for r in rows:
        sid = str(r.get("stock_id", "")).strip()
        if not sid:
            continue
        close = _f(r.get("close"))
        score = _f(r.get("entry_score"))
        if close is None or close <= 0 or score is None:
            continue
        if sid not in best or score > _f(best[sid].get("entry_score"), -1e9):
            best[sid] = r
    return sorted(best.values(), key=lambda r: _f(r.get("entry_score"), 0.0), reverse=True)


def _fmt_line(i: int, r: dict) -> str:
    sid = str(r.get("stock_id", "")).strip()
    name = str(r.get("name", "")).strip() or "?"
    close = _f(r.get("close"))
    day_ret = _f(r.get("day_return"))
    score = _f(r.get("entry_score"), 0.0)
    grade = str(r.get("grade", "")).strip()
    entry = str(r.get("entry_signal", "")).strip().lower() in ("true", "1")
    fstreak = _f(r.get("foreign_buy_streak"), 0) or 0

    ret_txt = f"{day_ret * 100:+.1f}%" if day_ret is not None else "—"
    parts = [f"`{i:>2}.` **{sid} {name}** {close:g} ({ret_txt}) 分數 {score:.1f}"]
    tags = []
    if grade:
        tags.append(grade)
    if entry:
        tags.append("✅進場訊號")
    if fstreak >= 3:
        tags.append(f"外資連買{int(fstreak)}日")
    if str(r.get("is_sector_leader", "")).strip().lower() in ("true", "1"):
        tags.append("族群領頭")
    if tags:
        parts.append(" · ".join(tags))
    return "  ".join(parts)


def _send_discord(content: str) -> bool:
    webhook = os.getenv("DISCORD_WEBHOOK_URL", "").strip()
    if not webhook:
        print("[discord] DISCORD_WEBHOOK_URL 未設定，只印 log")
        return False
    try:
        req = urllib.request.Request(
            webhook,
            data=json.dumps({"content": content[:DISCORD_LIMIT]}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=10)
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[discord] 發送失敗: {exc}")
        return False


def main() -> int:
    date = os.getenv("SCAN_DATE", "").strip() or _taipei_today()
    rows, seg_count = _load_rows(date)

    if not rows:
        # 週末/假日或掃描沒跑：安靜結束。掃描空洞由「掃描完整度檢查」負責告警，
        # 這裡不重複發警報。
        print(f"[top20] {date} 沒有掃描資料（{seg_count} 個分段檔），跳過通知")
        return 0

    ranked = _rank(rows)
    top = ranked[:TOP_N]
    total = len(ranked)
    entry_cnt = sum(
        1 for r in ranked if str(r.get("entry_signal", "")).strip().lower() in ("true", "1")
    )

    lines = [_fmt_line(i + 1, r) for i, r in enumerate(top)]
    header = (
        f"🌙 **全市場掃描 TOP {len(top)}** · {date}\n"
        f"掃描 {total} 支（{seg_count} 段）· 進場訊號 {entry_cnt} 支"
    )
    body = "\n".join(lines)

    print(header)
    print(body)

    # Discord 上限 2000 字：header+前段一則，塞不下的行接第二則
    msg = header + "\n" + body
    if len(msg) <= DISCORD_LIMIT:
        _send_discord(msg)
    else:
        cut = msg.rfind("\n", 0, DISCORD_LIMIT)
        _send_discord(msg[:cut])
        _send_discord(msg[cut + 1:])
    print("[top20] 完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
