"""
Statistical backtest metrics for strategy evaluation.

Computes precision/recall, Sharpe ratio, max drawdown, and confusion matrix
from backtest result DataFrames produced by backtest.py.

Standalone module — no existing files modified.
"""

import math
import pandas as pd
import numpy as np


def sharpe_ratio(
    returns: "pd.Series | list",
    risk_free_rate: float = 0.02,
    annualize: bool = True,
) -> float:
    """
    Compute annualized Sharpe ratio from a Series of period returns.

    Parameters
    ----------
    returns : pd.Series or list
        Period returns as decimals (e.g., daily returns).
    risk_free_rate : float
        Annual risk-free rate (default 0.02).  Divided by 252 for daily.
    annualize : bool
        If True, multiply by sqrt(252) to annualize.

    Returns
    -------
    float
        Sharpe ratio, or 0.0 if std == 0 or fewer than 2 data points.
    """
    r = pd.Series(returns, dtype=float)
    if len(r) < 2:
        return 0.0

    daily_rf = risk_free_rate / 252.0
    excess = r - daily_rf
    std = excess.std(ddof=1)
    if math.isnan(std) or std == 0 or np.isclose(std, 0.0, atol=1e-12):
        return 0.0

    ratio = excess.mean() / std
    if annualize:
        ratio *= math.sqrt(252)
    return float(ratio)


def max_drawdown(equity_curve: "pd.Series | list") -> float:
    """
    Compute maximum drawdown from an equity curve.

    Parameters
    ----------
    equity_curve : pd.Series or list
        Cumulative portfolio values over time.

    Returns
    -------
    float
        Maximum drawdown as a positive decimal (e.g., 0.25 for 25% drawdown),
        or 0.0 if fewer than 2 points or no drawdown.
    """
    eq = pd.Series(equity_curve, dtype=float)
    if len(eq) < 2:
        return 0.0

    running_max = eq.cummax()
    drawdowns = (running_max - eq) / running_max
    dd = drawdowns.max()
    if math.isnan(dd) or dd < 0:
        return 0.0
    return float(dd)


def calmar_ratio(
    returns: "pd.Series | list",
    equity_curve: "pd.Series | list",
) -> float:
    """
    Compute Calmar ratio = annualized_return / max_drawdown.

    Parameters
    ----------
    returns : pd.Series or list
        Period returns as decimals.
    equity_curve : pd.Series or list
        Cumulative portfolio values over time.

    Returns
    -------
    float
        Calmar ratio, or 0.0 if max_drawdown is 0.
    """
    r = pd.Series(returns, dtype=float)
    n = len(r)
    if n == 0:
        return 0.0

    total_return = (1 + r).prod() - 1
    annualized = (1 + total_return) ** (252.0 / n) - 1

    dd = max_drawdown(equity_curve)
    if dd == 0.0:
        return 0.0

    return float(annualized / dd)


def win_rate(trade_returns: "pd.Series | list") -> float:
    """
    Proportion of trades with positive return.

    Parameters
    ----------
    trade_returns : pd.Series or list
        Individual trade returns as decimals.

    Returns
    -------
    float
        Win rate in [0, 1]; 0.0 if empty.
    """
    r = pd.Series(trade_returns, dtype=float)
    if len(r) == 0:
        return 0.0
    return float((r > 0).sum() / len(r))


def profit_factor(trade_returns: "pd.Series | list") -> float:
    """
    Sum of winning returns / abs(sum of losing returns).

    Parameters
    ----------
    trade_returns : pd.Series or list
        Individual trade returns as decimals.

    Returns
    -------
    float
        Profit factor, or 0.0 if sum of losing returns is 0.
    """
    r = pd.Series(trade_returns, dtype=float)
    wins = r[r > 0].sum()
    losses = r[r < 0].sum()  # negative number
    if losses == 0.0:
        return 0.0
    return float(wins / abs(losses))


def precision_at_k(
    y_true: "list | pd.Series",
    y_scores: "list | pd.Series",
    k: int,
) -> float:
    """
    Precision of the top-k predictions sorted by score descending.

    Parameters
    ----------
    y_true : list or pd.Series
        Binary ground-truth labels (0/1).
    y_scores : list or pd.Series
        Predicted scores/probabilities.
    k : int
        Number of top predictions to consider.

    Returns
    -------
    float
        Precision at k, or 0.0 if k == 0 or inputs are empty.
    """
    if k == 0:
        return 0.0

    true = pd.Series(y_true, dtype=float)
    scores = pd.Series(y_scores, dtype=float)

    if len(true) == 0:
        return 0.0

    # Sort by scores descending and take top k
    sorted_indices = scores.argsort()[::-1].iloc[:k]
    top_k_true = true.iloc[sorted_indices.values]
    return float(top_k_true.mean())


def recall_at_k(
    y_true: "list | pd.Series",
    y_scores: "list | pd.Series",
    k: int,
) -> float:
    """
    Among actual positives, what fraction appear in top-k by score.

    Parameters
    ----------
    y_true : list or pd.Series
        Binary ground-truth labels (0/1).
    y_scores : list or pd.Series
        Predicted scores/probabilities.
    k : int
        Number of top predictions to consider.

    Returns
    -------
    float
        Recall at k, or 0.0 if there are no actual positives.
    """
    true = pd.Series(y_true, dtype=float)
    scores = pd.Series(y_scores, dtype=float)

    total_positives = (true == 1).sum()
    if total_positives == 0:
        return 0.0

    sorted_indices = scores.argsort()[::-1].iloc[:k]
    top_k_true = true.iloc[sorted_indices.values]
    hits = (top_k_true == 1).sum()
    return float(hits / total_positives)


