from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Iterable
from urllib.parse import quote
import xml.etree.ElementTree as ET

import re

import pandas as pd
import requests


def _clean_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text).strip()


POSITIVE_KEYWORDS = [
    "漲",
    "上修",
    "成長",
    "新高",
    "利多",
    "擴產",
    "合作",
    "突破",
    "訂單",
    "買超",
    "獲利",
]

NEGATIVE_KEYWORDS = [
    "跌",
    "下修",
    "衰退",
    "虧損",
    "調降",
    "利空",
    "賣超",
    "裁員",
    "訴訟",
    "違約",
    "風險",
]


@dataclass
class NewsClient:
    cache_dir: Path
    timeout: int = 20

    def __post_init__(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _cache_path(self, stock_id: str, name: str, days: int, limit: int) -> Path:
        safe_name = "".join(char for char in name if char.isalnum()) or stock_id
        return self.cache_dir / f"news_{stock_id}_{safe_name}_{days}_{limit}.csv"

    def fetch_stock_news(
        self,
        stock_id: str,
        name: str,
        days: int = 7,
        limit: int = 5,
        use_cache: bool = True,
    ) -> pd.DataFrame:
        cache_path = self._cache_path(stock_id, name, days, limit)
        if use_cache and cache_path.exists():
            try:
                frame = pd.read_csv(cache_path)
                if not frame.empty:
                    return frame.head(limit)
            except Exception:
                cache_path.unlink(missing_ok=True)

        query = quote(f"{stock_id} {name} 台股 when:{days}d")
        url = f"https://news.google.com/rss/search?q={query}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
        response = requests.get(url, timeout=self.timeout)
        response.raise_for_status()
        root = ET.fromstring(response.content)

        rows: list[dict[str, object]] = []
        for item in root.findall(".//item"):
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            source = (item.findtext("source") or "").strip()
            pub_date_text = (item.findtext("pubDate") or "").strip()
            published_at = _parse_pub_date(pub_date_text)
            raw_desc = (item.findtext("description") or "").strip()
            snippet = _clean_html(raw_desc)[:120] + ("…" if len(_clean_html(raw_desc)) > 120 else "")
            rows.append(
                {
                    "stock_id": stock_id,
                    "name": name,
                    "title": title,
                    "snippet": snippet,
                    "source": source or "Google News",
                    "link": link,
                    "published_at": published_at.isoformat() if published_at else None,
                    "sentiment": _classify_sentiment(title),
                }
            )
            if len(rows) >= limit:
                break

        frame = pd.DataFrame(rows)
        if use_cache and not frame.empty:
            frame.to_csv(cache_path, index=False, encoding="utf-8-sig")
        return frame


def _parse_pub_date(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return parsedate_to_datetime(value)
    except Exception:
        return None


def _classify_sentiment(title: str) -> str:
    positive_hits = sum(keyword in title for keyword in POSITIVE_KEYWORDS)
    negative_hits = sum(keyword in title for keyword in NEGATIVE_KEYWORDS)
    if positive_hits > negative_hits:
        return "positive"
    if negative_hits > positive_hits:
        return "negative"
    return "neutral"


def summarize_news(news_items: Iterable[dict[str, object]]) -> dict[str, object]:
    items = list(news_items)
    counts = {"positive": 0, "neutral": 0, "negative": 0}
    for item in items:
        sentiment = str(item.get("sentiment") or "neutral")
        if sentiment not in counts:
            sentiment = "neutral"
        counts[sentiment] += 1
    summary = "neutral"
    if counts["positive"] > counts["negative"]:
        summary = "positive"
    elif counts["negative"] > counts["positive"]:
        summary = "negative"
    top_headlines = [
        {
            "title": str(item.get("title") or ""),
            "snippet": str(item.get("snippet") or ""),
            "sentiment": str(item.get("sentiment") or "neutral"),
            "source": str(item.get("source") or ""),
            "published_at": str(item.get("published_at") or ""),
            "link": str(item.get("link") or ""),
        }
        for item in items[:3]
        if item.get("title")
    ]
    return {
        "sentiment": summary,
        "counts": counts,
        "has_recent_news": any(_is_recent(item.get("published_at")) for item in items),
        "headline": str(items[0].get("title") or "") if items else "",
        "top_headlines": top_headlines,
    }


def _is_recent(value: object) -> bool:
    if not value:
        return False
    try:
        published_at = datetime.fromisoformat(str(value))
    except ValueError:
        return False
    now = datetime.now(published_at.tzinfo) if published_at.tzinfo else datetime.now()
    return published_at >= now - timedelta(days=3)
