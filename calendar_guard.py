"""
Taiwan trading calendar guard utilities.

Provides helpers to detect high-risk calendar dates:
  - Taiwan public holidays (no trading)
  - Pre-holiday sessions (often thin volume / one-sided)
  - Post-weekend gap risk
  - Month-end / quarter-end window dressing periods

These are purely additive — no existing files are modified.
"""
from __future__ import annotations

import datetime
from functools import lru_cache


# ── Taiwan public holidays ─────────────────────────────────────────────────────

def tw_public_holidays(year: int) -> list[datetime.date]:
    """Return a list of major Taiwan public holiday dates for the given year.

    Includes fixed-date holidays only (New Year's Day, Labour Day, National Day,
    Constitution Day, etc.) plus Lunar New Year approximations.
    Does NOT include compensatory work Saturdays.
    """
    fixed = [
        datetime.date(year, 1, 1),    # 元旦
        datetime.date(year, 2, 28),   # 和平紀念日
        datetime.date(year, 4, 4),    # 兒童節 / 清明節 (approximate)
        datetime.date(year, 5, 1),    # 勞動節
        datetime.date(year, 6, 10),   # 端午節 (approximate, lunar)
        datetime.date(year, 9, 28),   # 教師節 (teachers' day, often market holiday)
        datetime.date(year, 10, 10),  # 國慶日
        datetime.date(year, 12, 25),  # 行憲紀念日 / Christmas adj.
    ]

    # Lunar New Year: approximately late Jan – early Feb, spans ~1 week
    # Rough estimate: year 2024→Feb 8, 2025→Jan 29, 2026→Feb 17, 2027→Feb 6
    # Use a heuristic for ±3 days around estimated LNY day
    lny_approx: dict[int, datetime.date] = {
        2024: datetime.date(2024, 2, 10),
        2025: datetime.date(2025, 1, 29),
        2026: datetime.date(2026, 2, 17),
        2027: datetime.date(2027, 2, 6),
        2028: datetime.date(2028, 1, 26),
    }
    lny = lny_approx.get(year)
    if lny:
        for delta in range(-1, 8):  # LNY eve + 7 holiday days
            fixed.append(lny + datetime.timedelta(days=delta))

    return sorted(set(fixed))


@lru_cache(maxsize=16)
def _holiday_set(year: int) -> frozenset[datetime.date]:
    return frozenset(tw_public_holidays(year))


def is_trading_day(date: datetime.date | str) -> bool:
    """Return True if the given date is a regular Taiwan trading day.

    Returns False for weekends and known public holidays.
    Note: does not account for exchange-announced special closures or
    typhoon days (those are unpredictable and not calendrical).
    """
    d = _to_date(date)
    if d.weekday() >= 5:  # Saturday=5, Sunday=6
        return False
    return d not in _holiday_set(d.year)


def next_trading_day(date: datetime.date | str, lookahead: int = 10) -> datetime.date | None:
    """Return the next trading day strictly after `date`, within `lookahead` days."""
    d = _to_date(date)
    for delta in range(1, lookahead + 1):
        candidate = d + datetime.timedelta(days=delta)
        if is_trading_day(candidate):
            return candidate
    return None


# ── Pre-holiday risk detection ─────────────────────────────────────────────────

def is_pre_holiday(date: datetime.date | str, lookahead_days: int = 1) -> bool:
    """Return True if any of the next `lookahead_days` trading days is followed
    by a non-trading day (holiday or weekend gap).

    Pre-holiday sessions often have thinner liquidity and one-sided moves.
    """
    d = _to_date(date)
    check = d
    for _ in range(lookahead_days):
        nxt = check + datetime.timedelta(days=1)
        while nxt.weekday() >= 5:
            nxt += datetime.timedelta(days=1)
        # nxt is the next calendar weekday; if it's a holiday, current session is pre-holiday
        if nxt in _holiday_set(nxt.year):
            return True
        check = nxt
    # Also flag Friday-before-long-weekend
    if d.weekday() == 4:  # Friday
        saturday = d + datetime.timedelta(days=1)
        monday = d + datetime.timedelta(days=3)
        if not is_trading_day(monday):
            return True
    return False


