"""美股特徵快照列的回歸測試(2026-07-21 診斷的 31/33 天缺失根因)。

fetch_us_features 的各 ticker 最後交易日不同:匯率/美債期貨有週日夜盤,
concat 後最後一列常是「只有 FX 欄有值、股指/VIX 全 NaN」的日期。
main.py 組 market_data 時若直接 us_df.iloc[-1],nasdaq/sox/vix 會整批變
null → 劇本分析拿到 VIX=nan、Discord 美股區全 N/A、分歧警告失效。

修法是 us_df.ffill().iloc[-1]:每欄各自帶到最新有效值。這裡用與實際
輸出同構的 DataFrame 釘住這個語意,防止日後回退成 iloc[-1]。
"""
from __future__ import annotations

import math

import pandas as pd


def _make_us_df() -> pd.DataFrame:
    # 與 fetch_us_features 輸出同構:date + *_ret1 + vix;
    # 最後一列(07-21)只有 dxy 有值 — 股指/VIX 的最新有效值在 07-20。
    return pd.DataFrame(
        {
            "date": pd.to_datetime(["2026-07-18", "2026-07-20", "2026-07-21"]),
            "nasdaq_ret1": [0.004, -0.012, float("nan")],
            "sox_ret1": [0.008, -0.021, float("nan")],
            "vix": [17.2, 19.4, float("nan")],
            "dxy_ret1": [0.001, -0.002, 0.003],
        }
    )


class TestUsRowSnapshot:
    def test_naive_last_row_loses_equity_features(self):
        """未修復的取法:iloc[-1] 讓股指/VIX 變 NaN(重現 bug)。"""
        us_df = _make_us_df()
        row = us_df.iloc[-1]
        assert math.isnan(row["nasdaq_ret1"])
        assert math.isnan(row["vix"])

    def test_ffill_last_row_keeps_latest_valid_per_column(self):
        """修復後的取法:ffill().iloc[-1] 每欄各自取最新有效值。"""
        us_df = _make_us_df()
        row = us_df.ffill().iloc[-1]
        assert row["nasdaq_ret1"] == -0.012   # 07-20 的隔夜報酬
        assert row["sox_ret1"] == -0.021
        assert row["vix"] == 19.4
        assert row["dxy_ret1"] == 0.003       # FX 本來就有今日值,不受影響

    def test_main_uses_ffill_snapshot(self):
        """main.py 的組裝點必須維持 ffill 寫法(文字層防回退)。"""
        source = open("main.py", encoding="utf-8").read()
        assert "us_df.ffill().iloc[-1]" in source
        assert "\n    _us_row = us_df.iloc[-1]" not in source
