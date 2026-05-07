# main.py
import os
import csv
import requests
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


STOCKS_FILE = "stocks.csv"
FINMIND_API_URL = "https://api.finmindtrade.com/api/v3/data"


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


def fetch_stock_price(stock_id):
    end_date = datetime.now(ZoneInfo("Asia/Taipei")).date()
    start_date = end_date - timedelta(days=60)

    params = {
        "dataset": "TaiwanStockPrice",
        "stock_id": stock_id,
        "date": start_date.strftime("%Y-%m-%d"),
        "end_date": end_date.strftime("%Y-%m-%d")
    }

    finmind_user_id = os.getenv("FINMIND_USER_ID")
    finmind_password = os.getenv("FINMIND_PASSWORD")

    if finmind_user_id is not None and finmind_user_id.strip() != "":
        params["user_id"] = finmind_user_id

    if finmind_password is not None and finmind_password.strip() != "":
        params["password"] = finmind_password

    response = requests.get(FINMIND_API_URL, params=params, timeout=60)

    if response.status_code != 200:
        raise RuntimeError("FinMind API 錯誤：" + str(response.status_code) + " " + response.text)

    data = response.json()

    if "data" not in data:
        raise RuntimeError("FinMind 回傳格式異常：" + str(data))

    rows = data["data"]

    if len(rows) == 0:
        return None

    rows = sorted(rows, key=lambda x: x.get("date", ""))

    return rows


def to_float(value):
    try:
        return float(value)
    except Exception:
        return None


def to_int(value):
    try:
        return int(float(value))
    except Exception:
        return None


def format_number(value):
    if value is None:
        return "N/A"

    return "{:,}".format(value)


def analyze_stock(stock):
    stock_id = stock["stock_id"]
    name = stock["name"]

    rows = fetch_stock_price(stock_id)

    if rows is None:
        return {
            "stock_id": stock_id,
            "name": name,
            "status": "NO_DATA"
        }

    latest = rows[-1]

    latest_date = latest.get("date", "")
    close_price = to_float(latest.get("close"))
    open_price = to_float(latest.get("open"))
    high_price = to_float(latest.get("max"))
    low_price = to_float(latest.get("min"))
    volume = to_int(latest.get("Trading_Volume"))
    trading_money = to_int(latest.get("Trading_money"))

    return_5d = None

    if len(rows) >= 6:
        previous_row = rows[-6]
        previous_close = to_float(previous_row.get("close"))

        if previous_close is not None and previous_close != 0 and close_price is not None:
            return_5d = ((close_price / previous_close) - 1) * 100

    return {
        "stock_id": stock_id,
        "name": name,
        "status": "OK",
        "date": latest_date,
        "open": open_price,
        "high": high_price,
        "low": low_price,
        "close": close_price,
        "volume": volume,
        "trading_money": trading_money,
        "return_5d": return_5d
    }


def build_message(results):
    now = datetime.now(ZoneInfo("Asia/Taipei")).strftime("%Y-%m-%d %H:%M:%S")

    lines = []
    lines.append("📈 台股日 K 資料回報")
    lines.append("🕒 台灣時間：" + now)
    lines.append("📊 股票數量：" + str(len(results)) + " 檔")
    lines.append("")

    for item in results:
        stock_id = item["stock_id"]
        name = item["name"]

        if item["status"] != "OK":
            lines.append("⚠️ " + stock_id + " " + name + "：查無資料")
            lines.append("")
            continue

        close_text = "N/A"
        if item["close"] is not None:
            close_text = str(item["close"])

        return_5d_text = "N/A"
        if item["return_5d"] is not None:
            return_5d_text = str(round(item["return_5d"], 2)) + "%"

        volume_text = format_number(item["volume"])
        money_text = format_number(item["trading_money"])

        lines.append(stock_id + " " + name)
        lines.append("日期：" + str(item["date"]))
        lines.append("收盤：" + close_text)
        lines.append("5日漲跌：" + return_5d_text)
        lines.append("成交量：" + volume_text)
        lines.append("成交金額：" + money_text)
        lines.append("")

    lines.append("備註：此為公開資料整理，不構成投資建議。")

    return "\n".join(lines)


def split_message(message, max_length):
    parts = []
    current = ""

    lines = message.split("\n")

    for line in lines:
        if len(current) + len(line) + 1 > max_length:
            parts.append(current)
            current = line
        else:
            if current == "":
                current = line
            else:
                current = current + "\n" + line

    if current != "":
        parts.append(current)

    return parts


def main():
    stocks = load_stocks()

    results = []

    for stock in stocks:
        try:
            result = analyze_stock(stock)
            results.append(result)
        except Exception as error:
            results.append({
                "stock_id": stock["stock_id"],
                "name": stock["name"],
                "status": "ERROR",
                "error": str(error)
            })

    message = build_message(results)

    messages = split_message(message, 1800)

    for msg in messages:
        send_to_discord(msg)


main()
