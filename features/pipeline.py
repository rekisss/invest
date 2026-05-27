"""Unified feature engineering pipeline for stock signals."""
from __future__ import annotations

import pandas as pd


def build_stock_features(
    df: pd.DataFrame,
    config=None,
    market_df: pd.DataFrame | None = None,
    institutional_df: pd.DataFrame | None = None,
    fundamentals_df: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Add all technical and fundamental features to a stock price DataFrame.

    This is a thin wrapper around strategy.prepare_stock_signals() that
    provides a clean, typed interface for the feature pipeline.

    Args:
        df:               OHLCV DataFrame with at minimum: close, volume columns.
        config:           StrategyConfig (uses defaults if None).
        market_df:        TAIEX index DataFrame for relative strength calculations.
        institutional_df: Three institutional investors buy/sell DataFrame.
        fundamentals_df:  Financial statement DataFrame for F-Score.

    Returns:
        df with 100+ indicator columns added in-place (also returned).
    """
    from strategy import prepare_stock_signals, StrategyConfig

    if config is None:
        config = StrategyConfig()

    return prepare_stock_signals(
        df,
        config=config,
        market_df=market_df,
        inst_df=institutional_df,
        fund_df=fundamentals_df,
    )


def build_market_features(
    taiex_df: pd.DataFrame,
    config=None,
) -> pd.DataFrame:
    """Add market-level technical features (MA, regime, breadth)."""
    from strategy import prepare_market_frame, StrategyConfig

    if config is None:
        config = StrategyConfig()

    return prepare_market_frame(taiex_df, config=config)
