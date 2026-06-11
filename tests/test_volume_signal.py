"""Tests for volume_signal module."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest


def _make_price_vol(n: int = 50) -> tuple[pd.Series, pd.Series]:
    """Helper: create simple trending price and volume series."""
    close = pd.Series(100.0 + np.arange(n) * 0.5)
    volume = pd.Series([1_000_000.0] * n)
    return close, volume


class TestVolumeCollapseExit:
    def test_no_collapse_on_normal_volume(self):
        from volume_signal import volume_collapse_exit
        close, volume = _make_price_vol(50)
        signal = volume_collapse_exit(close, volume, window=20, collapse_ratio=0.50)
        assert not signal.any()

    def test_detects_collapse(self):
        from volume_signal import volume_collapse_exit
        close, volume = _make_price_vol(50)
        # Artificially collapse volume in last 3 days
        volume.iloc[-3:] = 10_000.0  # well below 50% of 1M average
        signal = volume_collapse_exit(close, volume, window=20, collapse_ratio=0.50, consecutive_days=2)
        assert signal.iloc[-1] or signal.iloc[-2]

    def test_returns_boolean_series(self):
        from volume_signal import volume_collapse_exit
        close, volume = _make_price_vol(30)
        signal = volume_collapse_exit(close, volume)
        assert signal.dtype == bool
        assert len(signal) == len(close)


class TestDistributionDays:
    def test_no_distribution_on_up_trend(self):
        from volume_signal import distribution_days
        close = pd.Series(100.0 + np.arange(30) * 1.0)  # steadily rising
        volume = pd.Series([1_000_000.0] * 30)
        dist = distribution_days(close, volume)
        # Prices only go up, so no distribution days
        assert (dist == 0).all()

    def test_counts_distribution_days(self):
        from volume_signal import distribution_days
        close = pd.Series([100.0, 99.5, 99.0, 100.0, 98.0] * 6)  # alternating
        volume = pd.Series([800_000.0, 1_200_000.0, 1_300_000.0, 700_000.0, 1_400_000.0] * 6)
        dist = distribution_days(close, volume)
        # Should detect some distribution days
        assert dist.max() > 0


class TestVolumeThrustScore:
    def test_zero_when_no_breakout(self):
        from volume_signal import volume_thrust_score
        close = pd.Series([100.0] * 30)  # flat, never breaks out
        volume = pd.Series([1_000_000.0] * 30)
        score = volume_thrust_score(close, volume, breakout_window=20)
        assert (score == 0.0).all()

    def test_positive_on_breakout(self):
        from volume_signal import volume_thrust_score
        close = pd.Series([100.0] * 25 + [105.0] * 5)  # breaks above 100 in last 5 days
        volume = pd.Series([1_000_000.0] * 25 + [3_000_000.0] * 5)  # 3× volume surge
        score = volume_thrust_score(close, volume)
        # First breakout day (index 25) should score high; later days fall off once
        # 105.0 appears in the rolling max window
        assert score.iloc[25] > 50.0  # 3× volume at first breakout → near 100

    def test_score_range(self):
        from volume_signal import volume_thrust_score
        close, volume = _make_price_vol(40)
        score = volume_thrust_score(close, volume)
        assert (score >= 0.0).all()
        assert (score <= 100.0).all()


class TestAccumulationDistributionRatio:
    def test_returns_float_series(self):
        from volume_signal import accumulation_distribution_ratio
        high = pd.Series([105.0] * 20)
        low = pd.Series([95.0] * 20)
        close = pd.Series([103.0] * 20)  # close near high → accumulation
        volume = pd.Series([1_000_000.0] * 20)
        ad = accumulation_distribution_ratio(high, low, close, volume)
        assert ad.dtype in (float, np.float64)
        assert len(ad) == 20

    def test_accumulation_gt_one_when_close_near_high(self):
        from volume_signal import accumulation_distribution_ratio
        high = pd.Series([105.0] * 15 + [105.0] * 5)
        low = pd.Series([95.0] * 15 + [95.0] * 5)
        # Mix: first 15 days close near high (accumulation), last 5 near low (distribution)
        close = pd.Series([104.0] * 15 + [96.0] * 5)
        volume = pd.Series([1_000_000.0] * 20)
        ad = accumulation_distribution_ratio(high, low, close, volume, window=10)
        # At index 14 (last accumulation day), ratio should be well above 1
        assert ad.iloc[14] >= 1.0


class TestThinFloat:
    def test_thin_when_low_turnover(self):
        from volume_signal import is_thin_float
        assert is_thin_float(volume_ma20=10_000, close=50.0)  # 10K × 50 = 500K < 30M

    def test_liquid_when_high_turnover(self):
        from volume_signal import is_thin_float
        assert not is_thin_float(volume_ma20=2_000_000, close=50.0)  # 100M > 30M
