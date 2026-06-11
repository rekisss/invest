"""
Weekly performance report generator.

Reads from trade_journal.db and scan history to produce a weekly
summary — useful for end-of-week Discord notifications or review.

Standalone module — no existing files modified.
"""
from __future__ import annotations

import datetime
import os
from pathlib import Path

import pandas as pd


def _week_bounds(
    week_start: str | None = None,
    week_end: str | None = None,
) -> tuple[str, str]:
    """Return (week_start, week_end) as 'YYYY-MM-DD' strings.

    If both are provided they are returned as-is.
    Otherwise computes the most recently completed Mon-Fri week:
      - go back to the last Monday that is at least 7 days ago and use that
        Mon-Fri pair.
    """
    if week_start is not None and week_end is not None:
        return week_start, week_end

    today = datetime.date.today()
    # Find the most recent Monday that is >= 7 days ago so the full week
    # (Mon-Fri) has completed.
    days_since_monday = today.weekday()  # Mon=0 … Sun=6
    # Last Monday (could be this week's Monday if today >= Mon)
    last_monday = today - datetime.timedelta(days=days_since_monday)
    # Go back one more week so we always have a fully-completed week
    target_monday = last_monday - datetime.timedelta(weeks=1)
    target_friday = target_monday + datetime.timedelta(days=4)

    return target_monday.strftime("%Y-%m-%d"), target_friday.strftime("%Y-%m-%d")


def generate_weekly_report(
    journal_db_path: str = "output/trade_journal.db",
    week_start: str | None = None,
    week_end: str | None = None,
) -> dict:
    """Generate weekly performance statistics from the trade journal.

    Returns a dict with keys:
        week_label, closed_trades, win_rate, total_pnl_twd, avg_return_pct,
        best_trade, worst_trade, stopped_out, open_positions.

    If the DB doesn't exist or an error occurs the numeric fields default to
    zero/None and only week_label is set.
    """
    ws, we = _week_bounds(week_start, week_end)
    week_label = f"{ws} ~ {we}"

    zeros: dict = {
        "week_label": week_label,
        "closed_trades": 0,
        "win_rate": 0.0,
        "total_pnl_twd": 0.0,
        "avg_return_pct": 0.0,
        "best_trade": None,
        "worst_trade": None,
        "stopped_out": 0,
        "open_positions": 0,
    }

    if not os.path.exists(journal_db_path):
        return zeros

    try:
        from trade_journal import TradeJournal

        tj = TradeJournal(db_path=journal_db_path)

        # Closed trades within the week window
        closed_df = tj.get_closed_trades(since_date=ws)
        if not closed_df.empty and "exit_date" in closed_df.columns:
            closed_df = closed_df[closed_df["exit_date"] <= we]

        open_df = tj.get_open_trades()
        open_positions = len(open_df)

        if closed_df.empty:
            zeros["open_positions"] = open_positions
            return zeros

        n = len(closed_df)
        win_rate = float((closed_df["pnl_pct"] > 0).sum() / n)
        total_pnl_twd = float(closed_df["pnl_twd"].sum())
        avg_return_pct = float(closed_df["pnl_pct"].mean())
        stopped_out = int((closed_df["status"] == "STOPPED").sum())

        # Best trade
        best_idx = closed_df["pnl_pct"].idxmax()
        best_row = closed_df.loc[best_idx]
        best_trade = {
            "stock_id": str(best_row.get("stock_id", "")),
            "name": str(best_row.get("name", "")),
            "pnl_pct": float(best_row["pnl_pct"]) * 100,
        }

        # Worst trade
        worst_idx = closed_df["pnl_pct"].idxmin()
        worst_row = closed_df.loc[worst_idx]
        worst_trade = {
            "stock_id": str(worst_row.get("stock_id", "")),
            "name": str(worst_row.get("name", "")),
            "pnl_pct": float(worst_row["pnl_pct"]) * 100,
        }

        return {
            "week_label": week_label,
            "closed_trades": n,
            "win_rate": win_rate,
            "total_pnl_twd": total_pnl_twd,
            "avg_return_pct": avg_return_pct * 100,
            "best_trade": best_trade,
            "worst_trade": worst_trade,
            "stopped_out": stopped_out,
            "open_positions": open_positions,
        }

    except Exception:
        return zeros


