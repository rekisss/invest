from __future__ import annotations

import os
from dataclasses import dataclass

import pandas as pd
import requests


@dataclass
class FugleClient:
    api_key: str | None = None
    base_url: str = "https://api.fugle.tw/marketdata/v1.0"
    timeout: int = 20

    def __post_init__(self) -> None:
        if self.api_key is None:
            self.api_key = os.getenv("FUGLE_API_KEY", "").strip() or None

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> dict[str, str]:
        if not self.api_key:
            raise RuntimeError("FUGLE_API_KEY is not configured.")
        return {"X-API-KEY": self.api_key}

    def fetch_quote(self, symbol: str) -> dict[str, object]:
        response = requests.get(
            f"{self.base_url}/stock/intraday/quote/{symbol}",
            headers=self._headers(),
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()


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


def fetch_watch_quotes(client: FugleClient, symbols: list[str]) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    for symbol in symbols:
        try:
            payload = client.fetch_quote(symbol)
            rows.append(normalize_quote(symbol, payload))
        except Exception as error:
            rows.append({"symbol": symbol, "error": str(error)})
    return pd.DataFrame(rows)
