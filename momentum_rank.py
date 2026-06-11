"""
Multi-timeframe momentum ranking utilities.

Implements dual-momentum and cross-sectional relative strength rankings.
Based on academic momentum research: 1-month, 3-month, 6-month, and 12-month
lookback periods. Provides sector-relative momentum as well.

Standalone module — no existing files modified.
"""

import math

import numpy as np
import pandas as pd


def compute_price_momentum(
    prices: pd.DataFrame,
    lookbacks: list[int] | None = None,
) -> pd.DataFrame:
    """
    Compute multi-timeframe momentum for each stock.

    Parameters
    ----------
    prices : pd.DataFrame
        columns = stock_ids, index = dates (most recent last).
    lookbacks : list[int] | None
        Trading-day lookback periods.  Default [21, 63, 126, 252].

    Returns
    -------
    pd.DataFrame
        Index = stock_id, columns = mom_1m / mom_3m / mom_6m / mom_12m.
        NaN where insufficient history exists.
    """
    if lookbacks is None:
        lookbacks = [21, 63, 126, 252]

    label_map = {21: "mom_1m", 63: "mom_3m", 126: "mom_6m", 252: "mom_12m"}
    col_names = [label_map.get(lb, f"mom_{lb}d") for lb in lookbacks]

    n_rows = len(prices)
    results: dict[str, pd.Series] = {}

    for lb, col in zip(lookbacks, col_names):
        if lb == 21:
            # 1-month: simply end / start(21 days ago) - 1
            if n_rows < lb + 1:
                results[col] = pd.Series(np.nan, index=prices.columns)
            else:
                end = prices.iloc[-1]
                start = prices.iloc[-lb - 1]
                results[col] = end / start - 1
        else:
            # Skip most-recent month (reversal bias avoidance).
            # numerator = price 22 days ago, denominator = price L+1 days ago
            if n_rows < lb + 1:
                results[col] = pd.Series(np.nan, index=prices.columns)
            else:
                end = prices.iloc[-22]        # 1 month ago
                start = prices.iloc[-lb - 1]  # L+1 days ago
                results[col] = end / start - 1

    df = pd.DataFrame(results)
    df.index.name = "stock_id"
    return df


def compute_composite_momentum(
    momentum_df: pd.DataFrame,
    weights: dict | None = None,
) -> pd.Series:
    """
    Combine multi-timeframe momentum columns into a single composite score.

    Each momentum column is independently percentile-ranked (0-1), then the
    weighted average of those ranks is returned.

    Parameters
    ----------
    momentum_df : pd.DataFrame
        Output of compute_price_momentum.
    weights : dict | None
        Column → weight mapping.  Defaults to
        {"mom_3m": 0.4, "mom_6m": 0.3, "mom_12m": 0.2, "mom_1m": 0.1}.

    Returns
    -------
    pd.Series
        Composite momentum score in [0, 1], indexed by stock_id.
    """
    if weights is None:
        weights = {"mom_3m": 0.4, "mom_6m": 0.3, "mom_12m": 0.2, "mom_1m": 0.1}

    # Keep only columns that exist in momentum_df
    active_weights = {c: w for c, w in weights.items() if c in momentum_df.columns}

    if not active_weights:
        return pd.Series(np.nan, index=momentum_df.index)

    total_weight = sum(active_weights.values())

    ranked_parts: list[pd.Series] = []
    for col, w in active_weights.items():
        ranked = momentum_df[col].rank(pct=True, na_option="keep")
        ranked_parts.append(ranked * (w / total_weight))

    composite = pd.concat(ranked_parts, axis=1).sum(axis=1, min_count=1)
    composite.name = "composite_momentum"
    return composite


def rank_by_momentum(
    prices: pd.DataFrame,
    top_n: int = 20,
    min_periods: int = 63,
) -> pd.DataFrame:
    """
    Full pipeline: momentum → composite score → top-N ranking.

    Parameters
    ----------
    prices : pd.DataFrame
        columns = stock_ids, index = dates (most recent last).
    top_n : int
        Number of top stocks to return.
    min_periods : int
        Minimum number of valid trading days required for a stock to qualify.

    Returns
    -------
    pd.DataFrame
        Columns: stock_id, composite_momentum, mom_1m, mom_3m, mom_6m, mom_12m.
        At most top_n rows, sorted descending by composite_momentum.
    """
    # Filter stocks by data availability (non-NaN rows)
    valid_stocks = [
        col for col in prices.columns if prices[col].count() >= min_periods
    ]
    if not valid_stocks:
        return pd.DataFrame(
            columns=["stock_id", "composite_momentum", "mom_1m", "mom_3m", "mom_6m", "mom_12m"]
        )

    filtered = prices[valid_stocks]
    mom_df = compute_price_momentum(filtered)
    composite = compute_composite_momentum(mom_df)

    result = mom_df.copy()
    result.insert(0, "composite_momentum", composite)
    result = result.sort_values("composite_momentum", ascending=False).head(top_n)
    result = result.reset_index()  # stock_id becomes a column

    # Ensure consistent column order
    base_cols = ["stock_id", "composite_momentum"]
    mom_cols = [c for c in ["mom_1m", "mom_3m", "mom_6m", "mom_12m"] if c in result.columns]
    return result[base_cols + mom_cols]


