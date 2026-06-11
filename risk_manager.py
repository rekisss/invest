"""
Position sizing and risk management utilities.

Provides Kelly criterion sizing, ATR-based stop-loss calculation,
and portfolio-level risk aggregation for the Taiwan stock scanner.

Standalone module — no existing files modified.
"""

import math


def kelly_position_size(
    win_rate: float,
    avg_win_pct: float,
    avg_loss_pct: float,
    kelly_fraction: float = 0.5,
) -> float:
    """
    Compute Kelly criterion position size as a fraction of portfolio.

    Args:
        win_rate: Probability of a winning trade (0.0–1.0).
        avg_win_pct: Average gain on winning trades (e.g. 0.05 = 5%).
        avg_loss_pct: Average loss on losing trades (e.g. 0.03 = 3%).
        kelly_fraction: Fraction of full Kelly to use (default 0.5 = half-Kelly).

    Returns:
        Position size as a fraction of portfolio, clamped to [0.0, 0.20].
        Returns 0.0 on invalid inputs.
    """
    # Validate inputs
    if (
        win_rate < 0.0
        or win_rate > 1.0
        or avg_win_pct <= 0.0
        or avg_loss_pct < 0.0
        or kelly_fraction <= 0.0
    ):
        return 0.0

    loss_rate = 1.0 - win_rate
    full_kelly = (win_rate * avg_win_pct - loss_rate * avg_loss_pct) / avg_win_pct

    if full_kelly <= 0.0:
        return 0.0

    result = full_kelly * kelly_fraction
    return max(0.0, min(result, 0.20))


def atr_stop_loss(
    entry_price: float,
    atr: float,
    atr_multiplier: float = 2.5,
) -> float:
    """
    Compute ATR-based stop-loss price for a long position.

    Args:
        entry_price: Trade entry price.
        atr: Average True Range over the lookback period (e.g. ATR-14).
        atr_multiplier: Number of ATR units below entry for the stop (default 2.5).

    Returns:
        Stop price.  Always < entry_price for long positions.
        Returns 0.0 if entry_price <= 0 or atr <= 0.
        The stop is capped at entry_price * 0.80 (max 20% downside).
    """
    if entry_price <= 0.0 or atr <= 0.0:
        return 0.0

    stop = entry_price - atr * atr_multiplier
    min_stop = entry_price * 0.80
    return max(stop, min_stop)


def risk_reward_ratio(
    entry_price: float,
    stop_price: float,
    target_price: float,
) -> float:
    """
    Compute risk/reward ratio for a trade.

    Args:
        entry_price: Trade entry price.
        stop_price: Stop-loss price (below entry for longs).
        target_price: Profit-taking target (above entry for longs).

    Returns:
        Reward / Risk ratio.  Returns 0.0 if risk <= 0.
    """
    risk = entry_price - stop_price
    if risk <= 0.0:
        return 0.0

    reward = target_price - entry_price
    return reward / risk


def position_size_from_risk(
    portfolio_value: float,
    risk_per_trade_pct: float,
    entry_price: float,
    stop_price: float,
) -> int:
    """
    Compute number of shares to buy given a fixed monetary risk per trade.

    The position is sized so that if stopped out, the loss equals
    portfolio_value * risk_per_trade_pct.

    Args:
        portfolio_value: Total portfolio value in TWD.
        risk_per_trade_pct: Fraction of portfolio to risk (e.g. 0.01 = 1%).
        entry_price: Trade entry price.
        stop_price: Stop-loss price.

    Returns:
        Number of shares (integer, floored).  Returns 0 if entry <= stop.
    """
    if entry_price <= stop_price:
        return 0

    risk_per_share = entry_price - stop_price
    dollar_risk = portfolio_value * risk_per_trade_pct
    shares = dollar_risk / risk_per_share
    return math.floor(shares)


def portfolio_heat(positions: list[dict], portfolio_value: float) -> float:
    """
    Compute total open portfolio risk as a fraction of portfolio value.

    Args:
        positions: List of position dicts, each with keys:
            - "entry_price": float
            - "stop_price": float
            - "shares": int
        portfolio_value: Total portfolio value in TWD.

    Returns:
        Heat as a fraction [0, 1].  Returns 0.0 if no positions.
    """
    if not positions or portfolio_value <= 0.0:
        return 0.0

    total_risk = 0.0
    for pos in positions:
        entry = pos.get("entry_price", 0.0)
        stop = pos.get("stop_price", 0.0)
        shares = pos.get("shares", 0)
        risk = max(0.0, entry - stop) * shares
        total_risk += risk

    return total_risk / portfolio_value


