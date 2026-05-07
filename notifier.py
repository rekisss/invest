from __future__ import annotations

import os
from typing import Iterable

import requests


def split_message(message: str, max_length: int = 1800) -> list[str]:
    parts: list[str] = []
    current = ""
    for line in message.splitlines():
        candidate = line if not current else f"{current}\n{line}"
        if len(candidate) > max_length:
            if current:
                parts.append(current)
            current = line
        else:
            current = candidate
    if current:
        parts.append(current)
    return parts


def send_discord_messages(messages: Iterable[str], webhook_url: str | None = None) -> None:
    url = (webhook_url or os.getenv("DISCORD_WEBHOOK_URL") or "").strip()
    if not url:
        return

    for message in messages:
        response = requests.post(url, json={"content": message}, timeout=30)
        response.raise_for_status()
