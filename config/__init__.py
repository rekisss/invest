from __future__ import annotations

import os

from .settings import Settings, get_settings

# Singleton instance — import with `from config import settings`
_base = get_settings()


class _ExtendedSettings:
    """Wraps Settings and adds extra fields required by config.py consumers."""

    def __init__(self, base: Settings) -> None:
        self._base = base

    def __getattr__(self, name: str):
        return getattr(self._base, name)

    def __setattr__(self, name: str, value) -> None:
        if name.startswith("_"):
            object.__setattr__(self, name, value)
        else:
            # Allow monkeypatching (e.g. in tests)
            object.__setattr__(self, name, value)

    # Extra fields with defaults
    @property
    def output_dir(self) -> str:
        return os.getenv("OUTPUT_DIR", "output")

    @property
    def scan_dir(self) -> str:
        return os.getenv("SCAN_DIR", "output/full_scan")

    @property
    def models_dir(self) -> str:
        return os.getenv("MODELS_DIR", "models")

    @property
    def default_portfolio_value(self) -> float:
        return float(os.getenv("DEFAULT_PORTFOLIO_VALUE", "1000000.0"))

    @property
    def default_top_n(self) -> int:
        return int(os.getenv("DEFAULT_TOP_N", "20"))

    @property
    def base_risk_pct(self) -> float:
        return float(os.getenv("BASE_RISK_PCT", "0.01"))

    @property
    def discord_webhook_url_2(self) -> str:
        return os.getenv("DISCORD_WEBHOOK_URL_2", "")

    def all_finmind_tokens(self) -> list:
        return self._base.all_finmind_tokens()


settings = _ExtendedSettings(_base)


def get_finmind_tokens() -> list:
    """Return list of non-empty FinMind token strings."""
    return [
        t for t in [
            settings.finmind_token,
            settings.finmind_token_2,
            settings.finmind_token_3,
        ]
        if t
    ]


def active_tokens() -> list:
    """Alias for get_finmind_tokens()."""
    return get_finmind_tokens()


def has_discord() -> bool:
    """Return True if the primary Discord webhook URL is configured."""
    return bool(settings.discord_webhook_url)


def has_anthropic() -> bool:
    """Return True if the Anthropic API key is configured."""
    return bool(settings.anthropic_api_key)


__all__ = [
    "Settings",
    "get_settings",
    "settings",
    "get_finmind_tokens",
    "active_tokens",
    "has_discord",
    "has_anthropic",
]
