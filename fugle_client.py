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
            f"{self.base_url}/intraday/quote",
            headers=self._headers(),
            params={"symbol": symbol},
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()


def normalize_quote(symbol: str, payload: dict[str, object]) -> dict[str, object]:
    data = payload.get("data", {}) if isinstance(payload, dict) else {}
    info = data.get("info", {}) if isinstance(data, dict) else {}
    quote = data.get("quote", {}) if isinstance(data, dict) else {}
    order = data.get("order", {}) if isinstance(data, dict) else {}
    trade = data.get("trade", {}) if isinstance(data, dict) else {}
    price_high = quote.get("highPrice")
    price_low = quote.get("lowPrice")
    price_open = quote.get("openPrice")
    price_prev = quote.get("prevClosePrice")
    price_last = trade.get("price") if trade else quote.get("tradePrice")
    volume = trade.get("volume") if trade else quote.get("tradeVolume")
    return {
        "symbol": symbol,
        "name": info.get("name"),
        "industry": info.get("industry"),
        "is_limit_up_price": quote.get("isLimitUpPrice"),
        "is_limit_down_price": quote.get("isLimitDownPrice"),
        "open": price_open,
        "high": price_high,
        "low": price_low,
        "prev_close": price_prev,
        "last": price_last,
        "volume": volume,
        "bid": order.get("bids", [{}])[0].get("price") if order.get("bids") else None,
        "ask": order.get("asks", [{}])[0].get("price") if order.get("asks") else None,
        "quote_time": trade.get("at") or quote.get("at"),
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