def trading_days_until_holiday(date: datetime.date | str, max_lookahead: int = 10) -> int:
    """Return the number of trading days from `date` until the next public holiday.

    Returns max_lookahead if no holiday found within that window.
    """
    d = _to_date(date)
    holidays_this_and_next_year = (
        _holiday_set(d.year) | _holiday_set(d.year + 1)
    )
    trading_count = 0
    cursor = d
    for _ in range(max_lookahead * 3):
        cursor += datetime.timedelta(days=1)
        if cursor in holidays_this_and_next_year:
            return trading_count
        if is_trading_day(cursor):
            trading_count += 1
            if trading_count >= max_lookahead:
                return max_lookahead
    return max_lookahead


# ── Month / quarter end window dressing ───────────────────────────────────────

def is_month_end_window(date: datetime.date | str, window_days: int = 3) -> bool:
    """Return True if `date` is within `window_days` trading days before month-end.

    Month-end window dressing (institutional buying to mark up holdings) can
    distort signals — entry near end-of-month may capture artificial strength.
    """
    d = _to_date(date)
    import calendar
    last_day_of_month = datetime.date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])
    cursor = last_day_of_month
    # Walk backward to find the last trading day of the month
    while not is_trading_day(cursor) and cursor > d:
        cursor -= datetime.timedelta(days=1)
    last_trade = cursor
    # Count trading days from d to last_trade
    count = 0
    cur = d + datetime.timedelta(days=1)
    while cur <= last_trade:
        if is_trading_day(cur):
            count += 1
        cur += datetime.timedelta(days=1)
    return count <= window_days


def is_quarter_end_window(date: datetime.date | str, window_days: int = 5) -> bool:
    """Return True if `date` is within `window_days` trading days before quarter-end.

    Quarter-end has stronger window-dressing and rebalancing flows.
    """
    d = _to_date(date)
    quarter_end_months = {3, 6, 9, 12}
    if d.month not in quarter_end_months:
        # Still worth checking if we're close to the end of a quarter-end month
        return False
    return is_month_end_window(date, window_days=window_days)


# ── Calendar risk label ────────────────────────────────────────────────────────

def get_calendar_risk_label(date: datetime.date | str) -> str | None:
    """Return a human-readable risk label if the date carries elevated calendar risk.

    Returns None if no special conditions apply.
    Example returns:
      "⚠️ 明日休市（節前效應，注意流動性）"
      "⚠️ 農曆年前週 — 外資提前撤倉風險"
      "📅 月底窗飾期（法人可能人為拉抬）"
      "📅 季底窗飾期（法人籌碼干擾較強）"
    """
    d = _to_date(date)
    labels: list[str] = []

    if is_quarter_end_window(date):
        labels.append("📅 季底窗飾期（法人籌碼干擾較強）")
    elif is_month_end_window(date):
        labels.append("📅 月底窗飾期（法人可能人為拉抬）")

    if is_pre_holiday(date, lookahead_days=1):
        labels.append("⚠️ 明日休市（節前效應，注意流動性）")

    # Lunar New Year week (approximately)
    lny_approx: dict[int, datetime.date] = {
        2024: datetime.date(2024, 2, 10),
        2025: datetime.date(2025, 1, 29),
        2026: datetime.date(2026, 2, 17),
        2027: datetime.date(2027, 2, 6),
    }
    lny = lny_approx.get(d.year)
    if lny:
        days_before_lny = (lny - d).days
        if 3 <= days_before_lny <= 10:
            labels.append("⚠️ 農曆年前 — 外資提前撤倉風險")

    return "；".join(labels) if labels else None


# ── Helpers ────────────────────────────────────────────────────────────────────

def _to_date(date: datetime.date | str) -> datetime.date:
    if isinstance(date, datetime.date):
        return date
    # Accept both "2026-06-11" and "2026/06/11"
    clean = str(date).strip().replace("/", "-")
    return datetime.date.fromisoformat(clean[:10])
