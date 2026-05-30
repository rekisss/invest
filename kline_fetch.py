"""
K-line incremental fetch + Notion sync + Excel export.

Logic:
  1. Read batch_seq*.csv from the last 30 days → all scanned stock IDs
  2. Diff against kline_cache.json → only fetch stocks missing or stale (>2 days old)
  3. Data older than 30 days is PRESERVED (never deleted from cache)
  4. Fetch in parallel using all available FinMind tokens (1 thread per token)
  5. Save updated output/kline_cache.json
  6. Sync 30-day/90-day stats to Notion (PATCH schema first, then update pages)
  7. Export output/kline_export.xlsx (K線匯總 + OHLCV近30日)
"""

from __future__ import annotations

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd
import requests
from loguru import logger
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from tenacity import retry, stop_after_attempt, wait_exponential

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT       = Path(__file__).parent
SCAN_DIR   = ROOT / "output" / "full_scan"
CACHE_FILE = ROOT / "output" / "kline_cache.json"
EXCEL_FILE = ROOT / "output" / "kline_export.xlsx"

LOOKBACK_DAYS = 90   # calendar days of OHLCV to fetch
WINDOW_DAYS   = 30   # collect stocks scanned within this many days
STALE_DAYS    = 2    # cache entry is stale if latest bar is older than this

FINMIND_API = "https://api.finmindtrade.com/api/v4/data"
NOTION_API  = "https://api.notion.com/v1"
NOTION_VER  = "2022-06-28"

# ── Logging setup ──────────────────────────────────────────────────────────────
logger.remove()
logger.add(
    sys.stdout,
    format="<green>{time:HH:mm:ss}</green> | <level>{level:<7}</level> | {message}",
    level="DEBUG",
    colorize=True,
)


# ── Date helpers ───────────────────────────────────────────────────────────────
def today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def days_ago(n: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=n)).strftime("%Y-%m-%d")


# ── Step 1: Collect stock IDs from last 30 days of scan CSVs ──────────────────
def get_stock_ids_last_30_days() -> list[str]:
    if not SCAN_DIR.exists():
        logger.warning(f"Scan directory not found: {SCAN_DIR}")
        return []

    cutoff = days_ago(WINDOW_DAYS)
    files: list[Path] = []
    for f in sorted(SCAN_DIR.iterdir()):
        m = f.name if f.is_file() else None
        if m is None:
            continue
        import re
        match = re.match(r"^batch_seq\d+_(\d{4}-\d{2}-\d{2})\.csv$", f.name)
        if match and match.group(1) >= cutoff:
            files.append(f)

    if not files:
        logger.warning("No batch_seq CSV files found in last 30 days — trying all available")
        import re
        all_files = sorted(
            [f for f in SCAN_DIR.iterdir()
             if re.match(r"^batch_seq\d+_\d{4}-\d{2}-\d{2}\.csv$", f.name)],
            reverse=True
        )
        files = all_files[:9]

    ids: set[str] = set()
    dates_seen: set[str] = set()
    for f in files:
        try:
            df = pd.read_csv(f, usecols=["stock_id"], encoding="utf-8-sig", dtype=str)
            df = df.dropna(subset=["stock_id"])
            ids.update(df["stock_id"].str.strip().tolist())
            import re
            m = re.search(r"(\d{4}-\d{2}-\d{2})", f.name)
            if m:
                dates_seen.add(m.group(1))
        except Exception as exc:
            logger.warning(f"Could not read {f.name}: {exc}")

    logger.info(f"Scan dates found: {', '.join(sorted(dates_seen))}")
    logger.info(f"Unique stocks from last {WINDOW_DAYS} days: {len(ids)}")
    return sorted(ids)


# ── Step 2: Determine which stocks need a fresh fetch ─────────────────────────
def get_stocks_needing_update(cache: dict[str, list], stock_ids: list[str]) -> list[str]:
    threshold = days_ago(STALE_DAYS)
    to_fetch: list[str] = []
    for sid in stock_ids:
        bars = cache.get(sid)
        if not bars:
            to_fetch.append(sid)
            continue
        latest_time = bars[-1].get("time", "")
        if latest_time < threshold:
            to_fetch.append(sid)
    skipped = len(stock_ids) - len(to_fetch)
    if skipped > 0:
        logger.info(f"Already up-to-date: {skipped} stocks (skipping)")
    return to_fetch


