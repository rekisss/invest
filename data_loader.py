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


def _opendata_margin_day(day: pd.Timestamp) -> pd.DataFrame:
    """單日 TWSE MI_MARGN（融資融券餘額），含快取。

    Returns DataFrame with columns: stock_id, date, MarginPurchaseTodayBalance, ShortSaleTodayBalance.
    Only covers TWSE-listed stocks (not TPEX OTC stocks).
    """
    key = f"margin::{day:%Y%m%d}"
    if key in _open_data_cache:
        return _open_data_cache[key]  # type: ignore[return-value]
    frame = pd.DataFrame()
    try:
        resp = requests.get(
            _TWSE_MARGIN_URL,
            params={"date": day.strftime("%Y%m%d"), "selectType": "ALL", "response": "json"},
            timeout=15,
            headers={"accept": "application/json", "User-Agent": "Mozilla/5.0"},
        )
        resp.raise_for_status()
        payload = resp.json()
        time.sleep(0.15)
        if isinstance(payload, dict) and payload.get("stat") == "OK" and payload.get("data"):
            fields = [str(f) for f in payload.get("fields", [])]
            code_idx = next((i for i, f in enumerate(fields) if "代號" in f), 0)
            margin_idx = next(
                (i for i, f in enumerate(fields) if "融資" in f and "餘額" in f), None
            )
            short_idx = next(
                (i for i, f in enumerate(fields) if "融券" in f and "餘額" in f), None
            )
            if margin_idx is not None:
                rows = []
                for r in payload["data"]:
                    if not isinstance(r, (list, tuple)) or len(r) <= code_idx:
                        continue
                    row: dict[str, object] = {
                        "stock_id": str(r[code_idx]).strip(),
                        "date": day.normalize(),
                        "MarginPurchaseTodayBalance": _to_float(r[margin_idx]) if len(r) > margin_idx else 0.0,
                    }
                    if short_idx is not None and len(r) > short_idx:
                        row["ShortSaleTodayBalance"] = _to_float(r[short_idx])
                    rows.append(row)
                frame = pd.DataFrame(rows)
    except Exception:
        pass
    _open_data_cache[key] = frame
    return frame


def fetch_all_margin_data(
    client: "FinMindClient",
    end_date: str,
    lookback: int = 10,
) -> pd.DataFrame:
    """Batch fetch margin/short today-balance for ALL stocks.

    Strategy:
    1. Try FinMind range query (works on premium plans).
    2. Fall back to TWSE open data MI_MARGN (TWSE-listed stocks only; no auth needed).

    Returns columns: stock_id, date, MarginPurchaseTodayBalance, ShortSaleTodayBalance.
    """
    start = (pd.Timestamp(end_date) - pd.Timedelta(days=lookback)).strftime("%Y-%m-%d")

    def _process_finmind(frame: pd.DataFrame) -> pd.DataFrame:
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

    # ── Try 1: FinMind range query (premium plans) ──────────────────────────
    try:
        frame = client.fetch_dataset(
            "TaiwanStockMarginPurchaseShortSale",
            start_date=start,
            end_date=end_date,
        )
        if not frame.empty:
            result = _process_finmind(frame)
            if not result.empty:
                print(f"[data_loader] 融資資料（FinMind）：{len(result)} 筆", file=sys.stderr)
                return result
    except Exception as exc:
        print(f"[data_loader] FinMind 融資資料取得失敗，改用 TWSE 公開資料: {exc}", file=sys.stderr)

    # ── Try 2: TWSE open data MI_MARGN fallback ──────────────────────────────
    try:
        target_days = max(6, min(int(lookback * 0.6) or 6, 8))
        frames: list[pd.DataFrame] = []
        day = pd.Timestamp(end_date)
        deadline = time.monotonic() + 30.0
        for _ in range(target_days + 14):
            if len(frames) >= target_days or time.monotonic() > deadline:
                break
            if day.dayofweek < 5:
                f = _opendata_margin_day(day)
                if not f.empty:
                    frames.append(f)
            day -= pd.Timedelta(days=1)
        if frames:
            result = (
                pd.concat(frames, ignore_index=True)
                .sort_values(["stock_id", "date"])
                .reset_index(drop=True)
            )
            print(
                f"[data_loader] 融資資料（TWSE 公開資料）：{len(result)} 筆"
                f"（{result['stock_id'].nunique()} 支 / {len(frames)} 日）",
                file=sys.stderr,
            )
            return result
    except Exception as exc:
        print(f"[data_loader] TWSE 融資公開資料 fallback 失敗（graceful skip）: {exc}", file=sys.stderr)

    return pd.DataFrame()


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


