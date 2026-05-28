"""Tests for news_engine.sentiment."""
import pytest
from news_engine.sentiment import NewsSentimentEngine, SentimentResult


@pytest.fixture
def engine():
    return NewsSentimentEngine()


_POSITIVE_ITEMS = [
    {"title": "台積電法說會正面，目標價上調，訂單滿載", "published_at": "2026-05-27T10:00:00"},
    {"title": "NVDA AI晶片需求強勁，毛利提升", "published_at": "2026-05-27T09:00:00"},
    {"title": "外資大買超，台股創新高", "published_at": "2026-05-27T08:00:00"},
]

_NEGATIVE_ITEMS = [
    {"title": "外資賣超200億，大盤下跌跌停", "published_at": "2026-05-27T10:00:00"},
    {"title": "半導體砍單，庫存壓力沉重，目標價下調", "published_at": "2026-05-27T09:00:00"},
]


def test_positive_sentiment(engine):
    result = engine.analyse(_POSITIVE_ITEMS)
    assert result.overall == "positive"
    assert result.market_impact_score > 0
    assert result.n_articles == 3
    assert result.positive_count >= 2


def test_negative_sentiment(engine):
    result = engine.analyse(_NEGATIVE_ITEMS)
    assert result.overall == "negative"
    assert result.market_impact_score < 0


def test_empty_items(engine):
    result = engine.analyse([])
    assert result.n_articles == 0
    assert result.overall == "neutral"


def test_event_classification(engine):
    sent, _ = engine.score_title("台積電法說會非常正面，目標價上調")
    event = engine.classify_event("台積電法說會")
    assert event == "台積電"


def test_negation_handling(engine):
    sent_pos, _ = engine.score_title("台股大漲")
    sent_neg, _ = engine.score_title("台股不漲")
    assert sent_pos == "positive"
    assert sent_neg == "neutral"  # negation neutralises


def test_discord_format(engine):
    result = engine.analyse(_POSITIVE_ITEMS)
    disc = result.format_discord()
    assert "📰" in disc
    assert "正面" in disc


def test_top_headlines_populated(engine):
    result = engine.analyse(_POSITIVE_ITEMS)
    assert len(result.top_headlines) >= 1
    assert "title" in result.top_headlines[0]


def test_confidence_increases_with_articles(engine):
    r1 = engine.analyse(_POSITIVE_ITEMS[:1])
    r3 = engine.analyse(_POSITIVE_ITEMS)
    assert r3.confidence >= r1.confidence
