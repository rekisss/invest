"""
K-line incremental fetch + Notion sync + Excel export.

Data sources: TWSE (listed) and TPEX (OTC) official public APIs — no API key needed.

Logic:
  1. Read batch_seq*.csv from last 30 days → all scanned stock IDs
  2. Diff against kline_cache.json → only fetch dates newer than latest cached bar
  3. Fetch ALL stocks per trading day (batch approach):
       TWSE: MI_INDEX endpoint (main board, all stocks, one day per call)
       TPEX: otc_quotes endpoint (OTC board, all stocks, one day per call)
  4. Filter to scanned stocks, accumulate OHLCV bars
  5. Preserve bars older than the fetch window (never deleted)
  6. Save updated output/kline_cache.json
  7. Sync 30-day/90-day stats to Notion (PATCH schema first, then update pages)
  8. Export output/kline_export.xlsx (K線匯總 + OHLCV近30日)
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd
import requests
from loguru import logger
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT       = Path(__file__).parent
SCAN_DIR   = ROOT / "output" / "full_scan"
CACHE_FILE = ROOT / "output" / "kline_cache.json"
EXCEL_FILE = ROOT / "output" / "kline_export.xlsx"

LOOKBACK_DAYS = 90   # calendar days of OHLCV to fetch
WINDOW_DAYS   = 30   # collect stocks scanned within this many days

TWSE_MI_URL  = "https://www.twse.com.tw/exchangeReport/MI_INDEX"
TPEX_OTC_URL = "https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes/stk_wn1_result.php"

NOTION_API = "https://api.notion.com/v1"
NOTION_VER = "2022-06-28"

# ── Logging setup ──────────────────────────────────────────────────────────────
logger.remove()
logger.add(
    sys.stdout,
    format="<green>{time:HH:mm:ss}</green> | <level>{level:<7}</level> | {message}",
    level="DEBUG",
    colorize=True,
)


# ── Date helpers ───────────────────────────────────────────────────────────────
def today_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def days_ago_iso(n: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=n)).strftime("%Y-%m-%d")


def weekdays_between(start: str, end: str) -> list[str]:
    """Return list of Mon-Fri date strings in [start, end]."""
    result: list[str] = []
    d = date.fromisoformat(start)
    stop = date.fromisoformat(end)
    while d <= stop:
        if d.weekday() < 5:   # 0=Mon … 4=Fri
            result.append(d.isoformat())
        d += timedelta(days=1)
    return result


# ── Step 1: Collect stock IDs from last 30 days of scan CSVs ──────────────────
def get_stock_ids_last_30_days() -> list[str]:
    if not SCAN_DIR.exists():
        logger.warning(f"Scan directory not found: {SCAN_DIR}")
        return []

    cutoff = days_ago_iso(WINDOW_DAYS)
    files: list[Path] = []
    for f in sorted(SCAN_DIR.iterdir()):
        if not f.is_file():
            continue
        m = re.match(r"^batch_seq\d+_(\d{4}-\d{2}-\d{2})\.csv$", f.name)
        if m and m.group(1) >= cutoff:
            files.append(f)

    if not files:
        logger.warning("No batch_seq CSV files in last 30 days — trying all available")
        all_files = sorted(
            [f for f in SCAN_DIR.iterdir()
             if re.match(r"^batch_seq\d+_\d{4}-\d{2}-\d{2}\.csv$", f.name)],
            reverse=True,
        )
        files = all_files[:9]

    ids: set[str] = set()
    dates_seen: set[str] = set()
    for f in files:
        try:
            df = pd.read_csv(f, usecols=["stock_id"], encoding="utf-8-sig", dtype=str)
            ids.update(df["stock_id"].dropna().str.strip().tolist())
            mm = re.search(r"(\d{4}-\d{2}-\d{2})", f.name)
            if mm:
                dates_seen.add(mm.group(1))
        except Exception as exc:
            logger.warning(f"Could not read {f.name}: {exc}")

    logger.info(f"Scan dates found: {', '.join(sorted(dates_seen))}")
    logger.info(f"Unique stocks from last {WINDOW_DAYS} days: {len(ids)}")
    return sorted(ids)


# ── Step 2: Determine which dates need fetching ───────────────────────────────
def get_dates_to_fetch(existing_cache: dict[str, list], lookback_days: int) -> list[str]:
    """Return weekday dates that are newer than the latest bar already cached."""
    start = days_ago_iso(lookback_days)
    end   = today_iso()
    all_days = weekdays_between(start, end)

    # Find latest date already in cache across all stocks
    latest_cached = "1900-01-01"
    for bars in existing_cache.values():
        if bars and bars[-1].get("time", "") > latest_cached:
            latest_cached = bars[-1]["time"]

    if latest_cached > "1900-01-01":
        new_days = [d for d in all_days if d > latest_cached]
        skipped = len(all_days) - len(new_days)
        if skipped:
            logger.info(f"Cache already has data up to {latest_cached} — skipping {skipped} days")
        return new_days

    return all_days   # no cache yet, fetch everything


# ── Step 3: Fetch one trading day from TWSE (listed stocks) ───────────────────
def _parse_price(s: str) -> float | None:
    s = str(s).strip().replace(",", "")
    if s in ("--", "", "X"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def fetch_twse_day(date_str: str, session: requests.Session) -> dict[str, dict]:
    """Return {stock_id: bar_dict} for all TWSE main-board stocks on date_str."""
    yyyymmdd = date_str.replace("-", "")
    try:
        resp = session.get(
            TWSE_MI_URL,
            params={"response": "json", "date": yyyymmdd, "type": "ALLBUT0999"},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=30,
        )
        resp.raise_for_status()
        body = resp.json()
    except Exception as exc:
        logger.debug(f"TWSE {date_str}: {exc}")
        return {}

    if body.get("stat") != "OK":
        return {}

    result: dict[str, dict] = {}
    for row in body.get("data9", []):
        if len(row) < 9:
            continue
        sid = str(row[0]).strip()
        o = _parse_price(row[5])
        h = _parse_price(row[6])
        lv = _parse_price(row[7])
        c = _parse_price(row[8])
        if None in (o, h, lv, c):
            continue
        try:
            vol = int(str(row[2]).replace(",", ""))
        except ValueError:
            vol = 0
        result[sid] = {"time": date_str, "open": o, "high": h, "low": lv, "close": c, "volume": vol}

    return result


# ── Step 4: Fetch one trading day from TPEX (OTC stocks) ─────────────────────
def fetch_tpex_day(date_str: str, session: requests.Session) -> dict[str, dict]:
    """Return {stock_id: bar_dict} for all TPEX OTC stocks on date_str."""
    y, m, d = date_str.split("-")
    roc_date = f"{int(y) - 1911}/{m}/{d}"
    try:
        resp = session.get(
            TPEX_OTC_URL,
            params={"l": "zh-tw", "d": roc_date, "se": "EW", "o": "json"},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=30,
        )
        resp.raise_for_status()
        body = resp.json()
    except Exception as exc:
        logger.debug(f"TPEX {date_str}: {exc}")
        return {}

    result: dict[str, dict] = {}
    for row in body.get("aaData", []):
        if len(row) < 8:
            continue
        sid = str(row[0]).strip()
        o = _parse_price(row[4])
        h = _parse_price(row[5])
        lv = _parse_price(row[6])
        c = _parse_price(row[7])
        if None in (o, h, lv, c):
            continue
        try:
            vol = int(str(row[2]).replace(",", ""))
        except ValueError:
            vol = 0
        result[sid] = {"time": date_str, "open": o, "high": h, "low": lv, "close": c, "volume": vol}

    return result


# ── Step 5: Compute statistics ────────────────────────────────────────────────
def compute_stats(bars: list[dict], cutoff_30d: str) -> dict[str, Any] | None:
    if not bars:
        return None
    latest = bars[-1]
    bars_30 = [b for b in bars if b.get("time", "") >= cutoff_30d]
    first_30 = bars_30[0] if bars_30 else None
    first_90 = bars[0]

    def pct(new_close: float, old_close: float) -> float | None:
        if not old_close:
            return None
        return round((new_close - old_close) / old_close * 100, 2)

    return {
        "latest_close": latest["close"],
        "latest_date":  latest["time"],
        "return_30d":   pct(latest["close"], first_30["close"]) if first_30 else None,
        "high_30d":     round(max(b["high"] for b in bars_30), 2) if bars_30 else None,
        "low_30d":      round(min(b["low"]  for b in bars_30), 2) if bars_30 else None,
        "return_90d":   pct(latest["close"], first_90["close"]) if len(bars) >= 10 else None,
        "days":         len(bars),
    }


# ── Step 6: Excel export ──────────────────────────────────────────────────────
HEADER_FILL  = PatternFill("solid", fgColor="1F3864")
HEADER_FONT  = Font(bold=True, color="FFFFFF", name="微軟正黑體")
HEADER_ALIGN = Alignment(horizontal="center", vertical="center")
ALT_FILL     = PatternFill("solid", fgColor="EEF2F7")


def _style_header(ws, headers: list[str], col_widths: list[int]) -> None:
    ws.row_dimensions[1].height = 22
    for col_idx, (h, w) in enumerate(zip(headers, col_widths), start=1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.font      = HEADER_FONT
        cell.fill      = HEADER_FILL
        cell.alignment = HEADER_ALIGN
        ws.column_dimensions[cell.column_letter].width = w


def export_excel(kline_map: dict[str, list], path: Path) -> None:
    cutoff_30d = days_ago_iso(30)
    wb = Workbook()

    # Sheet 1: Summary
    ws1 = wb.active
    ws1.title = "K線匯總"
    headers1 = ["股票代號", "最新收盤", "最後更新", "30日漲幅%", "90日漲幅%", "30日最高", "30日最低", "資料天數"]
    widths1  = [10, 10, 14, 12, 12, 10, 10, 10]
    _style_header(ws1, headers1, widths1)

    rows_summary = []
    for sid, bars in kline_map.items():
        s = compute_stats(bars, cutoff_30d)
        if not s:
            continue
        rows_summary.append((sid, s["latest_close"], s["latest_date"],
                             s["return_30d"], s["return_90d"],
                             s["high_30d"], s["low_30d"], s["days"]))
    rows_summary.sort(key=lambda r: (r[3] or -9999), reverse=True)

    for row_idx, row in enumerate(rows_summary, start=2):
        fill = ALT_FILL if row_idx % 2 == 0 else None
        for col_idx, val in enumerate(row, start=1):
            cell = ws1.cell(row=row_idx, column=col_idx, value=val)
            cell.alignment = Alignment(horizontal="center")
            if fill:
                cell.fill = fill

    # Sheet 2: OHLCV (last 30 days)
    ws2 = wb.create_sheet("OHLCV(近30日)")
    headers2 = ["股票代號", "日期", "開盤", "最高", "最低", "收盤", "成交量"]
    widths2  = [10, 12, 10, 10, 10, 10, 14]
    _style_header(ws2, headers2, widths2)

    raw_rows: list[tuple] = []
    for sid, bars in kline_map.items():
        for b in bars:
            if b.get("time", "") >= cutoff_30d:
                raw_rows.append((sid, b["time"], b["open"], b["high"],
                                 b["low"], b["close"], b["volume"]))
    raw_rows.sort(key=lambda r: (r[0], r[1]))

    for row_idx, row in enumerate(raw_rows, start=2):
        fill = ALT_FILL if row_idx % 2 == 0 else None
        for col_idx, val in enumerate(row, start=1):
            cell = ws2.cell(row=row_idx, column=col_idx, value=val)
            cell.alignment = Alignment(horizontal="center")
            if fill:
                cell.fill = fill

    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    logger.info(f"Excel saved: {path.name}  ({len(rows_summary)} stocks, {len(raw_rows)} OHLCV rows)")


# ── Step 7: Notion sync ────────────────────────────────────────────────────────
def _notion_headers(token: str) -> dict[str, str]:
    return {
        "Authorization":  f"Bearer {token}",
        "Notion-Version": NOTION_VER,
        "Content-Type":   "application/json",
    }


def sync_to_notion(kline_map: dict[str, list], token: str, db_id: str) -> None:
    if not token or not db_id:
        logger.info("Notion: skipped (NOTION_TOKEN or NOTION_DATABASE_ID not set)")
        return

    cutoff_30d = days_ago_iso(30)

    # Ensure K-line properties exist in the database schema
    try:
        requests.patch(
            f"{NOTION_API}/databases/{db_id}",
            headers=_notion_headers(token),
            json={"properties": {
                "30日漲幅%": {"number": {"format": "percent"}},
                "30日最高":  {"number": {"format": "number"}},
                "30日最低":  {"number": {"format": "number"}},
                "90日漲幅%": {"number": {"format": "percent"}},
                "K線更新日": {"rich_text": {}},
            }},
            timeout=25,
        ).raise_for_status()
        logger.info("Notion schema patch: OK")
    except Exception as exc:
        logger.warning(f"Notion schema patch warning: {exc}")

    # Paginate through all pages and update matching entries
    cursor: str | None = None
    updated = failed = total = 0

    while True:
        body: dict = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        try:
            resp = requests.post(
                f"{NOTION_API}/databases/{db_id}/query",
                headers=_notion_headers(token),
                json=body,
                timeout=25,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            logger.error(f"Notion query error: {exc}")
            break

        pages = data.get("results", [])
        total += len(pages)

        for page in pages:
            rt = page.get("properties", {}).get("股票代號", {}).get("rich_text", [])
            sid = rt[0]["text"]["content"].strip() if rt else ""
            if not sid or sid not in kline_map:
                continue

            stats = compute_stats(kline_map[sid], cutoff_30d)
            if not stats:
                continue

            props: dict = {
                "30日最高":  {"number": stats["high_30d"]},
                "30日最低":  {"number": stats["low_30d"]},
                "K線更新日": {"rich_text": [{"text": {"content": stats["latest_date"]}}]},
            }
            if stats["return_30d"] is not None:
                props["30日漲幅%"] = {"number": stats["return_30d"] / 100}
            if stats["return_90d"] is not None:
                props["90日漲幅%"] = {"number": stats["return_90d"] / 100}

            try:
                requests.patch(
                    f"{NOTION_API}/pages/{page['id']}",
                    headers=_notion_headers(token),
                    json={"properties": props},
                    timeout=25,
                ).raise_for_status()
                updated += 1
                time.sleep(0.05)
            except Exception as exc:
                logger.debug(f"  Notion update {sid} failed: {exc}")
                failed += 1

        if data.get("has_more"):
            cursor = data["next_cursor"]
        else:
            break

    logger.info(
        f"Notion: scanned {total} pages, updated {updated}"
        + (f", {failed} failed" if failed else "")
    )


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    logger.info("=== K-line incremental fetch (TWSE + TPEX) ===")

    # ── 1. Collect stock IDs from last 30 days of scan CSVs ──────────────────
    stock_ids = set(get_stock_ids_last_30_days())
    if not stock_ids:
        logger.warning("No stocks found in last 30 days of scans — exiting")
        sys.exit(0)

    # ── 2. Load existing cache ────────────────────────────────────────────────
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    existing_cache: dict[str, list] = {}
    if CACHE_FILE.exists():
        try:
            existing_cache = json.loads(CACHE_FILE.read_text("utf-8"))
            logger.info(f"Cache loaded: {len(existing_cache)} stocks")
        except Exception as exc:
            logger.warning(f"Failed to load cache ({exc}) — starting fresh")

    # ── 3. Determine which dates to fetch ────────────────────────────────────
    dates_to_fetch = get_dates_to_fetch(existing_cache, LOOKBACK_DAYS)
    if not dates_to_fetch:
        logger.info("Cache is already up-to-date — skipping API calls")
    else:
        logger.info(f"Fetching {len(dates_to_fetch)} trading days "
                    f"({dates_to_fetch[0]} ~ {dates_to_fetch[-1]})")

    # ── 4. Batch-by-day fetch from TWSE + TPEX ───────────────────────────────
    kline_map: dict[str, list] = {sid: list(bars) for sid, bars in existing_cache.items()}
    twse_hits = tpex_hits = empty_days = 0

    with requests.Session() as session:
        for i, date_str in enumerate(dates_to_fetch):
            twse = fetch_twse_day(date_str, session)
            time.sleep(0.4)
            tpex = fetch_tpex_day(date_str, session)
            time.sleep(0.4)

            day_data = {**twse, **tpex}

            if not day_data:
                empty_days += 1
                continue   # holiday or weekend — no market data

            for sid in stock_ids:
                if sid in day_data:
                    kline_map.setdefault(sid, []).append(day_data[sid])

            day_twse = sum(1 for s in stock_ids if s in twse)
            day_tpex = sum(1 for s in stock_ids if s in tpex)
            twse_hits += day_twse
            tpex_hits += day_tpex

            if (i + 1) % 10 == 0 or (i + 1) == len(dates_to_fetch):
                logger.info(
                    f"  [{i+1}/{len(dates_to_fetch)}] {date_str}  "
                    f"TWSE:{len(twse)} OTC:{len(tpex)}  "
                    f"scanned hits: {day_twse}T+{day_tpex}O"
                )

    if dates_to_fetch:
        covered = sum(1 for bars in kline_map.values() if bars)
        logger.info(
            f"Fetch complete: {covered}/{len(stock_ids)} scanned stocks have K-line data  "
            f"(TWSE bars: {twse_hits}, OTC bars: {tpex_hits}, "
            f"empty days skipped: {empty_days})"
        )

    # Sort bars by date within each stock (ensure chronological order)
    for sid in kline_map:
        kline_map[sid].sort(key=lambda b: b.get("time", ""))

    # ── 5. Save updated cache ─────────────────────────────────────────────────
    CACHE_FILE.write_text(json.dumps(kline_map, ensure_ascii=False), "utf-8")
    logger.info(f"Cache saved: {CACHE_FILE.name} ({len(kline_map)} stocks)")

    # ── 6. Excel export ───────────────────────────────────────────────────────
    logger.info("=== Excel export ===")
    try:
        export_excel(kline_map, EXCEL_FILE)
    except Exception as exc:
        logger.error(f"Excel export failed: {exc}")

    # ── 7. Notion sync ────────────────────────────────────────────────────────
    logger.info("=== Notion sync ===")
    notion_token = os.environ.get("NOTION_TOKEN",       "").strip()
    notion_db_id = os.environ.get("NOTION_DATABASE_ID", "").strip()
    try:
        sync_to_notion(kline_map, notion_token, notion_db_id)
    except Exception as exc:
        logger.error(f"Notion sync failed: {exc}")

    logger.info("=== Done ===")


if __name__ == "__main__":
    main()
