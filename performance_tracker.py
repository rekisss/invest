"""
Performance tracker for scan pick outcomes.

Reads historical batch_seq CSV files from the full-scan output directory,
matches top-N picks from an entry date against actual closing prices found
in a later scan CSV, and computes win-rate statistics useful for strategy
calibration — all without live API calls.

Usage (standalone):
    python performance_tracker.py --scan-dir output/full_scan --holding-days 7 --top-n 20
    python performance_tracker.py --scan-dir output/full_scan --holding-days 5 --notify
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import NamedTuple

import numpy as np
import pandas as pd


# ── Data loading ───────────────────────────────────────────────────────────────

def load_scan_picks(scan_dir: Path | str, scan_date: str, top_n: int = 20) -> pd.DataFrame:
    """Load top-N picks for a given scan date from batch_seq CSVs.

    Returns a DataFrame with at least: stock_id, name, entry_score, close, date.
    Returns empty DataFrame if no matching CSV found.
    """
    scan_dir = Path(scan_dir)
    csvs = sorted(scan_dir.glob(f"batch_seq*_{scan_date}.csv"))
    if not csvs:
        csvs = sorted(scan_dir.glob(f"batch_*_{scan_date}.csv"))
    if not csvs:
        return pd.DataFrame()

    frames = []
    for p in csvs:
        try:
            frames.append(pd.read_csv(p, encoding="utf-8-sig"))
        except Exception:
            pass
    if not frames:
        return pd.DataFrame()

    df = pd.concat(frames, ignore_index=True)
    if "stock_id" in df.columns:
        df = df.drop_duplicates(subset=["stock_id"])
    if "entry_score" in df.columns:
        df = df.sort_values("entry_score", ascending=False)
    return df.head(top_n).reset_index(drop=True)


def list_available_scan_dates(scan_dir: Path | str) -> list[str]:
    """Return sorted list of scan dates that have batch_seq CSV files."""
    scan_dir = Path(scan_dir)
    dates: set[str] = set()
    for p in scan_dir.glob("batch_seq*.csv"):
        m = re.search(r"(\d{4}-\d{2}-\d{2})\.csv$", p.name)
        if m:
            dates.add(m.group(1))
    for p in scan_dir.glob("batch_*.csv"):
        m = re.search(r"(\d{4}-\d{2}-\d{2})\.csv$", p.name)
        if m:
            dates.add(m.group(1))
    return sorted(dates)


def _build_price_map(scan_dir: Path, date: str) -> dict[str, float]:
    """Build stock_id → close price mapping from all batch CSVs for a date."""
    price_map: dict[str, float] = {}
    csvs = sorted(scan_dir.glob(f"batch_seq*_{date}.csv"))
    if not csvs:
        csvs = sorted(scan_dir.glob(f"batch_*_{date}.csv"))
    for p in csvs:
        try:
            df = pd.read_csv(p, encoding="utf-8-sig")
            # Normalise column names (strip BOM that encoding='utf-8-sig' may leave on col 0)
            df.columns = [str(c).lstrip("﻿").strip() for c in df.columns]
            if "stock_id" not in df.columns or "close" not in df.columns:
                continue
            for _, row in df.iterrows():
                sid = str(row["stock_id"])
                try:
                    price_map[sid] = float(row["close"])
                except (TypeError, ValueError):
                    pass
        except Exception:
            pass
    return price_map


# ── Return computation ─────────────────────────────────────────────────────────

def compute_pick_performance(
    scan_dir: Path | str,
    entry_date: str,
    exit_date: str,
    top_n: int = 20,
) -> pd.DataFrame:
    """Compute actual returns for top-N picks from entry_date, using exit_date prices.

    Both dates must have existing scan CSVs in scan_dir.
    Returns annotated picks DataFrame (empty if data missing).

    Added columns:
      close_entry  — entry closing price
      close_exit   — exit closing price (NaN if not found in exit date's scan)
      return_pct   — (exit - entry) / entry × 100
      hit          — True if return_pct > 0
      exit_date    — the exit date string
    """
    scan_dir = Path(scan_dir)
    picks = load_scan_picks(scan_dir, entry_date, top_n=top_n)
    if picks.empty:
        return pd.DataFrame()

    price_map = _build_price_map(scan_dir, exit_date)
    result = picks.copy()
    result["close_entry"] = pd.to_numeric(result.get("close", pd.Series(dtype=float)), errors="coerce")
    result["close_exit"] = result["stock_id"].astype(str).map(price_map)
    entry = pd.to_numeric(result["close_entry"], errors="coerce")
    exit_ = pd.to_numeric(result["close_exit"], errors="coerce")
    result["return_pct"] = ((exit_ - entry) / entry.replace(0, np.nan) * 100).round(2)
    result["hit"] = result["return_pct"] > 0
    result["exit_date"] = exit_date
    return result


# ── Aggregate statistics ───────────────────────────────────────────────────────

class PerformanceStats(NamedTuple):
    entry_date: str
    exit_date: str
    n_picks: int
    n_with_exit: int
    hit_rate: float         # % profitable
    avg_return: float       # mean return %
    avg_win: float          # mean return % of winners
    avg_loss: float         # mean return % of losers (negative)
    best: float
    worst: float
    sharpe_approx: float    # avg_return / std (simplified, not annualised)


def compute_period_stats(
    perf_df: pd.DataFrame, entry_date: str, exit_date: str
) -> PerformanceStats | None:
    """Compute summary stats from a performance DataFrame."""
    if perf_df.empty or "return_pct" not in perf_df.columns:
        return None
    measured = perf_df[perf_df["return_pct"].notna()]
    if measured.empty:
        return None
    rets = measured["return_pct"].astype(float)
    winners = rets[rets > 0]
    losers = rets[rets <= 0]
    std = float(rets.std()) if len(rets) > 1 else 1.0
    return PerformanceStats(
        entry_date=entry_date,
        exit_date=exit_date,
        n_picks=len(perf_df),
        n_with_exit=len(measured),
        hit_rate=round(float(len(winners) / len(measured) * 100), 1),
        avg_return=round(float(rets.mean()), 2),
        avg_win=round(float(winners.mean()), 2) if not winners.empty else 0.0,
        avg_loss=round(float(losers.mean()), 2) if not losers.empty else 0.0,
        best=round(float(rets.max()), 2),
        worst=round(float(rets.min()), 2),
        sharpe_approx=round(float(rets.mean() / max(std, 0.01)), 3),
    )


def make_date_pairs(dates: list[str], holding_days: int = 7) -> list[tuple[str, str]]:
    """Pair each scan date with the closest available exit date >= holding_days later."""
    if len(dates) < 2:
        return []
    pairs: list[tuple[str, str]] = []
    for i, entry in enumerate(dates):
        min_exit_ts = pd.Timestamp(entry) + pd.Timedelta(days=holding_days)
        future = [d for d in dates[i + 1:] if pd.Timestamp(d) >= min_exit_ts]
        if future:
            pairs.append((entry, future[0]))
    return pairs


def run_performance_analysis(
    scan_dir: Path | str,
    holding_days: int = 7,
    top_n: int = 20,
    last_n_periods: int = 20,
) -> tuple[list[PerformanceStats], pd.DataFrame]:
    """Run the full performance analysis over all available scan dates.

    Returns (stats_list, combined_picks_df).
    """
    scan_dir = Path(scan_dir)
    dates = list_available_scan_dates(scan_dir)
    pairs = make_date_pairs(dates, holding_days=holding_days)
    # Only evaluate periods where exit date already has data
    pairs = [(e, x) for e, x in pairs if x in dates]
    pairs = pairs[-last_n_periods:]  # cap to avoid huge runtime

    all_stats: list[PerformanceStats] = []
    all_picks: list[pd.DataFrame] = []
    for entry_date, exit_date in pairs:
        perf = compute_pick_performance(scan_dir, entry_date, exit_date, top_n=top_n)
        if not perf.empty:
            all_picks.append(perf)
            stats = compute_period_stats(perf, entry_date, exit_date)
            if stats:
                all_stats.append(stats)

    combined = pd.concat(all_picks, ignore_index=True) if all_picks else pd.DataFrame()
    return all_stats, combined


# ── Report formatting ──────────────────────────────────────────────────────────

def format_performance_report(
    all_stats: list[PerformanceStats],
    combined: pd.DataFrame,
    top_n: int = 20,
    holding_days: int = 7,
) -> str:
    """Format a Discord-ready performance report."""
    if not all_stats:
        return (
            f"📊 **TOP {top_n} 績效追蹤**（{holding_days}日持有）\n"
            "尚無足夠歷史資料（需要至少兩個間隔 ≥ holding_days 的掃描日期）"
        )

    lines = [
        f"📊 **TOP {top_n} 持股績效追蹤**（{holding_days}日持有）",
        f"統計期間：{all_stats[0].entry_date} → {all_stats[-1].exit_date}",
        f"共 `{len(all_stats)}` 個觀測期",
        "",
    ]

    # Overall aggregate from combined picks
    if not combined.empty and "return_pct" in combined.columns:
        rets = pd.to_numeric(combined["return_pct"], errors="coerce").dropna()
        if not rets.empty:
            total_hit = float((rets > 0).sum() / len(rets) * 100)
            total_avg = float(rets.mean())
            lines.append("**📈 整體績效**")
            lines.append(
                f"   勝率：`{total_hit:.1f}%`  |  平均報酬：`{total_avg:+.2f}%`"
            )
            lines.append(
                f"   最佳：`+{float(rets.max()):.1f}%`  |  最差：`{float(rets.min()):.1f}%`"
            )
            lines.append(f"   樣本數：`{len(rets)}` 筆")
            lines.append("")

    # Per-period breakdown (last 8 periods)
    lines.append("**逐期明細（最近8期）**")
    for s in all_stats[-8:]:
        hit_icon = "🟢" if s.hit_rate >= 55 else ("🟡" if s.hit_rate >= 45 else "🔴")
        lines.append(
            f"   {hit_icon} {s.entry_date}→{s.exit_date}  "
            f"勝率`{s.hit_rate}%`  均`{s.avg_return:+.2f}%`  "
            f"（贏`{s.avg_win:+.1f}%` / 輸`{s.avg_loss:.1f}%`）"
        )

    return "\n".join(lines)


# ── CLI ────────────────────────────────────────────────────────────────────────

def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Compute and report actual win rate from historical scan picks."
    )
    parser.add_argument("--scan-dir", default="output/full_scan",
                        help="Directory containing batch_seq CSV files")
    parser.add_argument("--holding-days", type=int, default=7,
                        help="Minimum calendar days between entry and exit")
    parser.add_argument("--top-n", type=int, default=20,
                        help="Number of top picks to evaluate per scan date")
    parser.add_argument("--last-n", type=int, default=20,
                        help="Evaluate only the last N periods")
    parser.add_argument("--notify", action="store_true",
                        help="Send report to Discord via DISCORD_WEBHOOK_URL")
    args = parser.parse_args()

    scan_dir = Path(args.scan_dir)
    if not scan_dir.exists():
        print(f"[performance_tracker] ❌ scan-dir not found: {scan_dir}", file=sys.stderr)
        sys.exit(1)

    dates = list_available_scan_dates(scan_dir)
    if len(dates) < 2:
        print(f"[performance_tracker] ⚠️ 只找到 {len(dates)} 個掃描日期，至少需要 2 個", file=sys.stderr)
        sys.exit(0)

    print(f"[performance_tracker] 掃描日期：{len(dates)} 個（{dates[0]} ~ {dates[-1]}）")
    all_stats, combined = run_performance_analysis(
        scan_dir, holding_days=args.holding_days, top_n=args.top_n, last_n_periods=args.last_n
    )

    report = format_performance_report(all_stats, combined, top_n=args.top_n, holding_days=args.holding_days)
    print(report)

    if args.notify:
        webhook = os.getenv("DISCORD_WEBHOOK_URL", "").strip()
        if webhook:
            try:
                import requests
                resp = requests.post(webhook, json={"content": report[:1990]}, timeout=15)
                resp.raise_for_status()
                print("[performance_tracker] ✅ Discord 通知已發送")
            except Exception as exc:
                print(f"[performance_tracker] ⚠️ Discord 通知失敗: {exc}", file=sys.stderr)
        else:
            print("[performance_tracker] ⚠️ DISCORD_WEBHOOK_URL 未設定，跳過通知")


if __name__ == "__main__":
    _cli()
