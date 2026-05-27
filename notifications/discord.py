"""Discord notification module — re-exports from notifier.py with added logging."""
from __future__ import annotations

from notifier import send_discord_messages as _send, split_message


def send_discord_messages(
    webhook_url: str,
    messages: list[str],
    *,
    username: str = "投資機器人",
    log: bool = True,
) -> None:
    """Send Discord messages with optional logging of total characters sent."""
    if log:
        try:
            from loguru import logger
            total_chars = sum(len(m) for m in messages)
            logger.debug(f"Discord: sending {len(messages)} message(s), {total_chars} chars total")
        except ImportError:
            pass
    _send(webhook_url, messages)


__all__ = ["send_discord_messages", "split_message"]
