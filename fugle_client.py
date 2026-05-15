from __future__ import annotations

import os
import random
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

import pandas as pd
import requests
from requests.adapters import HTTPAdapter


def _retry(func, max_attempts: int = 3, backoff: float = 2.0):
    last_error: Exception | None = None
    for attempt in range(max_attempts):
        try:
            return func()
        except requests.exceptions.HTTPError as exc:
            # 4xx 是用戶端錯誤（金鑰無效、無權限等），重試無意義
            if exc.response is not None and exc.response.status_code < 500:
                raise
            last_error = exc
            if attempt < max_attempts - 1:
                time.sleep(backoff * (2 ** attempt) + random.uniform(0, 0.5))
        except Exception as exc:
            last_error = exc
            if attempt < max_attempts - 1:
                time.sleep(backoff * (2 ** attempt) + random.uniform(0, 0.5))
    raise last_error  # type: ignore[misc]


@dataclass
class FugleClient:
    api_key: str | None = None
    base_url: str = "https://api.fugle.tw/marketdata/v1.0"
    timeout: int = 20

    def __post_init__(self) -> None:
        if self.api_key is None:
            self.api_key = os.getenv("FUGLE_API_KEY", "").strip() or None
        self._session = requests.Session()
        _adapter = HTTPAdapter(pool_connections=2, pool_maxsize=16)
        self._session.mount("https://", _adapter)
        self._session.mount("http://", _adapter)
        self._headers_cache: dict[str, str] = {"X-API-KEY": self.api_key} if self.api_key else {}

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> dict[str, str]:
        if not self.api_key:
            raise RuntimeError("FUGLE_API_KEY is not configured.")
        return self._headers_cache

    def fetch_quote(self, symbol: str) -> dict[str, object]:
        def _do() -> dict[str, object]:
            response = self._session.get(
                f"{self.base_url}/stock/intraday/quote/{symbol}",
                headers=self._headers(),
                timeout=self.timeout,
            )
            if response.status_code == 401:
                raise requests.exceptions.HTTPError(
                    "401 金鑰無效或未授權，請確認 FUGLE_API_KEY 是否正確", response=response
                )
            if response.status_code == 403:
                raise requests.exceptions.HTTPError(
                    "403 金鑰無此 API 權限，請升級方案", response=response
                )
            if response.status_code == 429:
                raise requests.exceptions.HTTPError(
                    "429 請求頻率過高，請稍後再試", response=response
                )
            response.raise_for_status()
            return response.json()
        return _retry(_do)


def normalize_quote(symbol: str, payload: dict[str, object]) -> dict[str, object]:
    data = payload if isinstance(payload, dict) else {}
    price_high = data.get("highPrice")
    price_low = data.get("lowPrice")
    price_open = data.get("openPrice")
    price_prev = data.get("previousClose")
    price_last = data.get("closePrice")
    volume = data.get("tradeVolume")
    return {
        "symbol": symbol,
        "name": data.get("name"),
        "industry": data.get("industry"),
        "exchange": data.get("exchange"),
        "market": data.get("market"),
        "open": price_open,
        "high": price_high,
        "low": price_low,
        "prev_close": price_prev,
        "last": price_last,
        "volume": volume,
        "reference_price": data.get("referencePrice"),
        "bid": None,
        "ask": None,
        "quote_time": data.get("closeTime") or data.get("openTime"),
    }


def fetch_watch_quotes(client: FugleClient, symbols: list[str], workers: int = 5) -> pd.DataFrame:
    def _fetch_one(symbol: str) -> dict[str, object]:
        try:
            return normalize_quote(symbol, client.fetch_quote(symbol))
        except Exception as error:
            return {"symbol": symbol, "error": str(error)}

    rows: list[dict[str, object]] = [None] * len(symbols)  # type: ignore[list-item]
    with ThreadPoolExecutor(max_workers=min(workers, len(symbols) or 1)) as pool:
        future_to_idx = {pool.submit(_fetch_one, sym): i for i, sym in enumerate(symbols)}
        for future in as_completed(future_to_idx):
            rows[future_to_idx[future]] = future.result()
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame

    if "last" in frame.columns and "prev_close" in frame.columns:
        last_num = pd.to_numeric(frame["last"], errors="coerce")
        prev_num = pd.to_numeric(frame["prev_close"], errors="coerce")
        frame["intraday_pct"] = last_num / prev_num - 1
        frame.loc[prev_num == 0, "intraday_pct"] = pd.NA
    else:
        frame["intraday_pct"] = pd.NA

    if "error" not in frame.columns:
        frame["error"] = pd.NA

    frame["sort_intraday"] = pd.to_numeric(frame["intraday_pct"], errors="coerce").fillna(-999)
    frame["has_error"] = frame["error"].notna() & (frame["error"].astype(str) != "nan")
    frame = frame.sort_values(["has_error", "sort_intraday"], ascending=[True, False]).drop(columns=["sort_intraday", "has_error"])
    return frame.reset_index(drop=True)
