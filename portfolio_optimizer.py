"""
Portfolio optimizer for scan candidate lists.

Given a list of top candidates (with entry_score, ATR, close, industry_category,
grade), returns a suggested portfolio allocation that respects:
  - Grade-based filtering (exclude D/X by default)
  - ATR-based position sizing (risk per trade = fixed % of portfolio)
  - Single-position cap (max % in one stock)
  - Sector concentration cap (max % in one sector)

Usage (standalone):
    python portfolio_optimizer.py --input output/full_scan --date 2026-06-11 --value 1000000
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd


# ── Defaults ───────────────────────────────────────────────────────────────────

_DEFAULT_MAX_POSITIONS  = 10
_DEFAULT_RISK_PER_TRADE = 0.01     # 1% of portfolio value at risk per position
_DEFAULT_ATR_STOP_MULT  = 2.5      # stop = close - N × ATR
_DEFAULT_MAX_SECTOR_PCT = 0.30     # max 30% portfolio weight in one sector
_DEFAULT_MAX_SINGLE_PCT = 0.15     # max 15% portfolio weight in one position
_DEFAULT_MIN_GRADE      = "C"      # skip D and X grades

_GRADE_RANK = {"A": 4, "B": 3, "C": 2, "D": 1, "X": 0, "": -1}


# ── Core allocation ────────────────────────────────────────────────────────────

def suggest_portfolio(
    candidates: pd.DataFrame,
    portfolio_value: float = 1_000_000,
    max_positions: int = _DEFAULT_MAX_POSITIONS,
    risk_per_trade: float = _DEFAULT_RISK_PER_TRADE,
    atr_stop_mult: float = _DEFAULT_ATR_STOP_MULT,
    max_sector_pct: float = _DEFAULT_MAX_SECTOR_PCT,
    max_single_pct: float = _DEFAULT_MAX_SINGLE_PCT,
    min_grade: str = _DEFAULT_MIN_GRADE,
) -> pd.DataFrame:
    """Return a portfolio allocation table for top candidates.

    Each output row contains:
      stock_id, name, grade, entry_score, sector,
      close, stop_price, stop_pct, shares, position_value, weight_pct

    Filtering:
      1. Exclude X; exclude grades below min_grade if grade column present.
      2. Require close > 0 and computable ATR stop (atr14 column).
      3. Sector cap: max_sector_pct × portfolio_value per sector.
      4. Single cap: max_single_pct × portfolio_value per position.

    Position sizing:
      risk_budget = portfolio_value × risk_per_trade
      raw_shares  = risk_budget / (close - stop_price)
      capped at floor(max_single_pct × portfolio_value / close) shares.
    """
    if candidates.empty:
        return pd.DataFrame()

    df = candidates.copy()
    min_rank = _GRADE_RANK.get(min_grade, 0)

    # Grade filter
    if "grade" in df.columns:
        df = df[df["grade"].map(lambda g: _GRADE_RANK.get(str(g), -1)) >= min_rank]

    if df.empty:
        return pd.DataFrame()

    # Numeric close
    df["close"] = pd.to_numeric(df.get("close", pd.Series(dtype=float)), errors="coerce")
    df = df[df["close"].notna() & (df["close"] > 0)]

    # ATR stop
    atr_series = pd.to_numeric(df.get("atr14", pd.Series(dtype=float)), errors="coerce").fillna(0.0)
    df = df.assign(atr14=atr_series)
    df["stop_price"] = (df["close"] - atr_stop_mult * df["atr14"]).round(2)
    df["stop_pct"]   = ((df["close"] - df["stop_price"]) / df["close"] * 100).round(2)
    df = df[(df["stop_price"] > 0) & (df["stop_pct"] > 0)]

    if df.empty:
        return pd.DataFrame()

    # Sort by entry_score
    if "entry_score" in df.columns:
        df = df.sort_values("entry_score", ascending=False)

    sector_col = "industry_category" if "industry_category" in df.columns else None
    sector_used: dict[str, float] = {}
    rows: list[dict] = []

    for _, row in df.iterrows():
        if len(rows) >= max_positions:
            break

        close = float(row["close"])
        stop  = float(row["stop_price"])
        risk_per_share = close - stop
        if risk_per_share <= 0:
            continue

        # Risk-based sizing
        raw_position_value = (portfolio_value * risk_per_trade / risk_per_share) * close
        # Apply single-position cap
        cap_by_pct = portfolio_value * max_single_pct
        position_value = min(raw_position_value, cap_by_pct)

        # Apply sector cap
        sector = str(row.get(sector_col, "其他")) if sector_col else "其他"
        used = sector_used.get(sector, 0.0)
        sector_cap = portfolio_value * max_sector_pct
        if used + position_value > sector_cap:
            position_value = sector_cap - used
        if position_value < close:
            continue

        shares = int(position_value // close)
        if shares == 0:
            continue
        actual_value = shares * close
        sector_used[sector] = used + actual_value

        rows.append({
            "stock_id":       str(row.get("stock_id", "")),
            "name":           str(row.get("name", "")),
            "grade":          str(row.get("grade", "")),
            "entry_score":    float(row.get("entry_score", 0)),
            "sector":         sector,
            "close":          round(close, 2),
            "stop_price":     round(stop, 2),
            "stop_pct":       float(row["stop_pct"]),
            "shares":         shares,
            "position_value": round(actual_value),
            "weight_pct":     0.0,
        })

    if not rows:
        return pd.DataFrame()

    result = pd.DataFrame(rows)
    result["weight_pct"] = (result["position_value"] / portfolio_value * 100).round(1)
    return result


def portfolio_summary(allocation: pd.DataFrame, portfolio_value: float) -> dict:
    """Return a summary dict for the allocation."""
    if allocation.empty:
        return {"n_positions": 0, "total_invested": 0.0, "cash": portfolio_value, "invested_pct": 0.0}
    total = float(allocation["position_value"].sum())
    return {
        "n_positions":   len(allocation),
        "total_invested": round(total),
        "cash":          round(portfolio_value - total),
        "invested_pct":  round(total / portfolio_value * 100, 1),
    }


# ── Report formatting ──────────────────────────────────────────────────────────

def format_portfolio_report(
    allocation: pd.DataFrame,
    portfolio_value: float = 1_000_000,
) -> str:
    """Format a Discord-ready portfolio allocation table."""
    if allocation.empty:
        return (
            "📋 **組合建議**\n"
            "無符合條件的候選股票（A/B/C 級且有 ATR 資料）"
        )

    summary = portfolio_summary(allocation, portfolio_value)
    lines = [
        f"📋 **組合建議** — {summary['n_positions']} 支",
        (
            f"投入 `{summary['total_invested']:,}` / "
            f"現金 `{summary['cash']:,}` / "
            f"占比 `{summary['invested_pct']:.1f}%`"
        ),
        "",
    ]

    for _, row in allocation.iterrows():
        lines.append(
            f"  **{row['stock_id']}** {row['name']} `[{row['grade']}]`  "
            f"`{row['weight_pct']:.1f}%`  "
            f"收`{row['close']:.2f}` 停損`{row['stop_price']:.2f}`(`-{row['stop_pct']:.1f}%`)  "
            f"{int(row['shares'])}股 ≈`{int(row['position_value']):,}`"
        )

    if "sector" in allocation.columns:
        lines.append("")
        lines.append("**類股分配**")
        by_sector = (
            allocation.groupby("sector")["weight_pct"]
            .sum()
            .sort_values(ascending=False)
        )
        for sector, pct in by_sector.items():
            bar_len = int(pct / 5)  # 1 block per 5%
            bar = "█" * bar_len + "░" * max(0, 6 - bar_len)
            lines.append(f"  {bar} {sector}: `{pct:.1f}%`")

    return "\n".join(lines)


# ── CLI ────────────────────────────────────────────────────────────────────────

def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Suggest portfolio allocation from scan candidates."
    )
    parser.add_argument("--input", default="output/full_scan",
                        help="Directory containing batch_seq CSVs (or path to a CSV)")
    parser.add_argument("--date", default="",
                        help="Scan date (YYYY-MM-DD); defaults to latest available")
    parser.add_argument("--value", type=float, default=1_000_000,
                        help="Total portfolio value in NTD")
    parser.add_argument("--max-positions", type=int, default=_DEFAULT_MAX_POSITIONS)
    parser.add_argument("--risk-pct", type=float, default=1.0,
                        help="Risk per trade as %% of portfolio (default 1.0)")
    parser.add_argument("--min-grade", default=_DEFAULT_MIN_GRADE,
                        choices=["A", "B", "C", "D"],
                        help="Minimum grade to include")
    args = parser.parse_args()

    input_path = Path(args.input)
    date = args.date

    # Resolve CSV(s)
    if input_path.is_file():
        csvs = [input_path]
    elif input_path.is_dir():
        if date:
            csvs = sorted(input_path.glob(f"batch_seq*_{date}.csv"))
            if not csvs:
                csvs = sorted(input_path.glob(f"batch_*_{date}.csv"))
        else:
            # Find latest date
            all_dates: list[str] = []
            for p in input_path.glob("batch_seq*.csv"):
                m = re.search(r"(\d{4}-\d{2}-\d{2})\.csv$", p.name)
                if m:
                    all_dates.append(m.group(1))
            if not all_dates:
                print("[portfolio_optimizer] ❌ 找不到批次 CSV", file=sys.stderr)
                sys.exit(1)
            date = max(all_dates)
            csvs = sorted(input_path.glob(f"batch_seq*_{date}.csv"))
    else:
        print(f"[portfolio_optimizer] ❌ 路徑不存在: {input_path}", file=sys.stderr)
        sys.exit(1)

    if not csvs:
        print(f"[portfolio_optimizer] ❌ 找不到 {date} 的 CSV", file=sys.stderr)
        sys.exit(1)

    frames = []
    for p in csvs:
        try:
            frames.append(pd.read_csv(p, encoding="utf-8-sig"))
        except Exception as exc:
            print(f"[portfolio_optimizer] ⚠️ 跳過 {p.name}: {exc}", file=sys.stderr)
    if not frames:
        print("[portfolio_optimizer] ❌ 所有 CSV 讀取失敗", file=sys.stderr)
        sys.exit(1)

    df = pd.concat(frames, ignore_index=True)
    if "stock_id" in df.columns:
        df = df.drop_duplicates(subset=["stock_id"])
    if "entry_score" in df.columns:
        df = df.sort_values("entry_score", ascending=False)

    # If no grade column, run post_process.enrich first
    if "grade" not in df.columns:
        try:
            from post_process import enrich as _pp_enrich
            df = _pp_enrich(df)
        except Exception:
            pass

    allocation = suggest_portfolio(
        df,
        portfolio_value=args.value,
        max_positions=args.max_positions,
        risk_per_trade=args.risk_pct / 100,
        min_grade=args.min_grade,
    )

    report = format_portfolio_report(allocation, portfolio_value=args.value)
    print(report)

    summary = portfolio_summary(allocation, args.value)
    print(f"\n[portfolio_optimizer] 共 {summary['n_positions']} 支 | 日期: {date or '未知'}")


if __name__ == "__main__":
    _cli()
