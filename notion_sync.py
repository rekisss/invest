from __future__ import annotations

import os
import time
from typing import Any

import requests


def _confidence_score(row: Any) -> int:
    cond = min(int(float(row.get("condition_count", 0) or 0)) / 23 * 55, 55)
    adx_pts = min(float(row.get("adx14", 0) or 0) / 40 * 20, 20)
    rs_pts = min(max(float(row.get("relative_strength_5d", 0) or 0) * 200, 0), 15)
    vol_pts = min(max((float(row.get("volume_ratio", 0) or 0) - 1) / 2 * 10, 0), 10)
    return max(0, min(100, int(cond + adx_pts + rs_pts + vol_pts)))

NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"


def notion_enabled() -> bool:
    return bool(os.getenv("NOTION_TOKEN") and os.getenv("NOTION_DATABASE_ID"))


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {os.getenv('NOTION_TOKEN', '').strip()}",
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
    }


def _rt(content: str) -> list[dict]:
    return [{"text": {"content": str(content)[:2000]}}]


def _query_existing_for_date(database_id: str, date: str) -> dict[str, str]:
    """Return {stock_id: page_id} for existing pages matching the given date."""
    url = f"{NOTION_API}/databases/{database_id}/query"
    payload: dict[str, Any] = {
        "filter": {"property": "日期", "date": {"equals": date}},
        "page_size": 100,
    }
    result: dict[str, str] = {}
    try:
        while True:
            resp = requests.post(url, headers=_headers(), json=payload, timeout=30)
            if not resp.ok:
                return result
            data = resp.json()
            for page in data.get("results", []):
                page_id = page.get("id", "")
                props = page.get("properties", {})
                rich = props.get("股票代號", {}).get("rich_text", [])
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


def _get_title_property_name(database_id: str) -> str:
    resp = requests.get(f"{NOTION_API}/databases/{database_id}", headers=_headers(), timeout=30)
    if not resp.ok:
        return "股票名稱"
    for name, prop in resp.json().get("properties", {}).items():
        if prop.get("type") == "title":
            return name
    return "股票名稱"


def _setup_database(database_id: str) -> None:
    props = {
        "股票代號": {"rich_text": {}},
        "日期": {"date": {}},
        "類型": {"select": {}},
        "信心分數": {"number": {"format": "number"}},
        "分數": {"number": {"format": "number"}},
        "收盤價": {"number": {"format": "number"}},
        "RSI": {"number": {"format": "number"}},
        "ADX": {"number": {"format": "number"}},
        "KD值": {"number": {"format": "number"}},
        "條件達成": {"rich_text": {}},
        "產業別": {"rich_text": {}},
        "外資連買天數": {"number": {"format": "number"}},
        "投信連買天數": {"number": {"format": "number"}},
        "自營連買天數": {"number": {"format": "number"}},
        "MFI": {"number": {"format": "number"}},
        "BB位置%": {"number": {"format": "number"}},
        "一目雲上": {"checkbox": {}},
        "5日漲幅%": {"number": {"format": "number"}},
        "相對強度": {"number": {"format": "number"}},
        "成交量比": {"number": {"format": "number"}},
        "參考停損價": {"number": {"format": "number"}},
        "觀察建議": {"rich_text": {}},
        "新聞情緒": {"select": {}},
        "新聞摘要": {"rich_text": {}},
        "狀態": {"select": {}},
        "優先度": {"select": {}},
        "市場氛圍": {"select": {}},
    }
    requests.patch(
        f"{NOTION_API}/databases/{database_id}",
        headers=_headers(),
        json={"properties": props},
        timeout=30,
    ).raise_for_status()


def _news_sentiment(summary: dict[str, Any]) -> tuple[str, str]:
    headlines = summary.get("top_headlines") or []
    if not headlines:
        headline = str(summary.get("headline") or "")
        if not headline:
            return "無資料", ""
        # Prefer recent_sentiment when fresh news exists
        has_recent = bool(summary.get("has_recent_news"))
        raw = str(summary.get("recent_sentiment" if has_recent else "sentiment") or "neutral")
        label = {"positive": "正面", "negative": "負面"}.get(raw, "中性")
        return label, headline[:500]
    pos = sum(1 for h in headlines if h.get("sentiment") == "positive")
    neg = sum(1 for h in headlines if h.get("sentiment") == "negative")
    label = "正面" if pos > neg else ("負面" if neg > pos else "中性")
    titles = [str(h.get("title", "")) for h in headlines[:2] if h.get("title")]
    return label, " / ".join(titles)[:500]


def recommend_observation_period(row: Any, is_candidate: bool = True) -> str:
    if not is_candidate:
        return "訊號尚未完整，觀察 10–15 個交易日等待條件齊備"
    score = float(row.get("entry_score", 0) or 0)
    adx = float(row.get("adx14", 0) or 0)
    if score >= 900 and adx >= 25:
        return "強勢訊號，3–5 個交易日內留意回測進場機會"
    elif score >= 800:
        return "訊號良好，5–7 個交易日確認支撐後進場"
    else:
        return "訊號普通，7–10 個交易日等待更明確方向"


