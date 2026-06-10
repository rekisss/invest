from __future__ import annotations

import sys
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


_EVENT_KEYWORDS: dict[str, list[str]] = {
    "Fed/聯準會": ["Fed", "FOMC", "聯準會", "升息", "降息", "利率", "鮑爾", "貨幣政策"],
    "台積電":     ["台積電", "TSMC", "法說", "CoWoS", "先進封裝", "3nm", "2nm", "N3", "N2"],
    "AI供應鏈":   ["AI", "人工智慧", "輝達", "NVIDIA", "CoWoS", "HBM", "算力", "GB200"],
    "地緣政治":   ["貿易戰", "關稅", "制裁", "台海", "兩岸", "軍演", "出口管制"],
    "半導體":     ["費半", "SOX", "晶片", "半導體", "記憶體", "DRAM", "HBM", "晶圓"],
    "美股":       ["道瓊", "S&P", "那斯達克", "美股", "標普", "史坦普"],
}


def _classify_event(title: str) -> str:
    """Classify a news title into a market event category."""
    for event_type, keywords in _EVENT_KEYWORDS.items():
        if any(kw in title for kw in keywords):
            return event_type
    return ""


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
                    "event_type": _classify_event(title),
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
        if len(top_headlines) < 5 and item.get("title"):
            top_headlines.append({
                "title": str(item.get("title") or ""),
                "snippet": str(item.get("snippet") or ""),
                "sentiment": str(item.get("sentiment") or "neutral"),
                "event_type": str(item.get("event_type") or _classify_event(str(item.get("title") or ""))),
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


def fetch_finmind_market_news(
    finmind_client: object,
    top_stocks: list[str] | None = None,
    days: int = 2,
) -> list[dict[str, object]]:
    """Fetch market news from FinMind TaiwanStockNews for key stocks (best-effort)."""
    if top_stocks is None:
        top_stocks = ["2330", "2317", "2454", "3008", "2382"]
    # TaiwanStockNews API rejects end_date (returns one day of data per call) —
    # pass only start_date
    start = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    rows: list[dict[str, object]] = []
    for stock_id in top_stocks:
        try:
            df = finmind_client.fetch_dataset(  # type: ignore[union-attr]
                "TaiwanStockNews",
                data_id=stock_id,
                start_date=start,
                use_cache=True,
                cache_ttl_days=0.25,
            )
            if df.empty:
                continue
            title_col = next((c for c in ("title", "description", "content") if c in df.columns), None)
            date_col = next((c for c in ("date", "published_at", "created_at") if c in df.columns), None)
            for _, r in df.iterrows():
                title = str(r[title_col]) if title_col else ""
                if not title:
                    continue
                rows.append({
                    "title": title[:80],
                    "snippet": title,
                    "source": "FinMind",
                    "published_at": str(r[date_col]) if date_col else "",
                    "sentiment": _classify_sentiment(title),
                    "event_type": _classify_event(title),
                })
        except Exception as exc:
            print(f"[news] FinMind news {stock_id} 失敗（skip）: {exc}", file=sys.stderr)
    return rows


def fetch_market_news_sentiment(
    news_client: "NewsClient",
    days: int = 2,
    limit: int = 20,
    finmind_client: object = None,
) -> dict[str, object]:
    """Fetch aggregate news sentiment combining Google RSS and FinMind news."""
    all_items: list[dict[str, object]] = []

    # Source 1: Google News RSS
    try:
        news = news_client.fetch_stock_news(
            stock_id="TAIEX",
            name="台股大盤",
            days=days,
            limit=limit,
        )
        if not news.empty:
            all_items.extend(news.to_dict("records"))
    except Exception as exc:
        print(f"[news] Google RSS 取得失敗（graceful skip）: {exc}", file=sys.stderr)

    # Source 2: FinMind TaiwanStockNews (optional)
    if finmind_client is not None:
        try:
            fm_items = fetch_finmind_market_news(finmind_client, days=days)
            all_items.extend(fm_items)
        except Exception as exc:
            print(f"[news] FinMind 新聞合併失敗（graceful skip）: {exc}", file=sys.stderr)

    if not all_items:
        return {}

    # Deduplicate by title prefix (first 20 chars)
    seen: set[str] = set()
    deduped: list[dict[str, object]] = []
    for item in all_items:
        key = str(item.get("title") or "")[:20]
        if key and key not in seen:
            seen.add(key)
            deduped.append(item)

    return summarize_news(deduped)


def format_market_news_block(sentiment: dict[str, object]) -> str:
    """Format market-level news sentiment as a Discord block. Returns '' if empty."""
    if not sentiment:
        return ""
    counts = sentiment.get("counts") or {}
    pos   = int(counts.get("positive", 0))
    neg   = int(counts.get("negative", 0))
    total = pos + neg + int(counts.get("neutral", 0))
    if total == 0:
        return ""
    overall = str(sentiment.get("sentiment", "neutral"))
    label = {"positive": "偏多", "negative": "偏空"}.get(overall, "中性")
    emoji = {"positive": "📈", "negative": "📉"}.get(overall, "→")

    _SENT_EMOJI = {"positive": "🟢", "negative": "🔴", "neutral": "⚪"}
    lines = ["📰 **市場新聞**（近48小時）"]

    headlines = list(sentiment.get("top_headlines") or [])[:5]
    for h in headlines:
        title = str(h.get("title") or "")[:38]
        sent = str(h.get("sentiment") or "neutral")
        event = str(h.get("event_type") or "")
        s_emoji = _SENT_EMOJI.get(sent, "⚪")
        event_tag = f" `[{event}]`" if event else ""
        # Relative time
        time_str = ""
        pub = str(h.get("published_at") or "")
        if pub:
            try:
                pub_dt = datetime.fromisoformat(pub)
                now = datetime.now(pub_dt.tzinfo) if pub_dt.tzinfo else datetime.now()
                h_ago = int((now - pub_dt).total_seconds() / 3600)
                time_str = f" · {h_ago}h前" if 0 <= h_ago < 48 else ""
            except Exception:
                pass
        lines.append(f"   {s_emoji} {title}{time_str}{event_tag}")

    lines.append(f"   {'─' * 22}")
    lines.append(f"   正面 `{pos}` 則 | 負面 `{neg}` 則 | {emoji} **{label}**")
    return "\n".join(lines)


def _is_recent(value: object) -> bool:
    if not value:
        return False
    try:
        published_at = datetime.fromisoformat(str(value))
    except (ValueError, TypeError):
        return False
    now = datetime.now(published_at.tzinfo) if published_at.tzinfo else datetime.now()
    return published_at >= now - timedelta(days=5)
