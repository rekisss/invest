from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import pandas as pd
import requests


FINMIND_API_URL = "https://api.finmindtrade.com/api/v4/data"


@dataclass
class FinMindClient:
    cache_dir: Path = Path("cache")
    timeout: int = 90

    def __post_init__(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _auth_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        token = os.getenv("FINMIND_TOKEN", "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def _cache_path(self, dataset: str, key_parts: Iterable[str]) -> Path:
        safe_name = "_".join(str(part).replace("/", "-") for part in key_parts if str(part))
        return self.cache_dir / f"{dataset}_{safe_name}.csv"

    def fetch_dataset(self, dataset: str, use_cache: bool = True, **params: str) -> pd.DataFrame:
        cache_path = self._cache_path(
            dataset,
            [
                params.get("stock_id", ""),
                params.get("data_id", ""),
                params.get("date", ""),
                params.get("start_date", ""),
                params.get("end_date", ""),
            ]
        )
        if use_cache and cache_path.exists():
            return pd.read_csv(cache_path)

        request_params: dict[str, str] = {}
        request_params["dataset"] = dataset
        request_params.update({key: value for key, value in params.items() if value is not None})

        response = requests.get(
            FINMIND_API_URL,
            headers=self._auth_headers(),
            params=request_params,
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()
        if "data" not in payload:
            raise RuntimeError(f"Unexpected FinMind payload for {dataset}: {payload}")

        frame = pd.DataFrame(payload["data"])
        if use_cache:
            frame.to_csv(cache_path, index=False, encoding="utf-8-sig")
        return frame


def fetch_stock_info(client: FinMindClient, use_cache: bool = True) -> pd.DataFrame:
    frame = client.fetch_dataset("TaiwanStockInfo", use_cache=use_cache)
    if frame.empty:
        return pd.DataFrame(columns=["stock_id", "stock_name", "industry_category", "type", "date"])
    return frame


def load_stock_list(stock_source: str | os.PathLike[str]) -> pd.DataFrame:
    path = Path(stock_source)
    if not path.exists():
        raise FileNotFoundError(f"Stock list not found: {path}")

    frame = pd.read_csv(path, encoding="utf-8-sig")
    if "stock_id" not in frame.columns:
        raise ValueError("Stock list must contain a stock_id column.")

    if "name" not in frame.columns:
        frame["name"] = frame["stock_id"].astype(str)

    frame["stock_id"] = frame["stock_id"].astype(str).str.strip()
    frame["name"] = frame["name"].astype(str).str.strip()
    frame = frame[frame["stock_id"] != ""].drop_duplicates(subset=["stock_id"]).reset_index(drop=True)
    return frame[["stock_id", "name"]]


def fetch_stock_prices(
    client: FinMindClient,
    stock_id: str,
    start_date: str,
    end_date: str,
) -> pd.DataFrame:
    frame = client.fetch_dataset(
        "TaiwanStockPrice",
        data_id=stock_id,
        start_date=start_date,
        end_date=end_date,
    )
    if frame.empty:
        return pd.DataFrame(columns=["date", "open", "high", "low", "close", "volume", "amount"])

    renamed = frame.rename(
        columns={
            "max": "high",
            "min": "low",
            "Trading_Volume": "volume",
            "Trading_money": "amount",
        }
    )
    keep_columns = ["date", "open", "high", "low", "close", "volume", "amount"]
    renamed = renamed[keep_columns].copy()
    renamed["date"] = pd.to_datetime(renamed["date"])
    renamed = renamed.sort_values("date").drop_duplicates(subset=["date"]).reset_index(drop=True)
    return renamed


def fetch_stock_kbar(
    client: FinMindClient,
    stock_id: str,
    date: str,
) -> pd.DataFrame:
    frame = client.fetch_dataset(
        "TaiwanStockKBar",
        use_cache=False,
        data_id=stock_id,
        start_date=date,
    )
    if frame.empty:
        return pd.DataFrame(columns=["date", "minute", "stock_id", "open", "high", "low", "close", "volume"])

    keep_columns = ["date", "minute", "stock_id", "open", "high", "low", "close", "volume"]
    frame = frame[keep_columns].copy()
    frame["date"] = pd.to_datetime(frame["date"])
    frame["minute"] = frame["minute"].astype(str)
    numeric_columns = ["open", "high", "low", "close", "volume"]
    for column in numeric_columns:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame = frame.sort_values(["date", "minute"]).reset_index(drop=True)
    return frame


def fetch_market_index(
    client: FinMindClient,
    start_date: str,
    end_date: str,
) -> pd.DataFrame:
    frame = client.fetch_dataset(
        "TaiwanStockTotalReturnIndex",
        data_id="TAIEX",
        start_date=start_date,
        end_date=end_date,
    )
    if frame.empty:
        return pd.DataFrame(columns=["date", "close"])

    if "price" not in frame.columns:
        raise RuntimeError(f"TaiwanStockTotalReturnIndex missing price column: {frame.columns.tolist()}")

    market = frame[["date", "price"]].rename(columns={"price": "close"}).copy()
    market["date"] = pd.to_datetime(market["date"])
    market["close"] = pd.to_numeric(market["close"], errors="coerce")
    market = market.dropna(subset=["close"]).sort_values("date").drop_duplicates(subset=["date"]).reset_index(drop=True)
    return market


def fetch_foreign_investor_data(
    client: FinMindClient,
    stock_id: str,
    start_date: str,
    end_date: str,
) -> pd.DataFrame:
    frame = client.fetch_dataset(
        "TaiwanStockInstitutionalInvestorsBuySell",
        data_id=stock_id,
        start_date=start_date,
        end_date=end_date,
    )
    if frame.empty:
        return pd.DataFrame(columns=["date", "foreign_net"])

    mask = frame["name"].astype(str).str.contains("Foreign", case=False, na=False)
    filtered = frame.loc[mask].copy()
    if filtered.empty:
        return pd.DataFrame(columns=["date", "foreign_net"])

    filtered["date"] = pd.to_datetime(filtered["date"])
    filtered["buy"] = pd.to_numeric(filtered["buy"], errors="coerce").fillna(0)
    filtered["sell"] = pd.to_numeric(filtered["sell"], errors="coerce").fillna(0)
    filtered["foreign_net"] = filtered["buy"] - filtered["sell"]
    grouped = filtered.groupby("date", as_index=False)["foreign_net"].sum()
    grouped = grouped.sort_values("date").reset_index(drop=True)
    return grouped


def fetch_financial_statement_dates(
    client: FinMindClient,
    stock_id: str,
    start_date: str,
    end_date: str,
) -> pd.DataFrame:
    """Best-effort helper. FinMind report timing fields vary across datasets, so this is optional."""
    try:
        frame = client.fetch_dataset(
            "TaiwanStockFinancialStatements",
            data_id=stock_id,
            start_date=start_date,
            end_date=end_date,
        )
    except Exception:
        return pd.DataFrame(columns=["date"])

    if frame.empty:
        return pd.DataFrame(columns=["date"])

    date_column = None
    for candidate in ("date", "announcement_date", "upload_date"):
        if candidate in frame.columns:
            date_column = candidate
            break
    if date_column is None:
        return pd.DataFrame(columns=["date"])

    result = frame[[date_column]].rename(columns={date_column: "date"}).copy()
    result["date"] = pd.to_datetime(result["date"], errors="coerce")
    result = result.dropna().drop_duplicates().sort_values("date").reset_index(drop=True)
    return result
