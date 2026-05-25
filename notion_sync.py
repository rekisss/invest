from __future__ import annotations

import math
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import requests
from requests.adapters import HTTPAdapter

_session = requests.Session()
_session.mount("https://", HTTPAdapter(pool_connections=2, pool_maxsize=10))
_session.mount("http://", HTTPAdapter(pool_connections=2, pool_maxsize=10))

NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"


# ── NaN-safe converters ──────────────────────────────────────────────────────

def _sf(v: Any, default: float = 0.0) -> float:
    if v is None:
        return default
    try:
        f = float(v)
        return default if (math.isnan(f) or math.isinf(f)) else f
    except (ValueError, TypeError):
        return default


def _si(v: Any, default: int = 0) -> int:
    f = _sf(v, float(default))
    return default if (math.isnan(f) or math.isinf(f)) else int(f)


# ── Notion helpers ───────────────────────────────────────────────────────────

def notion_enabled() -> bool:
    return bool(os.getenv("NOTION_TOKEN") and os.getenv("NOTION_DATABASE_ID"))


_notion_headers_cache: dict[str, str] = {}


def _headers() -> dict[str, str]:
    if not _notion_headers_cache:
        token = os.getenv("NOTION_TOKEN", "").strip()
        if token:
            _notion_headers_cache.update({
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Notion-Version": NOTION_VERSION,
            })
    return _notion_headers_cache


def _rt(content: str) -> list[dict]:
    return [{"text": {"content": str(content)[:2000]}}]


# ── Public helpers (used by main.py) ─────────────────────────────────────────

def confidence_score(row: Any) -> int:
    cond   = min(_sf(row.get("condition_count")) / 23 * 55, 55)
    adx_p  = min(_sf(row.get("adx14")) / 40 * 20, 20)
    rs_p   = min(max(_sf(row.get("relative_strength_5d")) * 200, 0), 15)
    vol_p  = min(max((_sf(row.get("volume_ratio")) - 1) / 2 * 10, 0), 10)
    return max(0, min(100, int(cond + adx_p + rs_p + vol_p)))


def recommend_observation_period(row: Any, is_candidate: bool = True) -> str:
    if not is_candidate:
        return "訊號尚未完整，觀察 10–15 個交易日等待條件齊備"
    adx = _sf(row.get("adx14"))
    s20 = _sf(row.get("lr_slope_20"))
    s60 = _sf(row.get("lr_slope_60"))
    both_up = s20 > 0.05 and s60 > 0.03
    if both_up and adx >= 25:
        return "日月線同向強勢，建議 3–5 個交易日內留意回測進場機會"
    elif both_up and adx >= 20:
        return "日月線同向上升，可觀察 5–7 個交易日確認支撐後進場"
    elif s20 > 0.05 and adx >= 20:
        return "短線上升但月線偏弱，謹慎觀察 5–7 個交易日"
    elif s20 > 0 and s60 > 0:
        return "緩步上升趨勢，可觀察 7–10 個交易日等待確認"
    else:
        return "趨勢不明確，觀察 10–15 個交易日等待方向確立"


# ── Notion database helpers ───────────────────────────────────────────────────

def _get_title_property_name(database_id: str) -> str:
    resp = _session.get(f"{NOTION_API}/databases/{database_id}", headers=_headers(), timeout=30)
    if not resp.ok:
        return "股票名稱"
    for name, prop in resp.json().get("properties", {}).items():
        if prop.get("type") == "title":
            return name
    return "股票名稱"


def _setup_database(database_id: str) -> None:
    props = {
        "股票代號": {"rich_text": {}},
        "日期":     {"date": {}},
        "類型":     {"select": {}},
        "信心分數": {"number": {"format": "number"}},
        "分數":     {"number": {"format": "number"}},
        "收盤價":   {"number": {"format": "number"}},
        "RSI":      {"number": {"format": "number"}},
        "ADX":      {"number": {"format": "number"}},
        "KD值":     {"number": {"format": "number"}},
        "條件達成": {"rich_text": {}},
        "產業別":   {"rich_text": {}},
        "外資連買天數":   {"number": {"format": "number"}},
        "投信連買天數":   {"number": {"format": "number"}},
        "自營連買天數":   {"number": {"format": "number"}},
        "MFI":      {"number": {"format": "number"}},
        "BB位置%":  {"number": {"format": "number"}},
        "一目雲上": {"checkbox": {}},
        "5日漲幅%": {"number": {"format": "number"}},
        "相對強度": {"number": {"format": "number"}},
        "成交量比": {"number": {"format": "number"}},
        "參考停損價": {"number": {"format": "number"}},
        "觀察建議": {"rich_text": {}},
        "新聞情緒": {"select": {}},
        "新聞摘要": {"rich_text": {}},
        "狀態":     {"select": {}},
        "優先度":   {"select": {}},
        "市場氛圍": {"select": {}},
        "日線趨勢%": {"number": {"format": "number"}},
        "月線趨勢%": {"number": {"format": "number"}},
    }
    _session.patch(
        f"{NOTION_API}/databases/{database_id}",
        headers=_headers(),
        json={"properties": props},
        timeout=30,
    ).raise_for_status()


