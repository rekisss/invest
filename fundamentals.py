"""
fundamentals.py – Piotroski F-Score for Taiwan stocks.

Computes 9 binary signals (4 profitability, 3 safety, 2 efficiency)
from FinMind quarterly financial data.  Returns -1 when data is
insufficient so callers can treat it as "no opinion".
"""
from __future__ import annotations

import numpy as np
import pandas as pd


# FinMind type-column aliases — each tuple is tried in declaration order
_INC_ALIAS: dict[str, tuple[str, ...]] = {
    "revenue":    ("Revenue", "SalesRevenue", "NetRevenue"),
    "gross":      ("GrossProfit", "GrossMargin", "GrossProfitLoss"),
    "net_income": ("NetIncome", "NetIncomeAfterTax", "ProfitAttributableToOwnersOfParent",
                   "ProfitForThePeriod"),
}
_BAL_ALIAS: dict[str, tuple[str, ...]] = {
    "total_assets": ("TotalAssets", "TotalAsset", "Assets"),
    "cur_assets":   ("CurrentAssets", "CurrentAsset"),
    "cur_liab":     ("CurrentLiabilities", "CurrentLiab"),
    "lt_debt":      ("LongTermBorrowings", "LongTermDebt", "NoncurrentLiabilities",
                     "LongTermLiabilities"),
    "shares":       ("ShareCapital", "IssuedCapital", "CommonStockSharesOutstanding",
                     "CapitalStock"),
}
_CF_ALIAS: dict[str, tuple[str, ...]] = {
    "ocf": ("CashFlowsFromOperatingActivities", "OperatingActivities",
            "NetCashFromOperatingActivities", "CashProvidedByOperatingActivities"),
}


def _pivot(df: pd.DataFrame) -> pd.DataFrame:
    """Convert FinMind long (date, type, value) → wide sorted by date."""
    if df.empty:
        return pd.DataFrame()
    if "type" in df.columns and "value" in df.columns:
        out = df.copy()
        out["date"] = pd.to_datetime(out["date"])
        out["value"] = pd.to_numeric(out["value"], errors="coerce")
        wide = out.pivot_table(index="date", columns="type", values="value", aggfunc="last")
        wide.columns.name = None
        return wide.sort_index().reset_index()
    # Already wide
    df = df.copy()
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date").reset_index(drop=True)


def _pick(df: pd.DataFrame, aliases: tuple[str, ...]) -> pd.Series | None:
    for name in aliases:
        if name in df.columns:
            return pd.to_numeric(df[name], errors="coerce").reset_index(drop=True)
    return None


def _ttm(series: pd.Series, n: int = 4) -> pd.Series:
    return series.rolling(n, min_periods=n).sum()


def _last2(series: pd.Series | None) -> tuple[float, float]:
    """(current, prior) from the last two non-NaN values, or (nan, nan)."""
    if series is None:
        return float("nan"), float("nan")
    vals = series.dropna()
    if len(vals) < 2:
        return float("nan"), float("nan")
    return float(vals.iloc[-1]), float(vals.iloc[-2])


