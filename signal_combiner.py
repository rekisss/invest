"""
Unified signal integration layer.

Combines outputs from all new standalone modules into a single enrichment
function that augments a scanner results DataFrame with:
  - Score grading (post_process)
  - Revenue signals (monthly_revenue)
  - Volume signals (volume_signal)
  - Calendar risk (calendar_guard)
  - Sector analysis (sector_analysis)
  - Risk management suggestions (risk_manager)

Call enrich_candidates() to add all signals to a scan result DataFrame.
Standalone module — no existing files modified.
"""
from __future__ import annotations

import math
import pandas as pd


def enrich_candidates(
    df: pd.DataFrame,
    scan_date: str,
    regime_label: str = "未知",
    portfolio_value: float = 1_000_000.0,
    max_per_sector: int = 3,
    revenue_df: pd.DataFrame | None = None,
    holding_df: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Apply each enrichment step to the scan result DataFrame.

    Parameters
    ----------
    df : pd.DataFrame
        Scanner results with at least stock_id and entry_score columns.
    scan_date : str
        Date of the scan in YYYY-MM-DD format.
    regime_label : str
        Market regime label (e.g. '牛市', '熊市', '盤整', '未知').
    portfolio_value : float
        Total portfolio value in TWD (used for position sizing).
    max_per_sector : int
        Maximum stocks per sector (passed to post_process.enrich).
    revenue_df : pd.DataFrame, optional
        DataFrame with stock_id, revenue_yoy, revenue_mom, revenue_3m_yoy.
    holding_df : pd.DataFrame, optional
        DataFrame with stock_id, foreign_holding_chg_5d, holding_bonus.

    Returns
    -------
    pd.DataFrame
        Enriched copy of df (input is never modified).
    """
    result = df.copy()

    # Step 1: post_process.enrich — adds grade, regime_score, regime_label,
    #         data_quality_ok, data_quality_note
    try:
        from post_process import enrich
        result = enrich(result, regime_label, max_per_sector)
    except Exception:
        pass

    # Step 2: Revenue signals — merge and compute bonus per row
    try:
        if revenue_df is not None and not revenue_df.empty:
            rev_cols = ["stock_id"]
            for col in ("revenue_yoy", "revenue_mom", "revenue_3m_yoy"):
                if col in revenue_df.columns:
                    rev_cols.append(col)
            rev_merge = revenue_df[rev_cols].copy()
            rev_merge["stock_id"] = rev_merge["stock_id"].astype(str)
            result["stock_id"] = result["stock_id"].astype(str)
            result = result.merge(rev_merge, on="stock_id", how="left")

            if "revenue_yoy" in result.columns:
                import monthly_revenue as _mr
                result["revenue_bonus"] = result["revenue_yoy"].apply(
                    lambda v: _mr.revenue_score_bonus(v if not (isinstance(v, float) and math.isnan(v)) else None)
                )
    except Exception:
        pass

    # Step 3: Calendar risk — same value for all rows
    try:
        from calendar_guard import get_calendar_risk_label
        result["calendar_risk"] = get_calendar_risk_label(scan_date)
    except Exception:
        pass

    # Step 4: ATR-based stop losses
    try:
        if "atr14" in result.columns and "close" in result.columns:
            import risk_manager as _rm
            result["suggested_stop"] = result.apply(
                lambda row: _rm.atr_stop_loss(
                    float(row["close"]) if row["close"] is not None else 0.0,
                    float(row["atr14"]) if row["atr14"] is not None else 0.0,
                ),
                axis=1,
            )
    except Exception:
        pass

    # Step 5: Foreign holding data
    try:
        if holding_df is not None and not holding_df.empty:
            hold_cols = ["stock_id"]
            for col in ("foreign_holding_chg_5d", "holding_bonus"):
                if col in holding_df.columns:
                    hold_cols.append(col)
            hold_merge = holding_df[hold_cols].copy()
            hold_merge["stock_id"] = hold_merge["stock_id"].astype(str)
            result["stock_id"] = result["stock_id"].astype(str)
            result = result.merge(hold_merge, on="stock_id", how="left")
    except Exception:
        pass

    return result


def compute_final_score(
    df: pd.DataFrame,
    base_col: str = "entry_score",
) -> pd.DataFrame:
    """Combine base score with optional bonuses into a single final_score.

    Uses regime_score as base if present, otherwise base_col.
    Adds revenue_bonus and holding_bonus when those columns exist.

    Parameters
    ----------
    df : pd.DataFrame
        Enriched DataFrame (typically the output of enrich_candidates).
    base_col : str
        Fallback score column when regime_score is absent.

    Returns
    -------
    pd.DataFrame
        Copy of df with final_score column added.
    """
    result = df.copy()

    if "regime_score" in result.columns:
        base = pd.to_numeric(result["regime_score"], errors="coerce").fillna(0.0)
    else:
        base = pd.to_numeric(result.get(base_col, 0), errors="coerce").fillna(0.0)

    bonus = pd.Series(0.0, index=result.index)
    if "revenue_bonus" in result.columns:
        bonus += pd.to_numeric(result["revenue_bonus"], errors="coerce").fillna(0.0)
    if "holding_bonus" in result.columns:
        bonus += pd.to_numeric(result["holding_bonus"], errors="coerce").fillna(0.0)

    result["final_score"] = (base + bonus).round(1)
    return result


def top_candidates(
    df: pd.DataFrame,
    n: int = 20,
    score_col: str = "final_score",
    grade_exclude: list[str] | None = None,
) -> pd.DataFrame:
    """Return the top n candidates sorted by score_col.

    Parameters
    ----------
    df : pd.DataFrame
        Enriched DataFrame with score and optional grade columns.
    n : int
        Number of top rows to return.
    score_col : str
        Column to sort by (descending).
    grade_exclude : list[str], optional
        Grade values to filter out before selecting top-n.

    Returns
    -------
    pd.DataFrame
        Top n rows, index reset.
    """
    result = df.copy()

    if grade_exclude is not None and "grade" in result.columns:
        result = result[~result["grade"].isin(grade_exclude)]

    scores = pd.to_numeric(result.get(score_col, pd.Series(dtype=float)), errors="coerce").fillna(0.0)
    result = result.copy()
    result[score_col] = scores
    result = result.sort_values(score_col, ascending=False)

    return result.head(n).reset_index(drop=True)


def summary_stats(df: pd.DataFrame) -> dict:
    """Return a summary statistics dictionary for a scan result DataFrame.

    Parameters
    ----------
    df : pd.DataFrame
        Enriched scan result DataFrame.

    Returns
    -------
    dict
        Keys: n_total, n_grade_a, n_grade_b, n_entry_signal,
              avg_final_score, top_sector, calendar_risk, regime.
    """
    n_total = len(df)

    n_grade_a = 0
    n_grade_b = 0
    if "grade" in df.columns:
        n_grade_a = int((df["grade"] == "A").sum())
        n_grade_b = int((df["grade"] == "B").sum())

    n_entry_signal = 0
    if "entry_signal" in df.columns:
        n_entry_signal = int(df["entry_signal"].eq(True).sum())

    avg_final_score = 0.0
    if "final_score" in df.columns:
        vals = pd.to_numeric(df["final_score"], errors="coerce")
        if not vals.isna().all():
            avg_final_score = float(vals.mean())

    top_sector = ""
    score_for_top = "final_score" if "final_score" in df.columns else ("entry_score" if "entry_score" in df.columns else None)
    if score_for_top and "industry_category" in df.columns:
        tmp = df.copy()
        tmp["_sc"] = pd.to_numeric(tmp[score_for_top], errors="coerce").fillna(0.0)
        top10 = tmp.nlargest(10, "_sc")
        if not top10.empty:
            top_sector = str(top10["industry_category"].mode().iloc[0]) if not top10["industry_category"].mode().empty else ""

    calendar_risk = None
    if "calendar_risk" in df.columns:
        for val in df["calendar_risk"]:
            if val is not None and not (isinstance(val, float) and math.isnan(val)):
                calendar_risk = val
                break

    regime = "未知"
    if "regime_label" in df.columns:
        for val in df["regime_label"]:
            if val is not None and not (isinstance(val, float) and math.isnan(val)):
                regime = str(val)
                break

    return {
        "n_total": n_total,
        "n_grade_a": n_grade_a,
        "n_grade_b": n_grade_b,
        "n_entry_signal": n_entry_signal,
        "avg_final_score": avg_final_score,
        "top_sector": top_sector,
        "calendar_risk": calendar_risk,
        "regime": regime,
    }


def format_enriched_summary(df: pd.DataFrame, top_n: int = 10) -> str:
    """Format the top candidates as a Discord-ready string.

    Parameters
    ----------
    df : pd.DataFrame
        Enriched DataFrame (with grade, final_score or entry_score, etc.).
    top_n : int
        Number of top candidates to display.

    Returns
    -------
    str
        Discord-formatted summary, or "" if df is empty.
    """
    if df.empty:
        return ""

    # Determine sort column
    if "final_score" in df.columns:
        score_col = "final_score"
    elif "entry_score" in df.columns:
        score_col = "entry_score"
    else:
        score_col = None

    result = df.copy()
    if score_col:
        result["_sort"] = pd.to_numeric(result[score_col], errors="coerce").fillna(0.0)
        result = result.sort_values("_sort", ascending=False)
    top = result.head(top_n)

    lines = [
        "🏆 最終候選（綜合評分）",
        "──────────────────────────────────",
    ]

    has_grade = "grade" in top.columns
    has_name = "name" in top.columns

    for rank, (_, row) in enumerate(top.iterrows(), start=1):
        stock_id = str(row.get("stock_id", ""))
        name = str(row.get("name", "")) if has_name else ""
        grade_part = f"[{row['grade']}] " if has_grade else ""

        score_val = None
        if score_col and score_col in row.index:
            try:
                score_val = float(row[score_col])
            except (TypeError, ValueError):
                score_val = None

        if score_val is not None and not math.isnan(score_val):
            score_str = f"★{int(round(score_val)):,}"
        else:
            score_str = ""

        stock_name = f"{stock_id} {name}".strip() if name else stock_id
        lines.append(f"{rank:2d}. {grade_part}{stock_name}  {score_str}")

    # Append calendar risk if present
    calendar_risk = None
    if "calendar_risk" in df.columns:
        for val in df["calendar_risk"]:
            if val is not None and not (isinstance(val, float) and math.isnan(val)):
                calendar_risk = val
                break
    if calendar_risk:
        lines.append(f"\n{calendar_risk}")

    return "\n".join(lines)
