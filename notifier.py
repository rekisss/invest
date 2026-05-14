from __future__ import annotations

import os
import random
import time
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


def _post_with_retry(url: str, payload: dict, max_attempts: int = 3) -> None:
    for attempt in range(max_attempts):
        try:
            resp = requests.post(url, json=payload, timeout=30)
            if resp.status_code == 429:
                retry_after = float(resp.json().get("retry_after", 1))
                time.sleep(retry_after)
                continue
            resp.raise_for_status()
            return
        except requests.exceptions.RequestException:
            if attempt == max_attempts - 1:
                raise
            time.sleep(2 ** attempt + random.uniform(0, 0.5))


def send_discord_messages(messages: Iterable[str], webhook_url: str | None = None) -> None:
    url = (webhook_url or os.getenv("DISCORD_WEBHOOK_URL") or "").strip()
    if not url:
        return

    for i, message in enumerate(messages):
        if i > 0:
            time.sleep(0.6)
        _post_with_retry(url, {"content": message})
