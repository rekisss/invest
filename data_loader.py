from __future__ import annotations

import os
import random
import re
import sys
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
        msg = str(payload.get("msg") or resp.text[:200])
        if status == 402 and "limit" in msg.lower():
            return False, f"⏰ FinMind 每日免費配額已耗盡，明天 UTC 00:00 自動重置。\n升級帳戶：https://finmindtrade.com/"
        return False, f"FinMind 拒絕 token（{status}）：{msg}"
    except Exception as exc:
        return False, f"無法連線 FinMind API：{exc}"


def probe_batch_quota(client: "FinMindClient") -> tuple[bool, str]:
    """Probe TaiwanStockPrice quota before a batch scan.

    Returns (True, msg)  — quota available, safe to scan.
    Returns (False, msg) — either permanent quota exhaustion OR transient IP
    throttle still active.  The caller is responsible for deciding whether to
    wait-and-retry (IP throttle) or skip entirely (quota exhausted).

    Callers can distinguish the two cases by checking whether "IP 限流" appears
    in the returned message.
    """
    from datetime import datetime, timedelta
    probe_date = (datetime.now() - timedelta(days=3)).strftime("%Y-%m-%d")
    today = datetime.now().strftime("%Y-%m-%d")
    _probe_ids = ["2330", "2317", "0050"]
    _transient_hits = 0
    for _pid in _probe_ids:
        try:
            client.fetch_dataset(
                "TaiwanStockPrice",
                use_cache=False,
                data_id=_pid,
                start_date=probe_date,
                end_date=today,
            )
        except RuntimeError as exc:
            msg = str(exc)
            if "配額已耗盡" in msg or "upper limit" in msg.lower():
                return False, f"配額已耗盡：{msg}"
            # Transient IP throttle — count it and try the next probe stock
            # immediately (no sleep here; the caller handles wait-and-retry).
            _transient_hits += 1
        except requests.exceptions.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 402:
                body = ""
                try:
                    body = exc.response.text or ""
                except Exception:
                    pass
                if "upper limit" in body.lower() or "每日" in body or "daily" in body.lower():
                    return False, "配額已耗盡（HTTP 402）"
                _transient_hits += 1
            else:
                return True, "配額正常（HTTP 錯誤忽略）"
        except Exception:
            return True, "配額正常（探測失敗忽略）"
    if _transient_hits >= 2:
        return False, f"IP 限流中（{_transient_hits}/3 個探測均暫時性失敗）"
    return True, "配額正常"


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
        time.sleep(0.3)  # rate-limit guard: spread requests to avoid IP throttling
        for key, value in params.items():
            if value is not None:
                request_params[key] = value

        last_error: Exception | None = None
        response = None
        for attempt in range(4):
            try:
                response = self._session.get(
                    FINMIND_API_URL,
                    headers=self._auth_headers(),
                    params=request_params,
                    timeout=self.timeout,
                )
                response.raise_for_status()
            except requests.exceptions.HTTPError as exc:
                if exc.response is not None and exc.response.status_code == 402:
                    # Try to read the response body to distinguish permanent quota
                    # exhaustion ("upper limit") from a transient rate-limit 402.
                    body = ""
                    try:
                        body = exc.response.text or ""
                    except Exception:
                        pass
                    if "upper limit" in body.lower() or "每日" in body or "daily" in body.lower():
                        # FinMind IP throttle sometimes returns the same 402 body as real
                        # quota exhaustion. Retry once after a wait to distinguish them:
                        # if it recovers → was just IP throttle; if it fails again → real quota.
                        if attempt < 1:
                            last_error = exc
                            time.sleep(20)
                            continue
                        raise RuntimeError(
                            f"FinMind 每日配額已耗盡，明天自動重置。(HTTP 402 {dataset})"
                        ) from exc
                    # Transient rate-limit: retry once briefly then give up fast
                    if attempt < 1:
                        last_error = exc
                        time.sleep(2.0)
                        continue
                    # Still 402 after retries but body never said "upper limit" →
                    # treat as transient (not permanent quota), caller should skip + continue
                    raise RuntimeError(
                        f"FinMind transient rate-limit (HTTP 402 {dataset}), giving up"
                    ) from exc
            except requests.exceptions.RequestException as exc:
                last_error = exc
                if attempt < 3:
                    time.sleep(2 ** attempt * 3 + random.uniform(0, 2))
                continue

            payload = response.json()
            api_status = payload.get("status")
            if api_status == 402:
                msg = payload.get("msg", "")
                # Only "upper limit" means permanent daily quota exhaustion;
                # "rate limit" / "limit" alone is just transient throttling → retry
                if "upper limit" in str(msg).lower():
                    # Same ambiguity as HTTP 402: retry once with wait before giving up.
                    if attempt < 1:
                        last_error = RuntimeError(f"FinMind 疑似配額耗盡，等待重試… ({msg})")
                        time.sleep(20)
                        continue
                    raise RuntimeError(f"FinMind 每日配額已耗盡，明天自動重置。({msg})")
                # Otherwise transient rate-limit — retry once briefly then give up fast
                last_error = RuntimeError(
                    f"FinMind rate limit (402) for {dataset}, attempt {attempt + 1}"
                )
                if attempt < 1:
                    time.sleep(2.0)
                continue
            if api_status is not None and api_status != 200:
                raise RuntimeError(
                    f"FinMind API error for {dataset}: status={api_status} msg={payload.get('msg', '')}"
                )
            if "data" not in payload:
                raise RuntimeError(f"Unexpected FinMind payload for {dataset}: {payload}")
            break
        else:
            raise last_error  # type: ignore[misc]

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
        print(f"[data_loader] fetch_stock_prices: 缺少欄位 {missing}，回傳空資料", file=sys.stderr)
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

    result = frame["date"].drop_duplicates().sort_values().rename("date").to_frame().reset_index(drop=True)
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