def max_loss_scenario(
    positions: list[dict],
    portfolio_value: float,
    scenario_drop_pct: float = 0.07,
) -> dict:
    """
    Estimate portfolio loss if all held stocks drop by scenario_drop_pct.

    Args:
        positions: List of position dicts, each with keys:
            - "entry_price": float
            - "shares": int
        portfolio_value: Total portfolio value in TWD.
        scenario_drop_pct: Fractional drop to model (default 0.07 = 7%).

    Returns:
        Dict with:
            - "total_loss_twd": float — total dollar loss across all positions
            - "portfolio_loss_pct": float — loss as fraction of portfolio
            - "n_positions": int — number of positions modelled
    """
    total_loss = 0.0
    for pos in positions:
        entry = pos.get("entry_price", 0.0)
        shares = pos.get("shares", 0)
        total_loss += entry * scenario_drop_pct * shares

    portfolio_loss_pct = (total_loss / portfolio_value) if portfolio_value > 0.0 else 0.0

    return {
        "total_loss_twd": total_loss,
        "portfolio_loss_pct": portfolio_loss_pct,
        "n_positions": len(positions),
    }


def suggest_position_size(
    entry_score: float,
    atr14: float,
    entry_price: float,
    portfolio_value: float = 1_000_000.0,
    base_risk_pct: float = 0.01,
) -> dict:
    """
    Convenience function combining several risk utilities into a position suggestion.

    Grades the trade by entry_score, scales risk accordingly, then returns
    sizing and risk metrics.

    Args:
        entry_score: Composite score from the scanner (higher is better).
        atr14: 14-period ATR for the stock.
        entry_price: Proposed entry price.
        portfolio_value: Total portfolio value in TWD (default 1,000,000).
        base_risk_pct: Base fraction of portfolio to risk per trade (default 0.01).

    Returns:
        Dict with keys: grade, stop_price, target_price, shares, risk_pct, risk_reward.
    """
    # Grade by score
    if entry_score >= 1800:
        grade = "A"
        risk_pct = base_risk_pct * 1.5
    elif entry_score >= 1400:
        grade = "B"
        risk_pct = base_risk_pct * 1.2
    elif entry_score >= 1000:
        grade = "C"
        risk_pct = base_risk_pct * 1.0
    else:
        grade = "D"
        risk_pct = base_risk_pct * 0.7

    stop_price = atr_stop_loss(entry_price, atr14)
    shares = position_size_from_risk(portfolio_value, risk_pct, entry_price, stop_price)
    target_price = entry_price * 1.08
    rr = risk_reward_ratio(entry_price, stop_price, target_price)

    return {
        "grade": grade,
        "stop_price": stop_price,
        "target_price": target_price,
        "shares": shares,
        "risk_pct": risk_pct,
        "risk_reward": rr,
    }


def format_position_suggestion(stock_id: str, name: str, suggestion: dict) -> str:
    """
    Format the output of suggest_position_size as a human-readable string.

    Args:
        stock_id: Stock ticker (e.g. "2330").
        name: Stock name in Chinese (e.g. "台積電").
        suggestion: Dict returned by suggest_position_size.

    Returns:
        Formatted multi-line string with position details.
    """
    grade = suggestion.get("grade", "?")
    stop_price = suggestion.get("stop_price", 0.0)
    target_price = suggestion.get("target_price", 0.0)
    shares = suggestion.get("shares", 0)
    risk_pct = suggestion.get("risk_pct", 0.0)
    risk_reward = suggestion.get("risk_reward", 0.0)

    return (
        f"🎯 {stock_id} {name}\n"
        f"建議股數：  {shares:,} 股\n"
        f"停損價：    ¥{stop_price:,.1f} (ATR×2.5)\n"
        f"目標價：    ¥{target_price:,.1f} (+8%)\n"
        f"風險報酬比：{risk_reward:.1f}:1\n"
        f"部位風險：  {risk_pct * 100:.1f}%\n"
        f"等級：      {grade}"
    )
