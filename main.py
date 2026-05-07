# main.py
import os
import requests
import pandas as pd
from datetime import datetime
from zoneinfo import ZoneInfo


STOCKS_FILE = "stocks.csv"


def send_to_discord(message: str):
    webhook_url = os.getenv("DISCORD_WEBHOOK_URL")

    if not webhook_url:
        raise RuntimeError("找不到 DISCORD_WEBHOOK_URL，請確認 GitHub Secrets 已設定")

    payload = {"content": message}

    response = requests.post(webhook_url, json=payload, timeout=30)

    if response.status_code not in (200, 204):
        raise RuntimeError(
            f"Discord Webhook 發送失敗：{response.status_code} {response.text}"
        )


def load_stocks():
    df = pd.read_csv(STOCKS_FILE, dtype={"stock_id": str})

    if "stock_id" not in df.columns:
        raise RuntimeError("stocks.csv 必須包含 stock_id 欄位")

    if "name" not in df.columns:
        df["name"] = ""

    df["stock_id"] = df["stock_id"].astype(str).str.strip()
    df["name"] = df["name"].astype(str).str.strip()

    df = df[df["stock_id"] != ""].copy()
    df = df.drop_duplicates(subset=["stock_id"]).reset_index(drop=True)

    return df


def build_stock_list_message(df: pd.DataFrame):
    now = datetime.now(ZoneInfo("Asia/Taipei")).strftime("%Y-%m-%d %H:%M:%S")

    stock_lines = []
    for _, row in df.iterrows():
        stock_id = row["stock_id"]
        name = row["name"]
        stock_lines.append(f"{stock_id} {name}")

    stock_text = "\n".join(stock_lines)

    message = (
        "📌 台股清單讀取成功\n"
        f"🕒 台灣時間：{now}\n"
        f"📊 股票數量：{len(df)} 檔\n"
        "\n"
        "
