"""MarketPredictor 訓練標籤的回歸測試(2026-11)。

舊寫法 `(close.shift(-h) > close * 1.003).astype(float)` 會把最後 h 筆「未來未知」
的 NaN 比較成 False → 0,dropna 也丟不掉。正式流程 fit 與 predict_proba 用同一份
market_df,所以「正要預測的那一列」在訓練時就被標成「沒漲」→ 系統性偏空。
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

mp = pytest.importorskip("market_predictor")
pytest.importorskip("xgboost")


def _taiex(n: int, drift: float = 0.0, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    close = 18000 * np.exp(np.cumsum(rng.standard_normal(n) * 0.01 + drift))
    return pd.DataFrame({"date": pd.bdate_range("2024-01-01", periods=n), "close": close})


class _Spy:
    """記錄每次 fit 收到的 y。"""
    calls: list[np.ndarray] = []


@pytest.fixture
def spy_xgb(monkeypatch):
    real = mp.XGBClassifier
    _Spy.calls = []

    class Recording(real):
        def fit(self, X, y, *a, **kw):
            _Spy.calls.append(np.asarray(y))
            return super().fit(X, y, *a, **kw)

    monkeypatch.setattr(mp, "XGBClassifier", Recording)
    return _Spy


def test_last_horizon_rows_are_not_trained_as_down(spy_xgb):
    df = _taiex(90)                      # < 100 筆 → 不走校準,直接 fit 一次
    p = mp.MarketPredictor(horizon=5).fit(df)
    assert p._trained
    y = spy_xgb.calls[-1]
    assert len(y) == len(df) - 5, "最後 5 筆的未來收盤未知,不能放進訓練集"
    assert not np.isnan(y).any()


def test_labels_match_definition(spy_xgb):
    df = _taiex(90, seed=3)
    mp.MarketPredictor(horizon=5).fit(df)
    y = spy_xgb.calls[-1]
    c = df["close"].values
    expected = (c[5:] > c[:-5] * 1.003).astype(float)
    assert np.array_equal(y, expected)


def test_steady_uptrend_is_not_predicted_bearish():
    """穩定上漲(每天都在漲)的盤勢:舊版會把最新幾筆當成跌 → 預測偏空。

    加一小段下跌讓兩類都存在(否則無法訓練),最新狀態是持續上漲。
    """
    n = 95
    rng = np.random.default_rng(1)
    r = np.full(n, 0.004) + rng.standard_normal(n) * 0.001
    r[20:35] = -0.006                    # 中段下跌,提供「沒漲」的樣本
    df = pd.DataFrame({"date": pd.bdate_range("2024-01-01", periods=n),
                       "close": 18000 * np.exp(np.cumsum(r))})
    p = mp.MarketPredictor(horizon=5).fit(df)
    out = p.predict_proba(df)
    assert out["trained"]
    assert out["prob_up"] > 0.5, f"持續上漲卻預測偏空:{out['prob_up']:.3f}"
