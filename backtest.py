from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import pandas as pd

from strategy import StrategyConfig


@dataclass
class Position:
    position_id: int
    stock_id: str
    name: str
    entry_date: pd.Timestamp
    entry_price: float
    quantity: int
    initial_quantity: int
    peak_price: float
    partial_taken: bool = False


@dataclass
class FillRecord:
    position_id: int
    stock_id: str
    name: str
    entry_date: pd.Timestamp
    exit_date: pd.Timestamp
    entry_price: float
    exit_price: float
    quantity: int
    pnl: float
    return_pct: float
    reason: str
    partial_exit: bool


def run_backtest(
    signals_by_stock: dict[str, pd.DataFrame],
    market_df: pd.DataFrame,
    config: StrategyConfig,
    initial_capital: float,
) -> dict[str, pd.DataFrame | dict[str, float] | list[str]]:
    master_dates = pd.DatetimeIndex(sorted(pd.to_datetime(market_df["date"]).unique()))
    prepared = {
        stock_id: frame.set_index("date").sort_index()
        for stock_id, frame in signals_by_stock.items()
        if not frame.empty
    }

    cash = float(initial_capital)
    positions: dict[str, Position] = {}
    fills: list[FillRecord] = []
    equity_rows: list[dict[str, float | pd.Timestamp]] = []
    notes: list[str] = []
    next_position_id = 1

    for date in master_dates:
        daily_candidates: list[tuple[float, str, pd.Series]] = []

        for stock_id, frame in prepared.items():
            if date not in frame.index:
                continue
            row = frame.loc[date]

            if stock_id in positions:
                position = positions[stock_id]
                close_price = float(row["close"])
                position.peak_price = max(position.peak_price, close_price)

                exit_reasons: list[str] = []
                if bool(row["macd_death_cross"]):
                    exit_reasons.append("macd_death_cross")
                if bool(row["close_below_ema20"]):
                    exit_reasons.append("close_below_ema20")
                if bool(row["close_below_swing_low"]):
                    exit_reasons.append("close_below_swing_low")
                if close_price <= position.entry_price * (1 - config.stop_loss_pct):
                    exit_reasons.append("stop_loss_5pct")

                if not position.partial_taken and close_price >= position.entry_price * (1 + config.take_profit_pct):
                    sell_qty = max(1, position.quantity // 2)
                    fill = _close_quantity(position, sell_qty, close_price, date, "take_profit_10pct_partial")
                    fills.append(fill)
                    cash += sell_qty * close_price
                    position.quantity -= sell_qty
                    position.partial_taken = True

                if position.partial_taken and close_price <= position.peak_price * (1 - config.trailing_stop_pct):
                    exit_reasons.append("trailing_stop_7pct")

                if exit_reasons:
                    sell_qty = position.quantity
                    fill = _close_quantity(position, sell_qty, close_price, date, "|".join(exit_reasons))
                    fills.append(fill)
                    cash += sell_qty * close_price
                    del positions[stock_id]
                    continue

            if stock_id not in positions and bool(row["entry_signal"]):
                daily_candidates.append((float(row["entry_score"]), stock_id, row))

        if daily_candidates and len(positions) < config.max_positions:
            daily_candidates.sort(key=lambda item: item[0], reverse=True)
            opened_today = 0

            for _, stock_id, row in daily_candidates:
                if opened_today >= config.max_new_positions_per_day:
                    break
                if len(positions) >= config.max_positions:
                    break
                if stock_id in positions:
                    continue

                price = float(row["close"])
                risk_budget = portfolio_equity(cash, positions, prepared, date) * config.risk_per_trade
                risk_per_share = price * config.stop_loss_pct
                if risk_per_share <= 0:
                    continue

                shares_by_risk = math.floor(risk_budget / risk_per_share)
                shares_by_cash = math.floor(cash / price)
                quantity = int(min(shares_by_risk, shares_by_cash))
                if quantity <= 0:
                    continue

                position = Position(
                    position_id=next_position_id,
                    stock_id=stock_id,
                    name=str(row["name"]),
                    entry_date=date,
                    entry_price=price,
                    quantity=quantity,
                    initial_quantity=quantity,
                    peak_price=price,
                )
                positions[stock_id] = position
                cash -= quantity * price
                next_position_id += 1
                opened_today += 1

        equity_rows.append(
            {
                "date": date,
                "cash": cash,
                "market_value": positions_market_value(positions, prepared, date),
                "equity": portfolio_equity(cash, positions, prepared, date),
                "positions": len(positions),
            }
        )

    if positions:
        final_date = master_dates[-1]
        for stock_id, position in list(positions.items()):
            close_price = _get_close_price(prepared[stock_id], final_date)
            fill = _close_quantity(position, position.quantity, close_price, final_date, "final_liquidation")
            fills.append(fill)
            cash += position.quantity * close_price
            del positions[stock_id]
        equity_rows[-1]["cash"] = cash
        equity_rows[-1]["market_value"] = 0.0
        equity_rows[-1]["equity"] = cash
        notes.append("Open positions were liquidated on the last backtest date for performance calculation.")

    equity_curve = pd.DataFrame(equity_rows)
    fill_frame = pd.DataFrame(asdict(fill) for fill in fills)
    trade_summary = summarize_trades(fill_frame)
    metrics = compute_performance_metrics(equity_curve, trade_summary, initial_capital)
    yearly = compute_yearly_performance(equity_curve)

    return {
        "equity_curve": equity_curve,
        "fills": fill_frame,
        "trade_summary": trade_summary,
        "metrics": metrics,
        "yearly": yearly,
        "notes": notes,
    }


def _get_close_price(frame: pd.DataFrame, date: pd.Timestamp) -> float:
    if date in frame.index:
        return float(frame.loc[date, "close"])
    prior = frame.loc[:date]
    if prior.empty:
        raise KeyError(f"No close price for {date}")
    return float(prior.iloc[-1]["close"])


def positions_market_value(
    positions: dict[str, Position],
    prepared: dict[str, pd.DataFrame],
    date: pd.Timestamp,
) -> float:
    total = 0.0
    for stock_id, position in positions.items():
        total += position.quantity * _get_close_price(prepared[stock_id], date)
    return total


def portfolio_equity(
    cash: float,
    positions: dict[str, Position],
    prepared: dict[str, pd.DataFrame],
    date: pd.Timestamp,
) -> float:
    return cash + positions_market_value(positions, prepared, date)


def _close_quantity(
    position: Position,
    quantity: int,
    exit_price: float,
    exit_date: pd.Timestamp,
    reason: str,
) -> FillRecord:
    pnl = (exit_price - position.entry_price) * quantity
    return_pct = (exit_price / position.entry_price) - 1
    return FillRecord(
        position_id=position.position_id,
        stock_id=position.stock_id,
        name=position.name,
        entry_date=position.entry_date,
        exit_date=exit_date,
        entry_price=position.entry_price,
        exit_price=exit_price,
        quantity=quantity,
        pnl=pnl,
        return_pct=return_pct,
        reason=reason,
        partial_exit=quantity < position.initial_quantity,
    )


def summarize_trades(fill_frame: pd.DataFrame) -> pd.DataFrame:
    if fill_frame.empty:
        return pd.DataFrame(
            columns=[
                "position_id",
                "stock_id",
                "name",
                "entry_date",
                "exit_date",
                "entry_price",
                "avg_exit_price",
                "quantity",
                "pnl",
                "return_pct",
                "exit_reasons",
            ]
        )

    grouped = fill_frame.groupby("position_id", as_index=False).agg(
        stock_id=("stock_id", "first"),
        name=("name", "first"),
        entry_date=("entry_date", "first"),
        exit_date=("exit_date", "last"),
        entry_price=("entry_price", "first"),
        quantity=("quantity", "sum"),
        pnl=("pnl", "sum"),
    )
    weighted_exit = (
        fill_frame.assign(weighted_exit=fill_frame["exit_price"] * fill_frame["quantity"])
        .groupby("position_id", as_index=False)
        .agg(weighted_exit=("weighted_exit", "sum"), quantity=("quantity", "sum"))
    )
    reasons = (
        fill_frame.groupby("position_id")["reason"]
        .apply(lambda values: " | ".join(values.astype(str)))
        .reset_index(name="exit_reasons")
    )
    summary = grouped.merge(weighted_exit, on=["position_id", "quantity"]).merge(reasons, on="position_id")
    summary["avg_exit_price"] = summary["weighted_exit"] / summary["quantity"]
    summary["return_pct"] = summary["avg_exit_price"] / summary["entry_price"] - 1
    summary = summary.drop(columns=["weighted_exit"])
    return summary.sort_values(["exit_date", "position_id"]).reset_index(drop=True)


def compute_performance_metrics(
    equity_curve: pd.DataFrame,
    trade_summary: pd.DataFrame,
    initial_capital: float,
) -> dict[str, float]:
    if equity_curve.empty:
        return {}

    equity = equity_curve["equity"].astype(float)
    daily_returns = equity.pct_change().fillna(0)
    running_max = equity.cummax()
    drawdown = equity / running_max - 1

    years = max((equity_curve["date"].iloc[-1] - equity_curve["date"].iloc[0]).days / 365.25, 1 / 365.25)
    ending_value = float(equity.iloc[-1])
    cagr = (ending_value / initial_capital) ** (1 / years) - 1

    sharpe = 0.0
    if daily_returns.std(ddof=0) > 0:
        sharpe = (daily_returns.mean() / daily_returns.std(ddof=0)) * (252 ** 0.5)

    gross_profit = float(trade_summary.loc[trade_summary["pnl"] > 0, "pnl"].sum()) if not trade_summary.empty else 0.0
    gross_loss = float(trade_summary.loc[trade_summary["pnl"] < 0, "pnl"].sum()) if not trade_summary.empty else 0.0
    profit_factor = gross_profit / abs(gross_loss) if gross_loss != 0 else float("inf") if gross_profit > 0 else 0.0

    wins = int((trade_summary["pnl"] > 0).sum()) if not trade_summary.empty else 0
    trades = int(len(trade_summary))
    win_rate = wins / trades if trades else 0.0

    return {
        "initial_capital": initial_capital,
        "ending_capital": ending_value,
        "total_return_pct": (ending_value / initial_capital - 1) * 100,
        "annual_return_pct": cagr * 100,
        "max_drawdown_pct": drawdown.min() * 100,
        "sharpe_ratio": sharpe,
        "profit_factor": profit_factor,
        "win_rate_pct": win_rate * 100,
        "total_trades": trades,
    }


def compute_yearly_performance(equity_curve: pd.DataFrame) -> pd.DataFrame:
    if equity_curve.empty:
        return pd.DataFrame(columns=["year", "starting_equity", "ending_equity", "pnl", "return_pct"])

    frame = equity_curve.copy()
    frame["year"] = pd.to_datetime(frame["date"]).dt.year
    yearly = frame.groupby("year", as_index=False).agg(
        starting_equity=("equity", "first"),
        ending_equity=("equity", "last"),
    )
    yearly["pnl"] = yearly["ending_equity"] - yearly["starting_equity"]
    yearly["return_pct"] = yearly["ending_equity"] / yearly["starting_equity"] - 1
    yearly["return_pct"] = yearly["return_pct"] * 100
    return yearly
