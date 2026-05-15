from __future__ import annotations

import re

import pandas as pd



THEME_KEYWORDS = [
    # Core tech themes
    "AI",
    "人工智慧",
    "半導體",
    "電腦及週邊",
    "電子",
    "光電",
    "網路",
    "通信",
    "伺服器",
    "散熱",
    "IC",
    "晶片",
    "ASIC",
    "CCL",
    # Advanced packaging / HBM
    "CoWoS",
    "HBM",
    "先進封裝",
    "封測",
    # EV / green energy
    "車用",
    "電動車",
    "綠能",
    "太陽能",
    "儲能",
    # Data center
    "資料中心",
    "機櫃",
    "液冷",
    # Optical / connectivity
    "矽光子",
    "光通訊",
    # Power semiconductors / industrial
    "功率半導體",
    "工業電腦",
    "GaN",
    "SiC",
    "PCB",
    # Memory
    "DRAM",
    "NAND",
    "記憶體",
    # Edge / cloud
    "邊緣運算",
    "雲端",
    # 2025/2026 emerging themes
    "AI PC",
    "機器人",
    "人形機器人",
    "軍工",
    "航太",
    "資安",
    "HPC",
    "高速運算",
    "高頻寬",
    "銅箔",
    "被動元件",
    "電源管理",
]

EXCLUDE_NAME_KEYWORDS = [
    "權證",
    "牛證",
    "熊證",
    "特別股",
    "認購",
    "認售",
    "可轉債",
]

_THEME_RE = re.compile("|".join(re.escape(kw) for kw in THEME_KEYWORDS), re.IGNORECASE)
_EXCLUDE_RE = re.compile("|".join(re.escape(kw) for kw in EXCLUDE_NAME_KEYWORDS), re.IGNORECASE)
_SECTOR_RE = re.compile(
    "半導體|電腦及週邊|電子|光電|通信|網路|封測|車用|綠能|儲能|PCB|工業電腦|記憶體|航太|資安|被動元件",
    re.IGNORECASE,
)
_ETF_RE = re.compile(r"ETF|指數股票型|元大|富邦.*TW|國泰.*TW", re.IGNORECASE)
_NUMERIC_ID_RE = re.compile(r"\d{4,6}")
_LISTED_RE = re.compile(r"twse|tse|上市", re.IGNORECASE)
_OTC_RE = re.compile(r"otc|tpex|上櫃", re.IGNORECASE)


def _is_numeric_stock_id(stock_id: str) -> bool:
    return bool(_NUMERIC_ID_RE.fullmatch(str(stock_id)))


def build_auto_universe(stock_info: pd.DataFrame, max_symbols: int = 120) -> pd.DataFrame:
    frame = stock_info.copy()
    frame["stock_id"] = frame["stock_id"].astype(str).str.strip()
    frame["stock_name"] = frame["stock_name"].astype(str).str.strip()
    frame["industry_category"] = frame["industry_category"].astype(str).str.strip()
    frame["type"] = frame["type"].astype(str).str.strip().str.lower()

    frame = frame[frame["stock_id"].map(_is_numeric_stock_id)]
    frame = frame[~frame["stock_name"].str.contains(_EXCLUDE_RE, na=False)]

    # Exclude ETFs: their technical signals and volume behaviour differ from individual stocks
    # Also exclude by stock_id prefix: Taiwan ETFs are typically 6-digit IDs starting with 0
    frame = frame[~frame["stock_name"].str.contains(_ETF_RE, na=False)]
    frame = frame[~(frame["stock_id"].str.len() == 6)].copy()  # copy before column assignment below

    _is_theme = (
        frame["stock_name"].str.contains(_THEME_RE, na=False)
        | frame["industry_category"].str.contains(_THEME_RE, na=False)
    )
    _is_sector = frame["industry_category"].str.contains(_SECTOR_RE, na=False)
    _is_listed = frame["type"].str.contains(_LISTED_RE, na=False)
    _is_otc = frame["type"].str.contains(_OTC_RE, na=False)
    frame["theme_score"] = (
        _is_theme.astype("int8") * 4
        + _is_sector.astype("int8") * 3
        + _is_listed.astype("int8") * 2
        + _is_otc.astype("int8")
    )

    ranked = frame.sort_values(
        ["theme_score", "stock_id"],
        ascending=[False, True],
    ).drop_duplicates(subset=["stock_id"])

    selected = ranked.head(max_symbols).copy()
    selected = selected.rename(columns={"stock_name": "name"})
    return selected[["stock_id", "name", "industry_category", "type", "theme_score"]].reset_index(drop=True)
