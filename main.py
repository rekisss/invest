# main.py
import os
import csv
import math
import requests
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


STOCKS_FILE = "stocks.csv"
FINMIND_API_URL = "https://api.finmindtrade.com/api/v3/data"


def send_to_discord(message):
    webhook_url = os.getenv("DISCORD_WEBHOOK_URL")

    if webhook_url is None or webhook_url.strip() == "":
        raise RuntimeError("找不到 DISCORD_WEBHOOK_URL，請確認 GitHub Secrets 已設定")

    payload = {"content": message}
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
                stocks.append({"stock_id": stock_id, "name": name})

    return stocks


def fetch_stock_price(stock_id):
    end_date = datetime.now(ZoneInfo("Asia/Taipei")).date()
    start_date = end_date - timedelta(days=260)

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
        return []

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


def ema(values, period):
    result = []

    if len(values) == 0:
        return result

    alpha = 2 / (period + 1)
    prev = None

    for value in values:
        if value is None:
            result.append(prev)
            continue

        if prev is None:
            prev = value
        else:
            prev = alpha * value + (1 - alpha) * prev

        result.append(prev)

    return result


def sma(values, period):
    result = []

    for i in range(len(values)):
        if i + 1 < period:
            result.append(None)
            continue

        window = values[i + 1 - period:i + 1]

        if any(v is None for v in window):
            result.append(None)
        else:
            result.append(sum(window) / period)

    return result


def calc_macd(closes):
    ema12 = ema(closes, 12)
    ema26 = ema(closes, 26)

    macd_line = []
    for i in range(len(closes)):
        if ema12[i] is None or ema26[i] is None:
            macd_line.append(None)
        else:
            macd_line.append(ema12[i] - ema26[i])

    signal_line = ema(macd_line, 9)

    hist = []
    for i in range(len(closes)):
        if macd_line[i] is None or signal_line[i] is None:
            hist.append(None)
        else:
            hist.append(macd_line[i] - signal_line[i])

    return macd_line, signal_line, hist


def calc_rsi(closes, period):
    result = []

    gains = []
    losses = []

    for i in range(len(closes)):
        if i == 0:
            gains.append(0)
            losses.append(0)
            result.append(None)
            continue

        change = closes[i] - closes[i - 1]

        if change > 0:
            gains.append(change)
            losses.append(0)
        else:
            gains.append(0)
            losses.append(abs(change))

        if i < period:
            result.append(None)
            continue

        avg_gain = sum(gains[i + 1 - period:i + 1]) / period
        avg_loss = sum(losses[i + 1 - period:i + 1]) / period

        if avg_loss == 0:
            result.append(100)
        else:
            rs = avg_gain / avg_loss
            rsi = 100 - (100 / (1 + rs))
            result.append(rsi)

    return result


def calc_adx(highs, lows, closes, period):
    trs = []
    plus_dm = []
    minus_dm = []

    for i in range(len(closes)):
        if i == 0:
            trs.append(None)
            plus_dm.append(0)
            minus_dm.append(0)
            continue

        high = highs[i]
        low = lows[i]
        prev_close = closes[i - 1]
        prev_high = highs[i - 1]
        prev_low = lows[i - 1]

        tr = max(
            high - low,
            abs(high - prev_close),
            abs(low - prev_close)
        )
        trs.append(tr)

        up_move = high - prev_high
        down_move = prev_low - low

        if up_move > down_move and up_move > 0:
            plus_dm.append(up_move)
        else:
            plus_dm.append(0)

        if down_move > up_move and down_move > 0:
            minus_dm.append(down_move)
        else:
            minus_dm.append(0)

    adx_values = []

    for i in range(len(closes)):
        if i < period:
            adx_values.append(None)
            continue

        tr_window = trs[i + 1 - period:i + 1]
        plus_window = plus_dm[i + 1 - period:i + 1]
        minus_window = minus_dm[i + 1 - period:i + 1]

        if any(v is None for v in tr_window):
            adx_values.append(None)
            continue

        atr = sum(tr_window) / period

        if atr == 0:
            adx_values.append(None)
            continue

        plus_di = 100 * (sum(plus_window) / period) / atr
        minus_di = 100 * (sum(minus_window) / period) / atr

        if plus_di + minus_di == 0:
            adx_values.append(None)
        else:
            dx = 100 * abs(plus_di - minus_di) / (plus_di + minus_di)
            adx_values.append(dx)

    adx_smoothed = sma(adx_values, period)
    return adx_smoothed


