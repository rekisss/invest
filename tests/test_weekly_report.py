import pytest
import datetime
from weekly_report import generate_weekly_report, format_weekly_discord, scan_stats_this_week, full_weekly_summary


class TestGenerateWeeklyReport:
    def test_nonexistent_db_returns_zeros(self, tmp_path):
        result = generate_weekly_report(
            journal_db_path=str(tmp_path / "no_such.db")
        )
        assert result["closed_trades"] == 0

    def test_returns_required_keys(self, tmp_path):
        result = generate_weekly_report(
            journal_db_path=str(tmp_path / "no_such.db")
        )
        for key in ("week_label", "closed_trades", "win_rate", "total_pnl_twd", "open_positions"):
            assert key in result, f"Missing key: {key}"

    def test_with_trade(self, tmp_path):
        from trade_journal import TradeJournal

        db_path = str(tmp_path / "journal.db")
        tj = TradeJournal(db_path=db_path)

        trade_id = tj.record_entry(
            stock_id="2330",
            name="台積電",
            entry_date="2026-06-02",
            entry_price=800.0,
            shares=1000,
            stop_price=760.0,
            target_price=900.0,
            entry_score=1500.0,
            grade="A",
            industry="半導體",
            entry_reason="test",
        )
        tj.record_exit(
            trade_id=trade_id,
            exit_date="2026-06-04",
            exit_price=856.0,
            exit_reason="target",
        )

        result = generate_weekly_report(
            journal_db_path=db_path,
            week_start="2026-06-01",
            week_end="2026-06-05",
        )
        assert result["closed_trades"] == 1


class TestFormatWeeklyDiscord:
    def _make_report(self, closed_trades: int = 3) -> dict:
        return {
            "week_label": "2026-06-01 ~ 2026-06-05",
            "closed_trades": closed_trades,
            "win_rate": 0.667,
            "total_pnl_twd": 12340.0,
            "avg_return_pct": 2.34,
            "best_trade": {"stock_id": "2330", "name": "台積電", "pnl_pct": 8.2},
            "worst_trade": {"stock_id": "2317", "name": "鴻海", "pnl_pct": -3.1},
            "stopped_out": 1,
            "open_positions": 3,
        }

    def test_returns_string(self):
        report = self._make_report()
        result = format_weekly_discord(report)
        assert isinstance(result, str)
        assert len(result) > 0

    def test_contains_week_label(self):
        report = self._make_report()
        result = format_weekly_discord(report)
        assert "週報" in result

    def test_no_trades_message(self):
        report = self._make_report(closed_trades=0)
        result = format_weekly_discord(report)
        assert "無交易" in result


class TestScanStatsThisWeek:
    def test_nonexistent_dir_returns_zeros(self, tmp_path):
        result = scan_stats_this_week(scan_dir=str(tmp_path / "no_such_dir"))
        assert result["n_scan_files"] == 0
        assert result["total_candidates"] == 0
        assert result["n_scan_days"] == 0

    def test_counts_csv_files(self, tmp_path):
        import pandas as pd

        (tmp_path / "batch_seq1_2026-06-02.csv").write_text(
            "stock_id,entry_score\n2330,1500\n2317,1200\n"
        )
        (tmp_path / "batch_seq2_2026-06-03.csv").write_text(
            "stock_id,entry_score\n2454,1600\n"
        )

        result = scan_stats_this_week(
            scan_dir=str(tmp_path), week_start="2026-06-01"
        )
        assert result["n_scan_files"] >= 2
        assert result["total_candidates"] >= 3
