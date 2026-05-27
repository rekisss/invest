"""Scenario generator — produces human-readable trading scenarios from regime + data."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .classifier import RegimeLabel


@dataclass
class ScenarioResult:
    regime_zh: str = ""
    main_scenario: str = ""
    best_strategy: str = ""
    danger_signals: list[str] = field(default_factory=list)
    forbidden_actions: list[str] = field(default_factory=list)
    win_rate_text: str = ""
    suitable_for_trading: bool = True

    def format_discord(self) -> str:
        """Format as Discord message block."""
        lines = [
            f"📊 **市場類型**：{self.regime_zh}",
            f"📋 **主力劇本**：{self.main_scenario}",
            f"🎯 **最佳策略**：{self.best_strategy}",
        ]
        if self.danger_signals:
            lines.append("⚡ **危險訊號**：" + " · ".join(self.danger_signals))
        if self.forbidden_actions:
            lines.append("🚫 **禁止操作**：" + " · ".join(self.forbidden_actions))
        lines.append(f"📈 **勝率估計**：{self.win_rate_text}")
        return "\n".join(lines)


def generate_scenario(
    regime_label: RegimeLabel,
    regime_zh: str,
    win_rate: float,
    vix: float = 20.0,
    futures_net: int = 0,
    night_change: float = 0.0,
    us_tech_strength: float = 0.0,
    pcr: float = 1.0,
    advance_ratio: float = 0.5,
    xgb_prob_up: float = 0.5,
) -> ScenarioResult:
    """Generate human-readable scenario from regime classification."""

    result = ScenarioResult(regime_zh=regime_zh)
    result.win_rate_text = f"方向策略 ~{win_rate:.0%}"
    danger: list[str] = []
    forbidden: list[str] = []

    # ── Danger signals ────────────────────────────────────────────────────────
    if futures_net <= -35_000:
        danger.append(f"外資空單極重（{futures_net:,}口），軋空風險高")
    if vix >= 25:
        danger.append(f"VIX={vix:.1f} 高波動，假突破機率高")
    if pcr > 1.5:
        danger.append(f"PCR={pcr:.2f} 市場恐慌，留意反彈")
    if abs(night_change) > 200:
        danger.append(f"夜盤缺口 {night_change:+.0f}pt 過大，易反轉")

    # ── Forbidden actions ─────────────────────────────────────────────────────
    if vix >= 28:
        forbidden.append("禁止 ORB 策略（波動過大）")
    if abs(night_change) > 200:
        forbidden.append(f"禁止追{'空' if night_change < 0 else '多'}缺口超過200pt")
    if futures_net <= -40_000:
        forbidden.append("禁止反彈高點追多（軋空陷阱）")

    # ── Regime-specific scenario ──────────────────────────────────────────────
    if regime_label == RegimeLabel.EXTREME_VOL:
        result.main_scenario = f"VIX={vix:.1f} 極端波動，市場失序，停止交易等待結構明朗"
        result.best_strategy = "場外觀望 / 縮小倉位至 20% 以下"
        result.suitable_for_trading = False

    elif regime_label == RegimeLabel.SHORT_SQUEEZE:
        result.main_scenario = (
            f"外資空單 {futures_net:,} 口，若開盤方向錯誤，空方被迫回補 → 先拉高再轉弱"
        )
        result.best_strategy = "等開盤15分鐘方向確認後再進場，避免追空缺口"
        danger.insert(0, "軋空風險：若開盤跳空向上超過150pt，空單需謹慎")
        forbidden.append("開盤前30分鐘禁止追空")

    elif regime_label == RegimeLabel.STRONG_BULL:
        fut_str = f"外資期貨 {futures_net:+,}口，" if futures_net != 0 else ""
        result.main_scenario = (
            f"美股科技強勁（tech強度={us_tech_strength:.1f}），{fut_str}廣度佳（{advance_ratio:.0%}），"
            "多頭慣性延續，適合趨勢追多"
        )
        result.best_strategy = "突破盤前高點追多 / ORB多方 / 持股待漲"

    elif regime_label == RegimeLabel.STRONG_BEAR:
        result.main_scenario = (
            f"美股疲弱，廣度差（{advance_ratio:.0%}），台股偏空，"
            "反彈幅度有限，建議輕倉或空手"
        )
        result.best_strategy = "反彈至VWAP附近做空 / 等ORB確認空方"

    elif regime_label == RegimeLabel.LONG_LIQUIDATE:
        result.main_scenario = (
            f"夜盤大跌 {night_change:.0f}pt，多頭倉位鬆動，"
            "開盤可能持續賣壓，避免搶反彈"
        )
        result.best_strategy = "等開盤30分鐘後觀察量能是否縮減，再考慮進場"

    elif regime_label == RegimeLabel.DOUBLE_WHIPSAW:
        result.main_scenario = (
            f"VIX={vix:.1f} 高波動，方向不明，上下兩難，"
            "策略錯誤易被雙向停損"
        )
        result.best_strategy = "縮小倉位 / 等待方向確認 / 以日內區間交易為主"
        result.suitable_for_trading = False

    else:  # RANGE_BOUND
        result.main_scenario = (
            f"無強烈方向訊號，台股可能在區間內震盪，"
            "注意盤中族群輪動"
        )
        result.best_strategy = "區間操作 / 選強勢族群個股 / 勿重押方向"

    result.danger_signals = danger
    result.forbidden_actions = forbidden
    return result