def round_text(value, digits):
    if value is None:
        return "N/A"
    return str(round(value, digits))


def money_text(value):
    if value is None:
        return "N/A"
    return "{:,}".format(value)


def analyze_stock(stock):
    stock_id = stock["stock_id"]
    name = stock["name"]

    rows = fetch_stock_price(stock_id)

    if len(rows) < 130:
        return {
            "stock_id": stock_id,
            "name": name,
            "status": "NO_ENOUGH_DATA"
        }

    dates = []
    opens = []
    highs = []
    lows = []
    closes = []
    volumes = []
    amounts = []

    for row in rows:
        dates.append(row.get("date", ""))
        opens.append(to_float(row.get("open")))
        highs.append(to_float(row.get("max")))
        lows.append(to_float(row.get("min")))
        closes.append(to_float(row.get("close")))
        volumes.append(to_int(row.get("Trading_Volume")))
        amounts.append(to_int(row.get("Trading_money")))

    ema20 = ema(closes, 20)
    ema60 = ema(closes, 60)
    ema120 = ema(closes, 120)
    macd_line, signal_line, hist = calc_macd(closes)
    rsi14 = calc_rsi(closes, 14)
    adx14 = calc_adx(highs, lows, closes, 14)
    vol_ma20 = sma(volumes, 20)
    amount_ma20 = sma(amounts, 20)

    i = len(rows) - 1
    p = len(rows) - 2

    latest_close = closes[i]
    prev_close = closes[p]
    day_return = None

    if prev_close is not None and prev_close != 0 and latest_close is not None:
        day_return = ((latest_close / prev_close) - 1) * 100

    return_5d = None
    if len(rows) >= 6:
        close_5d_ago = closes[i - 5]
        if close_5d_ago is not None and close_5d_ago != 0:
            return_5d = ((latest_close / close_5d_ago) - 1) * 100

    prev20_high = None
    if len(closes) >= 21:
        prev20_high = max(closes[i - 20:i])

    macd_golden_cross = False
    hist_turn_positive = False

    if macd_line[p] is not None and signal_line[p] is not None and macd_line[i] is not None and signal_line[i] is not None:
        macd_golden_cross = macd_line[p] <= signal_line[p] and macd_line[i] > signal_line[i]

    if hist[p] is not None and hist[i] is not None:
        hist_turn_positive = hist[p] <= 0 and hist[i] > 0

    above_ema60 = latest_close is not None and ema60[i] is not None and latest_close > ema60[i]
    ema60_gt_ema120 = ema60[i] is not None and ema120[i] is not None and ema60[i] > ema120[i]

    volume_break = False
    if volumes[i] is not None and vol_ma20[i] is not None:
        volume_break = volumes[i] > vol_ma20[i] * 1.5

    rsi_strong = rsi14[i] is not None and rsi14[i] > 55
    adx_trending = adx14[i] is not None and adx14[i] > 20

    breakout_20d = False
    if prev20_high is not None and latest_close is not None:
        breakout_20d = latest_close > prev20_high

    avoid_chase = True
    if day_return is not None and day_return > 7:
        avoid_chase = False

    liquidity_ok = False
    if amount_ma20[i] is not None:
        liquidity_ok = amount_ma20[i] >= 50000000

    long_upper_shadow = False
    body = abs(closes[i] - opens[i])
    upper_shadow = highs[i] - max(opens[i], closes[i])
    if body > 0 and upper_shadow > body * 2:
        long_upper_shadow = True

    conditions = [
        macd_golden_cross,
        hist_turn_positive,
        above_ema60,
        ema60_gt_ema120,
        volume_break,
        rsi_strong,
        adx_trending,
        breakout_20d,
        avoid_chase,
        liquidity_ok
    ]

    condition_count = 0
    for c in conditions:
        if c:
            condition_count += 1

    return {
        "stock_id": stock_id,
        "name": name,
        "status": "OK",
        "date": dates[i],
        "close": latest_close,
        "day_return": day_return,
        "return_5d": return_5d,
        "volume": volumes[i],
        "amount": amounts[i],
        "ema20": ema20[i],
        "ema60": ema60[i],
        "ema120": ema120[i],
        "macd": macd_line[i],
        "signal": signal_line[i],
        "hist": hist[i],
        "rsi14": rsi14[i],
        "adx14": adx14[i],
        "amount_ma20": amount_ma20[i],
        "condition_count": condition_count,
        "macd_golden_cross": macd_golden_cross,
        "hist_turn_positive": hist_turn_positive,
        "above_ema60": above_ema60,
        "ema60_gt_ema120": ema60_gt_ema120,
        "volume_break": volume_break,
        "rsi_strong": rsi_strong,
        "adx_trending": adx_trending,
        "breakout_20d": breakout_20d,
        "avoid_chase": avoid_chase,
        "liquidity_ok": liquidity_ok,
        "long_upper_shadow": long_upper_shadow
    }


