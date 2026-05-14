from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
import time
from typing import Iterable
from urllib.parse import quote
import xml.etree.ElementTree as ET

import re

import pandas as pd
import requests
from requests.adapters import HTTPAdapter


_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _clean_html(text: str) -> str:
    return _HTML_TAG_RE.sub("", text).strip()


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
    "營收創高",
    "獲利大增",
    "上調目標價",
    "強勁需求",
    "毛利率提升",
    "拿下大單",
    "法說會正面",
    "轉盈",
    "超預期",
    "大客戶",
    "庫藏股",
    "回購",
    "股利",
    "營收成長",
    "毛利提升",
    "市佔提升",
    "供貨穩定",
    "能見度高",
    "產能滿載",
    "新產品",
    "量產",
    "客戶認證",
    "入選",
    "獲選",
    "拿到",
    "旺季",
    "滿載",
    "買進",
    "增持",
    "升評",
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
    "警示",
    "停牌",
    "掏空",
    "弊案",
    "庫存壓力",
    "砍單",
    "目標價下調",
    "下滑",
    "縮水",
    "下修財測",
    "罰款",
    "查帳",
    "債務",
    "延遲出貨",
    "毛利下滑",
    "需求疲軟",
    "價格競爭",
    "跌停",
    "連跌",
    "減持",
    "調降評等",
    "降評",
    "虧損擴大",
    "停工",
    "火災",
    "產能閒置",
    "客戶流失",
    "被取代",
]


@dataclass
class NewsClient:
    cache_dir: Path
    timeout: int = 20
    cache_ttl_hours: float = 4.0

    def __post_init__(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._session: requests.Session = requests.Session()
        _adapter = HTTPAdapter(pool_connections=2, pool_maxsize=8)
        self._session.mount("https://", _adapter)
        self._session.mount("http://", _adapter)

    def _cache_path(self, stock_id: str, name: str, days: int, limit: int) -> Path:
        return self.cache_dir / f"news_{stock_id}_{days}_{limit}.csv"

    def fetch_stock_news(
        self,
        stock_id: str,
        name: str,
        days: int = 7,
        limit: int = 5,
        use_cache: bool = True,
    ) -> pd.DataFrame:
        cache_path = self._cache_path(stock_id, name, days, limit)
        cache_ttl_secs = self.cache_ttl_hours * 3600
        if use_cache:
            try:
                age_secs = time.time() - cache_path.stat().st_mtime
                if age_secs < cache_ttl_secs:
                    try:
                        frame = pd.read_csv(cache_path)
                        if not frame.empty:
                            return frame.head(limit)
                    except Exception:
                        cache_path.unlink(missing_ok=True)
            except FileNotFoundError:
                pass

        query = quote(f"{stock_id} {name} 台股 when:{days}d")
        url = f"https://news.google.com/rss/search?q={query}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
        response = self._session.get(url, timeout=self.timeout)
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
            clean_desc = _clean_html(raw_desc)
            snippet = clean_desc[:120] + ("…" if len(clean_desc) > 120 else "")
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


_NEGATION_CHARS = frozenset("不未沒無非")

# Precompiled patterns — longest keywords first to avoid partial overlaps
_POS_RE = re.compile("|".join(re.escape(kw) for kw in sorted(POSITIVE_KEYWORDS, key=len, reverse=True)))
_NEG_RE = re.compile("|".join(re.escape(kw) for kw in sorted(NEGATIVE_KEYWORDS, key=len, reverse=True)))


def _count_hits(pattern: re.Pattern, text: str) -> int:
    count = 0
    for m in pattern.finditer(text):
        preceding = text[max(0, m.start() - 2):m.start()]
        if not any(c in _NEGATION_CHARS for c in preceding):
            count += 1
    return count


def _classify_sentiment(title: str) -> str:
    pos = _count_hits(_POS_RE, title)
    neg = _count_hits(_NEG_RE, title)
    if pos > neg:
        return "positive"
    if neg > pos:
        return "negative"
    return "neutral"


def summarize_news(news_items: Iterable[dict[str, object]]) -> dict[str, object]:
    items = list(news_items)
    counts: dict[str, int] = {"positive": 0, "neutral": 0, "negative": 0}
    top_headlines: list[dict[str, object]] = []
    recent_items: list[dict[str, object]] = []

    for item in items:
        sentiment = str(item.get("sentiment") or "neutral")
        if sentiment not in counts:
            sentiment = "neutral"
        counts[sentiment] += 1
        if len(top_headlines) < 3 and item.get("title"):
            top_headlines.append({
                "title": str(item.get("title") or ""),
                "snippet": str(item.get("snippet") or ""),
                "sentiment": str(item.get("sentiment") or "neutral"),
                "source": str(item.get("source") or ""),
                "published_at": str(item.get("published_at") or ""),
                "link": str(item.get("link") or ""),
            })
        if _is_recent(item.get("published_at")):
            recent_items.append(item)

    summary = "neutral"
    if counts["positive"] > counts["negative"]:
        summary = "positive"
    elif counts["negative"] > counts["positive"]:
        summary = "negative"

    recent_sentiment = "neutral"
    if recent_items:
        r_pos = sum(1 for h in recent_items if h.get("sentiment") == "positive")
        r_neg = sum(1 for h in recent_items if h.get("sentiment") == "negative")
        recent_sentiment = "positive" if r_pos > r_neg else ("negative" if r_neg > r_pos else "neutral")

    return {
        "sentiment": summary,
        "recent_sentiment": recent_sentiment,
        "counts": counts,
        "has_recent_news": bool(recent_items),
        "headline": str(items[0].get("title") or "") if items else "",
        "top_headlines": top_headlines,
    }


def _is_recent(value: object) -> bool:
    if not value:
        return False
    published_at = None
    s = str(value)
    for parser in (datetime.fromisoformat, parsedate_to_datetime):
        try:
            published_at = parser(s)
            break
        except Exception:
            continue
    if published_at is None:
        return False
    now = datetime.now(published_at.tzinfo) if published_at.tzinfo else datetime.now()
    return published_at >= now - timedelta(days=5)