# ── Step 3: Fetch K-line data per stock ──────────────────────────────────────
@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10), reraise=True)
def _fetch_one_raw(sid: str, token: str, start: str, end: str) -> dict:
    resp = requests.get(
        FINMIND_API,
        params=dict(token=token, dataset="TaiwanStockPrice", stock_id=sid, start_date=start, end_date=end),
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_one(sid: str, token: str, start: str, end: str) -> list[dict] | None:
    try:
        data = _fetch_one_raw(sid, token, start, end)
        if data.get("status") == 200 and isinstance(data.get("data"), list) and data["data"]:
            return [
                dict(time=d["date"], open=d["open"], high=d["max"],
                     low=d["min"], close=d["close"], volume=d.get("Trading_Volume", 0))
                for d in data["data"]
            ]
        return None
    except Exception as exc:
        logger.debug(f"  fetch_one({sid}): {exc}")
        return None


def fetch_chunk(stock_ids: list[str], token: str, label: str, start: str, end: str) -> dict[str, list]:
    if not token or not stock_ids:
        return {}

    # Probe the first stock to validate the token / plan
    probe = fetch_one(stock_ids[0], token, start, end)
    if probe is None:
        logger.warning(f"[{label}] probe failed — skipping this token")
        return {}

    result: dict[str, list] = {stock_ids[0]: probe}
    for sid in stock_ids[1:]:
        bars = fetch_one(sid, token, start, end)
        if bars is not None:
            result[sid] = bars
        time.sleep(0.08)   # ~80 ms between requests; well within rate limits

    logger.info(f"[{label}] {len(result)}/{len(stock_ids)} fetched")
    return result


# ── Step 4: Compute statistics ────────────────────────────────────────────────
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
        "latest_close":  latest["close"],
        "latest_date":   latest["time"],
        "return_30d":    pct(latest["close"], first_30["close"])  if first_30 else None,
        "high_30d":      round(max(b["high"] for b in bars_30), 2) if bars_30 else None,
        "low_30d":       round(min(b["low"]  for b in bars_30), 2) if bars_30 else None,
        "return_90d":    pct(latest["close"], first_90["close"]) if len(bars) >= 10 else None,
        "days":          len(bars),
    }


# ── Step 5: Excel export ──────────────────────────────────────────────────────
HEADER_FILL   = PatternFill("solid", fgColor="1F3864")
HEADER_FONT   = Font(bold=True, color="FFFFFF", name="微軟正黑體")
HEADER_ALIGN  = Alignment(horizontal="center", vertical="center")
ALT_FILL      = PatternFill("solid", fgColor="EEF2F7")


