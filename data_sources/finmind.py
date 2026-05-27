"""Instrumented FinMindClient wrapper with logging and latency tracking.

This wraps the existing data_loader.FinMindClient and adds:
- Per-call latency tracking via storage.sqlite.PredictionStore
- loguru / stdlib logging for each API call
- Transparent pass-through of all existing methods
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pandas as pd


class InstrumentedFinMindClient:
    """Drop-in wrapper around data_loader.FinMindClient that records API latency."""

    def __init__(self, token: str = "", cache_dir: str | Path = ".cache", store=None):
        from data_loader import FinMindClient

        self._client = FinMindClient(token=token, cache_dir=str(cache_dir))
        self._store = store  # Optional PredictionStore; None = no tracking

        try:
            from loguru import logger
            self._log = logger.bind(name="finmind")
        except ImportError:
            import logging
            self._log = logging.getLogger("finmind")

    # ── Delegate everything to underlying client ─────────────────────────────────

    def __getattr__(self, name: str):
        return getattr(self._client, name)

    # ── Instrumented fetch ───────────────────────────────────────────────────────

    def fetch_dataset(self, dataset: str, **kwargs) -> pd.DataFrame:
        t0 = time.monotonic()
        status = "ok"
        error = None
        try:
            result = self._client.fetch_dataset(dataset, **kwargs)
            return result
        except Exception as exc:
            status = "error"
            error = str(exc)[:200]
            raise
        finally:
            latency_ms = int((time.monotonic() - t0) * 1000)
            self._log.debug(f"fetch_dataset {dataset} → {latency_ms}ms [{status}]")
            if self._store is not None:
                try:
                    self._store.log_api_call(dataset, latency_ms, status, error)
                except Exception:
                    pass

    def fetch_stock_prices(self, stock_id: str, **kwargs) -> pd.DataFrame:
        t0 = time.monotonic()
        status = "ok"
        error = None
        try:
            return self._client.fetch_stock_prices(stock_id, **kwargs)
        except Exception as exc:
            status = "error"
            error = str(exc)[:200]
            raise
        finally:
            latency_ms = int((time.monotonic() - t0) * 1000)
            self._log.debug(f"fetch_stock_prices {stock_id} → {latency_ms}ms [{status}]")
            if self._store is not None:
                try:
                    self._store.log_api_call(f"prices/{stock_id}", latency_ms, status, error)
                except Exception:
                    pass

    def fetch_market_index(self, **kwargs) -> pd.DataFrame:
        t0 = time.monotonic()
        try:
            return self._client.fetch_market_index(**kwargs)
        finally:
            latency_ms = int((time.monotonic() - t0) * 1000)
            self._log.debug(f"fetch_market_index → {latency_ms}ms")