def _query_existing_for_date(database_id: str, date: str) -> dict[str, str]:
    """Return {stock_id: page_id} for all existing pages on the given date."""
    url = f"{NOTION_API}/databases/{database_id}/query"
    payload: dict[str, Any] = {
        "filter": {"property": "日期", "date": {"equals": date}},
        "page_size": 100,
    }
    result: dict[str, str] = {}
    try:
        while True:
            resp = _session.post(url, headers=_headers(), json=payload, timeout=30)
            if not resp.ok:
                break
            data = resp.json()
            for page in data.get("results", []):
                page_id = page.get("id", "")
                rich = page.get("properties", {}).get("股票代號", {}).get("rich_text", [])
                if rich:
                    sid = rich[0].get("text", {}).get("content", "")
                    if sid:
                        result[sid] = page_id
            if not data.get("has_more"):
                break
            payload["start_cursor"] = data["next_cursor"]
    except Exception as exc:
        print(f"[Notion] dedup query failed (will create new pages): {exc}")
    return result


def _news_sentiment(summary: dict[str, Any]) -> tuple[str, str]:
    headlines = summary.get("top_headlines") or []
    if not headlines:
        headline = str(summary.get("headline") or "")
        if not headline:
            return "無資料", ""
        has_recent = bool(summary.get("has_recent_news"))
        raw = str(summary.get("recent_sentiment" if has_recent else "sentiment") or "neutral")
        label = {"positive": "正面", "negative": "負面"}.get(raw, "中性")
        return label, headline[:500]
    pos = sum(1 for h in headlines if h.get("sentiment") == "positive")
    neg = sum(1 for h in headlines if h.get("sentiment") == "negative")
    label = "正面" if pos > neg else ("負面" if neg > pos else "中性")
    titles = [str(h.get("title", "")) for h in headlines[:2] if h.get("title")]
    return label, " / ".join(titles)[:500]


# ── Single-row sync (called from thread pool) ─────────────────────────────────