# ── 免費官方公開資料 fallback（TWSE OpenAPI / TPEx OpenAPI）───────────────────
# FinMind sponsor 等級限定的資料集（處置股、月營收、外資持股）在 API 拒絕時，
# 改用證交所/櫃買中心的免費公開端點，輸出格式與 FinMind 版本一致。
# 僅在 FinMind 拋出例外（如 register 等級 400）時觸發，不影響原有流程。

_TWSE_PUNISH_URL    = "https://openapi.twse.com.tw/v1/announcement/punish"
_TPEX_PUNISH_URL    = "https://www.tpex.org.tw/openapi/v1/tpex_disposal_information"
_TWSE_MONTH_REV_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap05_L"
_TPEX_MONTH_REV_URL = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O"
_TWSE_QFIIS_URL     = "https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS"
_TWSE_MARGIN_URL    = "https://www.twse.com.tw/rwd/zh/marginTrade/MI_MARGN"

_OPEN_DATA_TIMEOUT = 20
_open_data_cache: dict[str, object] = {}


def _http_get_json(url: str, params: dict | None = None):
    resp = requests.get(
        url,
        params=params,
        timeout=_OPEN_DATA_TIMEOUT,
        headers={"accept": "application/json", "User-Agent": "Mozilla/5.0"},
    )
    resp.raise_for_status()
    return resp.json()


def _opendata_fetch_rows(url: str, label: str) -> list:
    """Fetch a JSON-array open-data endpoint with in-process caching."""
    key = f"rows::{url}"
    if key in _open_data_cache:
        return _open_data_cache[key]  # type: ignore[return-value]
    try:
        rows = _http_get_json(url)
        rows = rows if isinstance(rows, list) else []
    except Exception as exc:
        print(f"[data_loader] {label} 公開資料取得失敗: {exc}", file=sys.stderr)
        rows = []
    _open_data_cache[key] = rows
    return rows


def _find_key(row: dict, *needles: str, exclude: tuple[str, ...] = ()) -> str | None:
    """Find the first dict key containing any needle substring (schema-tolerant)."""
    for k in row.keys():
        ks = str(k)
        if any(n in ks for n in needles) and not any(x in ks for x in exclude):
            return k
    return None


def _roc_ym_to_month_end(text) -> pd.Timestamp | None:
    """ROC year-month like '11505' or '114/05' → month-end Timestamp."""
    digits = re.sub(r"\D", "", str(text))
    if len(digits) < 4:
        return None
    try:
        year, month = int(digits[:-2]) + 1911, int(digits[-2:])
        if not 1 <= month <= 12:
            return None
        return pd.Timestamp(year=year, month=month, day=1) + pd.offsets.MonthEnd(0)
    except ValueError:
        return None


def _roc_date_to_ts(text) -> pd.Timestamp | None:
    """ROC date like '1140612' or '114/06/12' → Timestamp."""
    digits = re.sub(r"\D", "", str(text))
    if len(digits) < 6:
        return None
    try:
        return pd.Timestamp(
            year=int(digits[:-4]) + 1911, month=int(digits[-4:-2]), day=int(digits[-2:])
        )
    except ValueError:
        return None