def format_weekly_discord(report: dict) -> str:
    """Format a weekly report dict as a Discord message block.

    Example output:
        📅 週報 2026-06-01 ~ 2026-06-05
        ─────────────────────────────────────
        本週交易：  5 筆 | 勝率 60.0%
        累計損益：  NT$+12,340
        平均報酬：  +2.34%
        最佳交易：  2330 台積電 +8.2%
        最差交易：  2317 鴻海 -3.1%（止損）
        ─────────────────────────────────────
        持倉中：    3 支
    """
    divider = "─────────────────────────────────────"
    week_label = report.get("week_label", "")
    closed_trades = report.get("closed_trades", 0)

    lines = [
        f"📅 週報 {week_label}",
        divider,
    ]

    if closed_trades == 0:
        lines.append("本週無交易記錄")
    else:
        win_rate = report.get("win_rate", 0.0) * 100
        total_pnl = report.get("total_pnl_twd", 0.0)
        avg_ret = report.get("avg_return_pct", 0.0)

        pnl_sign = "+" if total_pnl >= 0 else ""
        avg_sign = "+" if avg_ret >= 0 else ""

        lines.append(f"本週交易：  {closed_trades} 筆 | 勝率 {win_rate:.1f}%")
        lines.append(f"累計損益：  NT${pnl_sign}{total_pnl:,.0f}")
        lines.append(f"平均報酬：  {avg_sign}{avg_ret:.2f}%")

        best = report.get("best_trade")
        if best:
            sign = "+" if best["pnl_pct"] >= 0 else ""
            lines.append(f"最佳交易：  {best['stock_id']} {best['name']} {sign}{best['pnl_pct']:.1f}%")

        worst = report.get("worst_trade")
        if worst:
            stopped_out = report.get("stopped_out", 0)
            stop_note = "（止損）" if stopped_out > 0 else ""
            sign = "+" if worst["pnl_pct"] >= 0 else ""
            lines.append(
                f"最差交易：  {worst['stock_id']} {worst['name']} {sign}{worst['pnl_pct']:.1f}%{stop_note}"
            )

    lines.append(divider)
    open_pos = report.get("open_positions", 0)
    lines.append(f"持倉中：    {open_pos} 支")

    return "\n".join(lines)


def scan_stats_this_week(
    scan_dir: str = "output/full_scan",
    week_start: str | None = None,
) -> dict:
    """Count batch_seq*.csv files in scan_dir with dates within the week.

    Returns:
        {"n_scan_files": int, "total_candidates": int, "n_scan_days": int}

    If scan_dir doesn't exist returns all zeros.
    """
    zeros = {"n_scan_files": 0, "total_candidates": 0, "n_scan_days": 0}

    scan_path = Path(scan_dir)
    if not scan_path.exists():
        return zeros

    ws, we = _week_bounds(week_start)

    n_scan_files = 0
    total_candidates = 0
    scan_days: set[str] = set()

    for csv_file in scan_path.glob("batch_seq*.csv"):
        # Extract date from filename — look for YYYY-MM-DD pattern
        name = csv_file.stem
        # Find a date substring of form YYYY-MM-DD
        import re
        date_match = re.search(r"(\d{4}-\d{2}-\d{2})", name)
        if date_match:
            file_date = date_match.group(1)
            if not (ws <= file_date <= we):
                continue

        n_scan_files += 1

        try:
            df = pd.read_csv(csv_file)
            total_candidates += len(df)
            if date_match:
                scan_days.add(date_match.group(1))
        except Exception:
            pass

    return {
        "n_scan_files": n_scan_files,
        "total_candidates": total_candidates,
        "n_scan_days": len(scan_days),
    }


def full_weekly_summary(
    journal_db_path: str = "output/trade_journal.db",
    scan_dir: str = "output/full_scan",
) -> str:
    """Combine weekly trade report with scan statistics.

    Returns the Discord-formatted string with scan stats appended at the
    bottom when non-zero.
    """
    report = generate_weekly_report(journal_db_path=journal_db_path)
    ws, _ = _week_bounds()

    text = format_weekly_discord(report)

    stats = scan_stats_this_week(scan_dir=scan_dir, week_start=ws)
    if stats["n_scan_files"] > 0 or stats["total_candidates"] > 0:
        n_days = stats["n_scan_days"]
        n_candidates = stats["total_candidates"]
        text += f"\n掃描日數：{n_days} 天 | 候選合計：{n_candidates} 支"

    return text
