from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path


class Settings:
    """Application settings loaded from environment variables (and optional .env file).

    Uses plain os.getenv so it works without pydantic-settings installed.
    Drop-in compatible: call get_settings() to get a singleton.
    """

    def __init__(self) -> None:
        self._load_dotenv()

        # FinMind tokens (3 accounts for parallel scanning)
        self.finmind_token: str = os.getenv("FINMIND_TOKEN", "")
        self.finmind_token_2: str = os.getenv("FINMIND_TOKEN_2", "")
        self.finmind_token_3: str = os.getenv("FINMIND_TOKEN_3", "")

        # Notification
        self.discord_webhook_url: str = os.getenv("DISCORD_WEBHOOK_URL", "")

        # Claude AI
        self.anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")

        # Notion
        self.notion_token: str = os.getenv("NOTION_TOKEN", "")
        self.notion_database_id: str = os.getenv("NOTION_DATABASE_ID", "")

        # Fugle
        self.fugle_api_key: str = os.getenv("FUGLE_API_KEY", "")
        self.fugle_bearer_token: str = os.getenv("FUGLE_BEARER_TOKEN", "")

        # Storage
        self.db_path: Path = Path(os.getenv("DB_PATH", "storage/invest.db"))
        self.log_dir: Path = Path(os.getenv("LOG_DIR", "logs"))
        self.cache_dir: Path = Path(os.getenv("CACHE_DIR", ".cache"))

        # Runtime
        self.log_level: str = os.getenv("LOG_LEVEL", "INFO")
        self.max_workers: int = int(os.getenv("MAX_WORKERS", "2"))

    @staticmethod
    def _load_dotenv() -> None:
        env_path = Path(__file__).parent.parent / ".env"
        if not env_path.exists():
            return
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

    def all_finmind_tokens(self) -> list[str]:
        return [t for t in [self.finmind_token, self.finmind_token_2, self.finmind_token_3] if t]

    def active_token(self, seg: int = 0) -> str:
        tokens = self.all_finmind_tokens()
        if not tokens:
            return ""
        return tokens[seg % len(tokens)]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
