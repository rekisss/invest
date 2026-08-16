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
import re
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


def _sign(item: dict) -> int | None:
    """取 TWSE 獨立的「漲跌」方向欄 → +1 / -1 / 0(取不到回 None)。

    2026-08 診斷:MI_INDEX 的「漲跌點數」只有**幅度**,正負號放在另一個
    「漲跌(+/-)」欄。舊碼只讀點數 → change 恆為正 → actual_up 每天都 True
    → 真實命中率虛高(現場顯示 80%,實際 0/4)。這裡把方向欄讀回來。
    值可能是 +/-、▲/▼、紅/綠(台股慣例 綠=跌),或帶 HTML 標籤。
    """
    raw = _field(item, ["漲跌"], excludes=["點數", "百分比", "percent", "%"])
    if raw is None:
        raw = _field(item, ["updown", "direction"], excludes=["percent", "%"])
    if raw is None:
        return None
    s = str(raw)
    # 方向欄有時帶 HTML(例:<p style='color:green'>-</p>)。屬性字串裡的連字號
    # (font-weight、text-align…)會被誤判成「跌」,所以先把標籤整段剝掉再判讀。
    s = re.sub(r"<[^>]*>", "", s).strip().lower()
    if "▼" in s or "green" in s or "跌" in s or "-" in s:
        return -1
    if "▲" in s or "red" in s or "漲" in s or "+" in s:
        return 1
    # 認不出來就回 None(交由呼叫端沿用點數本身的符號)。
    # 早期版本回 0,會讓 abs(chg) * 0 把有效的漲跌幅直接歸零。
    return None