def _style_header(ws, headers: list[str], col_widths: list[int]) -> None:
    ws.row_dimensions[1].height = 22
    for col_idx, (h, w) in enumerate(zip(headers, col_widths), start=1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.font   = HEADER_FONT
        cell.fill   = HEADER_FILL
        cell.alignment = HEADER_ALIGN
        ws.column_dimensions[cell.column_letter].width = w


def export_excel(kline_map: dict[str, list], path: Path) -> None:
    cutoff_30d = days_ago(30)
    wb = Workbook()

    # ── Sheet 1: Summary ───────────────────────────────────────────────────────
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
    rows_summary.sort(key=lambda r: (r[3] or -9999), reverse=True)  # sort by 30d return desc

    for row_idx, row in enumerate(rows_summary, start=2):
        fill = ALT_FILL if row_idx % 2 == 0 else None
        for col_idx, val in enumerate(row, start=1):
            cell = ws1.cell(row=row_idx, column=col_idx, value=val)
            cell.alignment = Alignment(horizontal="center")
            if fill:
                cell.fill = fill

    # ── Sheet 2: OHLCV (last 30 days) ─────────────────────────────────────────
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


# ── Step 6: Notion sync ────────────────────────────────────────────────────────
def _notion_headers(token: str) -> dict[str, str]:
    return {
        "Authorization":  f"Bearer {token}",
        "Notion-Version": NOTION_VER,
        "Content-Type":   "application/json",
    }


def _notion_patch(path: str, token: str, body: dict) -> dict:
    r = requests.patch(f"{NOTION_API}{path}", headers=_notion_headers(token),
                       json=body, timeout=25)
    r.raise_for_status()
    return r.json()


def _notion_post(path: str, token: str, body: dict) -> dict:
    r = requests.post(f"{NOTION_API}{path}", headers=_notion_headers(token),
                      json=body, timeout=25)
    r.raise_for_status()
    return r.json()


def sync_to_notion(kline_map: dict[str, list], token: str, db_id: str) -> None:
    if not token or not db_id:
        logger.info("Notion: skipped (NOTION_TOKEN or NOTION_DATABASE_ID not set)")
        return

    cutoff_30d = days_ago(30)

    # Ensure K-line properties exist in the database schema
    try:
        _notion_patch(f"/databases/{db_id}", token, {
            "properties": {
                "30日漲幅%": {"number": {"format": "percent"}},
                "30日最高":  {"number": {"format": "number"}},
                "30日最低":  {"number": {"format": "number"}},
                "90日漲幅%": {"number": {"format": "percent"}},
                "K線更新日": {"rich_text": {}},
            }
        })
        logger.info("Notion schema patch: OK")
    except Exception as exc:
        logger.warning(f"Notion schema patch warning: {exc}")

    # Paginate through all pages and update matching entries
    cursor: str | None = None
    updated = 0
    failed  = 0
    total   = 0

    while True:
        body: dict = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        try:
            resp = _notion_post(f"/databases/{db_id}/query", token, body)
        except Exception as exc:
            logger.error(f"Notion query error: {exc}")
            break

        pages = resp.get("results", [])
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
                _notion_patch(f"/pages/{page['id']}", token, {"properties": props})
                updated += 1
                time.sleep(0.05)
            except Exception as exc:
                logger.debug(f"  Notion update {sid} failed: {exc}")
                failed += 1

        if resp.get("has_more"):
            cursor = resp["next_cursor"]
        else:
            break

    logger.info(f"Notion: scanned {total} pages, updated {updated}"
                + (f", {failed} failed" if failed else ""))


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    token_defs = [
        (os.environ.get("FINMIND_TOKEN",    "").strip(), "帳號1（600/hr）"),
        (os.environ.get("FINMIND_TOKEN_2",  "").strip(), "帳號2（600/hr）"),
        (os.environ.get("FINMIND_TOKEN_3",  "").strip(), "帳號3（600/hr）"),
        (os.environ.get("FINMIND_TOKEN_4",  "").strip(), "帳號4（600/hr）"),
        (os.environ.get("FINMIND_TOKEN_5",  "").strip(), "帳號5（600/hr）"),
        (os.environ.get("FINMIND_TOKEN_6",  "").strip(), "帳號6（300/hr）"),
        (os.environ.get("FINMIND_TOKEN_7",  "").strip(), "帳號7（300/hr）"),
        (os.environ.get("FINMIND_TOKEN_8",  "").strip(), "帳號8（300/hr）"),
        (os.environ.get("FINMIND_TOKEN_9",  "").strip(), "帳號9（300/hr）"),
        (os.environ.get("FINMIND_TOKEN_10", "").strip(), "帳號10（K線）"),
    ]
    active_tokens = [(tok, lbl) for tok, lbl in token_defs if tok]

    if not active_tokens:
        logger.error("No FINMIND tokens set. Set FINMIND_TOKEN through FINMIND_TOKEN_10.")
        sys.exit(1)

    end_date   = today_str()
    start_date = days_ago(LOOKBACK_DAYS)

    logger.info("=== K-line incremental fetch ===")
    logger.info(f"Date range: {start_date} ~ {end_date}")
    logger.info(f"Active tokens: {len(active_tokens)}")

    # ── 1. Collect stock IDs from last 30 days of scan CSVs ───────────────────
    all_stock_ids = get_stock_ids_last_30_days()
    if not all_stock_ids:
        logger.warning("No stocks found in last 30 days of scans — exiting")
        sys.exit(0)

    # ── 2. Load existing cache (preserves data outside the 30-day window) ─────
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    existing_cache: dict[str, list] = {}
    if CACHE_FILE.exists():
        try:
            existing_cache = json.loads(CACHE_FILE.read_text("utf-8"))
            logger.info(f"Cache loaded: {len(existing_cache)} stocks already cached")
        except Exception as exc:
            logger.warning(f"Failed to load cache ({exc}) — starting fresh")

    # ── 3. Determine which stocks need a refresh ──────────────────────────────
    to_fetch = get_stocks_needing_update(existing_cache, all_stock_ids)
    logger.info(f"To fetch: {len(to_fetch)} stocks")

    # ── 4. Parallel fetch (1 thread per token) ────────────────────────────────
    kline_map: dict[str, list] = dict(existing_cache)  # start with old data intact

    if to_fetch:
        chunk_size = max(1, -(-len(to_fetch) // len(active_tokens)))  # ceiling division
        chunks = [
            (to_fetch[i * chunk_size:(i + 1) * chunk_size], tok, lbl)
            for i, (tok, lbl) in enumerate(active_tokens)
            if to_fetch[i * chunk_size:(i + 1) * chunk_size]
        ]

        logger.info(f"Distributing {len(to_fetch)} stocks across {len(chunks)} threads "
                    f"(~{chunk_size} each)")

        with ThreadPoolExecutor(max_workers=len(chunks)) as pool:
            futures = {
                pool.submit(fetch_chunk, ids, tok, lbl, start_date, end_date): lbl
                for ids, tok, lbl in chunks
            }
            for future in as_completed(futures):
                try:
                    result = future.result()
                    kline_map.update(result)
                except Exception as exc:
                    logger.error(f"Chunk failed: {exc}")

        total_fetched = sum(1 for sid in to_fetch if sid in kline_map and
                            sid not in existing_cache or kline_map[sid] != existing_cache.get(sid))
        logger.info(f"Fetch complete: {len(kline_map)} stocks in cache total")
    else:
        logger.info("All stocks already up-to-date — skipping API calls")

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
