from __future__ import annotations

from pathlib import Path

import matplotlib
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

matplotlib.rcParams["font.family"] = ["DejaVu Sans", "sans-serif"]


def save_reports(
    output_dir: str | Path,
    metrics: dict[str, float],
    yearly: pd.DataFrame,
    trade_summary: pd.DataFrame,
    fills: pd.DataFrame,
    equity_curve: pd.DataFrame,
    signals: pd.DataFrame,
    notes: list[str],
    config: object | None = None,
) -> dict[str, Path]:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    excel_path = output_path / "backtest_report.xlsx"
    _write_excel(excel_path, metrics, yearly, trade_summary, fills, equity_curve, signals, notes, config)

    equity_chart = output_path / "equity_curve.png"
    yearly_chart = output_path / "yearly_performance.png"
    monthly_chart = output_path / "monthly_returns.png"
    trade_dist_chart = output_path / "trade_distribution.png"
    _plot_equity_curve(equity_curve, equity_chart)
    _plot_yearly_bar(yearly, yearly_chart)
    _plot_monthly_returns(equity_curve, monthly_chart)
    _plot_trade_distribution(trade_summary, trade_dist_chart)

    return {
        "excel": excel_path,
        "equity_chart": equity_chart,
        "yearly_chart": yearly_chart,
        "monthly_chart": monthly_chart,
        "trade_dist_chart": trade_dist_chart,
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
    config: object | None = None,
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
        if config is not None:
            try:
                from dataclasses import asdict
                config_dict = asdict(config)  # type: ignore[arg-type]
                config_frame = pd.DataFrame(
                    [{"parameter": k, "value": v} for k, v in config_dict.items()]
                )
                config_frame.to_excel(writer, sheet_name="config", index=False)
            except Exception:
                pass


def _plot_equity_curve(equity_curve: pd.DataFrame, output_path: Path) -> None:
    if equity_curve.empty:
        return

    frame = equity_curve.copy()
    frame["date"] = pd.to_datetime(frame["date"])
    frame["drawdown_pct"] = frame["equity"] / frame["equity"].cummax() - 1
    worst = frame.loc[frame["drawdown_pct"].idxmin()]

    has_benchmark = "benchmark_equity" in frame.columns and frame["benchmark_equity"].notna().any()

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(13, 8), sharex=True, gridspec_kw={"height_ratios": [3, 1]})
    ax1.plot(frame["date"], frame["equity"], color="#0f6cbd", linewidth=2, label="Strategy")
    if has_benchmark:
        ax1.plot(frame["date"], frame["benchmark_equity"], color="#767676", linewidth=1.5,
                 linestyle="--", alpha=0.8, label="TAIEX (buy & hold)")
    ax1.scatter(worst["date"], worst["equity"], color="#c50f1f", s=60, zorder=5, label="Max drawdown")
    ax1.set_title("Portfolio Equity Curve vs TAIEX")
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
    bars = ax.bar(yearly["year"].astype(str), yearly["return_pct"], color=colors)
    for bar, pct in zip(bars, yearly["return_pct"]):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + (0.3 if pct >= 0 else -1.2),
            f"{pct:+.1f}%",
            ha="center", va="bottom", fontsize=9,
        )
    ax.set_title("Yearly Return (%)")
    ax.set_xlabel("Year")
    ax.set_ylabel("Return %")
    ax.axhline(0, color="black", linewidth=0.8)
    ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()
    fig.savefig(output_path, dpi=160)
    plt.close(fig)


def _plot_monthly_returns(equity_curve: pd.DataFrame, output_path: Path) -> None:
    if equity_curve.empty:
        return

    frame = equity_curve.copy()
    frame["date"] = pd.to_datetime(frame["date"])
    frame["year"] = frame["date"].dt.year
    frame["month"] = frame["date"].dt.month
    monthly = frame.groupby(["year", "month"])["equity"].last().reset_index()
    monthly["prev_equity"] = monthly["equity"].shift(1)
    monthly["return_pct"] = (monthly["equity"] / monthly["prev_equity"] - 1) * 100

    pivot = monthly.pivot(index="year", columns="month", values="return_pct")
    pivot.columns = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][: len(pivot.columns)]

    fig, ax = plt.subplots(figsize=(14, max(3, len(pivot) * 0.6 + 1)))
    vmax = max(abs(pivot.values[np.isfinite(pivot.values)]).max(), 1) if pivot.size > 0 else 10
    im = ax.imshow(pivot.values, cmap="RdYlGn", aspect="auto", vmin=-vmax, vmax=vmax)
    ax.set_xticks(range(len(pivot.columns)))
    ax.set_xticklabels(pivot.columns)
    ax.set_yticks(range(len(pivot.index)))
    ax.set_yticklabels(pivot.index.astype(str))
    for (r, c), val in np.ndenumerate(pivot.values):
        if np.isfinite(val):
            ax.text(c, r, f"{val:+.1f}%", ha="center", va="center", fontsize=7, color="black")
    plt.colorbar(im, ax=ax, label="Monthly Return %")
    ax.set_title("Monthly Returns Heatmap")
    fig.tight_layout()
    fig.savefig(output_path, dpi=160)
    plt.close(fig)


def _plot_trade_distribution(trade_summary: pd.DataFrame, output_path: Path) -> None:
    if trade_summary.empty or "return_pct" not in trade_summary.columns:
        return

    returns_pct = trade_summary["return_pct"].dropna() * 100
    if returns_pct.empty:
        return

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 5))

    wins = returns_pct[returns_pct >= 0]
    losses = returns_pct[returns_pct < 0]
    bins = np.linspace(returns_pct.min() - 1, returns_pct.max() + 1, 30)
    ax1.hist(losses, bins=bins, color="#d13438", alpha=0.7, label=f"Losses ({len(losses)})")
    ax1.hist(wins, bins=bins, color="#107c10", alpha=0.7, label=f"Wins ({len(wins)})")
    ax1.axvline(0, color="black", linewidth=1)
    ax1.axvline(float(returns_pct.mean()), color="orange", linewidth=1.5, linestyle="--", label=f"Mean {returns_pct.mean():+.1f}%")
    ax1.set_title("Trade Return Distribution")
    ax1.set_xlabel("Return %")
    ax1.set_ylabel("Count")
    ax1.legend(fontsize=8)
    ax1.grid(alpha=0.3)

    labels = ["Wins", "Losses"]
    sizes = [len(wins), len(losses)]
    colors_pie = ["#107c10", "#d13438"]
    wedges, _, autotexts = ax2.pie(sizes, labels=labels, colors=colors_pie, autopct="%1.1f%%", startangle=90)
    for at in autotexts:
        at.set_fontsize(10)
    ax2.set_title(f"Win Rate  (n={len(returns_pct)})")

    fig.tight_layout()
    fig.savefig(output_path, dpi=160)
    plt.close(fig)
