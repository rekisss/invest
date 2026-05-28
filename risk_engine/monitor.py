"""Risk Engine Monitor.

Assesses today's trading risk from multiple dimensions:
- Macro calendar events (FOMC, CPI, PCE, settlement dates)
- Positioning risk (short squeeze / long liquidation)
- Volatility anomalies
- Data quality

Outputs a structured RiskAssessment with clear recommendations.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional


class RiskLevel(str, Enum):
    LOW    = "low"
    MEDIUM = "medium"
    HIGH   = "high"
    EXTREME = "extreme"


_RISK_ZH = {
    RiskLevel.LOW:     "🟢 低風險",
    RiskLevel.MEDIUM:  "🟡 中等風險",
    RiskLevel.HIGH:    "🔴 高風險",
    RiskLevel.EXTREME: "⚫ 極高風險",
}


# ── Settlement dates (Taiwan Futures third Wednesday) — hardcoded for 2026 ────────
_SETTLEMENT_MONTHS_2026 = {
    "2026-01-21", "2026-02-18", "2026-03-18",
    "2026-04-15", "2026-05-20", "2026-06-17",
    "2026-07-15", "2026-08-19", "2026-09-16",
    "2026-10-21", "2026-11-18", "2026-12-16",
}


@dataclass
class RiskFactor:
    name: str
    description: str
    severity: float   # 0.0–1.0
    action: str       # recommended action


@dataclass
class RiskAssessment:
    """Complete risk assessment for today's trading session."""

    trade_date: str = ""
    overall_level: RiskLevel = RiskLevel.MEDIUM
    overall_level_zh: str = ""
    composite_score: float = 0.0   # 0.0 (low) to 1.0 (extreme)

    suitable_for_trading: bool = True
    reduce_position: bool = False
    avoid_chasing: bool = False

    risk_factors: list[RiskFactor] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)

    def format_discord(self) -> str:
        lines = [f"🛡 **風險評估**：{self.overall_level_zh}"]
        if self.risk_factors:
            for f in self.risk_factors[:4]:
                lines.append(f"   • {f.name}：{f.description}")
        if self.recommendations:
            lines.append("   **建議**：" + " / ".join(self.recommendations[:3]))
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return {
            "trade_date": self.trade_date,
            "overall_level": self.overall_level.value,
            "composite_score": self.composite_score,
            "suitable_for_trading": self.suitable_for_trading,
            "reduce_position": self.reduce_position,
            "avoid_chasing": self.avoid_chasing,
            "n_risk_factors": len(self.risk_factors),
        }


class RiskMonitor:
    """Evaluates today's trading risk from structured market data."""

    def assess(
        self,
        trade_date: str | None = None,
        vix: float = 20.0,
        vix_change: float = 0.0,
        futures_net: int = 0,
        night_change: float = 0.0,
        advance_ratio: float = 0.5,
        pcr: float = 1.0,
        xgb_prob_up: float = 0.5,
        upcoming_events: list[dict] | None = None,
    ) -> RiskAssessment:

        date = trade_date or datetime.now().strftime("%Y-%m-%d")
        assessment = RiskAssessment(trade_date=date)
        factors: list[RiskFactor] = []
        score = 0.0
        recommendations: list[str] = []

        # ── Factor 1: VIX level ───────────────────────────────────────────────
        if vix >= 30:
            factors.append(RiskFactor("VIX極高", f"VIX={vix:.1f}，市場恐慌", 1.0, "停止交易"))
            score += 0.50  # VIX≥30 alone pushes to HIGH (≥0.45)
        elif vix >= 25:
            factors.append(RiskFactor("VIX偏高", f"VIX={vix:.1f}，波動擴大", 0.6, "縮小倉位50%"))
            score += 0.25
        elif vix_change >= 3:
            factors.append(RiskFactor("VIX急升", f"VIX單日+{vix_change:.1f}，恐慌加劇", 0.5, "謹慎操作"))
            score += 0.15

        # ── Factor 2: Futures positioning ────────────────────────────────────
        if futures_net <= -45_000:
            factors.append(RiskFactor("外資空單極重", f"{futures_net:,}口，軋空/崩潰雙向風險", 0.9, "避免重押方向"))
            score += 0.25
        elif futures_net <= -35_000:
            factors.append(RiskFactor("外資空單偏重", f"{futures_net:,}口", 0.5, "注意軋空"))
            score += 0.10

        # ── Factor 3: Night session large gap ─────────────────────────────────
        if abs(night_change) >= 200:
            factors.append(RiskFactor(
                "夜盤大缺口",
                f"夜盤 {night_change:+.0f}pt，開盤後可能快速反轉",
                0.6, "禁止追缺口超過200pt"
            ))
            score += 0.15

        # ── Factor 4: Calendar events ─────────────────────────────────────────
        is_settlement = date in _SETTLEMENT_MONTHS_2026
        if is_settlement:
            factors.append(RiskFactor("結算日", f"{date} 台指期結算日，波動加大", 0.5, "降低槓桿"))
            score += 0.10

        if upcoming_events:
            high_impact = [e for e in upcoming_events if e.get("impact") == "High"]
            if high_impact:
                names = "、".join(e.get("event", "")[:20] for e in high_impact[:2])
                factors.append(RiskFactor("重大總經事件", names, 0.7, "事件前縮倉"))
                score += 0.20

        # ── Factor 5: Breadth anomaly ─────────────────────────────────────────
        if advance_ratio < 0.25:
            factors.append(RiskFactor("極差廣度", f"上漲家數比={advance_ratio:.0%}，全面殺盤", 0.8, "空手觀望"))
            score += 0.15

        # ── Factor 6: PCR ─────────────────────────────────────────────────────
        if pcr > 1.8:
            factors.append(RiskFactor("PCR過高", f"PCR={pcr:.2f}，市場超賣，反彈機率高", 0.4, "避免追空"))
            score += 0.05

        # ── Determine overall level ───────────────────────────────────────────
        score = min(1.0, score)
        if score >= 0.70:
            level = RiskLevel.EXTREME
        elif score >= 0.45:
            level = RiskLevel.HIGH
        elif score >= 0.25:
            level = RiskLevel.MEDIUM
        else:
            level = RiskLevel.LOW

        assessment.risk_factors = factors
        assessment.composite_score = round(score, 3)
        assessment.overall_level = level
        assessment.overall_level_zh = _RISK_ZH[level]
        assessment.suitable_for_trading = level not in (RiskLevel.EXTREME,)
        assessment.reduce_position = level in (RiskLevel.HIGH, RiskLevel.EXTREME)
        assessment.avoid_chasing = level != RiskLevel.LOW

        # ── Recommendations ───────────────────────────────────────────────────
        if level == RiskLevel.EXTREME:
            recommendations = ["今日建議空手觀望", "停止所有新倉操作", "緊縮停損保護現有倉位"]
        elif level == RiskLevel.HIGH:
            recommendations = ["倉位縮小至正常的50%", "設定嚴格停損", "避免追高"]
        elif level == RiskLevel.MEDIUM:
            recommendations = ["正常倉位操作", "停損設寬一點應對波動", "注意事件風險"]
        else:
            recommendations = ["正常操作", "可適度加碼強勢股"]

        assessment.recommendations = recommendations
        return assessment
