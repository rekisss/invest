"""
Post-processing utilities for scan candidate DataFrames.

Apply after run_aggregate collects all batch CSVs to enrich output
without modifying any existing computation logic.

Usage (standalone enrichment):
    python post_process.py --input output/full_scan --date 2026-06-11
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd


# ── Score grading ──────────────────────────────────────────────────────────────

def add_score_grade(df: pd.DataFrame, score_col: str = "entry_score") -> pd.DataFrame:
    """Add score_pct (0-100 percentile rank) and grade (A/B/C/D/X) columns.

    Grade thresholds (percentile-based, no absolute score dependency):
      X — limit_down_streak >= 1 (skip regardless of score)
      A — score_pct >= 98   (top 2%)
      B — score_pct >= 90   (top 10%)
      C — score_pct >= 75   (top 25%)
      D — below C
    """
    df = df.copy()
    scores = pd.to_numeric(df[score_col], errors="coerce")
    df["score_pct"] = scores.rank(pct=True, method="average").mul(100).round(1)

    def _grade(row: pd.Series) -> str:
        if float(row.get("limit_down_streak", 0) or 0) >= 1:
            return "X"
        p = float(row.get("score_pct", 0) or 0)
        if p >= 98:
            return "A"
        if p >= 90:
            return "B"
        if p >= 75:
            return "C"
        return "D"

    df["grade"] = df.apply(_grade, axis=1)
    return df


# ── Regime-adjusted score ──────────────────────────────────────────────────────

_REGIME_MULTIPLIERS: dict[str, float] = {
    "牛市": 1.30,
    "盤整": 1.00,
    "熊市": 0.75,
    "未知": 0.90,
}


def apply_regime_weight(
    df: pd.DataFrame,
    regime_label: str,
    score_col: str = "entry_score",
) -> pd.DataFrame:
    """Add regime_score = entry_score × regime_multiplier and regime_label column.

    Multipliers:
      牛市 (bull)    → 1.30  (+30% confidence boost in trending up market)
      盤整 (neutral) → 1.00  (no adjustment)
      熊市 (bear)    → 0.75  (require higher raw score to keep candidate)
      未知 (unknown) → 0.90  (slight penalty for uncertainty)
    """
    df = df.copy()
    mult = _REGIME_MULTIPLIERS.get(regime_label, 1.00)
    scores = pd.to_numeric(df[score_col], errors="coerce").fillna(0.0)
    df["regime_score"] = (scores * mult).round(1)
    df["regime_label"] = regime_label
    return df


# ── Sector cap enforcement ─────────────────────────────────────────────────────

def enforce_sector_cap(
    df: pd.DataFrame,
    max_per_sector: int = 2,
    score_col: str = "entry_score",
) -> pd.DataFrame:
    """Return candidates with at most max_per_sector stocks per industry_category.

    Stocks are considered in descending score order; the first max_per_sector
    encountered in each sector are kept, the rest are dropped.
    Useful for preventing semiconductor-only results in strong tech rallies.
    """
    if "industry_category" not in df.columns or df.empty:
        return df
    df = df.copy()
    scores = pd.to_numeric(df[score_col], errors="coerce").fillna(0.0)
    df = df.assign(_sort_key=scores).sort_values("_sort_key", ascending=False)
    df["industry_category"] = df["industry_category"].fillna("其他").replace("", "其他")

    sector_counts: dict[str, int] = {}
    keep: list[int] = []
    for idx in df.index:
        sector = str(df.at[idx, "industry_category"])
        count = sector_counts.get(sector, 0)
        if count < max_per_sector:
            keep.append(idx)
            sector_counts[sector] = count + 1

    return df.loc[keep].drop(columns=["_sort_key"])


# ── Data quality flags ─────────────────────────────────────────────────────────

def check_data_quality(df: pd.DataFrame) -> pd.DataFrame:
    """Add data_quality_ok (bool) and data_quality_note (str) columns.

    Detects likely stub-zero situations where FinMind data was unavailable:
    - All three institutional streaks == 0 simultaneously (suspicious on active days)
    - revenue_yoy == 0 AND f_score == -1 (no fundamental data at all)

    A data_quality_ok = False row is still valid — data may just be missing
    for that specific stock; the flag helps prioritise manual review.
    """
    df = df.copy()
    notes: list[str] = []
    for _, row in df.iterrows():
        row_notes: list[str] = []
        fbs = _to_num(row.get("foreign_buy_streak"))
        its = _to_num(row.get("invest_trust_streak"))
        dbs = _to_num(row.get("dealer_buy_streak"))
        if fbs == 0 and its == 0 and dbs == 0:
            row_notes.append("三大法人資料可能未取得")
        rev = _to_num(row.get("revenue_yoy"))
        fs = _to_num(row.get("f_score", 0))
        if rev == 0.0 and fs == -1:
            row_notes.append("基本面資料未取得")
        notes.append("；".join(row_notes) if row_notes else "")
    df["data_quality_note"] = notes
    df["data_quality_ok"] = df["data_quality_note"].eq("")
    return df


def _to_num(val: object, default: float = 0.0) -> float:
    try:
        return float(val)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


# ── All-in-one enrichment ──────────────────────────────────────────────────────

def enrich(
    df: pd.DataFrame,
    regime_label: str = "未知",
    max_per_sector: int = 0,
    score_col: str = "entry_score",
) -> pd.DataFrame:
    """Apply all post-processing steps in order.

    Steps:
      1. add_score_grade       — percentile + A/B/C/D/X
      2. apply_regime_weight   — regime_score + regime_label
      3. check_data_quality    — data_quality_ok + data_quality_note
      4. enforce_sector_cap    — optional, only when max_per_sector > 0

    Returns enriched DataFrame (input is not mutated).
    """
    out = add_score_grade(df, score_col=score_col)
    out = apply_regime_weight(out, regime_label=regime_label, score_col=score_col)
    out = check_data_quality(out)
    if max_per_sector > 0:
        out = enforce_sector_cap(out, max_per_sector=max_per_sector, score_col=score_col)
    return out


# ── CLI runner ─────────────────────────────────────────────────────────────────

def _find_latest_batch_csv(scan_dir: Path, date: str) -> Path | None:
    """Find the most recent batch_seq CSV for the given date."""
    candidates = sorted(scan_dir.glob(f"batch_seq*_{date}.csv"))
    return candidates[-1] if candidates else None


def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Enrich scan output CSVs with grade, regime score, and data quality flags."
    )
    parser.add_argument("--input", default="output/full_scan", help="Directory with batch_seq CSVs")
    parser.add_argument("--date", default="", help="Scan date (YYYY-MM-DD); defaults to latest")
    parser.add_argument("--regime", default="未知", choices=list(_REGIME_MULTIPLIERS), help="Market regime label")
    parser.add_argument("--sector-cap", type=int, default=0, metavar="N",
                        help="Max stocks per sector (0 = disabled)")
    parser.add_argument("--output", default="", help="Output CSV path; defaults to <input>_enriched.csv")
    args = parser.parse_args()

    scan_dir = Path(args.input)
    if not scan_dir.exists():
        print(f"[post_process] ❌ 掃描目錄不存在: {scan_dir}", file=sys.stderr)
        sys.exit(1)

    date = args.date
    if not date:
        # Infer latest date from available batch_seq CSVs
        all_csvs = sorted(scan_dir.glob("batch_seq*.csv"))
        if not all_csvs:
            print("[post_process] ❌ 找不到任何 batch_seq CSV", file=sys.stderr)
            sys.exit(1)
        # Extract date from filename: batch_seq{N}_{date}.csv
        import re
        dates = []
        for p in all_csvs:
            m = re.search(r"_(\d{4}-\d{2}-\d{2})\.csv$", p.name)
            if m:
                dates.append(m.group(1))
        date = max(dates) if dates else ""

    if not date:
        print("[post_process] ❌ 無法判斷資料日期", file=sys.stderr)
        sys.exit(1)

    # Load all batch_seq CSVs for this date and concatenate
    csvs = sorted(scan_dir.glob(f"batch_seq*_{date}.csv"))
    if not csvs:
        print(f"[post_process] ❌ 找不到 {date} 的 batch_seq CSV", file=sys.stderr)
        sys.exit(1)

    frames = []
    for p in csvs:
        try:
            frames.append(pd.read_csv(p, encoding="utf-8-sig"))
        except Exception as exc:
            print(f"[post_process] ⚠️ 跳過 {p.name}: {exc}", file=sys.stderr)
    if not frames:
        print("[post_process] ❌ 所有 CSV 均讀取失敗", file=sys.stderr)
        sys.exit(1)

    df = pd.concat(frames, ignore_index=True)
    if "stock_id" in df.columns:
        df = df.drop_duplicates(subset=["stock_id"])

    df = enrich(df, regime_label=args.regime, max_per_sector=args.sector_cap)

    out_path = Path(args.output) if args.output else scan_dir / f"enriched_{date}.csv"
    df.to_csv(out_path, index=False, encoding="utf-8-sig")
    print(f"[post_process] ✅ 完成 — {len(df)} 支股票 → {out_path}")
    grade_counts = df["grade"].value_counts().to_dict() if "grade" in df.columns else {}
    for g in ["A", "B", "C", "D", "X"]:
        cnt = grade_counts.get(g, 0)
        if cnt:
            print(f"  {g} 級: {cnt} 支")


if __name__ == "__main__":
    _cli()