def compute_f_score(
    income_df: pd.DataFrame,
    balance_df: pd.DataFrame,
    cashflow_df: pd.DataFrame,
) -> dict[str, object]:
    """
    Compute Piotroski F-Score (0–9).

    Returns:
        {'f_score': int 0-9, 'f_detail': dict[str, int]}
        {'f_score': -1, 'f_detail': {}}  — when data is insufficient
    """
    empty: dict[str, object] = {"f_score": -1, "f_detail": {}}

    inc = _pivot(income_df)
    bal = _pivot(balance_df)
    cf  = _pivot(cashflow_df)

    if inc.empty and bal.empty and cf.empty:
        return empty

    # ── Balance sheet ─────────────────────────────────────────────────────────
    total_assets = None if bal.empty else _pick(bal, _BAL_ALIAS["total_assets"])
    if total_assets is None or total_assets.dropna().shape[0] < 2:
        return empty

    cur_assets = None if bal.empty else _pick(bal, _BAL_ALIAS["cur_assets"])
    cur_liab   = None if bal.empty else _pick(bal, _BAL_ALIAS["cur_liab"])
    lt_debt    = None if bal.empty else _pick(bal, _BAL_ALIAS["lt_debt"])
    shares     = None if bal.empty else _pick(bal, _BAL_ALIAS["shares"])

    ta_cur, ta_pri  = _last2(total_assets)
    ca_cur, ca_pri  = _last2(cur_assets)
    cl_cur, cl_pri  = _last2(cur_liab)
    ltd_cur, ltd_pri = _last2(lt_debt)
    sh_cur,  sh_pri  = _last2(shares)

    avg_assets = (ta_cur + ta_pri) / 2 if not (np.isnan(ta_cur) or np.isnan(ta_pri)) else ta_cur

    # ── Income (trailing 4Q if quarterly, else last 2 rows) ──────────────────
    is_quarterly = (not inc.empty) and len(inc) >= 4
    net_income_s = _pick(inc, _INC_ALIAS["net_income"]) if not inc.empty else None
    revenue_s    = _pick(inc, _INC_ALIAS["revenue"])    if not inc.empty else None
    gross_s      = _pick(inc, _INC_ALIAS["gross"])      if not inc.empty else None

    if is_quarterly:
        net_income_s = _ttm(net_income_s) if net_income_s is not None else None
        revenue_s    = _ttm(revenue_s)    if revenue_s    is not None else None
        gross_s      = _ttm(gross_s)      if gross_s      is not None else None

    ni_cur,  ni_pri  = _last2(net_income_s)
    rev_cur, rev_pri = _last2(revenue_s)
    gr_cur,  gr_pri  = _last2(gross_s)

    # ── Cash flow ─────────────────────────────────────────────────────────────
    is_cf_quarterly = (not cf.empty) and len(cf) >= 4
    ocf_s = _pick(cf, _CF_ALIAS["ocf"]) if not cf.empty else None
    if is_cf_quarterly and ocf_s is not None:
        ocf_s = _ttm(ocf_s)

    ocf_cur, _ = _last2(ocf_s)

    # ── 9 binary signals ──────────────────────────────────────────────────────
    def _f(cond: bool) -> int:
        return 1 if cond else 0

    roa_cur = ni_cur / avg_assets  if (avg_assets > 0 and not np.isnan(ni_cur))  else float("nan")
    roa_pri = ni_pri / ta_pri      if (ta_pri > 0    and not np.isnan(ni_pri))   else float("nan")
    ocf_roa = ocf_cur / avg_assets if (avg_assets > 0 and not np.isnan(ocf_cur)) else float("nan")

    lev_cur = ltd_cur / avg_assets if (not np.isnan(ltd_cur) and avg_assets > 0) else float("nan")
    lev_pri = ltd_pri / ta_pri     if (not np.isnan(ltd_pri) and ta_pri > 0)     else float("nan")
    cr_cur  = ca_cur  / cl_cur     if (not np.isnan(ca_cur) and not np.isnan(cl_cur) and cl_cur > 0) else float("nan")
    cr_pri  = ca_pri  / cl_pri     if (not np.isnan(ca_pri) and not np.isnan(cl_pri) and cl_pri > 0) else float("nan")
    gm_cur  = gr_cur  / rev_cur    if (not np.isnan(gr_cur) and not np.isnan(rev_cur) and rev_cur > 0) else float("nan")
    gm_pri  = gr_pri  / rev_pri    if (not np.isnan(gr_pri) and not np.isnan(rev_pri) and rev_pri > 0) else float("nan")
    at_cur  = rev_cur / avg_assets if (not np.isnan(rev_cur) and avg_assets > 0) else float("nan")
    at_pri  = rev_pri / ta_pri     if (not np.isnan(rev_pri) and ta_pri > 0)     else float("nan")

    # Require at least ROA to be computable
    if np.isnan(roa_cur):
        return empty

    detail: dict[str, int] = {
        # Profitability
        "F1_roa_positive":     _f(roa_cur > 0),
        "F2_ocf_positive":     _f(not np.isnan(ocf_cur) and ocf_cur > 0),
        "F3_roa_improving":    _f(not np.isnan(roa_pri) and roa_cur > roa_pri),
        "F4_low_accruals":     _f(not np.isnan(ocf_roa) and ocf_roa > roa_cur),
        # Safety
        "F5_leverage_down":    _f(not np.isnan(lev_cur) and not np.isnan(lev_pri) and lev_cur <= lev_pri),
        "F6_liquidity_up":     _f(not np.isnan(cr_cur)  and not np.isnan(cr_pri)  and cr_cur >= cr_pri),
        "F7_no_dilution":      _f(not np.isnan(sh_cur)  and not np.isnan(sh_pri)  and sh_cur <= sh_pri),
        # Efficiency
        "F8_gross_margin_up":  _f(not np.isnan(gm_cur)  and not np.isnan(gm_pri)  and gm_cur >= gm_pri),
        "F9_asset_turnover_up":_f(not np.isnan(at_cur)  and not np.isnan(at_pri)  and at_cur >= at_pri),
    }
    return {"f_score": sum(detail.values()), "f_detail": detail}