def sync_scan_results(
    candidates: Any,
    watchlist: Any,
    date: str,
    news_map: dict[str, Any] | None = None,
    market_regime: str = "",
) -> None:
    database_id = os.getenv("NOTION_DATABASE_ID", "").strip()
    if not database_id:
        return
    news_map = news_map or {}

    title_prop = _get_title_property_name(database_id)
    try:
        _setup_database(database_id)
    except Exception as exc:
        print(f"[Notion] schema setup warning: {exc}")

    existing = _query_existing_for_date(database_id, date)

    rows: list[tuple[Any, str]] = []
    for _, row in candidates.iterrows():
        rows.append((row, "候選"))
    for _, row in watchlist.head(10).iterrows():
        rows.append((row, "觀察名單"))

    for row, row_type in rows:
        stock_id = str(row.get("stock_id", ""))
        name = str(row.get("name", stock_id))
        score = float(row.get("entry_score", 0) or 0)
        close = float(row.get("close", 0) or 0)
        rsi = float(row.get("rsi14", 0) or 0)
        adx = float(row.get("adx14", 0) or 0)
        stoch_k = float(row.get("stoch_k", 0) or 0)
        condition_count = int(row.get("condition_count", 0) or 0)
        industry = str(row.get("industry_category", "") or "")
        foreign_streak = int(row.get("foreign_buy_streak", 0) or 0)
        invest_trust_streak = int(row.get("invest_trust_streak", 0) or 0)
        dealer_streak = int(row.get("dealer_buy_streak", 0) or 0)
        mfi14 = round(float(row.get("mfi14", 50) or 50), 1)
        bb_pct_b = round(float(row.get("bb_pct_b", 0) or 0) * 100, 1)
        above_cloud = bool(row.get("above_ichimoku_cloud", False))
        return_5d = float(row.get("return_5d", 0) or 0)
        rs5d = float(row.get("relative_strength_5d", 0) or 0)
        vol_ratio = float(row.get("volume_ratio", 0) or 0)
        stop_loss = round(close * 0.95, 2) if close > 0 else 0.0
        confidence = _confidence_score(row)
        obs = recommend_observation_period(row, is_candidate=(row_type == "候選"))
        news_info = news_map.get(stock_id, {})
        sentiment_label, news_summary = _news_sentiment(news_info.get("summary", {}))

        properties = {
            title_prop: {"title": _rt(f"{stock_id} {name}")},
            "股票代號": {"rich_text": _rt(stock_id)},
            "日期": {"date": {"start": date}},
            "類型": {"select": {"name": row_type}},
            "信心分數": {"number": confidence},
            "分數": {"number": round(score, 1)},
            "收盤價": {"number": round(close, 2)},
            "RSI": {"number": round(rsi, 1)},
            "ADX": {"number": round(adx, 1)},
            "KD值": {"number": round(stoch_k, 1)},
            "條件達成": {"rich_text": _rt(f"{condition_count}/23")},
            "產業別": {"rich_text": _rt(industry)},
            "外資連買天數": {"number": foreign_streak},
            "投信連買天數": {"number": invest_trust_streak},
            "自營連買天數": {"number": dealer_streak},
            "MFI": {"number": mfi14},
            "BB位置%": {"number": bb_pct_b},
            "一目雲上": {"checkbox": above_cloud},
            "5日漲幅%": {"number": round(return_5d * 100, 2)},
            "相對強度": {"number": round(rs5d * 100, 2)},
            "成交量比": {"number": round(vol_ratio, 2)},
            "參考停損價": {"number": stop_loss},
            "觀察建議": {"rich_text": _rt(obs)},
            "新聞情緒": {"select": {"name": sentiment_label}},
            "新聞摘要": {"rich_text": _rt(news_summary)},
            "狀態": {"select": {"name": "候選進場" if row_type == "候選" else "觀察中"}},
            "優先度": {"select": {"name": "高" if confidence >= 80 else ("中" if confidence >= 50 else "低")}},
            **({"市場氛圍": {"select": {"name": market_regime}}} if market_regime else {}),
        }

        page_id = existing.get(stock_id)
        for attempt in range(3):
            try:
                if page_id:
                    resp = requests.patch(
                        f"{NOTION_API}/pages/{page_id}",
                        headers=_headers(),
                        json={"properties": properties},
                        timeout=30,
                    )
                else:
                    resp = requests.post(
                        f"{NOTION_API}/pages",
                        headers=_headers(),
                        json={"parent": {"database_id": database_id}, "properties": properties},
                        timeout=30,
                    )
                if resp.status_code == 429:
                    retry_after = float(resp.json().get("retry_after", 1))
                    time.sleep(retry_after)
                    continue
                resp.raise_for_status()
                print(f"[Notion] synced {stock_id} {name}")
                break
            except Exception as exc:
                if attempt == 2:
                    print(f"[Notion] failed {stock_id}: {exc}")
                else:
                    time.sleep(2 ** attempt)
