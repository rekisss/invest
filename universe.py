from __future__ import annotations

import re

import pandas as pd


THEME_KEYWORDS = [
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
    "ETF",
    "指數股票型",
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


def _is_numeric_stock_id(stock_id: str) -> bool:
    return bool(re.fullmatch(r"\d{4,6}", str(stock_id)))


def build_auto_universe(stock_info: pd.DataFrame, max_symbols: int = 120) -> pd.DataFrame:
    frame = stock_info.copy()
    frame["stock_id"] = frame["stock_id"].astype(str).str.strip()
    frame["stock_name"] = frame["stock_name"].astype(str).str.strip()
    frame["industry_category"] = frame["industry_category"].astype(str).str.strip()
    frame["type"] = frame["type"].astype(str).str.strip().str.lower()

    frame = frame[frame["stock_id"].map(_is_numeric_stock_id)].copy()
    if EXCLUDE_NAME_KEYWORDS:
        frame = frame[~frame["stock_name"].str.contains("|".join(EXCLUDE_NAME_KEYWORDS), case=False, na=False)].copy()

    # Exclude ETFs: their technical signals and volume behaviour differ from individual stocks
    frame = frame[~frame["stock_name"].str.contains("ETF|指數股票型", case=False, na=False)].copy()

    frame["is_theme"] = (
        frame["stock_name"].str.contains("|".join(THEME_KEYWORDS), case=False, na=False)
        | frame["industry_category"].str.contains("|".join(THEME_KEYWORDS), case=False, na=False)
    )
    frame["is_listed"] = frame["type"].str.contains("twse|tse|上市", case=False, na=False)
    frame["is_otc"] = frame["type"].str.contains("otc|tpex|上櫃", case=False, na=False)

    frame["theme_score"] = 0
    frame.loc[frame["is_theme"], "theme_score"] += 4
    frame.loc[frame["industry_category"].str.contains("半導體|電腦及週邊|電子|光電|通信|網路", case=False, na=False), "theme_score"] += 3
    frame.loc[frame["is_listed"], "theme_score"] += 2
    frame.loc[frame["is_otc"], "theme_score"] += 1

    ranked = frame.sort_values(
        ["theme_score", "is_theme", "stock_id"],
        ascending=[False, False, True],
    ).drop_duplicates(subset=["stock_id"])

    selected = ranked.head(max_symbols).copy()
    selected = selected.rename(columns={"stock_name": "name"})
    return selected[["stock_id", "name", "industry_category", "type", "theme_score"]].reset_index(drop=True)
