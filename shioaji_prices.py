#!/usr/bin/env python3
"""Shioaji 即時報價快取產生器 (read-only).

Logs into SinoPac's Shioaji API with API key + secret ONLY (no CA certificate),
so this process can read market data but CANNOT place orders. It fetches a
snapshot for a list of Taiwan stocks and writes ``live_prices_shioaji.json`` in
the EXACT same schema the frontend's price cache already understands
(see web/src/hooks/useLivePrices.js → fetchPriceCache):

    {
      "updatedAt": "<ISO8601>",
      "source": "shioaji",
      "prices": {
        "<stock_id>": {price, prevClose, pct, high, low, open, volume,
                       time, isSnapshot},
        "_idx_t00":  {price, prevClose, change, pct, time}
      }
    }

This is a NEW, standalone module — it does not import or alter any existing
pipeline code. If credentials are absent or login fails, it exits 0 without
writing, so a scheduled run never poisons the cache or spams CI failures.

Required env (set as GitHub Actions secrets):
    SHIOAJI_API_KEY      永豐金 API key
    SHIOAJI_SECRET_KEY   永豐金 API secret
Optional env:
    SHIOAJI_OUT          output path (default: live_prices_shioaji.json)
    SHIOAJI_DATA_JSON    deployed data.json URL to augment the stock list
                         (default: https://rekisss.github.io/invest/data.json)
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

# Common large-caps always fetched, regardless of scan data (mirrors live-prices.yml).
ALWAYS = [
    "2330", "2317", "2303", "2454", "2412", "2382", "2357", "2308", "2002", "1301",
    "1303", "2882", "2881", "2886", "2891", "2884", "2892", "2885", "2887", "5880",
    "3481", "2408", "3034", "3008", "2409", "2603", "2609", "2615", "2618", "2610",
    "6505", "4904", "1718", "2059", "2327", "2474", "3711", "2301", "2376", "6669",
    "6770", "2379", "4938", "3231", "5483", "2492", "3533", "6415", "6456", "2049",
]

DEFAULT_DATA_JSON = "https://rekisss.github.io/invest/data.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _augment_from_data_json(ids: list[str], url: str) -> list[str]:
    """Add the latest scan's top stocks to the fetch list (best effort)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "shioaji-price-cache"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
        dates = sorted(data.get("dates") or [], reverse=True)
        if dates:
            top = data.get("scans", {}).get(dates[0], {}).get("top_stocks", []) or []
            scan_ids = [str(s.get("stock_id")) for s in top[:120] if s.get("stock_id")]
            merged = list(dict.fromkeys([*ids, *scan_ids]))
            print(f"Stock list: {len(merged)} symbols ({len(scan_ids)} from scan)")
            return merged
    except Exception as e:  # noqa: BLE001 — best effort, never fatal
        print(f"data.json fetch failed: {e}")
    return ids


def _to_num(v):
    try:
        f = float(v)
        return f if f == f else None  # drop NaN
    except (TypeError, ValueError):
        return None


def _resolve_contract(api, sid: str):
    """Find a stock contract across TSE / OTC. Returns None if unknown."""
    stocks = api.Contracts.Stocks
    # Direct index first (Shioaji resolves across exchanges for most ids).
    try:
        c = stocks[sid]
        if c is not None:
            return c
    except Exception:  # noqa: BLE001
        pass
    for ex_name in ("TSE", "OTC"):
        ex = getattr(stocks, ex_name, None)
        if ex is None:
            continue
        try:
            c = ex[sid]
            if c is not None:
                return c
        except Exception:  # noqa: BLE001
            continue
    return None


