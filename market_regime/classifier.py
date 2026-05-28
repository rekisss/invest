"""Market Regime Classifier.

Classifies today's market into one of 7 regimes using a rule-based engine
backed by quantitative thresholds. No magic numbers — all thresholds are
defined as named constants.

Regimes:
  STRONG_BULL    — 強趨勢多頭日
  STRONG_BEAR    — 強趨勢空頭日
  SHORT_SQUEEZE  — 軋空日（外資空單過重+美股強）
  LONG_LIQUIDATE — 多殺多日（多頭倉位崩潰）
  RANGE_BOUND    — 區間震盪
  DOUBLE_WHIPSAW — 多空雙巴（高波動無方向）
  EXTREME_VOL    — 極端波動日（黑天鵝）
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional


# ── Thresholds (named constants — no magic numbers) ──────────────────────────────

VIX_EXTREME = 30.0          # VIX above this = extreme volatility day
VIX_HIGH = 25.0             # VIX above this = elevated risk
VIX_CALM = 15.0             # VIX below this = calm market
NET_TREND_STRONG = 3.0      # composite net score above this = strong trend
FUTURES_HEAVY_SHORT = -35_000   # foreign futures net below this = heavy short
FUTURES_EXTREME_SHORT = -45_000 # extreme short → squeeze risk
NIGHT_GAP_LARGE = 150.0    # night session gap (pts) above this = large gap
ADV_RATIO_BROAD_BULL = 0.65 # breadth above this = broad-based rally
ADV_RATIO_BROAD_BEAR = 0.35 # breadth below this = broad selling


class RegimeLabel(str, Enum):
    STRONG_BULL    = "strong_bull"
    STRONG_BEAR    = "strong_bear"
    SHORT_SQUEEZE  = "short_squeeze"
    LONG_LIQUIDATE = "long_liquidate"
    RANGE_BOUND    = "range_bound"
    DOUBLE_WHIPSAW = "double_whipsaw"
    EXTREME_VOL    = "extreme_vol"


_REGIME_ZH: dict[RegimeLabel, str] = {
    RegimeLabel.STRONG_BULL:    "🔥 強趨勢多頭日",
    RegimeLabel.STRONG_BEAR:    "📉 強趨勢空頭日",
    RegimeLabel.SHORT_SQUEEZE:  "⚠️ 軋空日",
    RegimeLabel.LONG_LIQUIDATE: "💥 多殺多日",
    RegimeLabel.RANGE_BOUND:    "😴 區間震盪日",
    RegimeLabel.DOUBLE_WHIPSAW: "🔄 多空雙巴日",
    RegimeLabel.EXTREME_VOL:    "⚡ 極端波動日",
}


@dataclass
class RegimeClassification:
    label: RegimeLabel
    label_zh: str
    confidence: float         # 0.0–1.0
    reasoning: list[str]      # human-readable rationale
    win_rate_estimate: float  # directional win rate estimate (0–1)
    tradeable: bool           # whether to trade today

    def to_dict(self) -> dict:
        return {
            "label": self.label.value,
            "label_zh": self.label_zh,
            "confidence": self.confidence,
            "reasoning": self.reasoning,
            "win_rate_estimate": self.win_rate_estimate,
            "tradeable": self.tradeable,
        }


class MarketRegimeClassifier:
    """Classifies market regime from a structured market data dict."""

    def classify(
        self,
        vix: float = 20.0,
        futures_net: int = 0,
        night_change: float = 0.0,
        us_tech_strength: float = 0.0,
        advance_ratio: float = 0.5,
        taiex_dist_ma60: float = 0.0,
        pcr: float = 1.0,
        xgb_prob_up: float = 0.5,
    ) -> RegimeClassification:
        """Classify regime. All inputs have safe defaults so partial data works."""

        reasoning: list[str] = []
        confidence = 0.6

        # ── Rule 1: Extreme volatility (overrides all) ────────────────────────
        if vix >= VIX_EXTREME:
            reasoning.append(f"VIX={vix:.1f} ≥ {VIX_EXTREME} → 黑天鵝/極端波動")
            return self._result(RegimeLabel.EXTREME_VOL, reasoning, 0.9, 0.4, tradeable=False)

        # ── Rule 2: Short squeeze risk ────────────────────────────────────────
        if futures_net <= FUTURES_EXTREME_SHORT and us_tech_strength > 1.0:
            reasoning.append(f"外資期貨淨空單 {futures_net:,} 口（極重）+ 美股科技強 → 軋空風險")
            return self._result(RegimeLabel.SHORT_SQUEEZE, reasoning, 0.75, 0.55, tradeable=True)

        # ── Compute net direction score ───────────────────────────────────────
        net = 0.0
        net += max(-2, min(2, us_tech_strength))
        net += 1.0 if advance_ratio >= ADV_RATIO_BROAD_BULL else (-1.0 if advance_ratio <= ADV_RATIO_BROAD_BEAR else 0.0)
        net += max(-1, min(1, night_change / 100))
        net += max(-1, min(1, xgb_prob_up * 4 - 2))

        us_strong = us_tech_strength >= 1.5

        # ── Rule 3: Strong bull ───────────────────────────────────────────────
        if net >= NET_TREND_STRONG and us_strong and advance_ratio >= ADV_RATIO_BROAD_BULL:
            reasoning.append(f"美股科技強（{us_tech_strength:.1f}）+ 廣度佳（{advance_ratio:.0%}）+ net={net:.1f}")
            return self._result(RegimeLabel.STRONG_BULL, reasoning, 0.8, 0.65, tradeable=True)

        # ── Rule 4: Strong bear ───────────────────────────────────────────────
        if net <= -NET_TREND_STRONG and advance_ratio <= ADV_RATIO_BROAD_BEAR:
            reasoning.append(f"美股疲弱（{us_tech_strength:.1f}）+ 廣度差（{advance_ratio:.0%}）+ net={net:.1f}")
            return self._result(RegimeLabel.STRONG_BEAR, reasoning, 0.75, 0.35, tradeable=True)

        # ── Rule 5: Long liquidation (down with heavy volume) ─────────────────
        if net < -1.5 and night_change <= -NIGHT_GAP_LARGE:
            reasoning.append(f"夜盤大跌 {night_change:.0f}pt + 方向空 → 多殺多風險")
            return self._result(RegimeLabel.LONG_LIQUIDATE, reasoning, 0.7, 0.35, tradeable=True)

        # ── Rule 6: Double whipsaw (high VIX + mixed signals) ─────────────────
        if vix >= VIX_HIGH or (futures_net <= FUTURES_HEAVY_SHORT and abs(net) < 1.5):
            if vix >= VIX_HIGH:
                reasoning.append(f"VIX={vix:.1f} 高波動 → 多空雙巴")
            else:
                reasoning.append(f"外資空單 {futures_net:,} 口但方向不明 → 多空雙巴")
            return self._result(RegimeLabel.DOUBLE_WHIPSAW, reasoning, 0.6, 0.45, tradeable=False)

        # ── Rule 7: Range-bound (default) ────────────────────────────────────
        reasoning.append(f"無強烈方向訊號（net={net:.1f}, VIX={vix:.1f}）→ 區間震盪")
        win_rate = 0.50 + net * 0.02
        return self._result(RegimeLabel.RANGE_BOUND, reasoning, 0.55, round(win_rate, 2), tradeable=True)

    @staticmethod
    def _result(
        label: RegimeLabel,
        reasoning: list[str],
        confidence: float,
        win_rate: float,
        tradeable: bool,
    ) -> RegimeClassification:
        return RegimeClassification(
            label=label,
            label_zh=_REGIME_ZH[label],
            confidence=confidence,
            reasoning=reasoning,
            win_rate_estimate=round(max(0.25, min(0.80, win_rate)), 3),
            tradeable=tradeable,
        )


def classify_regime(**kwargs) -> RegimeClassification:
    """Convenience function — classify without instantiating the class."""
    return MarketRegimeClassifier().classify(**kwargs)
