"""News Sentiment Engine with structured event scoring."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Iterable


# ── Event importance weights ──────────────────────────────────────────────────────

_EVENT_WEIGHTS: dict[str, float] = {
    "Fed/聯準會": 1.5,
    "台積電":     1.4,
    "AI供應鏈":   1.2,
    "半導體":     1.2,
    "地緣政治":   1.3,
    "美股":       1.1,
}

# Market impact scores per sentiment * event weight
_IMPACT_MATRIX = {
    ("positive", "Fed/聯準會"):  0.8,
    ("negative", "Fed/聯準會"):  -0.9,
    ("positive", "台積電"):      0.9,
    ("negative", "台積電"):      -1.0,
    ("positive", "AI供應鏈"):    0.7,
    ("negative", "AI供應鏈"):    -0.7,
    ("positive", "地緣政治"):    -0.3,  # geopolitics: positive news = relief
    ("negative", "地緣政治"):    -1.2,
    ("positive", "半導體"):      0.6,
    ("negative", "半導體"):      -0.7,
}

_POS_KEYWORDS = frozenset([
    "漲", "上修", "成長", "新高", "利多", "擴產", "合作", "突破", "訂單",
    "買超", "獲利", "轉盈", "超預期", "大客戶", "庫藏股", "回購", "股利",
    "旺季", "滿載", "買進", "增持", "升評", "創高", "量產",
])
_NEG_KEYWORDS = frozenset([
    "跌", "下修", "衰退", "虧損", "調降", "利空", "賣超", "裁員", "訴訟",
    "違約", "風險", "警示", "停牌", "掏空", "砍單", "下滑", "縮水", "罰款",
    "查帳", "債務", "跌停", "減持", "降評", "停工", "火災",
])
_EVENT_KEYWORDS: dict[str, list[str]] = {
    "Fed/聯準會": ["Fed", "FOMC", "聯準會", "升息", "降息", "利率", "鮑爾"],
    "台積電":     ["台積電", "TSMC", "法說", "CoWoS", "先進封裝", "N3", "N2"],
    "AI供應鏈":   ["AI", "人工智慧", "輝達", "NVIDIA", "HBM", "算力", "GB200"],
    "地緣政治":   ["貿易戰", "關稅", "制裁", "台海", "兩岸", "軍演", "出口管制"],
    "半導體":     ["費半", "SOX", "晶片", "半導體", "記憶體", "DRAM", "晶圓"],
    "美股":       ["道瓊", "S&P", "那斯達克", "美股", "標普"],
}
_NEGATION = frozenset("不未沒無非")
_POS_RE = re.compile("|".join(re.escape(k) for k in sorted(_POS_KEYWORDS, key=len, reverse=True)))
_NEG_RE = re.compile("|".join(re.escape(k) for k in sorted(_NEG_KEYWORDS, key=len, reverse=True)))


@dataclass
class NewsItem:
    title: str
    snippet: str = ""
    source: str = ""
    published_at: str = ""
    sentiment: str = "neutral"       # positive / neutral / negative
    event_type: str = ""             # category from _EVENT_KEYWORDS
    market_impact: float = 0.0       # estimated market impact (-2 to +2)
    importance: float = 1.0          # event importance weight


@dataclass
class SentimentResult:
    """Aggregated news sentiment with market impact estimation."""

    overall: str = "neutral"          # positive / neutral / negative
    market_impact_score: float = 0.0  # -5 to +5
    confidence: float = 0.5
    n_articles: int = 0
    positive_count: int = 0
    neutral_count: int = 0
    negative_count: int = 0
    top_events: list[str] = field(default_factory=list)
    top_headlines: list[dict] = field(default_factory=list)
    has_recent_news: bool = False

    def format_discord(self) -> str:
        if self.n_articles == 0:
            return ""
        emoji = {"positive": "📈", "negative": "📉"}.get(self.overall, "→")
        label = {"positive": "偏多", "negative": "偏空"}.get(self.overall, "中性")
        _SE = {"positive": "🟢", "negative": "🔴", "neutral": "⚪"}
        lines = ["📰 **市場新聞情緒**（近48小時）"]
        for h in self.top_headlines[:4]:
            t = str(h.get("title", ""))[:40]
            s = str(h.get("sentiment", "neutral"))
            ev = str(h.get("event_type", ""))
            lines.append(f"   {_SE.get(s,'⚪')} {t}{f' `[{ev}]`' if ev else ''}")
        lines.append(f"   {'─'*22}")
        lines.append(
            f"   正面 `{self.positive_count}` | 負面 `{self.negative_count}` | "
            f"{emoji} **{label}**（衝擊指數 `{self.market_impact_score:+.1f}`）"
        )
        return "\n".join(lines)


class NewsSentimentEngine:
    """Scores news items and produces structured SentimentResult."""

    def score_title(self, title: str) -> tuple[str, float]:
        """Return (sentiment, market_impact)."""
        pos = self._count(self._POS_RE_local(), title)
        neg = self._count(self._NEG_RE_local(), title)
        if pos > neg:
            return "positive", min(2.0, pos * 0.5)
        if neg > pos:
            return "negative", max(-2.0, -(neg * 0.5))
        return "neutral", 0.0

    def classify_event(self, title: str) -> str:
        for event_type, keywords in _EVENT_KEYWORDS.items():
            if any(kw in title for kw in keywords):
                return event_type
        return ""

    def analyse(self, items: Iterable[dict]) -> SentimentResult:
        result = SentimentResult()
        scored: list[NewsItem] = []

        for raw in items:
            title = str(raw.get("title", ""))
            if not title:
                continue
            sentiment, raw_impact = self.score_title(title)
            event_type = self.classify_event(title)
            weight = _EVENT_WEIGHTS.get(event_type, 1.0)
            impact_key = (sentiment, event_type)
            impact = _IMPACT_MATRIX.get(impact_key, raw_impact) * weight

            scored.append(NewsItem(
                title=title,
                snippet=str(raw.get("snippet", ""))[:120],
                source=str(raw.get("source", "")),
                published_at=str(raw.get("published_at", "")),
                sentiment=sentiment,
                event_type=event_type,
                market_impact=round(impact, 3),
                importance=weight,
            ))

        if not scored:
            return result

        result.n_articles = len(scored)
        result.positive_count = sum(1 for s in scored if s.sentiment == "positive")
        result.negative_count = sum(1 for s in scored if s.sentiment == "negative")
        result.neutral_count = result.n_articles - result.positive_count - result.negative_count

        # Weighted market impact
        total_impact = sum(s.market_impact * s.importance for s in scored)
        total_weight = sum(s.importance for s in scored)
        result.market_impact_score = round(
            max(-5, min(5, total_impact / total_weight if total_weight else 0)),
            2,
        )

        result.overall = (
            "positive" if result.market_impact_score > 0.3
            else "negative" if result.market_impact_score < -0.3
            else "neutral"
        )
        result.confidence = min(0.9, 0.4 + len(scored) * 0.03)

        # Top events by importance
        event_counts: dict[str, int] = {}
        for s in scored:
            if s.event_type:
                event_counts[s.event_type] = event_counts.get(s.event_type, 0) + 1
        result.top_events = sorted(event_counts, key=lambda k: -event_counts[k])[:3]

        # Top headlines (most impactful)
        top = sorted(scored, key=lambda s: abs(s.market_impact) * s.importance, reverse=True)[:5]
        result.top_headlines = [
            {
                "title": s.title,
                "sentiment": s.sentiment,
                "event_type": s.event_type,
                "market_impact": s.market_impact,
                "published_at": s.published_at,
            }
            for s in top
        ]

        # Has recent news (< 48h)
        now = datetime.now()
        for s in scored:
            try:
                pub = datetime.fromisoformat(s.published_at.replace("Z", "+00:00"))
                pub_naive = pub.replace(tzinfo=None)
                if (now - pub_naive) < timedelta(hours=48):
                    result.has_recent_news = True
                    break
            except Exception:
                pass

        return result

    @staticmethod
    def _POS_RE_local():
        return _POS_RE

    @staticmethod
    def _NEG_RE_local():
        return _NEG_RE

    @staticmethod
    def _count(pattern, text: str) -> int:
        count = 0
        for m in pattern.finditer(text):
            preceding = text[max(0, m.start() - 2): m.start()]
            if not any(c in _NEGATION for c in preceding):
                count += 1
        return count
