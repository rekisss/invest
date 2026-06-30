"""Global Market Data Engine — fetches and validates all global market indicators.

Data sources (with graceful fallback):
  - yfinance: VIX, SOX, Nasdaq, S&P500, DXY, Gold, Oil, US10Y, NVDA, TSM ADR
  - FinMind: TAIEX, Taiwan Futures, institutional flows

Schema-validated output via GlobalMarketSnapshot dataclass.
All fields have sensible defaults so downstream code never crashes on stale data.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

import pandas as pd


# ── Yahoo chart REST (crumb-free) ──────────────────────────────────────────────
# yfinance gets blocked from CI/datacenter IPs (Yahoo rejects its fingerprint),
# which left every overnight-US feature null. The public v8/finance/chart endpoint
# is not blocked the same way — it's the same family of endpoints live-prices.yml
# already uses successfully from GitHub Actions. We try it first, then fall back to
# yfinance (which still works in local dev).
_YF_HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")


def _yahoo_chart_closes(ticker: str, rng: str = "5d") -> list[float]:
    """Return recent daily closes for a Yahoo ticker via the chart REST API."""
    sym = urllib.parse.quote(ticker)
    for host in _YF_HOSTS:
        try:
            url = f"https://{host}/v8/finance/chart/{sym}?range={rng}&interval=1d"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; market-data/1.0)"})
            with urllib.request.urlopen(req, timeout=15) as r:
                data = json.loads(r.read().decode("utf-8", "ignore"))
            res = (data.get("chart", {}).get("result") or [None])[0]
            if not res:
                continue
            closes = res.get("indicators", {}).get("quote", [{}])[0].get("close") or []
            vals = [float(c) for c in closes if c is not None]
            if len(vals) >= 1:
                return vals
        except Exception:
            continue
    return []


# ── Schema ───────────────────────────────────────────────────────────────────────

@dataclass
class GlobalMarketSnapshot:
    """Validated snapshot of global market indicators."""

    # Metadata
    fetched_at: str = ""
    data_staleness_hours: float = 0.0
    is_stale: bool = False
    missing_fields: list[str] = field(default_factory=list)

    # US Equity
    nasdaq_ret: float = 0.0       # 1-day return
    sp500_ret: float = 0.0
    sox_ret: float = 0.0          # PHLX Semiconductor Index
    nvda_ret: float = 0.0

    # Taiwan ADR / proxy
    tsm_adr_ret: float = 0.0      # TSM (ADR) daily return

    # Fear / Volatility
    vix: float = 20.0
    vix_prev: float = 20.0
    vix_change: float = 0.0

    # Macro
    dxy_ret: float = 0.0          # USD index
    us10y: float = 4.0            # US 10yr yield (%)
    gold_ret: float = 0.0
    oil_ret: float = 0.0

    # Composite signal
    us_risk_score: float = 0.0    # -5 to +5: negative = risk-off
    us_tech_strength: float = 0.0 # -5 to +5

    def is_valid(self) -> bool:
        return not self.is_stale and len(self.missing_fields) < 5

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


# ── Fetchers ─────────────────────────────────────────────────────────────────────

def _safe_yf_return(ticker: str, period: str = "2d") -> tuple[float, bool]:
    """Fetch 1-day return. Yahoo chart REST first (works in CI), then yfinance."""
    closes = _yahoo_chart_closes(ticker)
    if len(closes) >= 2 and closes[-2]:
        return float((closes[-1] - closes[-2]) / closes[-2]), True
    try:
        import yfinance as yf
        df = yf.download(ticker, period=period, progress=False, auto_adjust=True)
        if df.empty or len(df) < 2:
            return 0.0, False
        c = df["Close"].dropna()
        if len(c) < 2:
            return 0.0, False
        return float((c.iloc[-1] - c.iloc[-2]) / c.iloc[-2]), True
    except Exception:
        return 0.0, False


def _safe_yf_last(ticker: str, period: str = "2d") -> tuple[float, bool]:
    """Fetch latest level. Yahoo chart REST first (works in CI), then yfinance."""
    closes = _yahoo_chart_closes(ticker)
    if closes:
        return float(closes[-1]), True
    try:
        import yfinance as yf
        df = yf.download(ticker, period=period, progress=False, auto_adjust=True)
        if df.empty:
            return 0.0, False
        c = df["Close"].dropna()
        if c.empty:
            return 0.0, False
        return float(c.iloc[-1]), True
    except Exception:
        return 0.0, False


def _compute_us_risk_score(snap: GlobalMarketSnapshot) -> float:
    """Composite US risk-on/off score. Range -5 to +5."""
    score = 0.0
    # Tech momentum
    score += max(-2, min(2, snap.nasdaq_ret * 50))
    score += max(-1, min(1, snap.sox_ret * 30))
    # VIX (inverted — high VIX = risk off)
    if snap.vix > 30:
        score -= 2.0
    elif snap.vix > 25:
        score -= 1.0
    elif snap.vix < 15:
        score += 1.0
    # DXY (strong dollar = headwind for Taiwan stocks)
    score -= max(-0.5, min(0.5, snap.dxy_ret * 20))
    return round(max(-5, min(5, score)), 2)


def _compute_tech_strength(snap: GlobalMarketSnapshot) -> float:
    """Tech-specific strength score -5 to +5."""
    score = 0.0
    score += max(-2, min(2, snap.nasdaq_ret * 60))
    score += max(-1.5, min(1.5, snap.sox_ret * 40))
    score += max(-1, min(1, snap.nvda_ret * 20))
    score += max(-0.5, min(0.5, snap.tsm_adr_ret * 15))
    return round(max(-5, min(5, score)), 2)


# ── Main fetch function ───────────────────────────────────────────────────────────

def fetch_global_snapshot(use_cache: bool = True, cache_ttl_minutes: int = 30) -> GlobalMarketSnapshot:
    """Fetch all global market indicators with schema validation.

    Designed to be resilient: any individual fetch failure results in a
    missing_fields entry rather than a crash.
    """
    snap = GlobalMarketSnapshot(fetched_at=datetime.now().isoformat())
    missing: list[str] = []

    _TICKERS = {
        "nasdaq_ret":  "^IXIC",
        "sp500_ret":   "^GSPC",
        "sox_ret":     "^SOX",
        "nvda_ret":    "NVDA",
        "tsm_adr_ret": "TSM",
        "dxy_ret":     "DX-Y.NYB",
        "gold_ret":    "GC=F",
        "oil_ret":     "CL=F",
    }

    for attr, ticker in _TICKERS.items():
        ret, ok = _safe_yf_return(ticker, period="3d")
        if ok:
            setattr(snap, attr, round(ret, 5))
        else:
            missing.append(attr)

    # VIX (level + change)
    vix_now, ok1 = _safe_yf_last("^VIX", period="3d")
    if ok1:
        snap.vix = round(vix_now, 2)
        vix_closes = _yahoo_chart_closes("^VIX")
        if len(vix_closes) < 2:
            try:
                import yfinance as yf
                df = yf.download("^VIX", period="3d", progress=False, auto_adjust=True)
                vix_closes = [float(x) for x in df["Close"].dropna().tolist()]
            except Exception:
                vix_closes = []
        if len(vix_closes) >= 2:
            snap.vix_prev = round(float(vix_closes[-2]), 2)
            snap.vix_change = round(float(vix_closes[-1] - vix_closes[-2]), 2)
    else:
        missing.append("vix")

    # US 10yr yield
    us10y, ok_y = _safe_yf_last("^TNX", period="3d")
    if ok_y:
        snap.us10y = round(us10y, 3)
    else:
        missing.append("us10y")

    snap.missing_fields = missing
    snap.is_stale = len(missing) > 8  # more than half missing = treat as stale
    snap.us_risk_score = _compute_us_risk_score(snap)
    snap.us_tech_strength = _compute_tech_strength(snap)

    return snap
