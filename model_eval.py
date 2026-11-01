#!/usr/bin/env python3
"""大盤預測模型的「走查(walk-forward)」評估 —— 只產報告,不改任何線上預測。

目的:回答「模型到底有沒有比天真猜法準」,並比較幾種改進方向。
每個預測日 t 只用 t 當天(含)以前的資料訓練,完全模擬正式盤前預測的情境;
標籤與正式模型相同:5 個交易日後收盤 > 今日收盤 × 1.003。

比較的版本
  A_現行設定_舊標籤  修正前的正式模型(最新 5 筆被誤標為「沒漲」),僅供對照
  B_現行設定        標籤已修正;其餘同正式模型(全特徵、XGB 300 棵/深度 4、約 280 筆訓練、isotonic 校準)
  C_長訓練窗        同 B,但用全部歷史(擴張視窗)訓練
  D_精簡邏輯回歸     8 個特徵 + 標準化 + L2 邏輯回歸,長訓練窗
  E_精簡XGB         同 D 的特徵,XGB 100 棵/深度 2,長訓練窗
  基準:一律猜漲、站上 MA20 猜漲

用法(需要 FINMIND_TOKEN;美股特徵走 yfinance,抓不到就只用台股技術面):
  python model_eval.py --years 6 --out output/model_eval
輸出:<out>/report.json、<out>/report.md(GitHub Actions 會一併寫進 job summary)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import warnings
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

import market_predictor as mp

H = 5
UP = 1.003
NEUTRAL = 0.05
LEGACY_TRAIN_ROWS = 280          # 正式流程 --lookback-days 420 ≈ 280 個交易日
SIMPLE_FEATURES = [
    "ret_5d", "ret_20d", "dist_ma20", "dist_ma60", "rsi14", "vol_20d",
    "sp500_ret1", "nasdaq_ret1",
]


# ── 資料 ──────────────────────────────────────────────────────────────────────

def load_data(years: int, end: str) -> pd.DataFrame:
    from data_loader import FinMindClient, fetch_market_index
    start = (datetime.strptime(end, "%Y-%m-%d") - timedelta(days=int(years * 365.25) + 200)).strftime("%Y-%m-%d")
    client = FinMindClient(cache_dir=Path("output") / "cache")
    market = fetch_market_index(client, start, end)
    if market.empty:
        raise SystemExit("抓不到加權指數資料(FINMIND_TOKEN?)")
    df = mp._build_taiex_features(market.sort_values("date").reset_index(drop=True))
    us = mp.fetch_us_features(start, end)
    if us is not None and not us.empty:
        df = mp.MarketPredictor()._merge_us(df, us)
    print(f"[data] 加權指數 {len(market)} 筆 {market['date'].min():%Y-%m-%d}~{market['date'].max():%Y-%m-%d};"
          f"美股特徵 {0 if us is None else len(us)} 筆")
    return df.reset_index(drop=True)


def make_labels(close: np.ndarray, t: int, legacy: bool) -> np.ndarray:
    """站在第 t 天能知道的標籤。legacy=True 重現舊 bug(未知的最後 5 筆標成 0)。"""
    y = np.full(t + 1, np.nan)
    known = np.arange(t + 1) + H <= t
    idx = np.where(known)[0]
    y[idx] = (close[idx + H] > close[idx] * UP).astype(float)
    if legacy:
        y[~known] = 0.0
    return y


# ── 模型 ──────────────────────────────────────────────────────────────────────

def _xgb(n, depth, spw, mcw=1):
    from xgboost import XGBClassifier
    return XGBClassifier(n_estimators=n, max_depth=depth, learning_rate=0.05, subsample=0.8,
                         colsample_bytree=0.8, min_child_weight=mcw, scale_pos_weight=spw,
                         eval_metric="logloss", verbosity=0, random_state=42)


def fit_predict(kind: str, X: pd.DataFrame, y: np.ndarray, xrow: pd.DataFrame) -> float:
    med = X.median()
    Xf = X.fillna(med)
    xr = xrow.fillna(med)
    if len(np.unique(y)) < 2:
        return float(y.mean())
    if kind == "logit":
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler
        m = make_pipeline(StandardScaler(), LogisticRegression(C=0.3, max_iter=500)).fit(Xf.values, y)
        return float(m.predict_proba(xr.values)[0, 1])
    pos, neg = (y == 1).sum(), (y == 0).sum()
    spw = neg / pos if pos and neg > pos else 1.0
    if kind == "xgb_small":
        return float(_xgb(100, 2, spw, mcw=5).fit(Xf.values, y).predict_proba(xr.values)[0, 1])
    # 正式設定:≥100 筆時 isotonic 校準(與 models/calibration.py 相同)
    base = _xgb(300, 4, spw)
    if len(Xf) >= 100:
        from sklearn.calibration import CalibratedClassifierCV
        m = CalibratedClassifierCV(base, method="isotonic", cv=3).fit(Xf, y)
        return float(m.predict_proba(xr)[0, 1])
    return float(base.fit(Xf.values, y).predict_proba(xr.values)[0, 1])


VARIANTS = {
    # 名稱: (標籤 legacy?, 訓練窗筆數或 None=全部, 特徵集, 模型)
    "A_現行設定_舊標籤": (True, LEGACY_TRAIN_ROWS, "all", "xgb_prod"),
    "B_現行設定": (False, LEGACY_TRAIN_ROWS, "all", "xgb_prod"),
    "C_長訓練窗": (False, None, "all", "xgb_prod"),
    "D_精簡邏輯回歸": (False, None, "simple", "logit"),
    "E_精簡XGB": (False, None, "simple", "xgb_small"),
}


def walk_forward(df: pd.DataFrame, eval_years: int, step: int, only: list[str] | None) -> pd.DataFrame:
    close = df["close"].values.astype(float)
    all_feats = [c for c in mp._BASE_FEATURES + mp._US_FEATURES if c in df.columns and df[c].notna().sum() >= 20]
    simple = [c for c in SIMPLE_FEATURES if c in df.columns]
    X_all = df[all_feats].replace([np.inf, -np.inf], np.nan)
    n = len(df)
    first = max(LEGACY_TRAIN_ROWS + 130, n - int(eval_years * 245) - H)
    variants = {k: v for k, v in VARIANTS.items() if not only or k in only}
    rows = []
    cache: dict[str, float] = {}
    t0 = time.time()
    for t in range(first, n - H):
        rec = {"date": df["date"].iloc[t].strftime("%Y-%m-%d"),
               "ret5": close[t + H] / close[t] - 1,
               "ma20_up": float(df["dist_ma20"].iloc[t] > 0)}
        refit = (t - first) % step == 0
        for name, (legacy, win, fs, kind) in variants.items():
            if not refit and not legacy:
                rec[name] = cache[name]      # 非重訓日沿用上次機率(舊標籤版本每天都要重訓才能重現 bug)
                continue
            y = make_labels(close, t, legacy)
            lo = 120 if win is None else max(120, t + 1 - win)   # 前 120 筆是均線暖身
            mask = ~np.isnan(y[lo:])
            cols = all_feats if fs == "all" else simple
            X = X_all.iloc[lo:t + 1][cols][mask]
            p = fit_predict("xgb_small" if kind == "xgb_small" else ("logit" if kind == "logit" else "prod"),
                            X, y[lo:][mask], X_all.iloc[[t]][cols])
            rec[name] = cache[name] = p
        rows.append(rec)
        if (t - first) % 50 == 0:
            print(f"[wf] {rec['date']} ({t - first + 1}/{n - H - first}) {time.time() - t0:.0f}s", flush=True)
    return pd.DataFrame(rows)


# ── 評分 ──────────────────────────────────────────────────────────────────────

def score(res: pd.DataFrame, names: list[str]) -> dict:
    y = (res["ret5"] > UP - 1).values
    out = {"days": int(len(res)), "first": res["date"].iloc[0], "last": res["date"].iloc[-1],
           "up_rate": float(y.mean()), "independent_samples": int(len(res) // H), "models": {}}
    base_brier = float(((y.mean() - y) ** 2).mean())
    out["always_up"] = {"hit": float(y.mean()), "brier": base_brier}
    out["ma20"] = {"hit": float(((res["ma20_up"].values > 0) == y).mean())}
    for k in names:
        p = res[k].values
        d = np.abs(p - 0.5) > NEUTRAL
        yearly = {}
        for yr, g in res.assign(_y=y, _p=p).groupby(res["date"].str[:4]):
            dd = np.abs(g["_p"] - 0.5) > NEUTRAL
            yearly[yr] = {"n": int(dd.sum()),
                          "hit": float(((g["_p"][dd] > 0.5) == g["_y"][dd]).mean()) if dd.any() else None,
                          "always_up": float(g["_y"][dd].mean()) if dd.any() else None}
        buckets = []
        for lo, hi in [(0, .35), (.35, .45), (.45, .55), (.55, .65), (.65, 1.01)]:
            m = (p >= lo) & (p < hi)
            if m.any():
                buckets.append({"lo": lo, "hi": min(hi, 1), "n": int(m.sum()), "up_rate": float(y[m].mean())})
        out["models"][k] = {
            "mean_prob": float(p.mean()), "say_up": float((p > 0.5).mean()),
            "n_directional": int(d.sum()),
            "hit": float(((p[d] > 0.5) == y[d]).mean()) if d.any() else None,
            "always_up_same_days": float(y[d].mean()) if d.any() else None,
            "brier": float(((p - y) ** 2).mean()),
            "yearly": yearly, "buckets": buckets,
        }
        m = out["models"][k]
        m["edge"] = (m["hit"] - max(m["always_up_same_days"], 1 - m["always_up_same_days"])) if m["hit"] is not None else None
        m["passes_gate"] = bool(m["edge"] is not None and m["edge"] >= 0.05 and m["brier"] < base_brier)
    return out


def to_markdown(rep: dict) -> str:
    L = [f"## 大盤預測模型走查評估({rep['first']} ~ {rep['last']})", "",
         f"- 評估 {rep['days']} 個交易日(5 日標籤重疊,獨立樣本約 {rep['independent_samples']} 個)",
         f"- 實際上漲(5 日 >0.3%)比例 **{rep['up_rate']:.1%}**;一律猜漲 Brier {rep['always_up']['brier']:.3f};"
         f"站上 MA20 猜漲命中 {rep['ma20']['hit']:.1%}", "",
         "| 版本 | 平均機率 | 說漲比例 | 命中率(排除中性) | 同批一律猜漲 | 優勢 | Brier | 過門檻 |",
         "|---|---|---|---|---|---|---|---|"]
    for k, m in rep["models"].items():
        hit = f"{m['hit']:.1%}" if m["hit"] is not None else "—"
        au = f"{m['always_up_same_days']:.1%}" if m["always_up_same_days"] is not None else "—"
        edge = f"{m['edge'] * 100:+.1f}pt" if m["edge"] is not None else "—"
        L.append(f"| {k} | {m['mean_prob']:.3f} | {m['say_up']:.0%} | {hit} | {au} | {edge} | {m['brier']:.3f} | "
                 f"{'✅' if m['passes_gate'] else '❌'} |")
    L += ["", "門檻:命中率比同批日子的「一律猜漲/猜跌」較佳者高 ≥5 個百分點,且 Brier 低於一律猜漲。", "",
          "### 各年度命中率(排除中性)", "", "| 版本 | " + " | ".join(next(iter(rep["models"].values()))["yearly"]) + " |",
          "|---|" + "---|" * len(next(iter(rep["models"].values()))["yearly"])]
    for k, m in rep["models"].items():
        cells = []
        for v in m["yearly"].values():
            cells.append("—" if v["hit"] is None else f"{v['hit']:.0%}(漲 {v['always_up']:.0%})")
        L.append(f"| {k} | " + " | ".join(cells) + " |")
    L += ["", "過去表現不代表未來;本報告只用於決定是否改版,不構成投資建議。"]
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--years", type=int, default=6, help="抓幾年資料(含暖身)")
    ap.add_argument("--eval-years", type=int, default=4, help="評估最後幾年")
    ap.add_argument("--step", type=int, default=1, help="每幾個交易日重訓一次(正式流程是每天)")
    ap.add_argument("--end", default=datetime.now().strftime("%Y-%m-%d"))
    ap.add_argument("--only", nargs="*", help="只跑指定版本(預設全部)")
    ap.add_argument("--out", default="output/model_eval")
    args = ap.parse_args()
    warnings.filterwarnings("ignore")

    df = load_data(args.years, args.end)
    res = walk_forward(df, args.eval_years, args.step, args.only)
    names = [k for k in VARIANTS if k in res.columns]
    rep = score(res, names)
    rep["config"] = vars(args)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    res.to_csv(out / "predictions.csv", index=False)
    md = to_markdown(rep)
    (out / "report.md").write_text(md, encoding="utf-8")
    print(md)
    summary = os.getenv("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(md + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
