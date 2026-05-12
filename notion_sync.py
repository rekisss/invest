from __future__ import annotations

import os
from typing import Any

import requests

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


def _setup_database(database_id: str) -> None:
    props = {
        "股票代號": {"rich_text": {}},
        "日期": {"date": {}},
        "類型": {"select": {}},
        "分數": {"number": {"format": "number"}},
        "收盤價": {"number": {"format": "number"}},
        "RSI": {"number": {"format": "number"}},
        "ADX": {"number": {"format": "number"}},
        "條件達成": {"rich_text": {}},
        "觀察建議": {"rich_text": {}},
        "新聞情緒": {"select": {}},
        "新聞摘要": {"rich_text": {}},
        "狀態": {"select": {}},
    }
    requests.patch(
        f"{NOTION_API}/databases/{database_id}",
        headers=_headers(),
        json={"properties": props},
        timeout=30,
    ).raise_for_status()


def _news_sentiment(news_info: dict[str, Any]) -> tuple[str, str]:
    headlines = news_info.get("top_headlines") or []
    if not headlines:
        return "無資料", ""
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
) -> None:
    database_id = os.getenv("NOTION_DATABASE_ID", "").strip()
    if not database_id:
        return
    news_map = news_map or {}

    try:
        _setup_database(database_id)
    except Exception as exc:
        print(f"[Notion] schema setup warning: {exc}")

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
        condition_count = int(row.get("condition_count", 0) or 0)
        industry = str(row.get("industry_category", "") or "")
        foreign_streak = int(row.get("foreign_buy_streak", 0) or 0)
        return_5d = float(row.get("return_5d", 0) or 0)
        rs5d = float(row.get("relative_strength_5d", 0) or 0)
        vol_ratio = float(row.get("volume_ratio", 0) or 0)
        stop_loss = round(close * 0.95, 2) if close > 0 else 0.0
        obs = recommend_observation_period(row, is_candidate=(row_type == "候選"))
        sentiment_label, news_summary = _news_sentiment(news_map.get(stock_id, {}))

        properties = {
            "股票名稱": {"title": _rt(f"{stock_id} {name}")},
            "股票代號": {"rich_text": _rt(stock_id)},
            "日期": {"date": {"start": date}},
            "類型": {"select": {"name": row_type}},
            "分數": {"number": round(score, 1)},
            "收盤價": {"number": round(close, 2)},
            "RSI": {"number": round(rsi, 1)},
            "ADX": {"number": round(adx, 1)},
            "條件達成": {"rich_text": _rt(f"{condition_count}/13")},
            "產業別": {"rich_text": _rt(industry)},
            "外資連買天數": {"number": foreign_streak},
            "5日漲幅%": {"number": round(return_5d * 100, 2)},
            "相對強度": {"number": round(rs5d * 100, 2)},
            "成交量比": {"number": round(vol_ratio, 2)},
            "參考停損價": {"number": stop_loss},
            "觀察建議": {"rich_text": _rt(obs)},
            "新聞情緒": {"select": {"name": sentiment_label}},
            "新聞摘要": {"rich_text": _rt(news_summary)},
            "狀態": {"select": {"name": "新增"}},
        }

        try:
            requests.post(
                f"{NOTION_API}/pages",
                headers=_headers(),
                json={"parent": {"database_id": database_id}, "properties": properties},
                timeout=30,
            ).raise_for_status()
            print(f"[Notion] synced {stock_id} {name}")
        except Exception as exc:
            print(f"[Notion] failed {stock_id}: {exc}")
