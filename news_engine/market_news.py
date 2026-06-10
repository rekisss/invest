"""Market-level news sentiment aggregator.

Fetches news from Google RSS (and optionally FinMind) and runs
through the NewsSentimentEngine to produce a SentimentResult.
"""
from __future__ import annotations

from .sentiment import NewsSentimentEngine, SentimentResult


def fetch_market_sentiment(
    news_client=None,
    finmind_client=None,
    days: int = 2,
    limit: int = 20,
) -> SentimentResult:
    """Fetch and score market-level news sentiment.

    Gracefully degrades if news_client is None.
    """
    engine = NewsSentimentEngine()
    all_items: list[dict] = []

    # Source 1: Google News RSS (via existing NewsClient)
    if news_client is not None:
        try:
            df = news_client.fetch_stock_news(
                stock_id="TAIEX", name="台股大盤", days=days, limit=limit
            )
            if not df.empty:
                all_items.extend(df.to_dict("records"))
        except Exception as exc:
            import sys
            print(f"[news_engine] Google RSS 失敗（skip）: {exc}", file=sys.stderr)

    # Source 2: FinMind TaiwanStockNews for key stocks
    if finmind_client is not None:
        from datetime import datetime, timedelta
        # TaiwanStockNews API rejects end_date (one day of data per call)
        start = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        for stock_id in ["2330", "2317", "2454", "3008"]:
            try:
                df = finmind_client.fetch_dataset(
                    "TaiwanStockNews",
                    data_id=stock_id,
                    start_date=start,
                    use_cache=True,
                    cache_ttl_days=0.25,
                )
                if df is not None and not df.empty:
                    title_col = next((c for c in ("title", "description", "content") if c in df.columns), None)
                    date_col = next((c for c in ("date", "published_at") if c in df.columns), None)
                    for _, r in df.iterrows():
                        title = str(r[title_col]) if title_col else ""
                        if title:
                            all_items.append({
                                "title": title[:80],
                                "source": "FinMind",
                                "published_at": str(r[date_col]) if date_col else "",
                            })
            except Exception:
                pass

    # Deduplicate by title prefix
    seen: set[str] = set()
    deduped = []
    for item in all_items:
        key = str(item.get("title", ""))[:20]
        if key and key not in seen:
            seen.add(key)
            deduped.append(item)

    return engine.analyse(deduped)
