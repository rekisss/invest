"""
全盤掃描第二波：橫截面信號補充 + 基本面資料補抓。

Wave 1（全盤掃描）每支股票獨立計算，無法取得跨股票的相對信號。
本腳本在 Wave 1 提交後執行，讀取所有 batch_seq CSV，補充：

【橫截面信號（純計算，不需 API）】
  sector_rs            — 個股分數 vs 同類股中位數（相對類股強弱）
  sector_rs_rank       — 同類股內百分位排名 0-100
  market_rs_rank       — 全市場百分位排名 0-100（由 entry_score 計算）
  sector_breadth_60    — 同類股中站上 EMA60 的比例（類股廣度）
  sector_vol_zscore    — 量比 vs 同類股 z-score
  is_sector_leader     — 類股前 3 名旗手（True/False）
  sector_stock_count   — 同類股掃描股票數

【基本面補抓（需 FINMIND_TOKEN，Wave 1 配額重置後）】
  f_score_enriched     — 針對 f_score == -1 的股票補抓 Piotroski F-Score
  (覆寫原本的 f_score 欄位，其他欄位不動)

用法：
    python scan_enrich.py --scan-dir output/full_scan --date 2026-06-11
    python scan_enrich.py --scan-dir output/full_scan  # 自動取最新日期
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd


# ── 工具函式 ────────────────────────────────────────────────────────────────────

def _log(msg: str) -> None:
    print(f"[scan_enrich] {msg}", flush=True)


def _to_num(val: object, default: float = 0.0) -> float:
    try:
        return float(val)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _find_latest_date(scan_dir: Path) -> str | None:
    dates: set[str] = set()
    for p in scan_dir.glob("batch_seq*.csv"):
        m = re.search(r"(\d{4}-\d{2}-\d{2})\.csv$", p.name)
        if m:
            dates.add(m.group(1))
    return max(dates) if dates else None


def _load_all_batch_csvs(scan_dir: Path, date: str) -> pd.DataFrame:
    csvs = sorted(scan_dir.glob(f"batch_seq*_{date}.csv"))
    if not csvs:
        return pd.DataFrame()
    frames = []
    for p in csvs:
        try:
            frames.append(pd.read_csv(p, encoding="utf-8-sig", low_memory=False))
        except Exception as exc:
            _log(f"⚠️ 跳過 {p.name}: {exc}")
    if not frames:
        return pd.DataFrame()
    df = pd.concat(frames, ignore_index=True)
    # Normalise industry_category: pandas reads the string "nan" back as NaN
    if "industry_category" in df.columns:
        df["industry_category"] = df["industry_category"].fillna("其他").replace({"nan": "其他", "NaN": "其他", "None": "其他", "": "其他"})
    # 去重，保留最高分
    if "entry_score" in df.columns and "stock_id" in df.columns:
        df = (
            df.sort_values("entry_score", ascending=False)
            .drop_duplicates(subset=["stock_id"])
            .reset_index(drop=True)
        )
    return df


def _save_enriched(df: pd.DataFrame, scan_dir: Path, date: str) -> None:
    """Overwrite each batch_seq CSV with the enriched data for its own stocks."""
    csvs = sorted(scan_dir.glob(f"batch_seq*_{date}.csv"))
    if not csvs:
        _log("⚠️ 找不到 batch_seq CSV，無法回寫")
        return

    # Map stock_id → enriched row
    if "stock_id" not in df.columns:
        return
    enriched_map = {str(row["stock_id"]): row for _, row in df.iterrows()}

    for p in csvs:
        try:
            orig = pd.read_csv(p, encoding="utf-8-sig", low_memory=False)
            if orig.empty or "stock_id" not in orig.columns:
                continue
            # Add new enrichment columns (keep existing columns intact)
            _new_cols = [
                "sector_rs", "sector_rs_rank", "market_rs_rank",
                "sector_breadth_60", "sector_vol_zscore",
                "is_sector_leader", "sector_stock_count",
            ]
            for col in _new_cols:
                if col in df.columns:
                    orig[col] = orig["stock_id"].astype(str).map(
                        lambda sid, c=col: enriched_map.get(sid, {}).get(c, np.nan)
                    )
            # Overwrite f_score where enriched value is available and original was -1
            if "f_score_enriched" in df.columns and "f_score" in orig.columns:
                def _pick_fscore(row: pd.Series) -> float:
                    sid = str(row.get("stock_id", ""))
                    erow = enriched_map.get(sid)
                    if erow is None:
                        return row.get("f_score", -1)
                    enriched = _to_num(erow.get("f_score_enriched"), -1)
                    orig_fs = _to_num(row.get("f_score"), -1)
                    return enriched if (enriched >= 0 and orig_fs < 0) else orig_fs
                orig["f_score"] = orig.apply(_pick_fscore, axis=1)

            orig.to_csv(p, index=False, encoding="utf-8-sig")
            _log(f"✅ 回寫 {p.name}（{len(orig)} 支）")
        except Exception as exc:
            _log(f"⚠️ 回寫 {p.name} 失敗: {exc}")


# ── 橫截面信號計算 ─────────────────────────────────────────────────────────────

def compute_crosssectional_signals(df: pd.DataFrame) -> pd.DataFrame:
    """Compute cross-sectional signals that require all stocks to be present."""
    if df.empty:
        return df

    result = df.copy()
    sector_col = "industry_category" if "industry_category" in df.columns else None

    # ── 全市場百分位排名 ───────────────────────────────────────────────────────
    if "entry_score" in result.columns:
        scores = pd.to_numeric(result["entry_score"], errors="coerce")
        result["market_rs_rank"] = scores.rank(pct=True, method="average").mul(100).round(1)
    else:
        result["market_rs_rank"] = np.nan

    if sector_col is None or sector_col not in result.columns:
        result["sector_rs"]          = np.nan
        result["sector_rs_rank"]     = np.nan
        result["sector_breadth_60"]  = np.nan
        result["sector_vol_zscore"]  = np.nan
        result["is_sector_leader"]   = False
        result["sector_stock_count"] = 0
        return result

    # Normalise sector labels
    result[sector_col] = result[sector_col].fillna("其他").replace("", "其他")

    # Pre-compute per-sector stats
    sector_stats: dict[str, dict] = {}
    for sector, grp in result.groupby(sector_col):
        sector = str(sector)
        scores_s = pd.to_numeric(grp.get("entry_score", pd.Series(dtype=float)), errors="coerce")
        vr_s     = pd.to_numeric(grp.get("volume_ratio",  pd.Series(dtype=float)), errors="coerce")
        above_s  = grp.get("above_ema60", pd.Series(dtype=object))

        above_60_pct: float = 0.0
        if not above_s.empty:
            # above_ema60 may be True/False or 1/0
            numeric_above = pd.to_numeric(above_s, errors="coerce").fillna(0)
            above_60_pct = float(numeric_above.mean() * 100)

        sector_stats[sector] = {
            "median_score": float(scores_s.median()) if not scores_s.empty else 0.0,
            "vr_mean":      float(vr_s.mean())       if not vr_s.empty    else 1.0,
            "vr_std":       float(vr_s.std())         if vr_s.std() > 0   else 1.0,
            "above_60_pct": above_60_pct,
            "count":        int(len(grp)),
            # Top 3 stock_ids by entry_score in this sector
            "leader_ids":   set(
                grp.nlargest(3, "entry_score")["stock_id"].astype(str).tolist()
                if "entry_score" in grp.columns else []
            ),
        }

    # ── Per-row signals ───────────────────────────────────────────────────────
    def _row_signals(row: pd.Series) -> pd.Series:
        sector = str(row.get(sector_col, "其他"))
        stats  = sector_stats.get(sector, {})
        score  = _to_num(row.get("entry_score"))
        vr     = _to_num(row.get("volume_ratio"), 1.0)
        sid    = str(row.get("stock_id", ""))

        median  = stats.get("median_score", 0.0)
        vr_mean = stats.get("vr_mean", 1.0)
        vr_std  = stats.get("vr_std", 1.0)

        sector_rs = round(score - median, 1)

        # Sector-relative rank: rank within sector by entry_score
        # Computed below using groupby transform for efficiency
        sector_vol_z = round((vr - vr_mean) / max(vr_std, 0.01), 2)
        is_leader    = sid in stats.get("leader_ids", set())

        return pd.Series({
            "sector_rs":          sector_rs,
            "sector_breadth_60":  round(stats.get("above_60_pct", 0.0), 1),
            "sector_vol_zscore":  sector_vol_z,
            "is_sector_leader":   is_leader,
            "sector_stock_count": stats.get("count", 0),
        })

    extras = result.apply(_row_signals, axis=1)
    for col in extras.columns:
        result[col] = extras[col]

    # Sector-within rank (more efficient via groupby)
    if "entry_score" in result.columns:
        result["sector_rs_rank"] = (
            result.groupby(sector_col)["entry_score"]
            .transform(lambda x: x.rank(pct=True, method="average") * 100)
            .round(1)
        )
    else:
        result["sector_rs_rank"] = np.nan

    return result


# ── 基本面補抓（F-Score for f_score == -1）────────────────────────────────────

def _enrich_fscores(df: pd.DataFrame, token: str) -> pd.DataFrame:
    """For rows where f_score == -1, attempt to fetch Piotroski F-Score via FinMind.

    Uses the existing fundamentals.compute_f_score() function.
    Adds 'f_score_enriched' column (stays -1 if fetch fails).
    """
    if "f_score" not in df.columns or not token:
        df["f_score_enriched"] = -1
        return df

    missing_ids = df[pd.to_numeric(df["f_score"], errors="coerce").fillna(-1) < 0]["stock_id"].astype(str).tolist()
    if not missing_ids:
        _log("所有股票 F-Score 已完整，跳過補抓")
        df["f_score_enriched"] = -1
        return df

    _log(f"F-Score 缺失 {len(missing_ids)} 支，嘗試補抓…")

    enriched: dict[str, int] = {}
    try:
        from fundamentals import compute_f_score
    except ImportError:
        _log("⚠️ fundamentals 模組未找到，跳過 F-Score 補抓")
        df["f_score_enriched"] = -1
        return df

    # Limit to top 10 by entry_score to get diagnostic data without burning 13+ min on zero results
    if "entry_score" in df.columns:
        missing_df = df[pd.to_numeric(df["f_score"], errors="coerce").fillna(-1) < 0]
        if len(missing_df) > 10:
            missing_ids = (
                missing_df.sort_values("entry_score", ascending=False)
                .head(10)["stock_id"].astype(str).tolist()
            )
            _log(f"限制補抓前 10 支（診斷模式，待確認財報欄位後再擴增）")

    try:
        from data_loader import FinMindClient, fetch_fundamentals
    except ImportError:
        _log("⚠️ data_loader 模組未找到，跳過 F-Score 補抓")
        df["f_score_enriched"] = -1
        return df

    import time
    from datetime import datetime, timedelta

    end_date = datetime.now().strftime("%Y-%m-%d")
    start_date = (datetime.now() - timedelta(days=3 * 365)).strftime("%Y-%m-%d")

    client = FinMindClient()
    # If FinMindClient couldn't pick up FINMIND_TOKEN but we have one, inject it
    if token and not client._auth_headers_cache:
        client._auth_headers_cache = {"Authorization": f"Bearer {token}"}

    ok = fail = data_miss = 0
    _diag_logged = False  # log columns for the first non-empty stock only
    for sid in missing_ids:
        try:
            fundamentals = fetch_fundamentals(client, sid, start_date, end_date)
            inc = fundamentals.get("income", pd.DataFrame())
            bal = fundamentals.get("balance", pd.DataFrame())
            cf  = fundamentals.get("cashflow", pd.DataFrame())
            if inc.empty and bal.empty and cf.empty:
                data_miss += 1
                time.sleep(0.5)
                continue
            if not _diag_logged:
                _log(f"財報欄位診斷（{sid}）: income={list(inc.columns[:8])} bal={list(bal.columns[:8])} cf={list(cf.columns[:8])}")
                _diag_logged = True
            result = compute_f_score(inc, bal, cf)
            if isinstance(result, dict) and "f_score" in result:
                fs = result["f_score"]
                if isinstance(fs, (int, float)) and fs >= 0:
                    enriched[sid] = int(fs)
                    ok += 1
            # fetch_fundamentals makes 3 calls; FinMindClient already sleeps 0.3s each.
            # Extra sleep to keep total rate ≤ 600 calls/hr across the enrichment run.
            time.sleep(1.0)
        except Exception:
            fail += 1

    _log(f"F-Score 補抓完成：成功 {ok} / 資料空白 {data_miss} / 失敗 {fail}")
    df["f_score_enriched"] = df["stock_id"].astype(str).map(enriched).fillna(-1).astype(int)
    return df


# ── 類股資料補填 ────────────────────────────────────────────────────────────────

def _fetch_industry_map(token: str) -> dict[str, str]:
    """Fetch industry_category for all stocks from TaiwanStockInfo (1 API call).

    Returns a dict mapping stock_id → industry_category for stocks that have
    a non-null category.  Returns {} on failure so callers degrade gracefully.
    """
    try:
        from data_loader import FinMindClient
        client = FinMindClient()
        if token and not client._auth_headers_cache:
            client._auth_headers_cache = {"Authorization": f"Bearer {token}"}
        df = client.fetch_dataset("TaiwanStockInfo", use_cache=True, cache_ttl_days=7)
        if df.empty:
            _log("⚠️ TaiwanStockInfo 回傳空資料，無法補填類股")
            return {}
        _log(f"TaiwanStockInfo 欄位：{list(df.columns)}")
        if "industry_category" not in df.columns:
            _log("⚠️ TaiwanStockInfo 無 industry_category 欄位，無法補填類股")
            return {}
        mapping: dict[str, str] = {}
        for _, row in df.iterrows():
            sid = str(row.get("stock_id", "")).strip()
            cat = str(row.get("industry_category", "")).strip()
            if sid and cat and cat not in ("nan", "None", "", "其他"):
                mapping[sid] = cat
        _log(f"TaiwanStockInfo 取得 {len(mapping)} 支有效類股資料（共 {len(df)} 支）")
        return mapping
    except Exception as exc:
        _log(f"⚠️ 無法取得 TaiwanStockInfo: {exc}")
        return {}


# ── 主流程 ─────────────────────────────────────────────────────────────────────

def run_enrichment(scan_dir: Path, date: str, token: str = "") -> None:
    _log(f"開始第二波橫截面補充 — {date}")

    df = _load_all_batch_csvs(scan_dir, date)
    if df.empty:
        _log(f"❌ 找不到 {date} 的 batch_seq CSV，請確認 Wave 1 已完成並提交")
        sys.exit(1)

    n_sectors = df["industry_category"].nunique() if "industry_category" in df.columns else 0
    _log(f"讀入 {len(df)} 支股票資料（{n_sectors} 個類股）")

    # If all stocks are uncategorized (batch CSVs had "nan" industry_category),
    # fetch real categories from TaiwanStockInfo (1 API call, very cheap on quota).
    if "industry_category" in df.columns and n_sectors <= 1 and token:
        _log("industry_category 缺失，從 TaiwanStockInfo 補填…")
        ind_map = _fetch_industry_map(token)
        if ind_map:
            df["industry_category"] = df["stock_id"].astype(str).map(ind_map).fillna("其他")
            _log(f"補填後：{df['industry_category'].nunique()} 個類股")

    # Step 1: Cross-sectional signals (no API needed)
    _log("計算橫截面信號…")
    df = compute_crosssectional_signals(df)
    _log(
        f"  market_rs_rank: {df['market_rs_rank'].describe()['mean']:.1f} 平均 | "
        f"sector_leaders: {df['is_sector_leader'].sum() if 'is_sector_leader' in df.columns else 0} 支"
    )

    # Step 2: F-Score enrichment (uses FinMind API, quota reset after Wave 1)
    if token:
        _log("補抓缺失 F-Score…")
        df = _enrich_fscores(df, token)
    else:
        _log("FINMIND_TOKEN 未設定，跳過 F-Score 補抓")
        df["f_score_enriched"] = -1

    # Step 3: Write back enriched CSVs
    _log("回寫 enriched batch_seq CSV…")
    _save_enriched(df, scan_dir, date)

    # Summary stats
    if "sector_rs_rank" in df.columns:
        leaders = df[df.get("is_sector_leader", pd.Series(False, index=df.index))]
        _log(f"類股旗手：{len(leaders)} 支")
        for _, row in leaders.nlargest(5, "entry_score").iterrows():
            _log(
                f"  {row.get('stock_id','')} {row.get('name','')}  "
                f"分{row.get('entry_score',0):.0f}  "
                f"市場排名{row.get('market_rs_rank',0):.0f}%  "
                f"類股廣度{row.get('sector_breadth_60',0):.0f}%"
            )

    _log(f"✅ 第二波補充完成 — {date}")


# ── CLI ────────────────────────────────────────────────────────────────────────

def _cli() -> None:
    parser = argparse.ArgumentParser(description="Wave 2: 橫截面信號補充 + F-Score 補抓")
    parser.add_argument("--scan-dir", default="output/full_scan",
                        help="Wave 1 batch_seq CSV 所在目錄")
    parser.add_argument("--date", default="",
                        help="掃描日期 YYYY-MM-DD（不填則自動取最新）")
    args = parser.parse_args()

    scan_dir = Path(args.scan_dir)
    if not scan_dir.exists():
        print(f"[scan_enrich] ❌ 目錄不存在: {scan_dir}", file=sys.stderr)
        sys.exit(1)

    date = args.date or _find_latest_date(scan_dir)
    if not date:
        print("[scan_enrich] ❌ 找不到任何 batch_seq CSV", file=sys.stderr)
        sys.exit(1)

    token = (
        os.getenv("FINMIND_TOKEN", "")
        or os.getenv("FINMIND_TOKEN_2", "")
        or os.getenv("FINMIND_TOKEN_3", "")
    ).strip()

    run_enrichment(scan_dir, date, token=token)


if __name__ == "__main__":
    _cli()
