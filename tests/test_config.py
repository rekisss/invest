import pytest
import config
from config import settings, get_finmind_tokens, active_tokens, has_discord, has_anthropic


class TestSettings:
    def test_default_log_level(self):
        assert settings.log_level in ("INFO", "DEBUG", "WARNING", "ERROR")

    def test_default_max_workers(self):
        assert settings.max_workers >= 1

    def test_returns_settings_object(self):
        assert settings is not None


class TestHelperFunctions:
    def test_get_finmind_tokens_returns_list(self):
        result = get_finmind_tokens()
        assert isinstance(result, list)

    def test_active_tokens_alias(self):
        assert active_tokens() == get_finmind_tokens()

    def test_has_discord_false_when_empty(self, monkeypatch):
        monkeypatch.setattr(config.settings, "discord_webhook_url", "")
        assert has_discord() is False

    def test_has_anthropic_false_when_empty(self, monkeypatch):
        monkeypatch.setattr(config.settings, "anthropic_api_key", "")
        assert has_anthropic() is False
