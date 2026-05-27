from __future__ import annotations

import sys
from pathlib import Path


def setup_logging(log_dir: Path | str = "logs", level: str = "INFO") -> None:
    """Configure loguru with file + stderr sinks. Safe to call multiple times."""
    try:
        from loguru import logger

        log_dir = Path(log_dir)
        log_dir.mkdir(parents=True, exist_ok=True)

        logger.remove()
        logger.add(
            sys.stderr,
            level=level,
            format="<green>{time:HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{line}</cyan> — {message}",
        )
        logger.add(
            log_dir / "app.log",
            rotation="50 MB",
            retention="7 days",
            level="DEBUG",
            format="{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {name}:{line} | {message}",
            encoding="utf-8",
        )
    except ImportError:
        # loguru not installed — fall back to stdlib
        import logging
        logging.basicConfig(
            level=getattr(logging, level, logging.INFO),
            format="%(asctime)s | %(levelname)-8s | %(name)s:%(lineno)d | %(message)s",
        )


def get_logger(name: str = "invest"):
    """Return a loguru logger (falls back to stdlib if loguru not available)."""
    try:
        from loguru import logger
        return logger.bind(name=name)
    except ImportError:
        import logging
        return logging.getLogger(name)
