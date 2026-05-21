"""economic_calendar.py – Upcoming high-impact economic events.

Fetches this week's calendar from Forex Factory's public JSON mirror.
No API key required. Returns empty list on any network failure.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import requests

_FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
_CST = timezone(timedelta(hours=8))
_CURRENCY_FLAG = {
    "USD": "🇺🇸", "TWD": "🇹🇼", "CNY": "🇨🇳",
    "EUR": "🇪🇺", "JPY": "🇯🇵", "GBP": "🇬🇧",
}


def fetch_upcoming_events(days_ahead: int = 3, timeout: int = 10) -> list[dict[str, Any]]:
    """
    Return upcoming high-impact economic events (USD + TWD) within `days_ahead` days.
    Each item: {date, time_cst, event, currency, flag}.
    Returns [] on failure.
    """
    try:
        resp = requests.get(_FF_URL, timeout=timeout,
                            headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        raw: list[dict] = resp.json()
    except Exception as exc:
        print(f"[calendar] Forex Factory 取得失敗（graceful skip）: {exc}")
        return []

    now = datetime.now(_CST)
    cutoff = now + timedelta(days=days_ahead)
    result: list[dict[str, Any]] = []

    for ev in raw:
        impact = str(ev.get("impact", "")).strip().lower()
        if impact not in ("high", "3"):
            continue

        currency = str(ev.get("country", ev.get("currency", ""))).upper().strip()
        if currency not in ("USD", "TWD"):
            continue

        title = str(ev.get("title", ev.get("name", ""))).strip()
        date_str = str(ev.get("date", "")).strip()
        time_str = str(ev.get("time", "")).strip()

        dt = _parse_dt(date_str, time_str)
        if dt is None:
            continue

        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt_cst = dt.astimezone(_CST)

        if dt_cst < now or dt_cst > cutoff:
            continue

        result.append({
            "date":     dt_cst.strftime("%m-%d"),
            "time_cst": dt_cst.strftime("%H:%M"),
            "event":    title,
            "currency": currency,
            "flag":     _CURRENCY_FLAG.get(currency, "🌐"),
        })

    result.sort(key=lambda x: (x["date"], x["time_cst"]))
    return result


def _parse_dt(date_str: str, time_str: str) -> datetime | None:
    combined = f"{date_str} {time_str}".strip() if time_str else date_str
    for fmt in (
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %I:%M%p",
        "%Y-%m-%d %I:%M %p",
        "%m-%d-%Y %H:%M",
        "%Y-%m-%d",
        "%m-%d-%Y",
    ):
        try:
            return datetime.strptime(combined, fmt)
        except ValueError:
            pass
    return None


def format_calendar_block(events: list[dict[str, Any]]) -> str:
    """Format upcoming events as a Discord block. Returns '' if none."""
    if not events:
        return ""
    lines = ["⚠️ **近期重大事件**（未來3天，高影響）"]
    for ev in events[:5]:
        lines.append(f"   {ev['date']} {ev['time_cst']} CST  {ev['flag']} {ev['event']}")
    return "\n".join(lines)
