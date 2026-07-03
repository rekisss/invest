#!/usr/bin/env python3
"""全市場掃描完整度檢查 (standalone, read-only).

每天掃完後回報「哪幾段真的有資料、哪幾段空了」，並把空掉的分段對應回它用的
FinMind token，讓人一眼看出是哪把 token 出問題（額度滿 / register 等級 / 無效）。

背景：掃描的進度檔 `_attempted_<date>_seg<N>.csv` 會把「抓失敗」的股票也記成
「今天試過了」。所以普通重跑會被進度檔擋住（印「今日全部已掃完」卻沒有資料），
只有 force_rescan=true 才會真正重抓。本工具直接看「實際產出的 batch CSV 行數」，
不看進度檔，因此能誠實反映每段到底有沒有掃到東西。

不修改、不依賴任何現有掃描程式，只讀 output/full_scan/ 下的 CSV。設計成在
GitHub Actions 用排程/手動觸發，結果看 log + 發 Discord。
"""

from __future__ import annotations

import csv
import glob
import json
import os
import sys
from datetime import datetime, timedelta, timezone

# 掃描輸出目錄（對齊 full_market_scan.yml 的 --output output）
SCAN_DIR = os.path.join("output", "full_scan")

# seg -> 該分段使用的 FinMind token 環境變數（對齊 full_market_scan.yml 的 matrix）
SEG_TOKEN = {
    0: "FINMIND_TOKEN_2",
    1: "FINMIND_TOKEN_3",
    2: "FINMIND_TOKEN_4",
    3: "FINMIND_TOKEN_5",
    4: "FINMIND_TOKEN_6",
    5: "FINMIND_TOKEN_7",
    6: "FINMIND_TOKEN_8",
    7: "FINMIND_TOKEN_9",
    8: "FINMIND_TOKEN",  # 主帳號（備用），常是最弱的一把
}

# 每段的目標股數（加權分段，對齊 full_market_scan.yml）。只作參考顯示用。
SEG_TARGET = {0: 256, 1: 256, 2: 256, 3: 256, 4: 256, 5: 130, 6: 130, 7: 130, 8: 130}


def _taipei_today() -> str:
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")


def _count_rows(path: str) -> int:
    """回傳 CSV 的資料列數（不含表頭）。檔案不存在回 -1，空/只有表頭回 0。"""
    if not os.path.exists(path):
        return -1
    try:
        with open(path, "r", encoding="utf-8-sig", newline="") as f:
            reader = csv.reader(f)
            rows = [r for r in reader if any(c.strip() for c in r)]
        return max(0, len(rows) - 1)  # 扣掉表頭
    except Exception:
        return -1


def _attempted_count(date: str, seg: int) -> int:
    """該段今日「已標記嘗試」的股數（含抓失敗的）。無檔回 0。"""
    total = 0
    for path in glob.glob(os.path.join(SCAN_DIR, f"_attempted_{date}_seg{seg}.csv")):
        c = _count_rows(path)
        if c > 0:
            total += c
    return total


def main() -> int:
    date = os.getenv("SCAN_DATE", "").strip() or _taipei_today()

    print("=" * 70)
    print(f"全市場掃描完整度檢查 · {date}")
    print("=" * 70)
    print(f"{'分段':<6}{'token':<18}{'狀態':<10}{'有資料':<8}{'嘗試':<8}{'備註'}")
    print("-" * 70)

    have_data = empty = missing = 0
    total_rows = 0
    empty_segs: list[str] = []
    lines: list[str] = []  # compact per-seg lines for Discord

    for seg in sorted(SEG_TOKEN):
        env = SEG_TOKEN[seg]
        csv_path = os.path.join(SCAN_DIR, f"batch_seq{seg}_{date}.csv")
        rows = _count_rows(csv_path)
        attempted = _attempted_count(date, seg)

        if rows > 0:
            have_data += 1
            total_rows += rows
            state = "🟢有資料"
            note = ""
        elif rows == 0:
            empty += 1
            state = "🔴空的"
            note = f"試過 {attempted} 支全失敗 → 疑 {env} 額度滿/無效"
            empty_segs.append(f"seg{seg}({env})")
        else:  # rows == -1，檔案不存在
            if attempted > 0:
                empty += 1
                state = "🔴空的"
                note = f"試過 {attempted} 支全失敗、無輸出 → 疑 {env} 額度滿/無效"
                empty_segs.append(f"seg{seg}({env})")
            else:
                missing += 1
                state = "⚪未執行"
                note = "今日尚無此段（未跑到）"

        tgt = SEG_TARGET.get(seg, "?")
        print(f"{seg:<6}{env:<18}{state:<10}{str(max(rows,0)) + '/' + str(tgt):<8}{attempted:<8}{note}")
        lines.append(f"seg{seg} {state} {max(rows,0)}/{tgt} ({env})")

    print("-" * 70)
    print(f"總結：🟢有資料 {have_data} 段  🔴空 {empty} 段  ⚪未執行 {missing} 段  ·  合計 {total_rows} 支")
    if empty_segs:
        print("➡ 空掉的分段（同一組 token 反覆失敗）：" + "、".join(empty_segs))
        print("➡ 修法：1) 先跑『FinMind Token 健康檢查』確認這幾把是額度滿還是無效")
        print("        2) 額度滿→等重置；無效→到 Settings → Secrets 換掉")
        print("        3) 再用 workflow_dispatch 勾 force_rescan=true 重掃（普通重跑會被進度檔擋住）")
    elif have_data:
        print("✅ 全部分段都有資料，掃描完整。")

    # Discord 通知（有設 webhook 才發）
    webhook = os.getenv("DISCORD_WEBHOOK_URL", "").strip()
    if webhook:
        if empty_segs:
            headline = f"⚠️ 掃描不完整 · {date}：🔴{empty} 段空 / 🟢{have_data} 段有資料（合計 {total_rows} 支）"
        elif have_data:
            headline = f"✅ 掃描完整 · {date}：9 段全有資料（合計 {total_rows} 支）"
        else:
            headline = f"⚪ 掃描尚未執行 · {date}"
        body = "\n".join(lines)
        tail = ""
        if empty_segs:
            tail = ("\n🔴 空掉：" + "、".join(empty_segs)
                    + "\n→ 先查『FinMind Token 健康檢查』，修好 token 後用 force_rescan=true 重掃。")
        msg = f"**{headline}**\n```\n{body}\n```{tail}"
        try:
            import urllib.request
            req = urllib.request.Request(
                webhook,
                data=json.dumps({"content": msg[:1900]}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=10)
            print("[discord] 已發送掃描完整度通知")
        except Exception as exc:  # noqa: BLE001
            print(f"[discord] 通知失敗（skip）: {exc}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
