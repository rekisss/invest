import pytest
import datetime
import pandas as pd
from trade_journal import TradeJournal


@pytest.fixture
def journal(tmp_path):
    return TradeJournal(db_path=str(tmp_path / "test.db"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _add_trade(journal, stock_id="2330", name="台積電", entry_date="2026-01-10",
               entry_price=900.0, shares=100, stop_price=860.0,
               target_price=972.0, entry_score=85.0, grade="A"):
    return journal.record_entry(
        stock_id=stock_id,
        name=name,
        entry_date=entry_date,
        entry_price=entry_price,
        shares=shares,
        stop_price=stop_price,
        target_price=target_price,
        entry_score=entry_score,
        grade=grade,
    )


# ---------------------------------------------------------------------------
# TestRecordEntry
# ---------------------------------------------------------------------------

class TestRecordEntry:
    def test_returns_id(self, journal):
        tid = _add_trade(journal)
        assert isinstance(tid, int)
        assert tid > 0

    def test_trade_appears_in_open(self, journal):
        _add_trade(journal, stock_id="2330")
        df = journal.get_open_trades()
        assert len(df) == 1
        assert df.iloc[0]["stock_id"] == "2330"
        assert df.iloc[0]["status"] == "OPEN"

    def test_multiple_entries(self, journal):
        _add_trade(journal, stock_id="2330")
        _add_trade(journal, stock_id="2454")
        _add_trade(journal, stock_id="2317")
        df = journal.get_open_trades()
        assert len(df) == 3


# ---------------------------------------------------------------------------
# TestRecordExit
# ---------------------------------------------------------------------------

class TestRecordExit:
    def test_closes_trade(self, journal):
        tid = _add_trade(journal)
        journal.record_exit(tid, "2026-02-01", 960.0)
        df = journal.get_open_trades()
        assert len(df) == 0

    def test_computes_pnl(self, journal):
        tid = journal.record_entry(
            stock_id="TEST",
            name="Test",
            entry_date="2026-01-01",
            entry_price=100.0,
            shares=100,
            stop_price=90.0,
        )
        journal.record_exit(tid, "2026-01-20", 115.0)
        df = journal.get_closed_trades()
        row = df.iloc[0]
        assert abs(row["pnl_pct"] - 0.15) < 1e-9
        assert abs(row["pnl_twd"] - 1500.0) < 1e-9

    def test_stopped_status(self, journal):
        tid = _add_trade(journal, entry_price=900.0, stop_price=860.0)
        # exit at stop price — should be STOPPED
        journal.record_exit(tid, "2026-02-01", 855.0)
        df = journal.get_closed_trades()
        assert df.iloc[0]["status"] == "STOPPED"

    def test_closed_status(self, journal):
        tid = _add_trade(journal, entry_price=900.0, stop_price=860.0)
        journal.record_exit(tid, "2026-02-01", 960.0)
        df = journal.get_closed_trades()
        assert df.iloc[0]["status"] == "CLOSED"

    def test_invalid_id_returns_false(self, journal):
        result = journal.record_exit(999, "2026-02-01", 960.0)
        assert result is False


# ---------------------------------------------------------------------------
# TestPerformanceSummary
# ---------------------------------------------------------------------------

class TestPerformanceSummary:
    def test_empty_returns_zeros(self, journal):
        s = journal.performance_summary()
        assert s["n_trades"] == 0
        assert s["win_rate"] == 0.0
        assert s["total_pnl_twd"] == 0.0

    def test_win_rate(self, journal):
        # 2 wins (entry=100, exit=110), 1 loss (entry=100, exit=90)
        for exit_px in [110.0, 112.0, 90.0]:
            tid = journal.record_entry(
                stock_id="X", name="", entry_date="2026-01-01",
                entry_price=100.0, shares=10, stop_price=80.0,
            )
            journal.record_exit(tid, "2026-01-20", exit_px)
        s = journal.performance_summary()
        assert s["n_trades"] == 3
        assert abs(s["win_rate"] - 2 / 3) < 1e-6

    def test_total_pnl(self, journal):
        # Trade 1: +500, Trade 2: -200
        t1 = journal.record_entry("A", "", "2026-01-01", 100.0, 50, 90.0)
        t2 = journal.record_entry("B", "", "2026-01-01", 100.0, 20, 90.0)
        journal.record_exit(t1, "2026-01-15", 110.0)   # +500
        journal.record_exit(t2, "2026-01-15", 90.0)    # -200
        s = journal.performance_summary()
        assert abs(s["total_pnl_twd"] - 300.0) < 1e-6

    def test_since_date_filters(self, journal):
        # Old trade (before filter date)
        t1 = journal.record_entry("OLD", "", "2025-01-01", 100.0, 10, 80.0)
        journal.record_exit(t1, "2025-06-01", 110.0)
        # New trade (after filter date)
        t2 = journal.record_entry("NEW", "", "2026-01-01", 100.0, 10, 80.0)
        journal.record_exit(t2, "2026-03-01", 120.0)

        s_all = journal.performance_summary()
        assert s_all["n_trades"] == 2

        s_filtered = journal.performance_summary(since_date="2026-01-01")
        assert s_filtered["n_trades"] == 1


# ---------------------------------------------------------------------------
# TestRecordScan
# ---------------------------------------------------------------------------

class TestRecordScan:
    def test_records_without_error(self, journal):
        journal.record_scan(
            scan_date="2026-06-11",
            n_candidates=50,
            n_entry_signals=5,
            top_score=92.3,
            market_regime="BULL",
            notes="Test scan",
        )


# ---------------------------------------------------------------------------
# TestFormatOpenPositions
# ---------------------------------------------------------------------------

class TestFormatOpenPositions:
    def test_empty_message(self, journal):
        msg = journal.format_open_positions()
        assert "0 支" in msg

    def test_shows_stock_id(self, journal):
        _add_trade(journal, stock_id="2330")
        msg = journal.format_open_positions()
        assert "2330" in msg


# ---------------------------------------------------------------------------
# TestFormatPerformance
# ---------------------------------------------------------------------------

class TestFormatPerformance:
    def test_returns_string(self, journal):
        result = journal.format_performance()
        assert isinstance(result, str)
        assert len(result) > 0

    def test_contains_winrate_label(self, journal):
        result = journal.format_performance()
        assert "勝率" in result