def _sync_row(
    row: Any,
    row_type: str,
    date: str,
    database_id: str,
    title_prop: str,
    existing: dict[str, str],
    news_map: dict[str, Any],
    market_regime: str,
) -> str:
    stock_id  = str(row.get("stock_id", ""))
    name      = str(row.get("name", stock_id))
    score     = _sf(row.get("entry_score"))
    close     = _sf(row.get("close"))
    rsi       = _sf(row.get("rsi14"))
    adx       = _sf(row.get("adx14"))
    stoch_k   = _sf(row.get("stoch_k"))
    cond      = _si(row.get("condition_count"))
    industry  = str(row.get("industry_category") or "")
    if industry.lower() in ("nan", "none", ""):
        industry = ""
    foreign_streak      = _si(row.get("foreign_buy_streak"))
    invest_trust_streak = _si(row.get("invest_trust_streak"))
    dealer_streak       = _si(row.get("dealer_buy_streak"))
    mfi14     = _sf(row.get("mfi14"), 50.0)
    bb_pct_b  = _sf(row.get("bb_pct_b")) * 100
    above_cloud = bool(row.get("above_ichimoku_cloud", False))
    return_5d = _sf(row.get("return_5d"))
    rs5d      = _sf(row.get("relative_strength_5d"))
    vol_ratio = _sf(row.get("volume_ratio"))
    atr       = _sf(row.get("atr14"))
    stop_loss = round(close - 2 * atr, 2) if atr > 0 and close > 0 else (round(close * 0.95, 2) if close > 0 else 0.0)
    lr20      = round(_sf(row.get("lr_slope_20")), 3)
    lr60      = round(_sf(row.get("lr_slope_60")), 3)
    confidence = confidence_score(row)
    obs        = recommend_observation_period(row, is_candidate=(row_type != "觀察名單"))
    news_info  = news_map.get(stock_id, {})
    sentiment_label, news_summary = _news_sentiment(news_info.get("summary", {}))

    is_top20 = row_type == "TOP 20"
    if is_top20:
        狀態 = "TOP 20 進場"
    elif row_type in ("全部掃描", "候選進場"):
        狀態 = "候選進場"
    elif row_type == "觀察名單":
        狀態 = "觀察中"
    else:  # "無訊號" — full-snapshot stocks with no entry signal
        狀態 = "無訊號"

    properties: dict[str, Any] = {
        title_prop:    {"title": _rt(f"{stock_id} {name}")},
        "股票代號":    {"rich_text": _rt(stock_id)},
        "日期":        {"date": {"start": date}},
        "類型":        {"select": {"name": row_type}},
        "信心分數":    {"number": confidence},
        "分數":        {"number": round(score, 1)},
        "收盤價":      {"number": round(close, 2)},
        "RSI":         {"number": round(rsi, 1)},
        "ADX":         {"number": round(adx, 1)},
        "KD值":        {"number": round(stoch_k, 1)},
        "條件達成":    {"rich_text": _rt(f"{cond}/23")},
        "產業別":      {"rich_text": _rt(industry)},
        "外資連買天數": {"number": foreign_streak},
        "投信連買天數": {"number": invest_trust_streak},
        "自營連買天數": {"number": dealer_streak},
        "MFI":         {"number": round(mfi14, 1)},
        "BB位置%":     {"number": round(bb_pct_b, 1)},
        "一目雲上":    {"checkbox": above_cloud},
        "5日漲幅%":    {"number": round(return_5d * 100, 2)},
        "相對強度":    {"number": round(rs5d * 100, 2)},
        "成交量比":    {"number": round(vol_ratio, 2)},
        "參考停損價":  {"number": stop_loss},
        "日線趨勢%":   {"number": lr20},
        "月線趨勢%":   {"number": lr60},
        "觀察建議":    {"rich_text": _rt(obs)},
        "新聞情緒":    {"select": {"name": sentiment_label}},
        "新聞摘要":    {"rich_text": _rt(news_summary)},
        "狀態":        {"select": {"name": 狀態}},
        "優先度":      {"select": {"name": "高" if confidence >= 80 else ("中" if confidence >= 50 else "低")}},
        **({"市場氛圍": {"select": {"name": market_regime}}} if market_regime else {}),
    }

    page_id = existing.get(stock_id)
    for attempt in range(4):
        try:
            if page_id:
                resp = _session.patch(
                    f"{NOTION_API}/pages/{page_id}",
                    headers=_headers(),
                    json={"properties": properties},
                    timeout=30,
                )
            else:
                resp = _session.post(
                    f"{NOTION_API}/pages",
                    headers=_headers(),
                    json={"parent": {"database_id": database_id}, "properties": properties},
                    timeout=30,
                )
            if resp.status_code == 429:
                retry_after = float(resp.json().get("retry_after", 2))
                time.sleep(retry_after)
                continue
            resp.raise_for_status()
            return f"ok:{stock_id}"
        except Exception as exc:
            if attempt == 3:
                return f"fail:{stock_id}:{exc}"
            time.sleep(2 ** attempt)
    return f"fail:{stock_id}:max_retries"


# ── Date summary page ─────────────────────────────────────────────────────────

