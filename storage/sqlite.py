from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Generator


_SCHEMA = """
CREATE TABLE IF NOT EXISTS predictions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    date             TEXT NOT NULL,
    model            TEXT NOT NULL DEFAULT 'market_xgb',
    stock_id         TEXT NOT NULL DEFAULT 'TAIEX',
    prob_up          REAL,
    predicted_up     INTEGER,
    actual_up        INTEGER,
    created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_calls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL,
    dataset      TEXT,
    latency_ms   INTEGER,
    status       TEXT,
    error        TEXT
);

CREATE TABLE IF NOT EXISTS scan_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date     TEXT NOT NULL,
    seg          INTEGER DEFAULT 0,
    stocks_scanned INTEGER DEFAULT 0,
    top_n        INTEGER DEFAULT 0,
    duration_s   REAL,
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_predictions_date  ON predictions(date);
CREATE INDEX IF NOT EXISTS idx_api_calls_ts      ON api_calls(ts);
CREATE INDEX IF NOT EXISTS idx_scan_runs_date    ON scan_runs(run_date);
"""


class PredictionStore:
    """Lightweight SQLite store for prediction history, API call logs, and scan run metadata."""

    def __init__(self, db_path: str | Path = "storage/invest.db") -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        with self._conn() as conn:
            conn.executescript(_SCHEMA)

    @contextmanager
    def _conn(self) -> Generator[sqlite3.Connection, None, None]:
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    # ── Predictions ──────────────────────────────────────────────────────────────

    def log_prediction(
        self,
        date: str,
        prob_up: float,
        predicted_up: bool,
        model: str = "market_xgb",
        stock_id: str = "TAIEX",
    ) -> int:
        with self._conn() as conn:
            cur = conn.execute(
                "INSERT INTO predictions (date, model, stock_id, prob_up, predicted_up, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (date, model, stock_id, prob_up, int(predicted_up), datetime.now().isoformat()),
            )
            return cur.lastrowid  # type: ignore[return-value]

    def fill_actual(self, date: str, actual_up: bool, model: str = "market_xgb", stock_id: str = "TAIEX") -> None:
        with self._conn() as conn:
            conn.execute(
                "UPDATE predictions SET actual_up = ? WHERE date = ? AND model = ? AND stock_id = ?",
                (int(actual_up), date, model, stock_id),
            )

    def prediction_accuracy(self, last_n: int = 30) -> dict[str, float]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT predicted_up, actual_up FROM predictions "
                "WHERE actual_up IS NOT NULL ORDER BY date DESC LIMIT ?",
                (last_n,),
            ).fetchall()
        if not rows:
            return {"accuracy": 0.0, "n": 0}
        correct = sum(1 for r in rows if r["predicted_up"] == r["actual_up"])
        return {"accuracy": correct / len(rows), "n": len(rows)}

    def recent_predictions(self, n: int = 10) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT date, model, stock_id, prob_up, predicted_up, actual_up, created_at "
                "FROM predictions ORDER BY date DESC LIMIT ?",
                (n,),
            ).fetchall()
        return [dict(r) for r in rows]

    # ── API call logging ──────────────────────────────────────────────────────────

    def log_api_call(
        self,
        dataset: str,
        latency_ms: int,
        status: str = "ok",
        error: str | None = None,
    ) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO api_calls (ts, dataset, latency_ms, status, error) VALUES (?, ?, ?, ?, ?)",
                (datetime.now().isoformat(), dataset, latency_ms, status, error),
            )

    def api_stats(self, dataset: str | None = None, last_hours: int = 24) -> dict:
        cutoff = datetime.now().timestamp() - last_hours * 3600
        cutoff_iso = datetime.fromtimestamp(cutoff).isoformat()
        with self._conn() as conn:
            if dataset:
                rows = conn.execute(
                    "SELECT latency_ms, status FROM api_calls WHERE ts >= ? AND dataset = ?",
                    (cutoff_iso, dataset),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT latency_ms, status FROM api_calls WHERE ts >= ?",
                    (cutoff_iso,),
                ).fetchall()
        if not rows:
            return {"count": 0, "avg_latency_ms": 0, "error_rate": 0.0}
        latencies = [r["latency_ms"] for r in rows if r["latency_ms"]]
        errors = sum(1 for r in rows if r["status"] != "ok")
        return {
            "count": len(rows),
            "avg_latency_ms": int(sum(latencies) / len(latencies)) if latencies else 0,
            "error_rate": errors / len(rows),
        }

    # ── Scan run logging ──────────────────────────────────────────────────────────

    def log_scan_run(
        self,
        run_date: str,
        stocks_scanned: int,
        top_n: int,
        duration_s: float,
        seg: int = 0,
    ) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO scan_runs (run_date, seg, stocks_scanned, top_n, duration_s, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (run_date, seg, stocks_scanned, top_n, duration_s, datetime.now().isoformat()),
            )
