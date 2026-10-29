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

2026-10 修正(日期錯位):
   MI_INDEX openapi 在 17:45 執行時多半還是「前一交易日」的資料,舊版卻一律
   當成「今天」寫入 → 每筆收盤都晚一天、休市日也有紀錄、偶爾重複舊值,隔日命中
   等於拿今天的預測對昨天的漲跌。改為:
   - 以 TWSE FMTQIK(每月每日市場成交資訊,每列自帶日期)建立「交易日 → 加權收盤」
     序列並快取在 output/outcomes/taiex_daily.json,依**真實交易日**重建打分紀錄。
   - TOP20 報酬改以同一份交易日曆 + kline_cache.json 計算,不再用「之後第 N 個快照」。
   - 第一次改寫前把原檔備份成 *_raw.json(不刪資料)。
   FMTQIK 抓不到時退回 MI_INDEX,但只採用回應裡自帶的日期;沒有日期就不寫(不猜)。
"""

from __future__ import annotations

import csv
import glob
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

SCAN_DIR = os.path.join("output", "full_scan")
OUT_DIR = os.path.join("output", "outcomes")
PRED_HISTORY = os.path.join("output", "prediction_history.json")
PRED_OUT = os.path.join(OUT_DIR, "prediction_outcomes.json")
TOP20_OUT = os.path.join(OUT_DIR, "top20_history.json")
TWSE_IDX = "https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX"
TWSE_FMTQIK = "https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date={ym}01&response=json"
TAIEX_SERIES = os.path.join(OUT_DIR, "taiex_daily.json")
KLINE_CACHE = os.path.join("output", "kline_cache.json")
HORIZONS = (1, 5, 10, 20)
DAILY_LIMIT = 0.105   # 台股漲跌停 10%,留一點四捨五入空間


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
            # 這一列資料「屬於哪一天」。2026-10 診斷:17:45 抓到的常是前一交易日,
            # 不能直接當今天。取不到日期時為 None,由呼叫端決定(不猜)。
            "date": _parse_twse_date(_field(item, ["日期", "date"], excludes=["update", "time"])),
            "close": close,
            "change": chg,
            "pct": (chg / prev) if (chg is not None and prev) else None,
            "name": matched,
        }
    print("[taiex] MI_INDEX 回應中找不到加權指數列(schema 可能再次改版)")
    return None


def _parse_twse_date(v) -> str | None:
    """TWSE 日期 → YYYY-MM-DD。支援民國 115/10/27、1151027 與西元 2026-10-27、20261027。"""
    if v is None:
        return None
    s = re.sub(r"<[^>]*>", "", str(v)).strip()
    m = re.fullmatch(r"(\d{2,4})[/\-.](\d{1,2})[/\-.](\d{1,2})", s)
    if m:
        y, mo, d = (int(x) for x in m.groups())
    else:
        digits = re.sub(r"\D", "", s)
        if len(digits) == 8:
            y, mo, d = int(digits[:4]), int(digits[4:6]), int(digits[6:])
        elif len(digits) == 7:
            y, mo, d = int(digits[:3]), int(digits[3:5]), int(digits[5:])
        else:
            return None
    if y < 1911:
        y += 1911
    try:
        return datetime(y, mo, d).strftime("%Y-%m-%d")
    except ValueError:
        return None


def parse_fmtqik(payload: dict) -> dict[str, float]:
    """FMTQIK JSON → {YYYY-MM-DD: 加權指數收盤}。欄位以名稱定位,避開報酬指數。"""
    if not isinstance(payload, dict) or str(payload.get("stat", "OK")).upper() != "OK":
        return {}
    fields = [str(f) for f in payload.get("fields") or []]
    di = next((i for i, f in enumerate(fields) if "日期" in f or f.lower() == "date"), None)
    ci = next((i for i, f in enumerate(fields)
               if "加權" in f and "指數" in f and "報酬" not in f), None)
    if di is None or ci is None:
        return {}
    out: dict[str, float] = {}
    for row in payload.get("data") or []:
        if not isinstance(row, (list, tuple)) or len(row) <= max(di, ci):
            continue
        d, c = _parse_twse_date(row[di]), _f(row[ci])
        if d and c and c > 0:
            out[d] = c
    return out


def _fetch_fmtqik_month(ym: str) -> dict[str, float] | None:
    """抓某個月(YYYYMM)的每日加權收盤;失敗回 None(與「該月沒有交易日」的 {} 區分)。"""
    try:
        req = urllib.request.Request(TWSE_FMTQIK.format(ym=ym), headers={"User-Agent": "outcome-tracker"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return parse_fmtqik(json.loads(r.read().decode("utf-8")))
    except Exception as exc:  # noqa: BLE001
        print(f"[taiex] FMTQIK {ym} 抓取失敗: {exc}")
        return None


def _months_between(first: str, last: str) -> list[str]:
    y, m = int(first[:4]), int(first[5:7])
    ey, em = int(last[:4]), int(last[5:7])
    out = []
    while (y, m) <= (ey, em):
        out.append(f"{y:04d}{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def update_taiex_series(today: str, earliest: str | None, fetch=_fetch_fmtqik_month) -> dict[str, float]:
    """維護「交易日 → 加權收盤」快取並回傳。

    已結束且抓過的月份不重抓;本月與上個月每次都重抓(月初跑時上個月最後幾天
    可能還沒進來)。快取格式:{"closes": {date: close}, "complete_months": [YYYYMM]}。
    """
    cache = _load_json(TAIEX_SERIES, {})
    closes: dict[str, float] = dict(cache.get("closes") or {})
    complete = set(cache.get("complete_months") or [])
    if not earliest:
        earliest = today
    months = _months_between(earliest[:7], today[:7])
    cur = today[:4] + today[5:7]
    prev = months[-2] if len(months) >= 2 else None
    fetched = 0
    for ym in months:
        if ym in complete and ym not in (cur, prev):
            continue
        if fetched:
            time.sleep(1.5)   # TWSE 有頻率限制
        got = fetch(ym)
        fetched += 1
        if got is None:
            continue
        closes.update(got)
        if ym != cur:
            complete.add(ym)
    if fetched:
        _save_json(TAIEX_SERIES, {"closes": dict(sorted(closes.items())),
                                  "complete_months": sorted(complete)})
        print(f"[taiex] FMTQIK 更新 {fetched} 個月,序列共 {len(closes)} 個交易日")
    return closes


def _backup_once(path: str) -> None:
    """第一次改寫前,把原檔另存 *_raw.json(已存在就不覆蓋)。"""
    raw = path.replace(".json", "_raw.json")
    if os.path.exists(path) and not os.path.exists(raw):
        _save_json(raw, _load_json(path, []))
        print(f"[backup] 原始檔備份 → {raw}")


def rebuild_prediction_outcomes(series: dict[str, float], preds: list, existing: list,
                                horizon: int | None = None) -> list:
    """以真實交易日序列重建打分紀錄(純函式,回傳新清單)。

    - 交易日 D 的紀錄:taiex_close = D 的收盤;方向 = D vs 前一交易日。
    - 預測只對「同一天」的那筆(盤前預測的 date 就是目標交易日);舊版會把
      幾天前的預測套到沒有預測的日子上,造成同一個預測被重複計分。
    - 5 日期距:base = D 的前一交易日(模型特徵的最後一根),target = base 之後
      第 horizon 個交易日,門檻 >0.3%,與 market_predictor 訓練 target 一致。
    - 既有紀錄中不是交易日的(休市日)保留但不計分;與序列不同的舊收盤留在
      taiex_close_legacy 供稽核。序列涵蓋範圍以外的舊紀錄原封不動。
    """
    horizon = horizon or PRED_HORIZON
    days = sorted(series)
    if not days:
        return existing
    idx = {d: i for i, d in enumerate(days)}
    pred_by_date = {}
    for p in preds or []:
        if p.get("date") and isinstance(p.get("xgb_prob_up"), (int, float)):
            pred_by_date[p["date"]] = p
    old_by_date = {e.get("date"): e for e in existing or [] if e.get("date")}
    start_candidates = [d for d in list(pred_by_date) + list(old_by_date) if d]
    start = max(min(start_candidates), days[0]) if start_candidates else days[0]

    # 整個月份都沒有資料(該月 FMTQIK 抓取失敗)就不能據此判定「休市」
    months = {d[:7] for d in days}
    out = []
    for date, old in sorted(old_by_date.items()):
        if date < days[0] or date > days[-1] or date[:7] not in months:
            out.append(old)                         # 序列涵蓋範圍外:不動
        elif date not in idx:
            e = dict(old)                           # 休市日紀錄:保留、不計分
            if e.get("taiex_close") is not None and "taiex_close_legacy" not in e:
                e["taiex_close_legacy"] = e["taiex_close"]
            e.update({"taiex_close": None, "taiex_change": None, "taiex_pct": None,
                      "actual_up": None, "hit": None, f"hit_h{horizon}": None,
                      "directional": False, "non_trading_day": True})
            out.append(e)

    key, ret_key = f"hit_h{horizon}", f"ret_h{horizon}"
    for d in days:
        if d < start:
            continue
        i = idx[d]
        e = dict(old_by_date.get(d) or {})
        for k in ("hit", key, ret_key, f"{key}_date", f"{key}_span_bdays", "prev_gap_bdays",
                  "close_suspect", "non_trading_day"):
            e.pop(k, None)
        close = series[d]
        if e.get("taiex_close") is not None and e["taiex_close"] != close and "taiex_close_legacy" not in e:
            e["taiex_close_legacy"] = e["taiex_close"]
        e.update({"date": d, "taiex_close": close, "taiex_close_date": d, "close_source": "TWSE FMTQIK"})
        base = series[days[i - 1]] if i >= 1 else None
        if base:
            e["taiex_change"] = round(close - base, 2)
            e["taiex_pct"] = (close - base) / base
            e["actual_up"] = close > base
        else:
            e["taiex_change"] = e["taiex_pct"] = e["actual_up"] = None
        p = pred_by_date.get(d)
        if p is None:
            for k in ("pred_date", "xgb_prob_up", "pred_label", "directional"):
                e.pop(k, None)
            e["hit"] = None
            e[key] = None
            out.append(e)
            continue
        prob = float(p["xgb_prob_up"])
        directional = abs(prob - 0.5) > 0.05
        e.update({"pred_date": d, "xgb_prob_up": prob, "pred_label": p.get("xgb_label"),
                  "directional": directional})
        e["hit"] = ((prob > 0.5) == e["actual_up"]) if (directional and e["actual_up"] is not None) else None
        e[key] = None
        t = i - 1 + horizon
        if base and i >= 1 and t < len(days):
            target = series[days[t]]
            e[ret_key] = round((target - base) / base * 100, 2)
            e[f"{key}_date"] = days[t]
            e[f"{key}_span_bdays"] = horizon        # 以真實交易日計,恆等於期距
            if directional:
                e[key] = (prob > 0.5) == (target > base * UP_THRESHOLD)
        out.append(e)
    out.sort(key=lambda e: e.get("date", ""))
    return out


def _load_kline_closes() -> dict[str, dict[str, float]]:
    data = _load_json(KLINE_CACHE, {})
    out: dict[str, dict[str, float]] = {}
    for sid, entry in (data or {}).items():
        bars = entry if isinstance(entry, list) else (entry or {}).get("1d") if isinstance(entry, dict) else None
        if isinstance(bars, list):
            m = {b.get("time"): _f(b.get("close")) for b in bars if isinstance(b, dict)}
            out[str(sid)] = {k: v for k, v in m.items() if k and v}
    return out


def fill_top20_returns(hist: list, days: list[str], today: str,
                       kline: dict[str, dict[str, float]], closes_today: dict[str, float]) -> tuple[int, int]:
    """依真實交易日曆回填 ret_{h}d,回傳 (寫入數, 更正數)。

    舊版用「之後第 N 個快照日」當 N 個交易日,掃描沒跑的日子會讓期距算錯
    (約 2 成的 ret_1d 實際跨 0/2/3 天)。這裡:target = 快照日之後第 h 個交易日;
    收盤優先取 kline_cache,當天則可用掃描 CSV。舊值不同時留在 ret_{h}d_legacy。
    """
    idx = {d: i for i, d in enumerate(days)}
    written = corrected = 0
    for snap in hist:
        i = idx.get(snap.get("date"))
        for st in snap.get("stocks") or []:
            sid = str(st.get("stock_id", ""))
            kc = kline.get(sid, {})
            base = kc.get(snap.get("date")) or st.get("close")
            for h in HORIZONS:
                k = f"ret_{h}d"
                new = None
                if i is not None and base and i + h < len(days) and days[i + h] <= today:
                    tgt = days[i + h]
                    now = kc.get(tgt) or (closes_today.get(sid) if tgt == today else None)
                    # 路徑上任一天漲跌超過漲跌停(±10%)→ 多半是減資/分割或 K 線髒資料,
                    # 這種報酬不代表選股好壞,寧可不算(例:6669 一天 7800→2610)
                    path = [base] + [kc[d] for d in days[i + 1:i + h + 1] if kc.get(d)]
                    if now and path[-1] != now:
                        path.append(now)
                    jump = any(b / a > 1 + DAILY_LIMIT or b / a < 1 - DAILY_LIMIT
                               for a, b in zip(path, path[1:]) if a)
                    if now and not jump:
                        new = round((now - base) / base, 4)
                if new is None:
                    # 算不出來:若舊值存在,它是用錯的期距算的 → 移到 legacy,不留著誤導
                    if k in st:
                        st.setdefault(f"{k}_legacy", st[k])
                        del st[k]
                        corrected += 1
                    continue
                if k in st and st[k] != new:
                    st.setdefault(f"{k}_legacy", st[k])
                    corrected += 1
                if st.get(k) != new:
                    written += 1
                st[k] = new
    return written, corrected


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

    僅在兩筆紀錄相隔剛好一個工作日時才改寫;跨距更大時保留 TWSE 原值並把
    方向/命中設為 None(見迴圈內註解),跨距一律記在 prev_gap_bdays。
    """
    asc = sorted(
        (e for e in records if isinstance(e.get("taiex_close"), (int, float)) and e.get("date")),
        key=lambda e: e["date"],
    )
    fixed = 0
    prev = None
    for e in asc:
        # 「前一筆紀錄」不等於「前一個交易日」:outcome_tracker 若某天沒跑(假日
        # 誤判、workflow 失敗),那天就沒有紀錄,兩筆之間可能隔了好幾個交易日。
        # 拿那種差額當「當日漲跌」會把跨兩三個交易日的累積波動寫成單日波動,而且
        # 會覆蓋掉 TWSE 當天回報的、正負號已修好的真實單日漲跌(見 _sign)。
        # 因此只有相鄰一個工作日時才用收盤差改寫;跨距更大時保留 TWSE 原值,
        # 並把跨距記在 prev_gap_bdays 供稽核。
        gap = _bdays_between(prev["date"], e["date"]) if prev else None
        adjacent = gap == 1
        if prev is None:                # 首筆沒有前一日可比,方向不可知
            up, chg, pct = None, None, None
        elif not adjacent:
            # 跨距不明的「隔日方向」不是隔日方向,寧可不打分也不誤報。
            up, chg, pct = None, None, None
        else:
            prev_close = prev["taiex_close"]
            up = e["taiex_close"] > prev_close
            chg = round(e["taiex_close"] - prev_close, 2)
            pct = ((e["taiex_close"] - prev_close) / prev_close) if prev_close else None
        if gap is not None:
            e["prev_gap_bdays"] = gap
        prob = e.get("xgb_prob_up")
        hit = None
        if up is not None and isinstance(prob, (int, float)) and abs(prob - 0.5) > 0.05:
            hit = (prob > 0.5) == up
        if e.get("hit") != hit or e.get("actual_up") != up:
            fixed += 1
        e["actual_up"], e["hit"] = up, hit
        if chg is not None:
            e["taiex_change"], e["taiex_pct"] = chg, pct
        prev = e
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


