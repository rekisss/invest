#!/usr/bin/env python3
"""
News corpus builder — fetches from FinMind TaiwanStockNews + Google News RSS,
maintains a rolling 3-day corpus in output/news_corpus.json.
Runs in GitHub Actions (has FINMIND_TOKEN).
"""
from __future__ import annotations
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote

import requests

ROOT = Path(__file__).parents[1]
CORPUS_FILE = ROOT / "output" / "news_corpus.json"
MAX_AGE_DAYS = 3
CUTOFF = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)
_HTML_RE = re.compile(r"<[^>]+>")

# FinMind 重點個股
KEY_STOCKS = [
    ("2330", "台積電"), ("2317", "鴻海"), ("2454", "聯發科"),
    ("3008", "大立光"), ("2382", "廣達"), ("2379", "瑞昱"),
    ("6505", "台塑化"), ("2308", "台達電"), ("3711", "日月光投控"),
    ("2303", "聯電"), ("2357", "華碩"), ("2395", "研華"),
]

# Google News 廣市場查詢（when:3d 限制近3天）
GOOGLE_QUERIES = [
    "台灣股市 大盤 指數",
    "台積電 2330 TSMC",
    "外資 三大法人 台指期貨",
    "美股 那斯達克 費半 NVIDIA",
    "半導體 AI 晶片 CoWoS",
    "生技 醫療 新藥 FDA",
    "聯準會 Fed 升息 降息",
    "匯率 新台幣 美元",
    "電動車 Tesla EV 電池",
    "供應鏈 庫存 拉貨 缺貨",
]

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "Mozilla/5.0 (compatible; InvestBot/1.0)"})


def _parse_dt(s: str) -> datetime | None:
    if not s:
        return None
    try:
        d = parsedate_to_datetime(s)
    except Exception:
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def _is_recent(article: dict) -> bool:
    d = _parse_dt(article.get("published_at", ""))
    return d is None or d > CUTOFF


def fetch_google_rss(query: str) -> list[dict]:
    q = quote(f"{query} when:3d")
    url = f"https://news.google.com/rss/search?q={q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
    try:
        r = SESSION.get(url, timeout=15)
        r.raise_for_status()
        root = ET.fromstring(r.content)
        items = []
        for item in root.findall(".//item"):
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or item.findtext("guid") or "").strip()
            pub = (item.findtext("pubDate") or "").strip()
            src = item.find("source")
            source = src.text.strip() if src is not None and src.text else "Google News"
            desc = _HTML_RE.sub("", item.findtext("description") or "").strip()[:300]
            if not title:
                continue
            dt = _parse_dt(pub)
            items.append({
                "title": title, "url": link, "source": source,
                "published_at": dt.isoformat() if dt else "",
                "summary": desc,
            })
        print(f"  Google [{query[:25]}]: {len(items)}")
        return items
    except Exception as e:
        print(f"  Google [{query[:25]}] ERR: {e}")
        return []


def fetch_finmind_news(stock_id: str, name: str, token: str) -> list[dict]:
    start = (datetime.now() - timedelta(days=3)).strftime("%Y-%m-%d")
    params = {
        "dataset": "TaiwanStockNews",
        "data_id": stock_id,
        "start_date": start,
        "token": token,
    }
    try:
        r = SESSION.get("https://api.finmindtrade.com/api/v4/data", params=params, timeout=15)
        r.raise_for_status()
        data = r.json()
        if data.get("status") != 200:
            return []
        rows = data.get("data") or []
        items = []
        for row in rows[:15]:
            title = (row.get("title") or row.get("content", "")[:80]).strip()
            if not title:
                continue
            pub = row.get("date") or row.get("time") or ""
            dt = _parse_dt(pub)
            items.append({
                "title": title, "url": row.get("link", ""), "source": "FinMind",
                "published_at": dt.isoformat() if dt else pub,
                "summary": (row.get("content") or "")[:300],
            })
        print(f"  FinMind [{stock_id} {name}]: {len(items)}")
        return items
    except Exception as e:
        print(f"  FinMind [{stock_id}] ERR: {e}")
        return []


def load_corpus() -> list[dict]:
    if CORPUS_FILE.exists():
        try:
            return json.loads(CORPUS_FILE.read_text(encoding="utf-8")).get("articles", [])
        except Exception:
            pass
    return []


def save_corpus(articles: list[dict]) -> None:
    CORPUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CORPUS_FILE.write_text(
        json.dumps({"updated_at": datetime.now(timezone.utc).isoformat(), "articles": articles},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Corpus saved: {len(articles)} articles → {CORPUS_FILE}")


def dedup(articles: list[dict]) -> list[dict]:
    seen: set[str] = set()
    result = []
    for a in articles:
        key = a["title"][:40]
        if key not in seen:
            seen.add(key)
            result.append(a)
    return result


def main() -> None:
    existing = load_corpus()
    print(f"Existing corpus: {len(existing)} articles")

    new_articles: list[dict] = []

    # Google News (broad market)
    print("Fetching Google News RSS...")
    for q in GOOGLE_QUERIES:
        new_articles.extend(fetch_google_rss(q))

    # FinMind stock news
    for env in ("FINMIND_TOKEN", "FINMIND_TOKEN_2", "FINMIND_TOKEN_3"):
        token = os.getenv(env, "").strip()
        if not token:
            continue
        print(f"Fetching FinMind news ({env})...")
        for stock_id, name in KEY_STOCKS:
            new_articles.extend(fetch_finmind_news(stock_id, name, token))
        break  # one token is enough for news

    # Merge: new articles first (fresher), then existing
    merged = dedup(new_articles + existing)

    # Filter to 3 days + sort newest first
    recent = sorted(
        [a for a in merged if _is_recent(a)],
        key=lambda a: a.get("published_at", ""),
        reverse=True,
    )[:500]

    print(f"After merge+filter: {len(existing)} → {len(recent)}")
    save_corpus(recent)


if __name__ == "__main__":
    main()