def bool_text(value):
    if value:
        return "Y"
    return "N"


def build_message(results):
    now = datetime.now(ZoneInfo("Asia/Taipei")).strftime("%Y-%m-%d %H:%M:%S")

    lines = []
    lines.append("📊 台股技術條件觀察回報")
    lines.append("🕒 台灣時間：" + now)
    lines.append("📌 說明：這是研究觀察資料，不是買賣建議。")
    lines.append("")

    for item in results:
        stock_id = item["stock_id"]
        name = item["name"]

        if item["status"] != "OK":
            lines.append("⚠️ " + stock_id + " " + name + "：資料不足或查無資料")
            lines.append("")
            continue

        lines.append(stock_id + " " + name)
        lines.append("日期：" + str(item["date"]))
        lines.append("收盤：" + round_text(item["close"], 2))
        lines.append("單日漲跌：" + round_text(item["day_return"], 2) + "%")
        lines.append("5日漲跌：" + round_text(item["return_5d"], 2) + "%")
        lines.append("RSI14：" + round_text(item["rsi14"], 2))
        lines.append("ADX14：" + round_text(item["adx14"], 2))
        lines.append("MACD Hist：" + round_text(item["hist"], 4))
        lines.append("20日均成交金額：" + money_text(item["amount_ma20"]))
        lines.append("條件觀察數：" + str(item["condition_count"]) + " / 10")
        lines.append("MACD黃金交叉：" + bool_text(item["macd_golden_cross"]))
        lines.append("Hist轉正：" + bool_text(item["hist_turn_positive"]))
        lines.append("站上EMA60：" + bool_text(item["above_ema60"]))
        lines.append("EMA60>EMA120：" + bool_text(item["ema60_gt_ema120"]))
        lines.append("量大於20均量1.5倍：" + bool_text(item["volume_break"]))
        lines.append("突破近20日高點：" + bool_text(item["breakout_20d"]))
        lines.append("避免追高條件：" + bool_text(item["avoid_chase"]))
        lines.append("流動性條件：" + bool_text(item["liquidity_ok"]))
        lines.append("長上影風險：" + bool_text(item["long_upper_shadow"]))
        lines.append("")

    message = "\n".join(lines)
    return message


def split_message(message, max_length):
    parts = []
    current = ""

    for line in message.split("\n"):
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