def track_top20(today: str, days: list[str] | None = None) -> None:
    hist = _load_json(TOP20_OUT, [])
    top = _top20(today)
    if top:
        hist = [s for s in hist if s.get("date") != today]  # 冪等
        hist.append({"date": today, "stocks": top})
        hist.sort(key=lambda s: s["date"])
        print(f"[top20] {today} 快照 {len(top)} 支")
    else:
        print(f"[top20] {today} 無掃描資料，跳過快照（僅回填）")

    closes_today = _load_closes(today)
    if days:
        # 有真實交易日曆:依交易日回填(並更正舊版用快照日數算錯的值)
        _backup_once(TOP20_OUT)
        written, corrected = fill_top20_returns(hist, days, today, _load_kline_closes(), closes_today)
        print(f"[top20] 依交易日曆回填 {written} 筆 forward return(更正舊值 {corrected} 筆)")
        _save_json(TOP20_OUT, hist)
        return

    # 退路(沒有交易日曆):今天是過去快照日之後的第 N 個「快照交易日」→ 對應 horizon 報酬
    dates = [s["date"] for s in hist]
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
    hist = _load_json(PRED_HISTORY, [])
    if isinstance(hist, dict):
        hist = hist.get("history", [])
    existing = _load_json(PRED_OUT, [])
    earliest = min([h["date"] for h in hist if h.get("date")] +
                   [e["date"] for e in existing if e.get("date")], default=today)
    series = update_taiex_series(today, earliest)
    series = {d: c for d, c in series.items() if d <= today}

    if series:
        _backup_once(PRED_OUT)
        out = rebuild_prediction_outcomes(series, hist, existing)
        _save_json(PRED_OUT, out)
        h_key = f"hit_h{PRED_HORIZON}"
        s1 = [e for e in out if e.get("hit") is not None]
        s5 = [e for e in out if e.get(h_key) is not None]
        last = max(series)
        print(f"[pred] 依真實交易日重建 {len(out)} 筆(最新收盤 {last} {series[last]:.2f})· "
              f"隔日命中 {sum(e['hit'] for e in s1)}/{len(s1)} · "
              f"{PRED_HORIZON}日期距命中 {sum(e[h_key] for e in s5)}/{len(s5)}")
        if last < today:
            print(f"[pred] 注意:FMTQIK 尚未有 {today} 的資料(最新 {last}),下次執行會補上")
        track_top20(today, sorted(series))
        return 0

    # 退路:FMTQIK 抓不到 → MI_INDEX,但只採用回應自帶的日期
    taiex = fetch_taiex()
    if taiex and taiex.get("date"):
        if taiex["date"] != today:
            print(f"[pred] MI_INDEX 資料日期為 {taiex['date']}(不是 {today}),以資料日期寫入")
        score_prediction(taiex["date"], taiex)
    elif taiex:
        print("[pred] MI_INDEX 沒有日期欄,無法確認是哪一天的收盤 → 不寫入(避免日期錯位)")
    else:
        print("[pred] 今日無指數資料（假日或 API 失敗），跳過預測打分")
        recs = _load_json(PRED_OUT, [])
        if recs:
            repair_history(recs)
            score_horizon_hits(recs)       # 到期的預測補上 5 日期距打分
            _save_json(PRED_OUT, recs)
    track_top20(today)
    return 0


if __name__ == "__main__":
    sys.exit(main())