def fetch_taiex() -> dict | None:
    """回傳 {close, change, pct}（TWSE MI_INDEX openapi，非交易日回 None）。

    Schema-agnostic:先用「任一欄位值含加權指數名稱」定位那一列(不預設
    名稱放哪個鍵),再以模糊鍵比對取收盤/漲跌點數(避開漲跌百分比),
    並把獨立「漲跌」欄的正負號套回幅度(見 _sign)。
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
        # 幅度 × 獨立方向欄的正負號(方向欄不存在時,沿用點數本身的符號)
        sign = _sign(item)
        if chg is not None and sign is not None:
            chg = abs(chg) * sign
        # 合理性檢查:加權指數單日漲跌不可能超過 15%(2026-08 現場曾解析出
        # +2030 點/+5% 這種值)。解析明顯有問題時寧可回 None,讓 score_prediction
        # 改用「與前一交易日收盤相比」這個不依賴 schema 的方式判方向。
        if chg is not None and close and abs(chg) / close > 0.15:
            print(f"[taiex] 漲跌點數 {chg} 相對收盤 {close} 不合理 → 捨棄,改用收盤差判方向")
            chg = None
        prev = close - chg if chg is not None else None
        # 記錄實際比對到的那一列名稱。2026-08 診斷:存下來的收盤序列單日波動
        # 中位數 1.34%、最大 7.69%(加權指數實際約 0.5~0.7%),且與掃描池等權
        # 報酬在 15 天中有 5 天連方向都相反——高度懷疑不同日子比對到不同指數。
        # 沙盒連不到 TWSE 無法直接驗證,因此把來源名稱寫進紀錄供事後稽核。
        matched = next((str(v) for v in item.values() if TAIEX_NAME in str(v)), None)
        return {
            "close": close,
            "change": chg,
            "pct": (chg / prev) if (chg is not None and prev) else None,
            "name": matched,
        }
    print("[taiex] MI_INDEX 回應中找不到加權指數列(schema 可能再次改版)")
    return None


# 模型的預測期距。MarketPredictor(horizon=5) 在 main.py / discord_bot.py 都是 5,
# 代表預測的是「5 個交易日後是否上漲 ≥0.3%」,不是隔天。過去把它當隔天預測打分,
# 等於拿五天後的天氣預報去對一小時後有沒有下雨——命中率結構上就不可能對。
PRED_HORIZON = 5
UP_THRESHOLD = 1.003   # 與 train 時的 target 定義一致(漲幅需 >0.3% 才算「上漲」)


SPAN_TOLERANCE = 2     # 容許國定假日造成的 1~2 個工作日誤差
MAX_SESSION_MOVE = 0.06  # 單一交易日漲跌超過 6% 視為可疑(加權指數極罕見)


def _bdays_between(a: str, b: str) -> int:
    """a→b 之間的工作日數(週一~週五;不含國定假日)。"""
    d = datetime.strptime(a, "%Y-%m-%d").date()
    end = datetime.strptime(b, "%Y-%m-%d").date()
    n = 0
    while d < end:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


def score_horizon_hits(records: list, horizon: int = PRED_HORIZON) -> int:
    """依模型真正的預測期距(預設 5 個交易日)回填 hit_h{n},回傳新打分的筆數。

    對每一筆有方向性預測的紀錄,取其後第 horizon 個交易日的收盤與當日收盤比較
    (門檻與訓練時相同:需漲逾 0.3%)。尚未到期的紀錄不打分(hit_h5=None),
    會在資料累積足夠後自動補上。
    """
    asc = sorted(
        (e for e in records if isinstance(e.get("taiex_close"), (int, float)) and e.get("date")),
        key=lambda e: e["date"],
    )
    key = f"hit_h{horizon}"
    ret_key = f"ret_h{horizon}"
    scored = 0
    for i, e in enumerate(asc):
        prob = e.get("xgb_prob_up")
        if not isinstance(prob, (int, float)) or abs(prob - 0.5) <= 0.05:
            e[key] = None          # 中性/無預測不計分
            continue
        j = i + horizon
        if j >= len(asc):
            e[key] = None          # 期距未到,之後補
            continue
        base, future = e["taiex_close"], asc[j]["taiex_close"]
        if not base:
            e[key] = None
            continue
        # 區間內只要有任何一天的收盤被標記可疑,就不打分(寧可少算不誤報)
        if any(x.get("close_suspect") for x in asc[i:j + 1]):
            e[key] = None
            continue
        # 「第 N 筆紀錄」≠「第 N 個交易日」:某天沒跑到就沒有紀錄,index+horizon 會
        # 跨過比預期更長的期間(2026-08 實測:11 筆有 7 筆跨了 6 個工作日而非 5,
        # 因為缺 07-31、08-13)。記錄實際跨距,明顯過長就不打分,寧可少算不誤報。
        span = _bdays_between(e["date"], asc[j]["date"])
        e[f"{key}_span_bdays"] = span
        if span > horizon + SPAN_TOLERANCE:
            e[key] = None
            continue
        up = future > base * UP_THRESHOLD
        e[key] = (prob > 0.5) == up
        e[ret_key] = round((future - base) / base * 100, 2)
        e[f"{key}_date"] = asc[j]["date"]
        scored += 1
    return scored


def repair_history(records: list) -> int:
    """就地重算既有紀錄的 方向/命中/漲跌(依收盤序列),回傳被更正的筆數。

    2026-08 之前寫入的紀錄帶著「漲跌點數缺正負號」的 bug:actual_up 恆為 True、
    偏多預測一律算命中(現場 4/5=80%,實際 0/4)。這裡用「當日收盤 vs 前一交易日
    收盤」把歷史一次校正,讓存檔本身就是對的(而不只是前端顯示層繞過)。
    只更正衍生欄位,不刪任何紀錄。
    """
    asc = sorted(
        (e for e in records if isinstance(e.get("taiex_close"), (int, float)) and e.get("date")),
        key=lambda e: e["date"],
    )
    fixed = 0
    prev_close = None
    for e in asc:
        if prev_close is None:          # 首筆沒有前一日可比,方向不可知
            up, chg, pct = None, None, None
        else:
            up = e["taiex_close"] > prev_close
            chg = round(e["taiex_close"] - prev_close, 2)
            pct = ((e["taiex_close"] - prev_close) / prev_close) if prev_close else None
        prob = e.get("xgb_prob_up")
        hit = None
        if up is not None and isinstance(prob, (int, float)) and abs(prob - 0.5) > 0.05:
            hit = (prob > 0.5) == up
        if e.get("hit") != hit or e.get("actual_up") != up:
            fixed += 1
        e["actual_up"], e["hit"] = up, hit
        if chg is not None:
            e["taiex_change"], e["taiex_pct"] = chg, pct
        prev_close = e["taiex_close"]
    if fixed:
        print(f"[pred] ⚠️ 校正 {fixed} 筆歷史紀錄(舊版漲跌點數缺正負號 → 方向/命中重算)")
    return fixed


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

    # 方向的權威來源 = 「今日收盤 vs 前一個已記錄交易日收盤」。不依賴 TWSE 的
    # 漲跌欄 schema,因此對欄位改版/缺正負號免疫(這正是 2026-08 命中率虛高的根因)。
    close = taiex["close"]
    chg, pct = taiex.get("change"), taiex.get("pct")
    prev_rec = max(
        (e for e in out if e.get("date", "") < today and isinstance(e.get("taiex_close"), (int, float))),
        key=lambda e: e["date"], default=None,
    )
    if prev_rec:
        pc = prev_rec["taiex_close"]
        chg = round(close - pc, 2)
        pct = ((close - pc) / pc) if pc else None
        up = close > pc
    else:
        up = (chg > 0) if chg is not None else None   # 首筆無前值:只能靠漲跌欄

    entry = {
        "date": today,
        "taiex_close": close,
        "taiex_change": chg,
        "taiex_pct": pct,
        "actual_up": up,
    }
    if taiex.get("name"):
        entry["taiex_name"] = taiex["name"]     # 來源稽核用
    # 合理性:加權指數單一交易日極少超過 6%。超過就標記為可疑(多半是比對到別的
    # 指數,或中間漏了交易日),打分時排除,避免把雜訊當成「真實命中率」。
    if prev_rec and pct is not None and abs(pct) > MAX_SESSION_MOVE:
        entry["close_suspect"] = True
    if pred:
        prob = float(pred["xgb_prob_up"])
        directional = abs(prob - 0.5) > 0.05
        entry.update({
            "pred_date": pred["date"],
            "xgb_prob_up": prob,
            "pred_label": pred.get("xgb_label"),
            # 只有明確方向的預測才算命中率（|prob-0.5|>0.05；中性不計分）
            "directional": directional,
            # 方向未知(首筆無前值且漲跌欄也缺)時不打分,不猜
            "hit": ((prob > 0.5) == up) if (directional and up is not None) else None,
        })
    out.append(entry)
    out.sort(key=lambda e: e["date"])
    repair_history(out)
    score_horizon_hits(out)          # 依模型真正的 5 日期距打分(hit_h5)
    _save_json(PRED_OUT, out)
    scored = [e for e in out if e.get("hit") is not None]
    hits = sum(1 for e in scored if e["hit"])
    h_key = f"hit_h{PRED_HORIZON}"
    h_scored = [e for e in out if e.get(h_key) is not None]
    h_hits = sum(1 for e in h_scored if e[h_key])
    chg_str = f"{chg:+.0f}" if isinstance(chg, (int, float)) else "—"
    print(f"[pred] {today} 加權 {close:.0f} ({chg_str}) · "
          f"預測 {entry.get('xgb_prob_up', '—')} → 隔日 hit={entry.get('hit')} · "
          f"隔日命中 {hits}/{len(scored)} · "
          f"{PRED_HORIZON}日期距命中 {h_hits}/{len(h_scored)}(模型真正的預測期距)")


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
        # 即使今天沒新資料,也把歷史的方向/命中校正一次(修舊版符號 bug)
        recs = _load_json(PRED_OUT, [])
        if recs:
            changed = repair_history(recs)
            score_horizon_hits(recs)       # 到期的預測補上 5 日期距打分
            if changed or recs:
                _save_json(PRED_OUT, recs)
    track_top20(today)
    return 0


if __name__ == "__main__":
    sys.exit(main())
