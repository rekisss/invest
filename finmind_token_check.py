#!/usr/bin/env python3
"""FinMind token 健康檢查 (standalone, read-only).

一次檢查掃描用的 9 把 FinMind token，回報每一把：
  - 是否有效 (token 被 API 接受)
  - 當前額度用量 / 上限 / 剩餘 (透過 user_info)
  - 是否額度已耗盡

不修改、不依賴任何現有掃描程式。設計成在 GitHub Actions 用 workflow_dispatch
跑（secrets 只在 CI 取得），結果直接看 log。

對應掃描分段的 token 環境變數：
  FINMIND_TOKEN (seg8), FINMIND_TOKEN_2..FINMIND_TOKEN_9 (seg0..seg7)
"""

from __future__ import annotations

import os
import sys

import requests

DATA_URL = "https://api.finmindtrade.com/api/v4/data"
USER_URL = "https://api.finmindtrade.com/api/v4/user_info"

# (env var, 掃描分段標籤) — 對齊 full_market_scan.yml 的 matrix
TOKENS = [
    ("FINMIND_TOKEN",   "seg8"),
    ("FINMIND_TOKEN_2", "seg0"),
    ("FINMIND_TOKEN_3", "seg1"),
    ("FINMIND_TOKEN_4", "seg2"),
    ("FINMIND_TOKEN_5", "seg3"),
    ("FINMIND_TOKEN_6", "seg4"),
    ("FINMIND_TOKEN_7", "seg5"),
    ("FINMIND_TOKEN_8", "seg6"),
    ("FINMIND_TOKEN_9", "seg7"),
]


def _check_one(token: str) -> dict:
    """Return {ok, exhausted, limit, used, remaining, note} for one token."""
    out = {"ok": False, "exhausted": False, "limit": None, "used": None, "remaining": None, "note": ""}
    # 1) 額度用量（best effort — 不同帳戶/版本欄位可能不同）
    try:
        r = requests.get(USER_URL, headers={"Authorization": f"Bearer {token}"}, timeout=15)
        j = r.json()
        data = j.get("data", j) if isinstance(j, dict) else {}
        lim = data.get("api_request_limit")
        used = data.get("user_count")
        if isinstance(lim, (int, float)):
            out["limit"] = int(lim)
        if isinstance(used, (int, float)):
            out["used"] = int(used)
        if out["limit"] is not None and out["used"] is not None:
            out["remaining"] = max(0, out["limit"] - out["used"])
    except Exception:
        pass
    # 2) 驗證 token + 偵測額度耗盡（沿用 data_loader 的可靠做法）
    try:
        resp = requests.get(
            DATA_URL,
            headers={"Authorization": f"Bearer {token}"},
            params={"dataset": "TaiwanStockInfo", "data_id": "2330"},
            timeout=15,
        )
        payload = resp.json()
        status = payload.get("status", resp.status_code)
        msg = str(payload.get("msg") or "")
        if status == 200:
            out["ok"] = True
            out["note"] = "OK"
        elif status == 402 or "limit" in msg.lower() or "上限" in msg:
            out["ok"] = True            # token 有效，只是額度滿
            out["exhausted"] = True
            out["note"] = "額度已耗盡"
        else:
            out["note"] = f"被拒({status}) {msg[:80]}"
    except Exception as exc:
        out["note"] = f"連線失敗：{exc}"
    return out


def main() -> int:
    print("=" * 64)
    print("FinMind Token 健康檢查")
    print("=" * 64)
    print(f"{'分段':<6}{'變數':<18}{'狀態':<10}{'剩餘/上限':<14}{'備註'}")
    print("-" * 64)

    valid = exhausted = unset = invalid = 0
    total_remaining = 0
    for env, seg in TOKENS:
        token = os.getenv(env, "").strip()
        if not token:
            unset += 1
            print(f"{seg:<6}{env:<18}{'⚪未設定':<10}{'-':<14}{'此分段沒有 token'}")
            continue
        r = _check_one(token)
        if r["remaining"] is not None:
            total_remaining += r["remaining"]
            quota = f"{r['remaining']}/{r['limit']}"
        elif r["limit"] is not None:
            quota = f"?/{r['limit']}"
        else:
            quota = "?"
        if r["exhausted"]:
            exhausted += 1; state = "🟠額度滿"
        elif r["ok"]:
            valid += 1; state = "🟢有效"
        else:
            invalid += 1; state = "🔴無效"
        print(f"{seg:<6}{env:<18}{state:<10}{quota:<14}{r['note']}")

    print("-" * 64)
    print(f"總結：🟢有效 {valid}  🟠額度滿 {exhausted}  🔴無效 {invalid}  ⚪未設定 {unset}  （共 {len(TOKENS)} 把）")
    if total_remaining:
        print(f"目前可用額度合計（有回報的 token）：約 {total_remaining} 次")
    if exhausted:
        print("➡ 有 token 額度耗盡：每小時/每日會重置（免費版每小時約 600 次/把）。")
    if invalid or unset:
        print("➡ 有 token 無效或未設定：到 GitHub repo Settings → Secrets → Actions 補上/更換。")
    if valid and not exhausted and not invalid and not unset:
        print("✅ 全部 token 健康，額度充足。若掃描仍缺資料，問題不在 token，需查掃描程式。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
