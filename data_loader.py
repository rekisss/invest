from __future__ import annotations

import os
import random
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from pandas.errors import EmptyDataError, ParserError


FINMIND_API_URL = "https://api.finmindtrade.com/api/v4/data"
FINMIND_LOGIN_URL = "https://api.finmindtrade.com/api/v4/login"


def validate_finmind_token() -> tuple[bool, str]:
    """Check that FINMIND_TOKEN is set and accepted by the API.

    Makes a lightweight data request (single stock info) to verify the token
    without downloading large datasets. Using the data endpoint is correct
    for Bearer token auth — the login endpoint requires user_id/password.
    """
    token = os.getenv("FINMIND_TOKEN", "").strip()
    if not token:
        return False, "FINMIND_TOKEN 未設定 — 請在 GitHub Secrets 加入此變數"
    try:
        resp = requests.get(
            FINMIND_API_URL,
            headers={"Authorization": f"Bearer {token}"},
            params={"dataset": "TaiwanStockInfo", "data_id": "2330"},
            timeout=15,
        )
        payload = resp.json()
        status = payload.get("status", resp.status_code)
        if status == 200:
            return True, "token OK"
        msg = payload.get("msg") or resp.text[:200]
        return False, f"FinMind 拒絕 token（{status}）：{msg}"
    except Exception as exc:
        return False, f"無法連線 FinMind API：{exc}"


@dataclass
class FinMindClient:
    cache_dir: Path = Path("cache")
    timeout: int = 90
    _session: requests.Session = field(default_factory=requests.Session, init=False, repr=False)

    def __post_init__(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        _adapter = HTTPAdapter(pool_connections=4, pool_maxsize=16)
        self._session.mount("https://", _adapter)
        self._session.mount("http://", _adapter)
        token = os.getenv("FINMIND_TOKEN", "").strip()
        self._auth_headers_cache: dict[str, str] = (
            {"Authorization": f"Bearer {token}"} if token else {}
        )

    def _auth_headers(self) -> dict[str, str]:
        return self._auth_headers_cache

    def _cache_path(self, dataset: str, key_parts: Iterable[str]) -> Path:
        safe_name = "_".join(str(part).replace("/", "-") for part in key_parts if str(part))
        return self.cache_dir / f"{dataset}_{safe_name}.csv"

    def fetch_dataset(self, dataset: str, use_cache: bool = True, cache_ttl_days: int = 0, **params: str) -> pd.DataFrame:
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
        cache_fresh = False
        if use_cache:
            try:
                mtime = cache_path.stat().st_mtime
                cache_fresh = cache_ttl_days <= 0 or (time.time() - mtime) / 86400 < cache_ttl_days
            except FileNotFoundError:
                pass
        if cache_fresh:
            try:
                return pd.read_csv(cache_path)
            except (EmptyDataError, ParserError):
                cache_path.unlink(missing_ok=True)

        request_params: dict[str, str] = {"dataset": dataset}
        for key, value in params.items():
            if value is not None:
                request_params[key] = value

        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = self._session.get(
                    FINMIND_API_URL,
                    headers=self._auth_headers(),
                    params=request_params,
                    timeout=self.timeout,
                )
                response.raise_for_status()
                break
            except requests.exceptions.RequestException as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(2 ** attempt * 2 + random.uniform(0, 1))
        else:
            raise last_error  # type: ignore[misc]

        payload = response.json()
        api_status = payload.get("status")
        if api_status is not None and api_status != 200:
            raise RuntimeError(
                f"FinMind API error for {dataset}: status={api_status} msg={payload.get('msg', '')}"
            )
        if "data" not in payload:
            raise RuntimeError(f"Unexpected FinMind payload for {dataset}: {payload}")

        frame = pd.DataFrame(payload["data"])
        if use_cache:
            frame.to_csv(cache_path, index=False, encoding="utf-8-sig")
        return frame


def fetch_stock_info(client: FinMindClient, use_cache: bool = True) -> pd.DataFrame:
    frame = client.fetch_dataset("TaiwanStockInfo", use_cache=use_cache, cache_ttl_days=1)
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

    _src_cols = [c for c in ["date", "open", "max", "min", "close", "Trading_Volume", "Trading_money"] if c in frame.columns]
    renamed = frame[_src_cols].rename(columns={
        "max": "high", "min": "low",
        "Trading_Volume": "volume", "Trading_money": "amount",
    })
    keep_columns = ["date", "open", "high", "low", "close", "volume", "amount"]
    missing = [c for c in keep_columns if c not in renamed.columns]
    if missing:
        return pd.DataFrame(columns=keep_columns)
    renamed = renamed[keep_columns].copy()
    renamed["date"] = pd.to_datetime(renamed["date"])
    numeric_cols = ["open", "high", "low", "close", "volume", "amount"]
    renamed[numeric_cols] = renamed[numeric_cols].apply(pd.to_numeric, errors="coerce")
    renamed = renamed.dropna(subset=["close"])
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
    frame[numeric_columns] = frame[numeric_columns].apply(pd.to_numeric, errors="coerce")
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


_INSTITUTION_PATTERNS: dict[str, list[str]] = {
    "foreign_net": ["Foreign", "外資"],
    "invest_trust_net": ["Investment_Trust", "投信"],
    "dealer_net": ["Dealer", "自營"],
}
_INSTITUTION_REGEXES: dict[str, re.Pattern[str]] = {
    col: re.compile("|".join(pats), re.IGNORECASE)
    for col, pats in _INSTITUTION_PATTERNS.items()
}


def fetch_institutional_data(
    client: FinMindClient,
    stock_id: str,
    start_date: str,
    end_date: str,
) -> pd.DataFrame:
    """Return daily net buy/sell for 外資, 投信, 自營商."""
    frame = client.fetch_dataset(
        "TaiwanStockInstitutionalInvestorsBuySell",
        data_id=stock_id,
        start_date=start_date,
        end_date=end_date,
    )
    empty = pd.DataFrame(columns=["date", "foreign_net", "invest_trust_net", "dealer_net"])
    if frame.empty:
        return empty

    frame["date"] = pd.to_datetime(frame["date"])
    frame["buy"] = pd.to_numeric(frame["buy"], errors="coerce").fillna(0)
    frame["sell"] = pd.to_numeric(frame["sell"], errors="coerce").fillna(0)
    frame["net"] = frame["buy"] - frame["sell"]
    name_col = frame["name"].astype(str)

    result = frame["date"].drop_duplicates().sort_values().rename("date").to_frame(index=False)
    for col, regex in _INSTITUTION_REGEXES.items():
        mask = name_col.str.contains(regex, na=False)
        if mask.any():
            grouped = frame.loc[mask].groupby("date", as_index=False)["net"].sum().rename(columns={"net": col})
            result = result.merge(grouped, on="date", how="left")
        else:
            result[col] = 0.0
    _net_cols = ["foreign_net", "invest_trust_net", "dealer_net"]
    result[_net_cols] = result[_net_cols].fillna(0)
    return result.sort_values("date").reset_index(drop=True)


def clean_cache(cache_dir: Path | str, max_age_days: int = 30) -> int:
    """Delete CSV cache files older than max_age_days. Returns count of deleted files."""
    cache_path = Path(cache_dir)
    if not cache_path.exists():
        return 0
    cutoff = time.time() - max_age_days * 86400
    deleted = 0
    for csv_file in cache_path.glob("*.csv"):
        try:
            if csv_file.stat().st_mtime < cutoff:
                csv_file.unlink()
                deleted += 1
        except OSError:
            pass
    return deleted


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