def absolute_momentum_filter(
    prices: pd.DataFrame,
    benchmark_prices: pd.Series,
    lookback: int = 252,
) -> pd.Series:
    """
    Dual Momentum filter: keep stocks whose 12-month return exceeds the benchmark.

    Parameters
    ----------
    prices : pd.DataFrame
        columns = stock_ids, index = dates (most recent last).
    benchmark_prices : pd.Series
        Benchmark index prices (e.g., TAIEX), most recent last.
    lookback : int
        Lookback window in trading days (default 252 ≈ 12 months).

    Returns
    -------
    pd.Series
        Boolean Series indexed by stock_id.
        True → stock outperformed the benchmark.
    """
    # Return all True when benchmark data is insufficient
    if benchmark_prices is None or len(benchmark_prices) < lookback + 1:
        return pd.Series(True, index=prices.columns)

    bench_return = (
        benchmark_prices.iloc[-1] / benchmark_prices.iloc[-lookback - 1] - 1
    )

    if len(prices) < lookback + 1:
        return pd.Series(True, index=prices.columns)

    stock_returns = prices.iloc[-1] / prices.iloc[-lookback - 1] - 1
    result = stock_returns > bench_return
    result.index.name = "stock_id"
    return result


def cross_sectional_rs(
    prices: pd.DataFrame,
    window: int = 63,
) -> pd.Series:
    """
    Cross-sectional relative strength: average daily percentile rank over a window.

    Parameters
    ----------
    prices : pd.DataFrame
        columns = stock_ids, index = dates (most recent last).
    window : int
        Number of trailing days to include.

    Returns
    -------
    pd.Series
        Average percentile rank (0-1) over the window, indexed by stock_id.
        Higher = stock consistently outperformed peers.
    """
    if len(prices) < window:
        window_data = prices
    else:
        window_data = prices.iloc[-window:]

    # Rank each row (day) cross-sectionally, result is (window, n_stocks)
    daily_ranks = window_data.rank(axis=1, pct=True)
    avg_rank = daily_ranks.mean(axis=0)
    avg_rank.index.name = "stock_id"
    avg_rank.name = "cross_sectional_rs"
    return avg_rank


def momentum_score_to_bonus(composite_score: float) -> int:
    """
    Map a composite momentum score (0-1) to an additive scanner bonus.

    Parameters
    ----------
    composite_score : float
        Output of compute_composite_momentum for a single stock.

    Returns
    -------
    int
        Additive bonus: 50 / 30 / 10 / 0 / -20.
        Returns 0 for NaN/None.
    """
    try:
        if math.isnan(composite_score):
            return 0
    except (TypeError, ValueError):
        return 0

    if composite_score >= 0.90:
        return 50
    if composite_score >= 0.75:
        return 30
    if composite_score >= 0.50:
        return 10
    if composite_score >= 0.25:
        return 0
    return -20


def format_momentum_report(ranked_df: pd.DataFrame, top_n: int = 10) -> str:
    """
    Format rank_by_momentum output as a Discord-friendly block.

    Parameters
    ----------
    ranked_df : pd.DataFrame
        Output of rank_by_momentum (already sorted descending).
    top_n : int
        Number of rows to show.

    Returns
    -------
    str
        Formatted report string, or "" if ranked_df is empty.
    """
    if ranked_df is None or ranked_df.empty:
        return ""

    rows = ranked_df.head(top_n)
    lines: list[str] = [
        f"🚀 動能排行榜 TOP {top_n}",
        "──────────────────────────────────",
    ]

    for rank, (_, row) in enumerate(rows.iterrows(), start=1):
        stock_id = row.get("stock_id", "?")
        composite = row.get("composite_momentum", float("nan"))
        mom_1m = row.get("mom_1m", float("nan"))
        mom_3m = row.get("mom_3m", float("nan"))
        mom_6m = row.get("mom_6m", float("nan"))

        def _fmt(val: float) -> str:
            if val is None or (isinstance(val, float) and math.isnan(val)):
                return "N/A"
            sign = "+" if val >= 0 else ""
            return f"{sign}{val * 100:.1f}%"

        comp_str = f"{composite:.2f}" if not (isinstance(composite, float) and math.isnan(composite)) else "N/A"

        line = (
            f"{rank:2d}. {stock_id}  動能 {comp_str} | "
            f"1M {_fmt(mom_1m)} | "
            f"3M {_fmt(mom_3m)} | "
            f"6M {_fmt(mom_6m)}"
        )
        lines.append(line)

    return "\n".join(lines)
