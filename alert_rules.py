"""
Rule-based alert engine for monitoring open positions.

Detects stop-loss breaches, momentum deterioration, institutional selling,
and other exit conditions from position data and latest scanner output.

Standalone module — no existing files modified.
"""
from __future__ import annotations

import enum
from typing import Any, Dict, List

import pandas as pd


class AlertLevel(enum.Enum):
    OK = "OK"
    WATCH = "WATCH"
    EXIT = "EXIT"


# Ordering for comparison: EXIT > WATCH > OK
_LEVEL_ORDER: Dict[AlertLevel, int] = {
    AlertLevel.OK: 0,
    AlertLevel.WATCH: 1,
    AlertLevel.EXIT: 2,
}


def _worst(*levels: AlertLevel) -> AlertLevel:
    """Return the most severe AlertLevel among the supplied levels."""
    return max(levels, key=lambda lvl: _LEVEL_ORDER[lvl])


def check_stop_loss(current_price: float, stop_price: float) -> AlertLevel:
    """Return EXIT if current_price is at or below stop_price, else OK."""
    if current_price <= stop_price:
        return AlertLevel.EXIT
    return AlertLevel.OK


def check_momentum_drop(
    entry_score: float,
    current_score: float,
    drop_threshold: float = 0.20,
) -> AlertLevel:
    """Return WATCH or EXIT depending on how much the score has dropped.

    Parameters
    ----------
    entry_score : momentum score at entry
    current_score : current momentum score
    drop_threshold : fraction drop that triggers WATCH (default 0.20 = 20%)

    Logic
    -----
    - EXIT  if drop > 35%
    - WATCH if drop > drop_threshold (default 20%)
    - OK    otherwise
    """
    if entry_score == 0:
        return AlertLevel.OK

    drop_fraction = (entry_score - current_score) / abs(entry_score)

    if drop_fraction > 0.35:
        return AlertLevel.EXIT
    if drop_fraction > drop_threshold:
        return AlertLevel.WATCH
    return AlertLevel.OK


def check_institutional_reversal(
    foreign_buy_streak: int,
    invest_trust_streak: int,
) -> AlertLevel:
    """Assess institutional buying/selling streaks.

    - EXIT  if both streaks < -2 (both selling for 2+ days)
    - WATCH if either streak is negative (selling started)
    - OK    if both >= 0
    """
    if foreign_buy_streak < -2 and invest_trust_streak < -2:
        return AlertLevel.EXIT
    if foreign_buy_streak < 0 or invest_trust_streak < 0:
        return AlertLevel.WATCH
    return AlertLevel.OK


def check_volume_collapse(
    volume_ratio: float,
    bb_pct_b: float,
    threshold: float = 0.30,
) -> AlertLevel:
    """Flag collapsing volume near the upper Bollinger Band.

    Returns WATCH if volume_ratio < threshold AND bb_pct_b > 0.5.
    """
    if volume_ratio < threshold and bb_pct_b > 0.5:
        return AlertLevel.WATCH
    return AlertLevel.OK