def _snapshot_to_entry(snap) -> dict | None:
    """Map a Shioaji Snapshot to the live_prices.json price entry schema."""
    price = _to_num(getattr(snap, "close", None))
    if not price:
        return None
    change_price = _to_num(getattr(snap, "change_price", None))
    prev = (price - change_price) if change_price is not None else None
    if prev and prev > 0:
        pct = (price - prev) / prev
    else:
        rate = _to_num(getattr(snap, "change_rate", None))  # percent
        pct = (rate / 100.0) if rate is not None else None
    ts = getattr(snap, "ts", None)  # nanoseconds since epoch
    try:
        time_iso = datetime.fromtimestamp(ts / 1e9, tz=timezone.utc).isoformat() if ts else _now_iso()
    except Exception:  # noqa: BLE001
        time_iso = _now_iso()
    return {
        "price": price,
        "prevClose": prev,
        "pct": pct,
        "high": _to_num(getattr(snap, "high", None)),
        "low": _to_num(getattr(snap, "low", None)),
        "open": _to_num(getattr(snap, "open", None)),
        # total_volume is the cumulative day volume (matches TWSE TradeVolume usage)
        "volume": int(_to_num(getattr(snap, "total_volume", None)) or 0),
        "time": time_iso,
        "isSnapshot": True,
    }


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def main() -> int:
    api_key = os.getenv("SHIOAJI_API_KEY", "").strip()
    secret_key = os.getenv("SHIOAJI_SECRET_KEY", "").strip()
    if not api_key or not secret_key:
        print("SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY not set — skipping (no-op).")
        return 0

    try:
        import shioaji as sj
    except ImportError:
        print("shioaji package not installed — skipping. (pip install shioaji)")
        return 0

    out_path = os.getenv("SHIOAJI_OUT", "live_prices_shioaji.json")
    ids = _augment_from_data_json(list(ALWAYS), os.getenv("SHIOAJI_DATA_JSON", DEFAULT_DATA_JSON))

    api = sj.Shioaji()
    try:
        try:
            api.login(api_key=api_key, secret_key=secret_key, contracts_timeout=15000)
        except TypeError:
            # Older signature: positional / no contracts_timeout
            api.login(api_key, secret_key)
        print("Shioaji login OK")

        contracts, resolved = [], []
        for sid in ids:
            c = _resolve_contract(api, sid)
            if c is not None:
                contracts.append(c)
                resolved.append(sid)
        print(f"Resolved {len(resolved)}/{len(ids)} contracts")

        prices: dict[str, dict] = {}
        for batch in _chunks(contracts, 400):  # snapshots cap is 500/call
            try:
                for snap in api.snapshots(batch):
                    code = str(getattr(snap, "code", "") or "")
                    entry = _snapshot_to_entry(snap)
                    if code and entry:
                        prices[code] = entry
            except Exception as e:  # noqa: BLE001
                print(f"snapshots batch failed: {e}")

        # 加權指數 (TWII) → _idx_t00, best effort.
        try:
            idx = api.Contracts.Indexs.TSE["001"]
            for snap in api.snapshots([idx]):
                price = _to_num(getattr(snap, "close", None))
                if not price:
                    continue
                change_price = _to_num(getattr(snap, "change_price", None))
                prev = (price - change_price) if change_price is not None else None
                prices["_idx_t00"] = {
                    "price": price,
                    "prevClose": prev,
                    "change": change_price if change_price is not None else (price - prev if prev else None),
                    "pct": ((price - prev) / prev) if prev and prev > 0 else None,
                    "time": _now_iso(),
                }
        except Exception as e:  # noqa: BLE001
            print(f"index snapshot failed: {e}")

        stock_count = len([k for k in prices if not k.startswith("_")])
        if stock_count == 0:
            print("No prices fetched — not writing (avoids poisoning cache).")
            return 0

        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"updatedAt": _now_iso(), "source": "shioaji", "prices": prices}, f)
        print(f"Wrote {out_path}: {stock_count} stocks, index={'_idx_t00' in prices}")
        return 0
    except Exception as e:  # noqa: BLE001 — never crash the scheduled job
        print(f"Shioaji run failed: {e}")
        return 0
    finally:
        try:
            api.logout()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())
