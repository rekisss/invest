# main.py
import os
import csv
import requests
from datetime import datetime
from zoneinfo import ZoneInfo


STOCKS_FILE = "stocks.csv"


def send_to_discord(message):
    webhook_url = os.getenv("DISCORD_WEBHOOK_URL")

    if webhook_url is None or webhook_url.strip() == "":
        raise RuntimeError("找不到 DISCORD_WEBHOOK_URL，請確認 GitHub Secrets 已設定")

    payload = {
        "content": message
    }

    response = requests.post(webhook_url, json=payload, timeout=30)

    if response.status_code not in [200, 204]:
        raise RuntimeError("Discord Webhook 發送失敗：" + str(response.status_code) + " " + response.text)


def load_stocks():
    stocks = []

    with open(STOCKS_FILE, mode="r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)

        if reader.fieldnames is None:
            raise RuntimeError("stocks.csv 是空的")

        if "stock_id" not in reader.fieldnames:
            raise RuntimeError("stocks.csv 必須包含 stock_id 欄位")

        for row in reader:
            stock_id = str(row.get("stock_id", "")).strip()
            name = str(row.get("name", "")).strip()

            if stock_id != "":
                stocks.append({
                    "stock_id": stock_id,
                    "name": name
                })

    return stocks


def build_message(stocks):
    now = datetime.now(ZoneInfo("Asia/Taipei")).strftime("%Y-%m-%d %H:%M:%S")

    lines = []
    lines.append("📌 台股清單讀取成功")
    lines.append("🕒 台灣時間：" + now)
    lines.append("📊 股票數量：" + str(len(stocks)) + " 檔")
    lines.append("")

    for stock in stocks:
        line = stock["stock_id"] + " " + stock["name"]
        lines.append(line)

    lines.append("")
    lines.append("✅ 下一階段可以開始接 FinMind 抓日 K 與技術指標。")

    message = "\n".join(lines)
    return message


def main():
    stocks = load_stocks()
    message = build_message(stocks)
    send_to_discord(message)


main()