def _upsert_date_summary(
    database_id: str,
    date: str,
    title_prop: str,
    top_rows: list[dict],
    total_scanned: int,
    entry_count: int,
) -> None:
    """Create or update a date-summary page in the Notion database."""
    existing_id: str | None = None
    try:
        resp = _session.post(
            f"{NOTION_API}/databases/{database_id}/query",
            headers=_headers(),
            json={
                "filter": {
                    "and": [
                        {"property": "日期",  "date":   {"equals": date}},
                        {"property": "類型",  "select": {"equals": "每日摘要"}},
                    ]
                },
                "page_size": 1,
            },
            timeout=30,
        )
        if resp.ok:
            results = resp.json().get("results", [])
            if results:
                existing_id = results[0]["id"]
    except Exception:
        pass

    top_lines = "\n".join(
        f"{i+1:2d}. {r.get('stock_id', '')} {r.get('name', ''):<10s}"
        f"  分數 {_sf(r.get('entry_score')):5.1f}"
        f"  RSI {_sf(r.get('rsi14')):5.1f}"
        f"  ADX {_sf(r.get('adx14')):5.1f}"
        f"  {str(r.get('industry_category', ''))}"
        for i, r in enumerate(top_rows)
    )
    summary_line = f"掃描 {total_scanned} 支 · 進場 {entry_count} 支 · TOP {len(top_rows)}"

    properties = {
        title_prop: {"title": [{"text": {"content": f"📅 {date} 掃描摘要"}}]},
        "日期":     {"date": {"start": date}},
        "類型":     {"select": {"name": "每日摘要"}},
        "條件達成": {"rich_text": _rt(summary_line)},
    }
    children = [
        {
            "object": "block", "type": "heading_2",
            "heading_2": {"rich_text": [{"text": {"content": f"🏆 TOP {len(top_rows)} 進場候選"}}]},
        },
        {
            "object": "block", "type": "code",
            "code": {
                "rich_text": [{"text": {"content": top_lines[:1900]}}],
                "language": "plain text",
            },
        },
        {"object": "block", "type": "divider", "divider": {}},
        {
            "object": "block", "type": "paragraph",
            "paragraph": {"rich_text": [{"text": {"content": summary_line}}]},
        },
    ]

    if existing_id:
        _session.patch(
            f"{NOTION_API}/pages/{existing_id}",
            headers=_headers(), json={"properties": properties}, timeout=30,
        )
        try:
            old = _session.get(
                f"{NOTION_API}/blocks/{existing_id}/children",
                headers=_headers(), timeout=30,
            ).json().get("results", [])
            for blk in old:
                _session.delete(f"{NOTION_API}/blocks/{blk['id']}",
                                headers=_headers(), timeout=15)
        except Exception:
            pass
        _session.patch(
            f"{NOTION_API}/blocks/{existing_id}/children",
            headers=_headers(), json={"children": children}, timeout=30,
        )
    else:
        _session.post(
            f"{NOTION_API}/pages",
            headers=_headers(),
            json={
                "parent": {"database_id": database_id},
                "properties": properties,
                "children": children,
            },
            timeout=30,
        ).raise_for_status()


# ── Main sync entry point ─────────────────────────────────────────────────────

def sync_scan_results(
    candidates: Any,
    watchlist: Any,
    date: str,
    news_map: dict[str, Any] | None = None,
    market_regime: str = "",
    top_stock_ids: set[str] | None = None,
) -> tuple[int, int]:
    """Upsert scan results into Notion (TOP 20 + 候選進場 only; skip 無訊號).

    Creates/updates a date-summary page in addition to individual stock pages.
    Returns (ok_count, fail_count).
    """
    database_id = os.getenv("NOTION_DATABASE_ID", "").strip()
    if not database_id:
        return 0, 0
    news_map = news_map or {}
    top_ids  = top_stock_ids or set()

    title_prop = _get_title_property_name(database_id)
    try:
        _setup_database(database_id)
    except Exception as exc:
        print(f"[Notion] schema setup warning: {exc}")

    existing = _query_existing_for_date(database_id, date)

    # Upload all stocks: TOP 20 / 候選進場 / 無訊號
    rows: list[tuple[Any, str]] = []
    entry_count = 0
    for _, row in candidates.iterrows():
        sid = str(row.get("stock_id", ""))
        if sid in top_ids:
            rows.append((row, "TOP 20"))
            entry_count += 1
        elif row.get("entry_signal", False):
            rows.append((row, "候選進場"))
            entry_count += 1
        else:
            rows.append((row, "無訊號"))
    for _, row in watchlist.iterrows():
        rows.append((row, "觀察名單"))

    total_candidates = len(candidates)
    print(f"[Notion] {date} 上傳 {len(rows)} 筆（TOP 20: {len(top_ids)}，候選: {entry_count - len(top_ids)}，無訊號: {total_candidates - entry_count}）")

    ok_count = fail_count = 0

    def _task(item: tuple[Any, str]) -> str:
        row, row_type = item
        return _sync_row(row, row_type, date, database_id, title_prop, existing, news_map, market_regime)

    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(_task, item): item for item in rows}
        for future in as_completed(futures):
            result = future.result()
            if result.startswith("ok:"):
                ok_count += 1
            else:
                fail_count += 1
                print(f"[Notion] {result}")

    print(f"[Notion] 完成：成功 {ok_count} 筆，失敗 {fail_count} 筆")

    # Build/update date-summary page
    top_list = [r.to_dict() for _, r in candidates.iterrows()
                if str(r.get("stock_id", "")) in top_ids]
    try:
        _upsert_date_summary(database_id, date, title_prop, top_list,
                             total_candidates, entry_count)
        print(f"[Notion] 日期摘要頁已更新：{date}")
    except Exception as exc:
        print(f"[Notion] 日期摘要頁更新失敗（graceful skip）: {exc}")

    return ok_count, fail_count
