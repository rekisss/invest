# main.py
import os
import requests
from datetime import datetime
from zoneinfo import ZoneInfo


def send_to_discord(message: str):
    webhook_url = os.getenv("DISCORD_WEBHOOK_URL")

    if not webhook_url:
        raise RuntimeError("找不到 DISCORD_WEBHOOK_URL，請確認 GitHub Secrets 已設定")

    payload = {
        "content": message
    }

    response = requests.post(webhook_url, json=payload, timeout=30)

    if response.status_code not in (200, 204):
        raise RuntimeError(
            f"Discord Webhook 發送失敗：{response.status_code} {response.text}"
        )


def main():
    now = datetime.now(ZoneInfo("Asia/Taipei")).strftime("%Y-%m-%d %H:%M:%S")

    message = (
        "✅ GitHub Actions 測試成功！\n"
        f"🕒 台灣時間：{now}\n"
        "📌 GitHub Actions → Python → Discord Webhook 已正常連線"
    )

    send_to_discord(message)


main()
