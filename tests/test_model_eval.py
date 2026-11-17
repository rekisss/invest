"""model_eval.py 的單元測試:標籤不偷看未來、舊 bug 重現正確、過門檻判定。"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

me = pytest.importorskip("model_eval")


def test_labels_never_peek_into_the_future():
    close = np.array([100, 101, 102, 103, 104, 105, 106, 107, 99, 98], dtype=float)
    y = me.make_labels(close, t=8, legacy=False)
    assert len(y) == 9
    # 第 i 筆需要 close[i+5],站在 t=8 只有 i<=3 已知
    assert np.isnan(y[4:]).all()
    assert y[:4].tolist() == [1.0, 1.0, 1.0, 0.0]   # close[8]=99 < 103*1.003


def test_legacy_labels_reproduce_old_bug():
    close = np.linspace(100, 120, 12)                # 一路上漲
    y = me.make_labels(close, t=11, legacy=True)
    assert y[-5:].tolist() == [0.0] * 5              # 舊寫法把未知的最後 5 筆標成「沒漲」
    assert (y[:-5] == 1.0).all()


def _res(p, ret):
    n = len(p)
    return pd.DataFrame({"date": pd.bdate_range("2025-01-01", periods=n).strftime("%Y-%m-%d"),
                         "ret5": ret, "ma20_up": np.ones(n), "M": p})


def test_gate_requires_edge_over_naive_and_better_brier():
    ret = np.array([0.01, -0.01] * 50)               # 一半漲一半跌
    perfect = np.where(ret > 0, 0.9, 0.1)
    rep = me.score(_res(perfect, ret), ["M"])
    assert rep["models"]["M"]["hit"] == 1.0 and rep["models"]["M"]["passes_gate"]
    always_bull = np.full(100, 0.7)                  # 跟一律猜漲一樣 → 沒有優勢
    rep = me.score(_res(always_bull, ret), ["M"])
    assert not rep["models"]["M"]["passes_gate"]
    assert abs(rep["models"]["M"]["edge"]) < 1e-9


def test_neutral_predictions_are_not_counted():
    ret = np.array([0.01] * 10)
    rep = me.score(_res(np.full(10, 0.52), ret), ["M"])
    assert rep["models"]["M"]["n_directional"] == 0 and rep["models"]["M"]["hit"] is None
