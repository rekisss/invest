"""
SQLite-backed trade journal for recording entries, exits, and P&L.

Tracks scanner recommendations over time so users can measure strategy
performance in practice (not just backtests).

Standalone module — no existing files modified.
Uses only stdlib sqlite3 + standard pandas.
"""

import sqlite3
import os
from datetime import datetime, timezone
from typing import Optional

import pandas as pd


class TradeJournal:
    """SQLite-backed trade journal for recording entries, exits, and P&L."""

    TRADE_COLUMNS = [
        "id", "stock_id", "name", "entry_date", "entry_price", "shares",
        "stop_price", "target_price", "entry_score", "grade", "industry",
        "entry_reason", "status", "exit_date", "exit_price", "exit_reason",
        "pnl_pct", "pnl_twd", "created_at",
    ]

    def __init__(self, db_path: str = "output/trade_journal.db"):
        self.db_path = db_path
        # Create parent directory if needed
        parent = os.path.dirname(db_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS trades (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    stock_id TEXT NOT NULL,
                    name TEXT DEFAULT '',
                    entry_date TEXT NOT NULL,
                    entry_price REAL NOT NULL,
                    shares INTEGER NOT NULL,
                    stop_price REAL NOT NULL,
                    target_price REAL,
                    entry_score REAL,
                    grade TEXT,
                    industry TEXT DEFAULT '',
                    entry_reason TEXT DEFAULT '',
                    status TEXT DEFAULT 'OPEN',
                    exit_date TEXT,
                    exit_price REAL,
                    exit_reason TEXT DEFAULT '',
                    pnl_pct REAL,
                    pnl_twd REAL,
                    created_at TEXT NOT NULL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS scan_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scan_date TEXT NOT NULL,
                    n_candidates INTEGER,
                    n_entry_signals INTEGER,
                    top_score REAL,
                    market_regime TEXT DEFAULT '',
                    notes TEXT DEFAULT '',
                    created_at TEXT NOT NULL
                )
            """)
            conn.commit()

    def _now_utc(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def record_entry(
        self,
        stock_id: str,
        name: str,
        entry_date: str,
        entry_price: float,
        shares: int,
        stop_price: float,
        target_price: Optional[float] = None,
        entry_score: Optional[float] = None,
        grade: Optional[str] = None,
        industry: str = "",
        entry_reason: str = "",
    ) -> int:
        """Insert a new OPEN trade row. Returns the new row's id."""
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO trades (
                    stock_id, name, entry_date, entry_price, shares,
                    stop_price, target_price, entry_score, grade, industry,
                    entry_reason, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
                """,
                (
                    stock_id, name, entry_date, entry_price, shares,
                    stop_price, target_price, entry_score, grade, industry,
                    entry_reason, self._now_utc(),
                ),
            )
            conn.commit()
            return cursor.lastrowid

    def record_exit(
        self,
        trade_id: int,
        exit_date: str,
        exit_price: float,
        exit_reason: str = "",
    ) -> bool:
        """Update trade with id=trade_id. Returns True if updated, False if not found."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT entry_price, shares, stop_price FROM trades WHERE id = ?",
                (trade_id,),
            ).fetchone()
            if row is None:
                return False

            entry_price = row["entry_price"]
            shares = row["shares"]
            stop_price = row["stop_price"]

            pnl_pct = (exit_price - entry_price) / entry_price
            pnl_twd = (exit_price - entry_price) * shares
            status = "STOPPED" if exit_price <= stop_price else "CLOSED"

            conn.execute(
                """
                UPDATE trades
                SET exit_date = ?, exit_price = ?, exit_reason = ?,
                    pnl_pct = ?, pnl_twd = ?, status = ?
                WHERE id = ?
                """,
                (exit_date, exit_price, exit_reason, pnl_pct, pnl_twd, status, trade_id),
            )
            conn.commit()
            return True

    def get_open_trades(self) -> pd.DataFrame:
        """Returns all rows where status = 'OPEN', as a DataFrame."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM trades WHERE status = 'OPEN' ORDER BY entry_date"
            ).fetchall()
        if not rows:
            return pd.DataFrame(columns=self.TRADE_COLUMNS)
        return pd.DataFrame([dict(r) for r in rows])

    def get_closed_trades(self, since_date: Optional[str] = None) -> pd.DataFrame:
        """Returns all rows where status in ('CLOSED', 'STOPPED'), optionally filtered."""
        with self._connect() as conn:
            if since_date:
                rows = conn.execute(
                    """
                    SELECT * FROM trades
                    WHERE status IN ('CLOSED', 'STOPPED')
                      AND exit_date >= ?
                    ORDER BY exit_date
                    """,
                    (since_date,),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM trades
                    WHERE status IN ('CLOSED', 'STOPPED')
                    ORDER BY exit_date
                    """
                ).fetchall()
        if not rows:
            return pd.DataFrame(columns=self.TRADE_COLUMNS)
        return pd.DataFrame([dict(r) for r in rows])

    def performance_summary(self, since_date: Optional[str] = None) -> dict:
        """Compute stats from closed trades. Returns dict with all zeros if no trades."""
        df = self.get_closed_trades(since_date=since_date)

        zeros = {
            "n_trades": 0,
            "win_rate": 0.0,
            "avg_return_pct": 0.0,
            "total_pnl_twd": 0.0,
            "best_trade_pct": 0.0,
            "worst_trade_pct": 0.0,
            "avg_hold_days": 0.0,
            "stopped_out_pct": 0.0,
        }

        if df.empty:
            return zeros

        n = len(df)
        win_rate = float((df["pnl_pct"] > 0).sum() / n)
        avg_return_pct = float(df["pnl_pct"].mean())
        total_pnl_twd = float(df["pnl_twd"].sum())
        best_trade_pct = float(df["pnl_pct"].max())
        worst_trade_pct = float(df["pnl_pct"].min())
        stopped_out_pct = float((df["status"] == "STOPPED").sum() / n)

        # Compute avg hold days
        try:
            entry_dates = pd.to_datetime(df["entry_date"])
            exit_dates = pd.to_datetime(df["exit_date"])
            hold_days = (exit_dates - entry_dates).dt.days
            avg_hold_days = float(hold_days.mean())
        except Exception:
            avg_hold_days = 0.0

        return {
            "n_trades": n,
            "win_rate": win_rate,
            "avg_return_pct": avg_return_pct,
            "total_pnl_twd": total_pnl_twd,
            "best_trade_pct": best_trade_pct,
            "worst_trade_pct": worst_trade_pct,
            "avg_hold_days": avg_hold_days,
            "stopped_out_pct": stopped_out_pct,
        }

    def record_scan(
        self,
        scan_date: str,
        n_candidates: int,
        n_entry_signals: int,
        top_score: float,
        market_regime: str = "",
        notes: str = "",
    ) -> None:
        """Insert a row into scan_history."""
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scan_history (
                    scan_date, n_candidates, n_entry_signals, top_score,
                    market_regime, notes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    scan_date, n_candidates, n_entry_signals, top_score,
                    market_regime, notes, self._now_utc(),
                ),
            )
            conn.commit()

    def format_open_positions(self) -> str:
        """Discord-formatted string of open positions."""
        df = self.get_open_trades()
        if df.empty:
            return "📋 **持倉追蹤** (0 支)\n無持倉"

        n = len(df)
        lines = [f"📋 **持倉追蹤** ({n} 支)"]
        for i, (_, row) in enumerate(df.iterrows(), start=1):
            target_str = f"{row['target_price']}" if row.get("target_price") is not None else "N/A"
            lines.append(
                f"{i}. {row['stock_id']} {row['name']}  "
                f"進場 {row['entry_price']} | "
                f"停損 {row['stop_price']} | "
                f"目標 {target_str} | "
                f"{row['entry_date']}"
            )
        return "\n".join(lines)

    def format_performance(self) -> str:
        """Discord-formatted performance summary."""
        s = self.performance_summary()
        n = s["n_trades"]
        win_pct = s["win_rate"] * 100
        avg_ret = s["avg_return_pct"] * 100
        total_pnl = s["total_pnl_twd"]
        stopped_pct = s["stopped_out_pct"] * 100

        sign = "+" if avg_ret >= 0 else ""
        pnl_sign = "+" if total_pnl >= 0 else ""

        return (
            "📊 **策略績效摘要**\n"
            f"交易筆數：  {n}\n"
            f"勝率：      {win_pct:.1f}%\n"
            f"平均報酬：  {sign}{avg_ret:.2f}%\n"
            f"累計損益：  NT${pnl_sign}{total_pnl:,.0f}\n"
            f"停損出場：  {stopped_pct:.1f}%"
        )