def fetch_market_institutional(
    client: FinMindClient,
    start_date: str,
    end_date: str,
) -> pd.DataFrame:
    """Fetch 三大法人現貨市場合計買賣超. Returns empty DataFrame on failure.

    Uses FinMind TaiwanStockTotalInstitutionalInvestors (market-level aggregate, no stock_id).
    Returns columns: date, foreign_inst_norm, trust_inst_norm (rolling-normalised to [-1,1]).
    """
    try:
        frame = client.fetch_dataset(
            "TaiwanStockTotalInstitutionalInvestors",
            start_date=start_date,
            end_date=end_date,
        )
    except Exception as exc:
        print(f"[data_loader] 三大法人市場合計取得失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.copy()
    frame.columns = [c.lower().strip() for c in frame.columns]
    frame["date"] = pd.to_datetime(frame["date"])

    inst_col = next(
        (c for c in frame.columns if c in ("institutional_investors", "name", "identity_type")),
        None,
    )
    if inst_col is None:
        return pd.DataFrame()

    net_col = next((c for c in frame.columns if c in ("diff", "net")), None)
    if net_col is None:
        if "buy" in frame.columns and "sell" in frame.columns:
            frame["buy"] = pd.to_numeric(frame["buy"], errors="coerce").fillna(0)
            frame["sell"] = pd.to_numeric(frame["sell"], errors="coerce").fillna(0)
            frame["diff"] = frame["buy"] - frame["sell"]
            net_col = "diff"
        else:
            return pd.DataFrame()
    frame[net_col] = pd.to_numeric(frame[net_col], errors="coerce").fillna(0)

    inst_str = frame[inst_col].astype(str)
    masks = {
        "foreign_buy_net": inst_str.str.contains("外資|Foreign", na=False),
        "trust_buy_net":   inst_str.str.contains("投信|Investment_Trust", na=False),
    }

    result: pd.DataFrame | None = None
    for col_name, mask in masks.items():
        if not mask.any():
            continue
        grp = (
            frame.loc[mask]
            .groupby("date", as_index=False)[net_col]
            .sum()
            .rename(columns={net_col: col_name})
        )
        result = grp if result is None else result.merge(grp, on="date", how="outer")

    if result is None or result.empty:
        return pd.DataFrame()

    result = result.sort_values("date").reset_index(drop=True)

    for raw_col, norm_col in [("foreign_buy_net", "foreign_inst_norm"), ("trust_buy_net", "trust_inst_norm")]:
        if raw_col not in result.columns:
            continue
        rolling_max = result[raw_col].abs().rolling(30, min_periods=5).max().replace(0, float("nan"))
        result[norm_col] = result[raw_col] / rolling_max

    keep = ["date"] + [c for c in ("foreign_inst_norm", "trust_inst_norm") if c in result.columns]
    out = result[keep].dropna(how="all", subset=[c for c in keep if c != "date"])
    return out.reset_index(drop=True)


def fetch_market_margin(
    client: FinMindClient,
    start_date: str,
    end_date: str,
) -> pd.DataFrame:
    """Fetch 融資融券餘額 for 0050 as market proxy. Returns empty DataFrame on failure.

    Returns columns: date, margin_purchase_chg (5d pct change), short_sale_chg (5d pct change).
    """
    try:
        frame = client.fetch_dataset(
            "TaiwanStockMarginPurchaseShortSale",
            data_id="0050",
            start_date=start_date,
            end_date=end_date,
        )
    except Exception as exc:
        print(f"[data_loader] 融資融券取得失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.copy()
    frame.columns = [c.lower().strip() for c in frame.columns]
    frame["date"] = pd.to_datetime(frame["date"])
    frame = frame.sort_values("date").reset_index(drop=True)

    margin_col = next(
        (c for c in frame.columns if "marginpurchasebalance" in c or "margin_purchase_balance" in c
         or ("margin" in c and "balance" in c and "short" not in c)),
        None,
    )
    short_col = next(
        (c for c in frame.columns if "shortsalebalance" in c or "short_sale_balance" in c
         or ("short" in c and "balance" in c)),
        None,
    )

    if margin_col is None and short_col is None:
        return pd.DataFrame()

    result = frame[["date"]].copy()
    for src, feat in [(margin_col, "margin_purchase_chg"), (short_col, "short_sale_chg")]:
        if src is not None:
            series = pd.to_numeric(frame[src], errors="coerce")
            result[feat] = series.pct_change(5)

    keep = ["date"] + [c for c in ("margin_purchase_chg", "short_sale_chg") if c in result.columns]
    out = result[keep].dropna(how="all", subset=[c for c in keep if c != "date"])
    return out.reset_index(drop=True)


def fetch_all_margin_data(
    client: "FinMindClient",
    end_date: str,
    lookback: int = 10,
) -> pd.DataFrame:
    """Batch fetch margin/short today-balance for ALL stocks (one API call).

    Returns columns: stock_id, date, MarginPurchaseTodayBalance, ShortSaleTodayBalance.
    """
    start = (pd.Timestamp(end_date) - pd.Timedelta(days=lookback)).strftime("%Y-%m-%d")
    try:
        frame = client.fetch_dataset(
            "TaiwanStockMarginPurchaseShortSale",
            start_date=start,
            end_date=end_date,
        )
    except Exception as exc:
        print(f"[data_loader] 全市場融資資料取得失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.copy()
    frame.columns = [c.lower().strip() for c in frame.columns]
    frame["date"] = pd.to_datetime(frame["date"])

    margin_col = next(
        (c for c in frame.columns if "marginpurchasetodaybalance" in c
         or ("margin" in c and "today" in c and "balance" in c and "short" not in c)),
        None,
    )
    short_col = next(
        (c for c in frame.columns if "shortsaletodaybalance" in c
         or ("short" in c and "today" in c and "balance" in c)),
        None,
    )

    if "stock_id" not in frame.columns or margin_col is None:
        return pd.DataFrame()

    keep = ["stock_id", "date", margin_col]
    rename = {margin_col: "MarginPurchaseTodayBalance"}
    if short_col:
        keep.append(short_col)
        rename[short_col] = "ShortSaleTodayBalance"

    result = frame[keep].rename(columns=rename)
    result["MarginPurchaseTodayBalance"] = pd.to_numeric(result["MarginPurchaseTodayBalance"], errors="coerce").fillna(0)
    if "ShortSaleTodayBalance" in result.columns:
        result["ShortSaleTodayBalance"] = pd.to_numeric(result["ShortSaleTodayBalance"], errors="coerce").fillna(0)
    return result.sort_values(["stock_id", "date"]).reset_index(drop=True)


def fetch_options_pcr(
    client: "FinMindClient",
    start_date: str,
    end_date: str,
    code: str = "TXO",
) -> "pd.DataFrame":
    """Fetch Put/Call Ratio for Taiwan Options (台指選擇權). Returns DataFrame(date, pcr) or empty."""
    import pandas as pd
    try:
        frame = client.fetch_dataset(
            "TaiwanOptionInstitutionalInvestors",
            data_id=code,
            start_date=start_date,
            end_date=end_date,
        )
    except Exception as exc:
        print(f"[data_loader] 選擇權PCR取得失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.copy()
    frame.columns = [c.lower().strip() for c in frame.columns]
    frame["date"] = pd.to_datetime(frame["date"])

    opt_col = next(
        (c for c in frame.columns if c in ("option_type", "call_put", "type", "put_call")),
        None,
    )
    if opt_col is None:
        return pd.DataFrame()

    oi_col = next(
        (c for c in frame.columns if "open_interest" in c or "_oi" in c),
        None,
    ) or next(
        (c for c in frame.columns if "volume" in c or "trade_volume" in c),
        None,
    )
    if oi_col is None:
        return pd.DataFrame()

    frame[oi_col] = pd.to_numeric(frame[oi_col], errors="coerce").fillna(0)
    opt_str = frame[opt_col].astype(str).str.upper()
    call_mask = opt_str.str.contains("CALL|^C$", na=False, regex=True)
    put_mask  = opt_str.str.contains("PUT|^P$",  na=False, regex=True)

    call_oi = frame.loc[call_mask].groupby("date")[oi_col].sum().rename("call_oi")
    put_oi  = frame.loc[put_mask].groupby("date")[oi_col].sum().rename("put_oi")

    result = pd.concat([call_oi, put_oi], axis=1).reset_index()
    result["pcr"] = result["put_oi"] / result["call_oi"].replace(0, float("nan"))

    return result[["date", "pcr"]].dropna().sort_values("date").reset_index(drop=True)


def fetch_disposition_stocks(
    client: "FinMindClient",
    date: str,
) -> set[str]:
    """Return stock_ids currently under TSE/OTC disposition monitoring restrictions.

    Disposition periods can last up to 3 months; we query 90 days back to catch
    any currently-active period whose start date predates today.
    """
    start = (pd.Timestamp(date) - pd.Timedelta(days=90)).strftime("%Y-%m-%d")
    try:
        frame = client.fetch_dataset(
            "TaiwanStockDispositionSecuritiesPeriod",
            use_cache=True,
            start_date=start,
            end_date=date,
        )
    except Exception as exc:
        print(f"[data_loader] 處置股資料取得失敗（graceful skip）: {exc}", file=sys.stderr)
        return set()

    if frame.empty:
        return set()

    frame = frame.copy()
    frame.columns = [c.lower().strip() for c in frame.columns]

    if "stock_id" not in frame.columns:
        return set()

    # Try to find an end-date column and filter to currently active dispositions
    end_col = next(
        (c for c in frame.columns if "end" in c and "date" in c),
        next((c for c in frame.columns if c in ("end_date", "enddate", "to", "finish_date")), None),
    )
    today_ts = pd.Timestamp(date)
    if end_col:
        frame[end_col] = pd.to_datetime(frame[end_col], errors="coerce")
        active = frame[frame[end_col].isna() | (frame[end_col] >= today_ts)]
    else:
        active = frame  # conservative: include all found

    result = set(active["stock_id"].astype(str).unique())
    print(f"[data_loader] 處置股：{len(result)} 支", file=sys.stderr)
    return result


def fetch_suspended_stocks(
    client: "FinMindClient",
    date: str,
) -> set[str]:
    """Return stock_ids currently suspended from trading."""
    start = (pd.Timestamp(date) - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    try:
        frame = client.fetch_dataset(
            "TaiwanStockSuspended",
            use_cache=True,
            start_date=start,
            end_date=date,
        )
    except Exception as exc:
        print(f"[data_loader] 暫停交易資料取得失敗（graceful skip）: {exc}", file=sys.stderr)
        return set()

    if frame.empty or "stock_id" not in frame.columns:
        return set()

    result = set(frame["stock_id"].astype(str).unique())
    print(f"[data_loader] 暫停交易：{len(result)} 支", file=sys.stderr)
    return result


def fetch_all_monthly_revenue(
    client: "FinMindClient",
    end_date: str,
    lookback_months: int = 13,
) -> pd.DataFrame:
    """Batch fetch monthly revenue for ALL stocks (one API call).

    Returns DataFrame with columns: stock_id, date, revenue.
    Revenue is in thousands of NTD (原始單位：千元).
    """
    start = (pd.Timestamp(end_date) - pd.DateOffset(months=lookback_months)).strftime("%Y-%m-%d")
    try:
        frame = client.fetch_dataset(
            "TaiwanStockMonthRevenue",
            use_cache=True,
            start_date=start,
            end_date=end_date,
        )
    except Exception as exc:
        print(f"[data_loader] 月營收資料取得失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.copy()
    frame.columns = [c.lower().strip() for c in frame.columns]

    if "stock_id" not in frame.columns:
        return pd.DataFrame()

    rev_col = next(
        (c for c in frame.columns if "revenue" in c and "year" not in c and "month" not in c),
        next((c for c in frame.columns if "revenue" in c), None),
    )
    if rev_col is None:
        return pd.DataFrame()

    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame[rev_col] = pd.to_numeric(frame[rev_col], errors="coerce").fillna(0)

    result = frame[["stock_id", "date", rev_col]].rename(columns={rev_col: "revenue"})
    result = result.dropna(subset=["date"]).sort_values(["stock_id", "date"]).reset_index(drop=True)
    print(f"[data_loader] 月營收資料：{len(result)} 筆（{result['stock_id'].nunique()} 支股票）", file=sys.stderr)
    return result


def fetch_all_shareholding(
    client: "FinMindClient",
    end_date: str,
    lookback: int = 10,
) -> pd.DataFrame:
    """Batch fetch foreign shareholding ratio for ALL stocks (one API call).

    Returns DataFrame with columns: stock_id, date, ForeignInvestmentSharesRatio.
    """
    start = (pd.Timestamp(end_date) - pd.Timedelta(days=lookback)).strftime("%Y-%m-%d")
    try:
        frame = client.fetch_dataset(
            "TaiwanStockShareholding",
            use_cache=True,
            start_date=start,
            end_date=end_date,
        )
    except Exception as exc:
        print(f"[data_loader] 外資持股比例資料取得失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.copy()
    frame.columns = [c.strip() for c in frame.columns]

    if "stock_id" not in frame.columns:
        return pd.DataFrame()

    ratio_col = next(
        (c for c in frame.columns if "ForeignInvestmentSharesRatio" in c or "foreigninvestmentsharesratio" in c.lower()),
        next((c for c in frame.columns if "ratio" in c.lower() and "foreign" in c.lower()), None),
    )
    if ratio_col is None:
        return pd.DataFrame()

    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame[ratio_col] = pd.to_numeric(frame[ratio_col], errors="coerce").fillna(0)

    result = frame[["stock_id", "date", ratio_col]].rename(columns={ratio_col: "ForeignInvestmentSharesRatio"})
    result = result.dropna(subset=["date"]).sort_values(["stock_id", "date"]).reset_index(drop=True)
    print(f"[data_loader] 外資持股比例：{len(result)} 筆（{result['stock_id'].nunique()} 支股票）", file=sys.stderr)
    return result


def compute_market_revenue_signal(
    client: "FinMindClient",
    end_date: str,
) -> pd.DataFrame:
    """Compute market-aggregate monthly revenue YoY signal for MarketPredictor.

    Fetches 14 months of TaiwanStockMonthRevenue (one API call), computes
    median YoY growth across all stocks per month, returns DataFrame(date,
    market_revenue_yoy) indexed to month-end dates. MarketPredictor ffill()
    propagates these monthly values to all trading days in each month.
    Empty DataFrame on failure.
    """
    try:
        frame = client.fetch_dataset(
            "TaiwanStockMonthRevenue",
            use_cache=True,
            start_date=(pd.Timestamp(end_date) - pd.DateOffset(months=14)).strftime("%Y-%m-%d"),
            end_date=end_date,
        )
    except Exception as exc:
        print(f"[data_loader] 市場月營收信號取得失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.copy()
    frame.columns = [c.lower().strip() for c in frame.columns]
    if "stock_id" not in frame.columns:
        return pd.DataFrame()

    rev_col = next(
        (c for c in frame.columns if "revenue" in c and "year" not in c and "month" not in c),
        next((c for c in frame.columns if "revenue" in c), None),
    )
    if rev_col is None:
        return pd.DataFrame()

    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame[rev_col] = pd.to_numeric(frame[rev_col], errors="coerce")
    frame = frame.dropna(subset=["date", rev_col]).copy()
    frame["year_month"] = frame["date"].dt.to_period("M")

    # Pivot: stock_id × year_month → latest revenue value
    pivot = (
        frame.sort_values(["stock_id", "date"])
        .groupby(["stock_id", "year_month"])[rev_col]
        .last()
        .unstack("year_month")
    )

    results = []
    for col in sorted(pivot.columns):
        prev_col = col - 12
        if prev_col not in pivot.columns:
            continue
        curr = pivot[col]
        prev = pivot[prev_col]
        mask = (curr > 0) & (prev > 0)
        if mask.sum() < 10:
            continue
        yoy = ((curr - prev) / prev)[mask].clip(-1.0, 5.0)
        month_end = pd.Timestamp(col.to_timestamp()) + pd.offsets.MonthEnd(0)
        results.append({"date": month_end, "market_revenue_yoy": float(yoy.median())})

    if not results:
        return pd.DataFrame()

    result_df = pd.DataFrame(results).sort_values("date").reset_index(drop=True)
    print(f"[data_loader] 市場月營收YoY信號：{len(result_df)} 個月份，最新 {result_df['market_revenue_yoy'].iloc[-1]:.2%}", file=sys.stderr)
    return result_df


def compute_market_shareholding_signal(
    client: "FinMindClient",
    end_date: str,
) -> pd.DataFrame:
    """Compute market-aggregate foreign shareholding 5-day change signal.

    Fetches TaiwanStockShareholding for the last 20 days (one API call),
    computes daily median foreign holding % across all stocks, then the
    5-day pct change. Returns DataFrame(date, market_foreign_holding_chg).
    Empty DataFrame on failure.
    """
    start = (pd.Timestamp(end_date) - pd.Timedelta(days=20)).strftime("%Y-%m-%d")
    try:
        frame = client.fetch_dataset(
            "TaiwanStockShareholding",
            use_cache=True,
            start_date=start,
            end_date=end_date,
        )
    except Exception as exc:
        print(f"[data_loader] 外資持股市場信號取得失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.copy()
    frame.columns = [c.strip() for c in frame.columns]
    if "stock_id" not in frame.columns:
        return pd.DataFrame()

    ratio_col = next(
        (c for c in frame.columns if "ForeignInvestmentSharesRatio" in c
         or "foreigninvestmentsharesratio" in c.lower()),
        next((c for c in frame.columns if "ratio" in c.lower() and "foreign" in c.lower()), None),
    )
    if ratio_col is None:
        return pd.DataFrame()

    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame[ratio_col] = pd.to_numeric(frame[ratio_col], errors="coerce")
    frame = frame.dropna(subset=["date", ratio_col]).copy()

    daily_median = (
        frame.groupby("date")[ratio_col]
        .median()
        .reset_index()
        .rename(columns={ratio_col: "median_holding"})
        .sort_values("date")
    )
    daily_median["market_foreign_holding_chg"] = daily_median["median_holding"].pct_change(5) * 100
    result = daily_median[["date", "market_foreign_holding_chg"]].dropna().reset_index(drop=True)
    print(f"[data_loader] 外資持股市場信號：{len(result)} 筆", file=sys.stderr)
    return result


def fetch_all_insider_trading(
    client: "FinMindClient",
    end_date: str,
    lookback: int = 30,
) -> pd.DataFrame:
    """Batch fetch director/supervisor insider purchase/sell for ALL stocks (one API call).

    Returns DataFrame with columns: stock_id, date, buy_amount, sell_amount, net_buy_amount.
    net_buy_amount = buy_amount - sell_amount (shares).
    """
    start = (pd.Timestamp(end_date) - pd.Timedelta(days=lookback)).strftime("%Y-%m-%d")
    try:
        frame = client.fetch_dataset(
            "TaiwanStockInsiderPurchaseSell",
            use_cache=True,
            start_date=start,
            end_date=end_date,
        )
    except Exception as exc:
        print(f"[data_loader] 董監持股異動資料取得失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.copy()
    frame.columns = [c.strip() for c in frame.columns]

    if "stock_id" not in frame.columns:
        return pd.DataFrame()

    buy_col = next(
        (c for c in frame.columns if "buy" in c.lower() and "amount" in c.lower()),
        next((c for c in frame.columns if "buy" in c.lower()), None),
    )
    sell_col = next(
        (c for c in frame.columns if "sell" in c.lower() and "amount" in c.lower()),
        next((c for c in frame.columns if "sell" in c.lower()), None),
    )

    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame = frame.dropna(subset=["date"])

    if buy_col:
        frame[buy_col] = pd.to_numeric(frame[buy_col], errors="coerce").fillna(0)
    if sell_col:
        frame[sell_col] = pd.to_numeric(frame[sell_col], errors="coerce").fillna(0)

    # Aggregate per stock_id + date (may have multiple rows per day for different insider types)
    agg_dict: dict[str, object] = {}
    if buy_col:
        agg_dict["buy_amount"] = (buy_col, "sum")
    if sell_col:
        agg_dict["sell_amount"] = (sell_col, "sum")

    if not agg_dict:
        return pd.DataFrame()

    grp_cols = [buy_col] if buy_col else []
    if sell_col:
        grp_cols.append(sell_col)

    result = frame.groupby(["stock_id", "date"])[grp_cols].sum().reset_index()
    rename_map: dict[str, str] = {}
    if buy_col:
        rename_map[buy_col] = "buy_amount"
    if sell_col:
        rename_map[sell_col] = "sell_amount"
    result = result.rename(columns=rename_map)

    if "buy_amount" not in result.columns:
        result["buy_amount"] = 0.0
    if "sell_amount" not in result.columns:
        result["sell_amount"] = 0.0

    result["net_buy_amount"] = result["buy_amount"] - result["sell_amount"]
    result = result.sort_values(["stock_id", "date"]).reset_index(drop=True)
    print(f"[data_loader] 董監持股異動：{len(result)} 筆（{result['stock_id'].nunique()} 支股票）", file=sys.stderr)
    return result


def fetch_buyback_stocks(
    client: "FinMindClient",
    end_date: str,
    lookback: int = 30,
) -> set:
    """Return set of stock_ids with active buyback (庫藏股買回) in the past lookback days.

    FinMind's API has no buyback dataset (TaiwanStockBuyBack / TaiwanStockRepurchase
    are both rejected by the server-side dataset enum), so this always returns an
    empty set without making API calls. Downstream consumers treat buyback_count=0
    as "no data" and skip the display. A future data source could be the TWSE
    OpenAPI (openapi.twse.com.tw), which publishes treasury-stock reports.
    """
    return set()


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


def fetch_fundamentals(
    client: FinMindClient,
    stock_id: str,
    start_date: str,
    end_date: str,
) -> dict[str, pd.DataFrame]:
    """Fetch income statement, balance sheet, and cash flow from FinMind.

    Uses 30-day cache — quarterly data changes infrequently.
    Returns empty DataFrames on failure so callers degrade gracefully.
    """
    datasets = {
        "income":   "TaiwanStockFinancialStatements",
        "balance":  "TaiwanStockBalanceSheet",
        "cashflow": "TaiwanStockCashFlowStatement",
    }
    result: dict[str, pd.DataFrame] = {}
    for key, dataset in datasets.items():
        try:
            df = client.fetch_dataset(
                dataset,
                cache_ttl_days=30,
                data_id=stock_id,
                start_date=start_date,
                end_date=end_date,
            )
            result[key] = df
        except Exception:
            result[key] = pd.DataFrame()
    return result


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
