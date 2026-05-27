"""Tests for storage.sqlite.PredictionStore."""
import os
import tempfile
import pytest
from storage.sqlite import PredictionStore


@pytest.fixture
def store(tmp_path):
    return PredictionStore(tmp_path / "test.db")


def test_log_and_recall(store):
    row_id = store.log_prediction("2026-01-01", prob_up=0.65, predicted_up=True)
    assert row_id > 0
    rows = store.recent_predictions(10)
    assert len(rows) == 1
    assert rows[0]["date"] == "2026-01-01"
    assert abs(rows[0]["prob_up"] - 0.65) < 1e-6


def test_fill_actual_and_accuracy(store):
    store.log_prediction("2026-01-01", 0.7, True)
    store.fill_actual("2026-01-01", True)
    acc = store.prediction_accuracy()
    assert acc["accuracy"] == 1.0
    assert acc["n"] == 1


def test_accuracy_with_wrong_prediction(store):
    store.log_prediction("2026-01-01", 0.7, True)
    store.fill_actual("2026-01-01", False)  # wrong
    acc = store.prediction_accuracy()
    assert acc["accuracy"] == 0.0


def test_api_call_logging(store):
    store.log_api_call("TaiwanStockPrice", latency_ms=120, status="ok")
    store.log_api_call("TaiwanStockPrice", latency_ms=350, status="error", error="timeout")
    stats = store.api_stats("TaiwanStockPrice", last_hours=1)
    assert stats["count"] == 2
    assert stats["error_rate"] == 0.5


def test_scan_run_logging(store):
    store.log_scan_run("2026-01-01", stocks_scanned=600, top_n=20, duration_s=3200.5, seg=0)
    # No assertion needed — just confirm no exception
