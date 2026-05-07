# main.py
import os
import requests
from datetime import datetime


def send_to_discord(message: str):
    webhook_url = os.getenv("DISCORD_WEBHOOK_URL")
    if not webhook_url:
        raise RuntimeError("❌ 找不到 DISCORD_WEBHOOK_URL，請確認已在 GitHub Secrets 設定")

    payload = {
        "content": message
    }

    r = requests.post(webhook_url, json=payload, timeout=30)
    if r.status_code not in (200, 204):
        raise RuntimeError(f"❌ Discord Webhook 發送失敗：{r.status_code} {r.text}")


def main():
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
    message = (
        "✅ GitHub Actions 測試成功！\n"
        f"🕒 執行時間：{now}\n"
        "📌 這代表 GitHub → Actions → Python → Discord Webhook 全部正常"
    )
    send_to_discord(message)


if name == "main":
    main()
