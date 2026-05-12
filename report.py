from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd


def save_reports(
    output_dir: str | Path,
    metrics: dict[str, float],
    yearly: pd.DataFrame,
    trade_summary: pd.DataFrame,
    fills: pd.DataFrame,
    equity_curve: pd.DataFrame,
    signals: pd.DataFrame,
    notes: list[str],
) -> dict[str, Path]:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    excel_path = output_path / "backtest_report.xlsx"
    _write_excel(excel_path, metrics, yearly, trade_summary, fills, equity_curve, signals, notes)

    equity_chart = output_path / "equity_curve.png"
    yearly_chart = output_path / "yearly_performance.png"
    _plot_equity_curve(equity_curve, equity_chart)
    _plot_yearly_bar(yearly, yearly_chart)

    return {
        "excel": excel_path,
        "equity_chart": equity_chart,
        "yearly_chart": yearly_chart,
    }


def save_scan_report(
    output_dir: str | Path,
    candidates: pd.DataFrame,
    watchlist: pd.DataFrame,
    universe: pd.DataFrame,
) -> Path:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    excel_path = output_path / "scan_report.xlsx"
    with pd.ExcelWriter(excel_path, engine="openpyxl") as writer:
        candidates.to_excel(writer, sheet_name="candidates", index=False)
        watchlist.to_excel(writer, sheet_name="watchlist", index=False)
        universe.to_excel(writer, sheet_name="universe", index=False)
    return excel_path


def save_hybrid_report(
    output_dir: str | Path,
    candidates: pd.DataFrame,
    watchlist: pd.DataFrame,
    live_quotes: pd.DataFrame,
    universe: pd.DataFrame,
) -> Path:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    excel_path = output_path / "hybrid_monitor_report.xlsx"
    with pd.ExcelWriter(excel_path, engine="openpyxl") as writer:
        candidates.to_excel(writer, sheet_name="daily_candidates", index=False)
        watchlist.to_excel(writer, sheet_name="watchlist", index=False)
        live_quotes.to_excel(writer, sheet_name="live_quotes", index=False)
        universe.to_excel(writer, sheet_name="universe", index=False)
    return excel_path


def save_sponsor_monitor_report(
    output_dir: str | Path,
    candidates: pd.DataFrame,
    watchlist: pd.DataFrame,
    intraday_rows: pd.DataFrame,
    universe: pd.DataFrame,
) -> Path:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    excel_path = output_path / "sponsor_monitor_report.xlsx"
    with pd.ExcelWriter(excel_path, engine="openpyxl") as writer:
        candidates.to_excel(writer, sheet_name="daily_candidates", index=False)
        watchlist.to_excel(writer, sheet_name="watchlist", index=False)
        intraday_rows.to_excel(writer, sheet_name="intraday_snapshot", index=False)
        universe.to_excel(writer, sheet_name="universe", index=False)
    return excel_path


def _write_excel(
    excel_path: Path,
    metrics: dict[str, float],
    yearly: pd.DataFrame,
    trade_summary: pd.DataFrame,
    fills: pd.DataFrame,
    equity_curve: pd.DataFrame,
    signals: pd.DataFrame,
    notes: list[str],
) -> None:
    metrics_frame = pd.DataFrame(
        [{"metric": key, "value": value} for key, value in metrics.items()]
    )
    notes_frame = pd.DataFrame({"note": notes or ["Earnings-date filter is optional and may be skipped if source dates are unavailable."]})

    with pd.ExcelWriter(excel_path, engine="openpyxl") as writer:
        metrics_frame.to_excel(writer, sheet_name="metrics", index=False)
        yearly.to_excel(writer, sheet_name="yearly", index=False)
        trade_summary.to_excel(writer, sheet_name="trade_summary", index=False)
        fills.to_excel(writer, sheet_name="trade_fills", index=False)
        equity_curve.to_excel(writer, sheet_name="equity_curve", index=False)
        signals.to_excel(writer, sheet_name="signals", index=False)
        notes_frame.to_excel(writer, sheet_name="notes", index=False)


def _plot_equity_curve(equity_curve: pd.DataFrame, output_path: Path) -> None:
    if equity_curve.empty:
        return

    frame = equity_curve.copy()
    frame["date"] = pd.to_datetime(frame["date"])
    frame["drawdown_pct"] = frame["equity"] / frame["equity"].cummax() - 1
    worst = frame.loc[frame["drawdown_pct"].idxmin()]

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(13, 8), sharex=True, gridspec_kw={"height_ratios": [3, 1]})
    ax1.plot(frame["date"], frame["equity"], color="#0f6cbd", linewidth=2, label="Equity")
    ax1.scatter(worst["date"], worst["equity"], color="#c50f1f", s=60, label="Max drawdown")
    ax1.set_title("Portfolio Equity Curve")
    ax1.set_ylabel("Equity")
    ax1.grid(alpha=0.3)
    ax1.legend()

    ax2.fill_between(frame["date"], frame["drawdown_pct"] * 100, 0, color="#f8b3b8")
    ax2.set_title("Drawdown")
    ax2.set_ylabel("%")
    ax2.grid(alpha=0.3)

    fig.tight_layout()
    fig.savefig(output_path, dpi=160)
    plt.close(fig)


def _plot_yearly_bar(yearly: pd.DataFrame, output_path: Path) -> None:
    if yearly.empty:
        return

    fig, ax = plt.subplots(figsize=(12, 5))
    colors = ["#107c10" if value >= 0 else "#d13438" for value in yearly["pnl"]]
    ax.bar(yearly["year"].astype(str), yearly["pnl"], color=colors)
    ax.set_title("Yearly PnL")
    ax.set_xlabel("Year")
    ax.set_ylabel("PnL")
    ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()
    fig.savefig(output_path, dpi=160)
    plt.close(fig)