def evaluate_position(position: dict, current_data: dict) -> dict:
    """Run all alert checks for a single position.

    Parameters
    ----------
    position : {"stock_id", "entry_price", "stop_price", "entry_score"}
    current_data : {"close", "entry_score", "foreign_buy_streak",
                    "invest_trust_streak", "volume_ratio", "bb_pct_b"}

    Returns
    -------
    dict with stock_id, overall_level, alerts, should_exit, should_watch
    """
    stock_id = position.get("stock_id", "")
    alerts: List[str] = []

    # 1. Stop-loss check
    current_price = float(current_data.get("close", position.get("entry_price", 0)))
    stop_price = float(position.get("stop_price", 0))
    sl_level = check_stop_loss(current_price, stop_price)
    if sl_level != AlertLevel.OK:
        alerts.append(
            f"⚠️ 止損觸發 (現價 {current_price} ≤ 止損 {stop_price})"
        )

    # 2. Momentum drop check
    entry_score = float(position.get("entry_score", 0))
    current_score = float(current_data.get("entry_score", entry_score))
    mom_level = check_momentum_drop(entry_score, current_score)
    if mom_level != AlertLevel.OK:
        drop_pct = (
            (entry_score - current_score) / abs(entry_score) * 100
            if entry_score != 0
            else 0.0
        )
        severity = "嚴重" if mom_level == AlertLevel.EXIT else ""
        alerts.append(f"⚠️ 動能{severity}下滑 ({drop_pct:.0f}%)")

    # 3. Institutional reversal check
    foreign_streak = int(current_data.get("foreign_buy_streak", 0))
    trust_streak = int(current_data.get("invest_trust_streak", 0))
    inst_level = check_institutional_reversal(foreign_streak, trust_streak)
    if inst_level != AlertLevel.OK:
        parts = []
        if foreign_streak < 0:
            parts.append("外資轉賣")
        if trust_streak < 0:
            parts.append("投信轉賣")
        alerts.append("⚠️ " + " | ".join(parts))

    # 4. Volume collapse check
    volume_ratio = float(current_data.get("volume_ratio", 1.0))
    bb_pct_b = float(current_data.get("bb_pct_b", 0.5))
    vol_level = check_volume_collapse(volume_ratio, bb_pct_b)
    if vol_level != AlertLevel.OK:
        alerts.append("⚠️ 量能萎縮 (高位縮量)")

    overall_level = _worst(sl_level, mom_level, inst_level, vol_level)

    return {
        "stock_id": stock_id,
        "overall_level": overall_level,
        "alerts": alerts,
        "should_exit": overall_level == AlertLevel.EXIT,
        "should_watch": overall_level == AlertLevel.WATCH,
    }


def screen_portfolio(
    positions: List[dict],
    scanner_results: pd.DataFrame,
    stock_id_col: str = "stock_id",
) -> pd.DataFrame:
    """Evaluate all positions against latest scanner results.

    Parameters
    ----------
    positions : list of position dicts (see evaluate_position)
    scanner_results : DataFrame with one row per stock; must contain stock_id_col
    stock_id_col : column name for stock identifier

    Returns
    -------
    DataFrame with columns: stock_id, overall_level, alerts, should_exit, should_watch
    Sorted EXIT first, then WATCH, then OK.
    """
    # Build a lookup dict from the scanner results
    if stock_id_col in scanner_results.columns:
        scanner_lookup: Dict[Any, Dict] = {
            str(row[stock_id_col]): row.to_dict()
            for _, row in scanner_results.iterrows()
        }
    else:
        scanner_lookup = {}

    rows = []
    for pos in positions:
        stock_id = str(pos.get("stock_id", ""))
        current_data = scanner_lookup.get(stock_id, {})
        result = evaluate_position(pos, current_data)
        rows.append(
            {
                "stock_id": result["stock_id"],
                "overall_level": result["overall_level"],
                "alerts": " | ".join(result["alerts"]),
                "should_exit": result["should_exit"],
                "should_watch": result["should_watch"],
            }
        )

    df = pd.DataFrame(
        rows,
        columns=["stock_id", "overall_level", "alerts", "should_exit", "should_watch"],
    )

    if df.empty:
        return df

    df["_order"] = df["overall_level"].map(_LEVEL_ORDER)
    df = df.sort_values("_order", ascending=False).drop(columns=["_order"])
    df = df.reset_index(drop=True)
    return df


def format_portfolio_alerts(alert_df: pd.DataFrame) -> str:
    """Format screen_portfolio output as a Discord-ready message.

    Returns "" if all positions are OK (no alerts to show).
    EXIT stocks appear first, then WATCH.
    """
    if alert_df.empty:
        return ""

    exit_rows = alert_df[alert_df["overall_level"] == AlertLevel.EXIT]
    watch_rows = alert_df[alert_df["overall_level"] == AlertLevel.WATCH]

    if exit_rows.empty and watch_rows.empty:
        return ""

    sections: List[str] = []

    if not exit_rows.empty:
        lines = ["🚨 **需要立即處理**"]
        for _, row in exit_rows.iterrows():
            lines.append(f"🚨 {row['stock_id']} — {row['alerts']}")
        sections.append("\n".join(lines))

    if not watch_rows.empty:
        lines = ["👁 **需要關注**"]
        for _, row in watch_rows.iterrows():
            lines.append(f"👁 {row['stock_id']} — {row['alerts']}")
        sections.append("\n".join(lines))

    return "\n\n".join(sections)