def confusion_matrix_summary(
    y_true: "list | pd.Series",
    y_pred: "list | pd.Series",
    threshold: float = 0.5,
) -> dict:
    """
    Compute confusion matrix components and derived metrics.

    Parameters
    ----------
    y_true : list or pd.Series
        Binary ground-truth labels (0/1).
    y_pred : list or pd.Series
        Predicted probabilities or binary labels.  Values not already 0/1
        are binarized using ``threshold``.
    threshold : float
        Binarization threshold for y_pred (default 0.5).

    Returns
    -------
    dict
        Keys: tp, fp, tn, fn, precision, recall, f1, accuracy.
        Floats are rounded to 4 decimal places.
    """
    true = pd.Series(y_true, dtype=float)
    pred_raw = pd.Series(y_pred, dtype=float)

    # Binarize predictions if not already 0/1
    unique_pred = set(pred_raw.unique())
    if unique_pred <= {0.0, 1.0}:
        pred = pred_raw.astype(int)
    else:
        pred = (pred_raw >= threshold).astype(int)

    true_int = true.astype(int)

    tp = int(((true_int == 1) & (pred == 1)).sum())
    fp = int(((true_int == 0) & (pred == 1)).sum())
    tn = int(((true_int == 0) & (pred == 0)).sum())
    fn = int(((true_int == 1) & (pred == 0)).sum())

    precision = round(tp / (tp + fp), 4) if (tp + fp) > 0 else 0.0
    recall = round(tp / (tp + fn), 4) if (tp + fn) > 0 else 0.0
    f1_denom = precision + recall
    f1 = round(2 * precision * recall / f1_denom, 4) if f1_denom > 0 else 0.0
    total = tp + fp + tn + fn
    accuracy = round((tp + tn) / total, 4) if total > 0 else 0.0

    return {
        "tp": tp,
        "fp": fp,
        "tn": tn,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "accuracy": accuracy,
    }


def trade_statistics(
    trade_df: pd.DataFrame,
    return_col: str = "trade_return",
) -> dict:
    """
    Compute summary statistics for a DataFrame of trades.

    Parameters
    ----------
    trade_df : pd.DataFrame
        DataFrame containing at least a column of trade returns.
    return_col : str
        Name of the column with per-trade returns (default "trade_return").

    Returns
    -------
    dict
        Keys: n_trades, win_rate, profit_factor, avg_return, median_return,
        max_win, max_loss, avg_win, avg_loss.
        Returns a dict of zeros if the DataFrame is empty.
    """
    empty = {
        "n_trades": 0,
        "win_rate": 0.0,
        "profit_factor": 0.0,
        "avg_return": 0.0,
        "median_return": 0.0,
        "max_win": 0.0,
        "max_loss": 0.0,
        "avg_win": 0.0,
        "avg_loss": 0.0,
    }

    if trade_df is None or trade_df.empty:
        return empty

    if return_col not in trade_df.columns:
        return empty

    r = trade_df[return_col].dropna().astype(float)
    if len(r) == 0:
        return empty

    wins = r[r > 0]
    losses = r[r < 0]

    return {
        "n_trades": int(len(r)),
        "win_rate": round(float(win_rate(r)), 4),
        "profit_factor": round(float(profit_factor(r)), 4),
        "avg_return": round(float(r.mean()), 4),
        "median_return": round(float(r.median()), 4),
        "max_win": round(float(wins.max()) if len(wins) > 0 else 0.0, 4),
        "max_loss": round(float(losses.min()) if len(losses) > 0 else 0.0, 4),
        "avg_win": round(float(wins.mean()) if len(wins) > 0 else 0.0, 4),
        "avg_loss": round(float(abs(losses.mean())) if len(losses) > 0 else 0.0, 4),
    }


def format_backtest_report(stats: dict) -> str:
    """
    Format trade_statistics output as a Discord/console-friendly string.

    Parameters
    ----------
    stats : dict
        Output from ``trade_statistics()``.

    Returns
    -------
    str
        Formatted multi-line report string.
    """
    n_trades = stats.get("n_trades", 0)
    wr = stats.get("win_rate", 0.0) * 100
    pf = stats.get("profit_factor", 0.0)
    avg_ret = stats.get("avg_return", 0.0) * 100
    max_win = stats.get("max_win", 0.0) * 100
    max_loss = stats.get("max_loss", 0.0) * 100  # negative value

    sign_avg = "+" if avg_ret >= 0 else ""
    sign_win = "+" if max_win >= 0 else ""
    sign_loss = "+" if max_loss >= 0 else ""

    divider = "─" * 29

    lines = [
        "📈 回測績效報告",
        divider,
        f"交易筆數：  {n_trades}",
        f"勝率：      {wr:.1f}%",
        f"獲利因子：  {pf:.2f}",
        f"平均報酬：  {sign_avg}{avg_ret:.2f}%",
        f"最大獲利：  {sign_win}{max_win:.1f}%",
        f"最大虧損：  {sign_loss}{max_loss:.1f}%",
        divider,
    ]
    return "\n".join(lines)
