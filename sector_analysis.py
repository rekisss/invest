"""
Sector rotation and breadth analysis utilities.

Provides sector-level aggregation of scan results so the aggregate
Discord output can highlight which sectors are showing broad strength.
These functions are purely additive — they read candidate DataFrames
and return enriched ones or summary strings.
"""
from __future__ import annotations

import pandas as pd
import numpy as np


# ── Sector score aggregation ───────────────────────────────────────────────────

def compute_sector_scores(
    df: pd.DataFrame,
    score_col: str = "entry_score",
) -> pd.DataFrame:
    """Return per-sector aggregate statistics sorted by median score descending.

    Returns a DataFrame with columns:
      industry_category, stock_count, median_score, mean_score,
      entry_signal_count, top_stock_id, top_stock_score
    """
    if df.empty or "industry_category" not in df.columns:
        return pd.DataFrame()

    df = df.copy()
    df["industry_category"] = df["industry_category"].fillna("其他").replace("", "其他")
    scores = pd.to_numeric(df[score_col], errors="coerce").fillna(0.0)
    df["_score"] = scores

    entry_col = "entry_signal" if "entry_signal" in df.columns else None

    rows = []
    for sector, grp in df.groupby("industry_category"):
        grp_sorted = grp.sort_values("_score", ascending=False)
        top_row = grp_sorted.iloc[0]
        entry_cnt = int(grp[entry_col].sum()) if entry_col else 0
        rows.append({
            "industry_category": sector,
            "stock_count": len(grp),
            "median_score": round(float(grp["_score"].median()), 1),
            "mean_score": round(float(grp["_score"].mean()), 1),
            "entry_signal_count": entry_cnt,
            "top_stock_id": str(top_row.get("stock_id", "")),
            "top_stock_score": round(float(top_row["_score"]), 1),
        })

    result = pd.DataFrame(rows).sort_values("median_score", ascending=False).reset_index(drop=True)
    return result


def get_sector_leaders(df: pd.DataFrame, top_n: int = 3) -> list[str]:
    """Return the top N sector names ranked by median entry_score.

    Only sectors with ≥2 stocks are considered to avoid single-stock noise.
    """
    sector_df = compute_sector_scores(df)
    if sector_df.empty:
        return []
    sector_df = sector_df[sector_df["stock_count"] >= 2]
    leaders = sector_df.head(top_n)["industry_category"].tolist()
    return leaders


def add_sector_momentum_bonus(
    df: pd.DataFrame,
    leader_sectors: list[str],
    bonus: float = 30.0,
    score_col: str = "entry_score",
) -> pd.DataFrame:
    """Add sector_bonus and sector_adjusted_score columns.

    Stocks in leader sectors receive a bonus on top of their existing entry_score.
    This does NOT modify entry_score — it creates a new sector_adjusted_score column
    so the original signal is preserved.
    """
    df = df.copy()
    df["industry_category"] = df.get("industry_category", pd.Series(dtype=str)).fillna("其他")
    in_leader = df["industry_category"].isin(set(leader_sectors))
    scores = pd.to_numeric(df[score_col], errors="coerce").fillna(0.0)
    df["sector_bonus"] = np.where(in_leader, bonus, 0.0)
    df["sector_adjusted_score"] = (scores + df["sector_bonus"]).round(1)
    return df


# ── Sector breadth summary ─────────────────────────────────────────────────────

def sector_breadth_summary(
    df: pd.DataFrame,
    top_n_sectors: int = 5,
    score_col: str = "entry_score",
) -> str:
    """Return a formatted Discord-ready text block summarising sector distribution.

    Example output:
        📊 **類股強弱**
           1. 半導體  ▸ 8支 | 中位分 1840 | 進場 5支
           2. 電子零組件 ▸ 6支 | 中位分 1720 | 進場 3支
           3. 金融  ▸ 4支 | 中位分 1540 | 進場 2支
    """
    sector_df = compute_sector_scores(df, score_col=score_col)
    if sector_df.empty:
        return ""

    lines = ["📊 **類股強弱**"]
    for i, row in sector_df.head(top_n_sectors).iterrows():
        entry_part = f" | 進場 `{int(row['entry_signal_count'])}`支" if row["entry_signal_count"] > 0 else ""
        lines.append(
            f"   {int(i)+1}. **{row['industry_category']}**"
            f"  ▸ `{int(row['stock_count'])}`支"
            f" | 中位分 `{row['median_score']:.0f}`"
            f"{entry_part}"
        )
    return "\n".join(lines)


# ── Sector relative strength ───────────────────────────────────────────────────

def sector_relative_strength(
    df: pd.DataFrame,
    return_col: str = "return_5d",
) -> pd.DataFrame:
    """Compute sector-level average 5-day return vs overall market average.

    Returns a DataFrame with columns:
      industry_category, sector_rs, sector_avg_return, stock_count
    where sector_rs = sector_avg_return - overall_avg_return.
    """
    if df.empty or "industry_category" not in df.columns or return_col not in df.columns:
        return pd.DataFrame()

    df = df.copy()
    df["industry_category"] = df["industry_category"].fillna("其他").replace("", "其他")
    ret = pd.to_numeric(df[return_col], errors="coerce")
    overall_avg = float(ret.mean())

    rows = []
    for sector, grp in df.groupby("industry_category"):
        grp_ret = pd.to_numeric(grp[return_col], errors="coerce")
        sector_avg = float(grp_ret.mean())
        rows.append({
            "industry_category": sector,
            "sector_avg_return": round(sector_avg, 4),
            "sector_rs": round(sector_avg - overall_avg, 4),
            "stock_count": len(grp),
        })

    result = pd.DataFrame(rows).sort_values("sector_rs", ascending=False).reset_index(drop=True)
    return result


def get_rotating_in_sectors(
    df: pd.DataFrame,
    rs_threshold: float = 0.005,
    min_stocks: int = 2,
) -> list[str]:
    """Return sectors that are rotating in (above-market return + sufficient breadth).

    Criteria: sector_rs >= rs_threshold AND stock_count >= min_stocks.
    Used to identify early-stage sector rotation.
    """
    rs_df = sector_relative_strength(df)
    if rs_df.empty:
        return []
    condition = (rs_df["sector_rs"] >= rs_threshold) & (rs_df["stock_count"] >= min_stocks)
    return rs_df[condition]["industry_category"].tolist()