def _to_float(text) -> float:
    try:
        return float(str(text).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def _opendata_disposition_stocks(date: str) -> set[str]:
    """處置股 fallback：TWSE announcement/punish + TPEx disposal_information."""
    try:
        today_ts = pd.Timestamp(date)
        result: set[str] = set()
        for url, label in ((_TWSE_PUNISH_URL, "TWSE 處置股"), (_TPEX_PUNISH_URL, "TPEx 處置股")):
            for row in _opendata_fetch_rows(url, label):
                if not isinstance(row, dict):
                    continue
                code_key = _find_key(row, "證券代號", "公司代號", "代號", "Code")
                if not code_key:
                    continue
                code = str(row[code_key]).strip()
                if not code:
                    continue
                # 過濾已結束的處置期間（格式如 "1140530~1140612"）
                period_key = _find_key(row, "處置起訖", "處置起迄", "處置期間", "Period")
                if period_key:
                    parts = re.split(r"[~～—–-]+", str(row[period_key]))
                    end_ts = _roc_date_to_ts(parts[-1]) if parts else None
                    if end_ts is not None and end_ts < today_ts:
                        continue
                result.add(code)
        if result:
            print(f"[data_loader] 處置股（TWSE/TPEx 公開資料）：{len(result)} 支", file=sys.stderr)
        return result
    except Exception as exc:
        print(f"[data_loader] 處置股公開資料 fallback 失敗（graceful skip）: {exc}", file=sys.stderr)
        return set()


def _opendata_monthly_revenue() -> pd.DataFrame:
    """月營收 fallback：MOPS 彙總表（上市 t187ap05_L + 上櫃 mopsfin_t187ap05_O）。

    每支股票合成 3 列（當月 / 上月 / 去年同月），足以讓 strategy.py 計算
    revenue_yoy 與 revenue_mom（revenue_3m_yoy 因資料不足維持 0，安全降級）。
    """
    try:
        records = []
        for url, label in ((_TWSE_MONTH_REV_URL, "上市月營收"), (_TPEX_MONTH_REV_URL, "上櫃月營收")):
            for row in _opendata_fetch_rows(url, label):
                if not isinstance(row, dict):
                    continue
                code_key = _find_key(row, "公司代號", "證券代號", "代號", "Code")
                ym_key = _find_key(row, "資料年月", "年月", "YearMonth")
                cur_key = _find_key(row, "當月營收", exclude=("去年", "累計"))
                if not (code_key and ym_key and cur_key):
                    continue
                month_end = _roc_ym_to_month_end(row[ym_key])
                sid = str(row[code_key]).strip()
                cur = _to_float(row[cur_key])
                if month_end is None or not sid or cur <= 0:
                    continue
                records.append({"stock_id": sid, "date": month_end, "revenue": cur})
                prev_key = _find_key(row, "上月營收", exclude=("比較", "增減"))
                if prev_key and (prev := _to_float(row[prev_key])) > 0:
                    records.append({
                        "stock_id": sid,
                        "date": month_end - pd.offsets.MonthEnd(1),
                        "revenue": prev,
                    })
                yoy_key = _find_key(row, "去年當月營收")
                if yoy_key and (yoy := _to_float(row[yoy_key])) > 0:
                    records.append({
                        "stock_id": sid,
                        "date": month_end - pd.DateOffset(years=1) + pd.offsets.MonthEnd(0),
                        "revenue": yoy,
                    })
        frame = pd.DataFrame(records)
        if frame.empty:
            return frame
        frame = (
            frame.drop_duplicates(subset=["stock_id", "date"], keep="first")
            .sort_values(["stock_id", "date"])
            .reset_index(drop=True)
        )
        print(
            f"[data_loader] 月營收（MOPS 公開資料）：{len(frame)} 筆"
            f"（{frame['stock_id'].nunique()} 支股票）",
            file=sys.stderr,
        )
        return frame
    except Exception as exc:
        print(f"[data_loader] 月營收公開資料 fallback 失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()


def _opendata_market_revenue_signal() -> pd.DataFrame:
    """市場月營收 YoY fallback：取彙總表「去年同月增減(%)」全市場中位數（單月）。"""
    try:
        yoys: list[float] = []
        month_end: pd.Timestamp | None = None
        for url, label in ((_TWSE_MONTH_REV_URL, "上市月營收"), (_TPEX_MONTH_REV_URL, "上櫃月營收")):
            for row in _opendata_fetch_rows(url, label):
                if not isinstance(row, dict):
                    continue
                chg_key = _find_key(row, "去年同月增減")
                ym_key = _find_key(row, "資料年月", "年月", "YearMonth")
                if not (chg_key and ym_key):
                    continue
                me = _roc_ym_to_month_end(row[ym_key])
                if me is None:
                    continue
                month_end = max(month_end, me) if month_end is not None else me
                yoys.append(_to_float(row[chg_key]) / 100.0)
        if len(yoys) < 10 or month_end is None:
            return pd.DataFrame()
        med = float(pd.Series(yoys).clip(-1.0, 5.0).median())
        print(f"[data_loader] 市場月營收YoY（MOPS 公開資料）：最新 {med:.2%}", file=sys.stderr)
        return pd.DataFrame([{"date": month_end, "market_revenue_yoy": med}])
    except Exception as exc:
        print(f"[data_loader] 市場月營收公開資料 fallback 失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()


_QFIIS_TIMEOUT = 5  # seconds — keep short; TWSE can be slow from CI IPs


def _opendata_shareholding_day(day: pd.Timestamp) -> pd.DataFrame:
    """單日 TWSE MI_QFIIS（外資及陸資持股統計），含快取與禮貌性延遲。"""
    key = f"qfiis::{day:%Y%m%d}"
    if key in _open_data_cache:
        return _open_data_cache[key]  # type: ignore[return-value]
    frame = pd.DataFrame()
    try:
        resp = requests.get(
            _TWSE_QFIIS_URL,
            params={"date": day.strftime("%Y%m%d"), "selectType": "ALLBUT0999", "response": "json"},
            timeout=_QFIIS_TIMEOUT,
            headers={"accept": "application/json", "User-Agent": "Mozilla/5.0"},
        )
        resp.raise_for_status()
        payload = resp.json()
        time.sleep(0.15)  # 禮貌性延遲，避免對 TWSE 過快連續請求
        if isinstance(payload, dict) and payload.get("stat") == "OK" and payload.get("data"):
            fields = [str(f) for f in payload.get("fields", [])]
            code_idx = next((i for i, f in enumerate(fields) if "代號" in f), 0)
            ratio_idx = next(
                (i for i, f in enumerate(fields) if "全體" in f and "比率" in f),
                next((i for i, f in enumerate(fields) if "持股比率" in f), None),
            )
            if ratio_idx is not None:
                rows = [
                    {
                        "stock_id": str(r[code_idx]).strip(),
                        "date": day.normalize(),
                        "ForeignInvestmentSharesRatio": _to_float(r[ratio_idx]),
                    }
                    for r in payload["data"]
                    if isinstance(r, (list, tuple)) and len(r) > max(code_idx, ratio_idx)
                ]
                frame = pd.DataFrame(rows)
    except Exception:
        pass
    _open_data_cache[key] = frame
    return frame


def _opendata_shareholding(end_date: str, lookback: int, budget_s: float = 25.0) -> pd.DataFrame:
    """外資持股比例 fallback：逐日抓 TWSE MI_QFIIS（僅上市；上櫃缺資料安全降級為 0）。

    budget_s caps the total elapsed time so a slow/blocked TWSE never stalls the run.
    """
    try:
        # pct_change(5) needs ≥6 rows; cap at 8 to stay well within budget
        target_days = max(6, min(int(lookback * 0.6) or 6, 8))
        frames: list[pd.DataFrame] = []
        day = pd.Timestamp(end_date)
        deadline = time.monotonic() + budget_s
        for _ in range(target_days + 14):  # extra buffer for weekends/holidays
            if len(frames) >= target_days:
                break
            if time.monotonic() > deadline:
                print(
                    f"[data_loader] 外資持股公開資料超時（{budget_s:.0f}s），已取得 {len(frames)} 日",
                    file=sys.stderr,
                )
                break
            if day.dayofweek < 5:
                f = _opendata_shareholding_day(day)
                if not f.empty:
                    frames.append(f)
            day -= pd.Timedelta(days=1)
        if not frames:
            return pd.DataFrame()
        result = (
            pd.concat(frames, ignore_index=True)
            .sort_values(["stock_id", "date"])
            .reset_index(drop=True)
        )
        print(
            f"[data_loader] 外資持股比例（TWSE 公開資料）：{len(result)} 筆"
            f"（{result['stock_id'].nunique()} 支股票 / {len(frames)} 個交易日）",
            file=sys.stderr,
        )
        return result
    except Exception as exc:
        print(f"[data_loader] 外資持股公開資料 fallback 失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()


def _opendata_market_shareholding_signal(end_date: str) -> pd.DataFrame:
    """市場外資持股 5 日變化 fallback：MI_QFIIS 每日中位數 → pct_change(5)。"""
    try:
        frame = _opendata_shareholding(end_date, lookback=10, budget_s=25.0)
        if frame.empty:
            return pd.DataFrame()
        daily = frame.groupby("date")["ForeignInvestmentSharesRatio"].median().sort_index()
        chg = (daily.pct_change(5) * 100).dropna()
        if chg.empty:
            return pd.DataFrame()
        result = pd.DataFrame(
            {"date": chg.index, "market_foreign_holding_chg": chg.values}
        ).reset_index(drop=True)
        print(f"[data_loader] 外資持股市場信號（TWSE 公開資料）：{len(result)} 筆", file=sys.stderr)
        return result
    except Exception as exc:
        print(f"[data_loader] 外資持股市場信號 fallback 失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()


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
        print(f"[data_loader] 處置股 FinMind 取得失敗，改用 TWSE/TPEx 公開資料: {exc}", file=sys.stderr)
        return _opendata_disposition_stocks(date)

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
        print(f"[data_loader] 月營收 FinMind 取得失敗，改用 MOPS 公開資料: {exc}", file=sys.stderr)
        return _opendata_monthly_revenue()

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
        print(f"[data_loader] 外資持股比例 FinMind 取得失敗，改用 TWSE 公開資料: {exc}", file=sys.stderr)
        return _opendata_shareholding(end_date, lookback)

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
        print(f"[data_loader] 市場月營收 FinMind 取得失敗，改用 MOPS 公開資料: {exc}", file=sys.stderr)
        return _opendata_market_revenue_signal()

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


def _inst_net_buy_shareholding_signal(
    client: "FinMindClient",
    end_date: str,
) -> pd.DataFrame:
    """Proxy for market_foreign_holding_chg using TaiwanStockTotalInstitutionalInvestors.

    TaiwanStockTotalInstitutionalInvestors is available at FinMind register level.
    We use daily market-total foreign net buy (億元) rolling-normalised as a proxy
    for whether foreign holdings are increasing or decreasing — sign and magnitude
    are directionally equivalent to a 5-day shareholding % change.

    Returns DataFrame(date, market_foreign_holding_chg) in the same schema
    expected by MarketPredictor, or empty DataFrame on failure.
    """
    start = (pd.Timestamp(end_date) - pd.Timedelta(days=30)).strftime("%Y-%m-%d")
    try:
        frame = client.fetch_dataset(
            "TaiwanStockTotalInstitutionalInvestors",
            use_cache=True,
            start_date=start,
            end_date=end_date,
        )
    except Exception as exc:
        print(f"[data_loader] 三大法人市場合計取得失敗（graceful skip）: {exc}", file=sys.stderr)
        return pd.DataFrame()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.copy()
    frame.columns = [c.lower().strip() for c in frame.columns]
    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")

    inst_col = next(
        (c for c in frame.columns if c in ("institutional_investors", "name", "identity_type")),
        None,
    )
    if inst_col is None:
        return pd.DataFrame()

    net_col = next((c for c in frame.columns if c in ("diff", "net")), None)
    if net_col is None:
        if "buy" in frame.columns and "sell" in frame.columns:
            frame["buy"]  = pd.to_numeric(frame["buy"],  errors="coerce").fillna(0)
            frame["sell"] = pd.to_numeric(frame["sell"], errors="coerce").fillna(0)
            frame["diff"] = frame["buy"] - frame["sell"]
            net_col = "diff"
        else:
            return pd.DataFrame()

    frame[net_col] = pd.to_numeric(frame[net_col], errors="coerce").fillna(0)

    inst_str = frame[inst_col].astype(str)
    foreign_mask = inst_str.str.contains("外資|Foreign", na=False)
    foreign = (
        frame[foreign_mask]
        .groupby("date")[net_col]
        .sum()
        .reset_index()
        .rename(columns={net_col: "foreign_net"})
        .sort_values("date")
    )
    if len(foreign) < 6:
        return pd.DataFrame()

    # 5-day cumulative sum as proxy for holding change direction
    foreign["foreign_net"] = pd.to_numeric(foreign["foreign_net"], errors="coerce").fillna(0)
    rolling_std = foreign["foreign_net"].rolling(20, min_periods=5).std()
    denom = rolling_std.replace(0, float("nan")).fillna(1)
    foreign["market_foreign_holding_chg"] = (foreign["foreign_net"].rolling(5).sum() / denom).round(4)
    result = foreign[["date", "market_foreign_holding_chg"]].dropna().reset_index(drop=True)

    if not result.empty:
        print(
            f"[data_loader] 外資持股市場信號（三大法人代理）：{len(result)} 筆，"
            f"最新 {result['market_foreign_holding_chg'].iloc[-1]:.3f}",
            file=sys.stderr,
        )
    return result


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
        print(f"[data_loader] 外資持股市場信號 FinMind 取得失敗，改用三大法人買賣超代理: {exc}", file=sys.stderr)
        result = _inst_net_buy_shareholding_signal(client, end_date)
        if not result.empty:
            return result
        return _opendata_market_shareholding_signal(end_date)

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
