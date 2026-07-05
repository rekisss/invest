#!/usr/bin/env python3
"""從每日掃描 CSV 累積訓練資料 (standalone, read-only inputs).

背景：collect_training_data.py 用 yfinance,但 GitHub Actions 的 IP 被 Yahoo
封鎖,CI 內無法重收資料;而每天的 batch_seq CSV 本身就含 train_model.py 需要的
全部 39 個特徵欄位(子代理逐欄比對過:0 個改名、0 個缺失)。本工具把掃描資料
轉成 train_model.py 的 legacy `historical_*.parquet` 格式,讓既有訓練程式
原封不動可用——不改任何保護的 Python。

防洩漏/資料品質規則:
  - 只保留 row.date == 檔案日期 的列(每天 ~9 列停牌股殘影帶舊日期,會毒化特徵與標籤)
  - label_5d 用「第 5 個全域掃描日」的收盤(不是每股第 5 列——個股缺天會造成
    horizon 漂移),該日該股無收盤 → 標籤 NaN(train_model 會丟棄)
  - 特徵與標籤起點同日(t 收盤特徵 → t+5 收盤標籤),與 collect_training_data
    的定義一致,維持與現有模型可比

已知侷限(誠實記錄,PR 有寫):未還原除權息(7 月除息季會有假負標籤)、
掃描樣本略偏(watchlist 過濾後 ~1450 支/日,非嚴格全市場)。

輸出:training_data/historical_scan_<today>.parquet
用法:python scan_training_builder.py  →  python train_model.py --data <輸出檔>
"""

from __future__ import annotations

import glob
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

SCAN_DIR = os.path.join("output", "full_scan")
OUT_DIR = "training_data"
LABEL_HORIZON = 5      # 第 5 個全域掃描日
LABEL_THRESHOLD = 0.03  # +3% → label_5d = 1（與 train_model.py 定義一致）
MIN_STOCKS_PER_DAY = 500  # 殘缺日（例如只掃到幾段）不納入，避免偏差


def _today() -> str:
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")


def load_scan_days() -> dict[str, pd.DataFrame]:
    """回傳 {date: df}，已去重、已丟棄舊日期殘影列與壞價列。"""
    dates = sorted({m.group(1) for f in glob.glob(f"{SCAN_DIR}/batch_seq*_????-??-??.csv")
                    if (m := re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(f)))})
    days: dict[str, pd.DataFrame] = {}
    for d in dates:
        frames = []
        for p in sorted(glob.glob(f"{SCAN_DIR}/batch_seq*_{d}.csv")):
            try:
                frames.append(pd.read_csv(p, encoding="utf-8-sig", low_memory=False))
            except Exception as exc:  # noqa: BLE001
                print(f"[builder] 略過 {os.path.basename(p)}: {exc}")
        if not frames:
            continue
        df = pd.concat(frames, ignore_index=True)
        df["stock_id"] = df["stock_id"].astype(str).str.strip()
        df["date"] = df["date"].astype(str).str.strip()
        df = df[df["date"] == d]                                   # 丟停牌殘影列
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        df = df[df["close"] > 0]                                   # 丟壞價
        # 同股取 entry_score 最高列（與網站/TOP20 相同的去重原則）
        df["_es"] = pd.to_numeric(df.get("entry_score"), errors="coerce").fillna(-1e9)
        df = df.sort_values("_es", ascending=False).drop_duplicates("stock_id").drop(columns="_es")
        if len(df) < MIN_STOCKS_PER_DAY:
            print(f"[builder] {d}: 僅 {len(df)} 支（殘缺日）→ 跳過")
            continue
        days[d] = df
        print(f"[builder] {d}: {len(df)} 支")
    return days


def build() -> str | None:
    days = load_scan_days()
    dates = sorted(days)
    if len(dates) <= LABEL_HORIZON:
        print(f"[builder] 掃描日不足（{len(dates)} 天，需 > {LABEL_HORIZON}），無可標籤資料")
        return None

    # 每個可標籤日 t：標籤日 = 全域掃描日序列的 t+5
    close_by_day = {d: days[d].set_index("stock_id")["close"] for d in dates}
    frames = []
    for i, d in enumerate(dates):
        j = i + LABEL_HORIZON
        if j >= len(dates):
            break  # 尾端尚無未來收盤，不產生無標籤列（train_model 會丟，省空間）
        fut = close_by_day[dates[j]]
        df = days[d].copy()
        fwd = df["stock_id"].map(fut) / df["close"] - 1.0
        df["forward_return_5d"] = fwd
        df["label_5d"] = (fwd > LABEL_THRESHOLD).astype("float")
        df.loc[fwd.isna(), "label_5d"] = np.nan   # 標籤日缺該股 → NaN（丟棄）
        frames.append(df)

    out = pd.concat(frames, ignore_index=True)
    out["date"] = pd.to_datetime(out["date"])     # train_model 的 time_split 需要 datetime
    # CSV 逐段讀入會產生混型 object 欄（同欄混 'True'/1.0/NaN），parquet 拒收；
    # 除文字欄外全部轉數值（True/False→1/0，轉不動→NaN，train_model 會 fillna(0)）
    TEXT_COLS = {"stock_id", "name", "industry_category", "entry_reason",
                 "skip_reason", "base_exit_reason", "grade"}
    for c in out.columns:
        if c == "date" or c in TEXT_COLS:
            continue
        if out[c].dtype == object:
            out[c] = pd.to_numeric(
                out[c].replace({"True": 1, "False": 0, "true": 1, "false": 0, True: 1, False: 0}),
                errors="coerce",
            )
    for c in TEXT_COLS - {"stock_id"}:
        if c in out.columns:
            out[c] = out[c].astype(str).replace("nan", "")
    # 掃描資料含 ±inf（如分母為 0 的量比），XGBoost 直接拒收；轉 NaN 讓 train_model fillna(0)
    num_cols = out.select_dtypes(include=[np.number]).columns
    out[num_cols] = out[num_cols].replace([np.inf, -np.inf], np.nan)
    labeled = int(out["label_5d"].notna().sum())
    pos = int((out["label_5d"] == 1).sum())
    print(f"[builder] 共 {len(out)} 列，其中可標籤 {labeled} 列，正例 {pos} "
          f"({pos / max(labeled, 1) * 100:.1f}%)，日期 {dates[0]} ~ {dates[len(dates) - LABEL_HORIZON - 1]}")

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, f"historical_scan_{_today()}.parquet")
    out.to_parquet(out_path, index=False)
    print(f"[builder] 已存 {out_path}（{os.path.getsize(out_path) // 1024} KB）")
    return out_path


if __name__ == "__main__":
    sys.exit(0 if build() else 1)
