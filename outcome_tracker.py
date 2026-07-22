#!/usr/bin/env python3
"""真實結果追蹤器 (standalone, read-only inputs → 自己的輸出檔).

可參考度的地基：把「預測準不準」「上榜股後來怎樣」從代理值/無紀錄，
變成用**真實收盤價**打分的持久紀錄。

做兩件事（都不動任何現有程式與資料）：

1. 大盤預測打分
   - 從 TWSE MI_INDEX openapi 抓當日加權指數真實收盤與漲跌（免費、無配額）
   - 對照 output/prediction_history.json 裡「最近一個 <= 今日的預測」
     （限 5 天內，避免跨長假亂配對），記錄 預測機率 vs 實際方向 → hit
   - 追加到 output/outcomes/prediction_outcomes.json

2. TOP 20 事後成績單
   - 用當日 batch_seq CSV 排出 TOP 20（同 top20_notify 的排序）快照存檔
   - 用今日各股收盤，回填過去快照的 +1/+5/+10/+20 交易日報酬
   - 存 output/outcomes/top20_history.json

冪等：同一天重跑會覆蓋當天紀錄，不會重複追加。
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
OUT_DIR = os.path.join("output", "outcomes")
PRED_HISTORY = os.path.join("output", "prediction_history.json")
PRED_OUT = os.path.join(OUT_DIR, "prediction_outcomes.json")
TOP20_OUT = os.path.join(OUT_DIR, "top20_history.json")
TWSE_IDX = "https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX"
HORIZONS = (1, 5, 10, 20)


def _today() -> str:
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")


def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def _f(v, default=None):
    try:
        x = float(str(v).replace(",", ""))
        return x if x == x and abs(x) != float("inf") else default
    except (TypeError, ValueError):
        return default


# ── 1) 真實加權指數收盤 ────────────────────────────────────────────────────────

# 加權指數的精確名稱。用完整字串「發行量加權股價指數」比對,可避免誤中
# 「發行量加權股價報酬指數」(總報酬指數,值不同)——後者含「股價報酬指數」
# 而非連續的「股價指數」,故不會被子字串命中。
TAIEX_NAME = "發行量加權股價指數"


def _field(item: dict, includes, excludes=()):
    """回傳第一個「鍵名含 includes 任一關鍵字、且不含 excludes 任一字」的值。

    TWSE openapi 的欄位名改過不只一次(指數名稱→指數、加/去英文鍵)。寫死
    欄位名會在改版後靜默失敗:fetch_taiex 回 None → 被當成假日跳過 →
    真實命中率永遠累積不到(2026-07 診斷:每個交易日都『無指數資料』)。
    模糊比對讓抓取對欄位改名有韌性。
    """
    for k, v in item.items():
        ks = str(k).lower()
        if any(inc.lower() in ks for inc in includes) and not any(ex.lower() in ks for ex in excludes):
            return v
    return None


def fetch_taiex() -> dict | None:
    """回傳 {close, change, pct}（TWSE MI_INDEX openapi，非交易日回 None）。

    Schema-agnostic:先用「任一欄位值含加權指數名稱」定位那一列(不預設
    名稱放哪個鍵),再以模糊鍵比對取收盤/漲跌點數(避開漲跌百分比)。
    """
    try:
        req = urllib.request.Request(TWSE_IDX, headers={"User-Agent": "outcome-tracker"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"[taiex] 抓取失敗: {exc}")
        return None
    for item in data or []:
        if not isinstance(item, dict):
            continue
        if not any(TAIEX_NAME in str(v) for v in item.values()):
            continue
        close = _f(_field(item, ["收盤", "closing", "close"]))
        # 漲跌點數:排除「漲跌百分比 / percent / %」避免取到百分比欄
        chg = _f(_field(item, ["漲跌點數", "點數", "change"], excludes=["百分比", "percent", "%"]))
        if close is None:
            continue
        prev = close - chg if chg is not None else None
        return {
            "close": close,
            "change": chg,
            "pct": (chg / prev) if (chg is not None and prev) else None,
        }
    print("[taiex] MI_INDEX 回應中找不到加權指數列(schema 可能再次改版)")
    return None


def score_prediction(today: str, taiex: dict) -> None:
    hist = _load_json(PRED_HISTORY, [])
    if isinstance(hist, dict):
        hist = hist.get("history", [])
    # 最近一個「日期 <= 今日、且 5 天內」的預測（預測 date = 目標交易日當天早上）
    cand = [h for h in hist if h.get("date") and h["date"] <= today and h.get("xgb_prob_up") is not None]
    cand.sort(key=lambda h: h["date"])
    pred = cand[-1] if cand else None
    if pred:
        gap = (datetime.strptime(today, "%Y-%m-%d") - datetime.strptime(pred["date"], "%Y-%m-%d")).days
        if gap > 5:
            pred = None
    out = _load_json(PRED_OUT, [])
    out = [e for e in out if e.get("date") != today]  # 冪等
    entry = {
        "date": today,
        "taiex_close": taiex["close"],
        "taiex_change": taiex["change"],
        "taiex_pct": taiex["pct"],
        "actual_up": (taiex["change"] or 0) > 0,
    }
    if pred:
        prob = float(pred["xgb_prob_up"])
        entry.update({
            "pred_date": pred["date"],
            "xgb_prob_up": prob,
            "pred_label": pred.get("xgb_label"),
            # 只有明確方向的預測才算命中率（|prob-0.5|>0.05；中性不計分）
            "directional": abs(prob - 0.5) > 0.05,
            "hit": (prob > 0.5) == ((taiex["change"] or 0) > 0) if abs(prob - 0.5) > 0.05 else None,
        })
    out.append(entry)
    out.sort(key=lambda e: e["date"])
    _save_json(PRED_OUT, out)
    scored = [e for e in out if e.get("hit") is not None]
    hits = sum(1 for e in scored if e["hit"])
    print(f"[pred] {today} 加權 {taiex['close']:.0f} ({taiex['change']:+.0f}) · "
          f"預測 {entry.get('xgb_prob_up', '—')} → hit={entry.get('hit')} · "
          f"累計真實命中 {hits}/{len(scored)}")


# ── 2) TOP20 快照 + 回填報酬 ──────────────────────────────────────────────────

def _load_closes(date: str) -> dict[str, float]:
    closes: dict[str, float] = {}
    for p in sorted(glob.glob(os.path.join(SCAN_DIR, f"batch_seq*_{date}.csv"))):
        try:
            with open(p, encoding="utf-8-sig", newline="") as fh:
                for r in csv.DictReader(fh):
                    sid = str(r.get("stock_id", "")).strip()
                    c = _f(r.get("close"))
                    if sid and c and c > 0:
                        closes[sid] = c
        except Exception:  # noqa: BLE001
            pass
    return closes


def _top20(date: str) -> list[dict]:
    best: dict[str, dict] = {}
    for p in sorted(glob.glob(os.path.join(SCAN_DIR, f"batch_seq*_{date}.csv"))):
        try:
            with open(p, encoding="utf-8-sig", newline="") as fh:
                for r in csv.DictReader(fh):
                    sid = str(r.get("stock_id", "")).strip()
                    sc, cl = _f(r.get("entry_score")), _f(r.get("close"))
                    if not sid or sc is None or not cl or cl <= 0:
                        continue
                    if sid not in best or sc > _f(best[sid].get("entry_score"), -1e9):
                        best[sid] = r
        except Exception:  # noqa: BLE001
            pass
    ranked = sorted(best.values(), key=lambda r: _f(r.get("entry_score"), 0), reverse=True)[:20]
    return [{"stock_id": str(r["stock_id"]).strip(), "name": str(r.get("name", "")).strip(),
             "close": _f(r.get("close")), "entry_score": round(_f(r.get("entry_score"), 0), 1)}
            for r in ranked]


def track_top20(today: str) -> None:
    hist = _load_json(TOP20_OUT, [])
    top = _top20(today)
    if top:
        hist = [s for s in hist if s.get("date") != today]  # 冪等
        hist.append({"date": today, "stocks": top})
        hist.sort(key=lambda s: s["date"])
        print(f"[top20] {today} 快照 {len(top)} 支")
    else:
        print(f"[top20] {today} 無掃描資料，跳過快照（僅回填）")

    # 回填：今天是過去快照日之後的第 N 個「快照交易日」→ 對應 horizon 報酬
    dates = [s["date"] for s in hist]
    closes_today = _load_closes(today)
    filled = 0
    for i, snap in enumerate(hist):
        n_days = len([d for d in dates if snap["date"] < d <= today])  # 之後過了幾個掃描日
        if n_days not in HORIZONS:
            continue
        key = f"ret_{n_days}d"
        for st in snap["stocks"]:
            if key in st or not st.get("close"):
                continue
            now = closes_today.get(st["stock_id"])
            if now:
                st[key] = round((now - st["close"]) / st["close"], 4)
                filled += 1
    if filled:
        print(f"[top20] 回填 {filled} 筆 forward return")
    _save_json(TOP20_OUT, hist)


def main() -> int:
    today = os.getenv("TRACK_DATE", "").strip() or _today()
    taiex = fetch_taiex()
    if taiex:
        score_prediction(today, taiex)
    else:
        print("[pred] 今日無指數資料（假日或 API 失敗），跳過預測打分")
    track_top20(today)
    return 0


if __name__ == "__main__":
    sys.exit(main())
