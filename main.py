# main.py
import os
import csv
import requests
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter


STOCKS_FILE = "stocks.csv"
FINMIND_API_URL = "https://api.finmindtrade.com/api/v3/data"
OUTPUT_DIR = "output"
EXCEL_FILE = OUTPUT_DIR + "/report.xlsx"


def send_to_discord(message):
    webhook_url = os.getenv("DISCORD_WEBHOOK_URL")
    if webhook_url is None or webhook_url.strip() == "":
        raise RuntimeError("找不到 DISCORD_WEBHOOK_URL，請確認 GitHub Secrets 已設定")

    response = requests.post(webhook_url, json={"content": message}, timeout=30)
    if response.status_code not in [200, 204]:
        raise RuntimeError("Discord Webhook 發送失敗：" + str(response.status_code) + " " + response.text)


def taipei_now():
    return datetime.now(ZoneInfo("Asia/Taipei"))


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


def round_value(value, digits):
    if value is None:
        return None
    return round(value, digits)


def round_text(value, digits):
    if value is None:
        return "N/A"
    return str(round(value, digits))


def bool_text(value):
    if value:
        return "Y"
    return "N"


def make_output_dir():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)


def split_message(message, max_length=1800):
    parts = []
    current = ""

    for line in message.split("\n"):
        if len(current) + len(line) + 1 > max_length:
            if current != "":
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


def finmind_params_base():
    params = {}

    user_id = os.getenv("FINMIND_USER_ID")
    password = os.getenv("FINMIND_PASSWORD")

    if user_id is not None and user_id.strip() != "":
        params["user_id"] = user_id

    if password is not None and password.strip() != "":
        params["password"] = password

    return params


def fetch_finmind(params):
    response = requests.get(FINMIND_API_URL, params=params, timeout=90)

    if response.status_code != 200:
        raise RuntimeError("FinMind API 錯誤：" + str(response.status_code) + " " + response.text)

    data = response.json()

    if "data" not in data:
        raise RuntimeError("FinMind 回傳格式異常：" + str(data))

    return data["data"]


def fetch_stock_price(stock_id):
    end_date = taipei_now().date()
    start_date = end_date - timedelta(days=360)

    params = finmind_params_base()
    params["dataset"] = "TaiwanStockPrice"
    params["stock_id"] = stock_id
    params["date"] = start_date.strftime("%Y-%m-%d")
    params["end_date"] = end_date.strftime("%Y-%m-%d")

    rows = fetch_finmind(params)
    rows = sorted(rows, key=lambda x: x.get("date", ""))

    return rows


def fetch_foreign_investors(stock_id):
    end_date = taipei_now().date()
    start_date = end_date - timedelta(days=45)

    params = finmind_params_base()
    params["dataset"] = "TaiwanStockInstitutionalInvestorsBuySell"
    params["stock_id"] = stock_id
    params["date"] = start_date.strftime("%Y-%m-%d")
    params["end_date"] = end_date.strftime("%Y-%m-%d")

    rows = fetch_finmind(params)
    rows = sorted(rows, key=lambda x: x.get("date", ""))

    return rows


def fetch_market_taiex():
    end_date = taipei_now().date()
    start_date = end_date - timedelta(days=150)

    daily_map = {}
    chunk_start = start_date

    while chunk_start <= end_date:
        chunk_end = chunk_start + timedelta(days=20)

        if chunk_end > end_date:
            chunk_end = end_date

        params = finmind_params_base()
        params["dataset"] = "TaiwanVariousIndicators5Seconds"
        params["date"] = chunk_start.strftime("%Y-%m-%d")
        params["end_date"] = chunk_end.strftime("%Y-%m-%d")

        try:
            rows = fetch_finmind(params)
        except Exception:
            rows = []

        for row in rows:
            dt_text = str(row.get("date", ""))
            taiex = to_float(row.get("TAIEX"))

            if dt_text != "" and taiex is not None:
                day = dt_text[:10]
                daily_map[day] = {
                    "date": day,
                    "close": taiex
                }

        chunk_start = chunk_end + timedelta(days=1)

    daily_rows = []

    for day in sorted(daily_map.keys()):
        daily_rows.append(daily_map[day])

    return daily_rows


def ema(values, period):
    result = []
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


def calc_rsi(closes, period=14):
    result = []
    gains = []
    losses = []

    for i in range(len(closes)):
        if i == 0 or closes[i] is None or closes[i - 1] is None:
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
            result.append(100 - (100 / (1 + rs)))

    return result


def calc_adx(highs, lows, closes, period=14):
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

        if high is None or low is None or prev_close is None or prev_high is None or prev_low is None:
            trs.append(None)
            plus_dm.append(0)
            minus_dm.append(0)
            continue

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

    dx_values = []

    for i in range(len(closes)):
        if i < period:
            dx_values.append(None)
            continue

        tr_window = trs[i + 1 - period:i + 1]

        if any(v is None for v in tr_window):
            dx_values.append(None)
            continue

        atr = sum(tr_window) / period

        if atr == 0:
            dx_values.append(None)
            continue

        plus_window = plus_dm[i + 1 - period:i + 1]
        minus_window = minus_dm[i + 1 - period:i + 1]

        plus_di = 100 * (sum(plus_window) / period) / atr
        minus_di = 100 * (sum(minus_window) / period) / atr

        if plus_di + minus_di == 0:
            dx_values.append(None)
        else:
            dx = 100 * abs(plus_di - minus_di) / (plus_di + minus_di)
            dx_values.append(dx)

    adx_values = sma(dx_values, period)

    return adx_values


def analyze_market():
    try:
        rows = fetch_market_taiex()

        if len(rows) < 65:
            return {
                "status": "NO_ENOUGH_DATA",
                "date": "",
                "market_close": None,
                "market_ma60": None,
                "market_above_ma60": False,
                "market_return_5d": None
            }

        closes = []

        for row in rows:
            closes.append(to_float(row.get("close")))

        ma60 = sma(closes, 60)

        i = len(rows) - 1
        close = closes[i]
        market_ma60 = ma60[i]

        market_above_ma60 = False

        if close is not None and market_ma60 is not None:
            market_above_ma60 = close > market_ma60

        market_return_5d = None

        if len(rows) >= 6:
            close_5d_ago = closes[i - 5]

            if close is not None and close_5d_ago is not None and close_5d_ago != 0:
                market_return_5d = ((close / close_5d_ago) - 1) * 100

        return {
            "status": "OK",
            "date": rows[i].get("date", ""),
            "market_close": close,
            "market_ma60": market_ma60,
            "market_above_ma60": market_above_ma60,
            "market_return_5d": market_return_5d
        }

    except Exception as error:
        return {
            "status": "ERROR",
            "date": "",
            "market_close": None,
            "market_ma60": None,
            "market_above_ma60": False,
            "market_return_5d": None,
            "error": str(error)
        }


def analyze_foreign(stock_id):
    try:
        rows = fetch_foreign_investors(stock_id)

        daily_net = {}

        for row in rows:
            investor_name = str(row.get("name", ""))

            if investor_name != "Foreign_Investor":
                continue

            day = str(row.get("date", ""))
            buy = to_int(row.get("buy"))
            sell = to_int(row.get("sell"))

            if buy is None:
                buy = 0

            if sell is None:
                sell = 0

            net = buy - sell

            if day not in daily_net:
                daily_net[day] = 0

            daily_net[day] = daily_net[day] + net

        days = sorted(daily_net.keys())

        if len(days) == 0:
            return {
                "foreign_net_latest": None,
                "foreign_buy_streak": 0,
                "foreign_buy_3d": False
            }

        streak = 0
        latest_net = daily_net[days[-1]]

        for day in reversed(days):
            if daily_net[day] > 0:
                streak = streak + 1
            else:
                break

        return {
            "foreign_net_latest": latest_net,
            "foreign_buy_streak": streak,
            "foreign_buy_3d": streak >= 3
        }

    except Exception:
        return {
            "foreign_net_latest": None,
            "foreign_buy_streak": 0,
            "foreign_buy_3d": False
        }


def grade_result(condition_count, risk_count, liquidity_ok, avoid_chase):
    if condition_count >= 10 and risk_count == 0 and liquidity_ok and avoid_chase:
        return "A"

    if condition_count >= 8 and liquidity_ok and avoid_chase:
        return "B"

    return "C"


def analyze_stock(stock, market):
    stock_id = stock["stock_id"]
    name = stock["name"]

    rows = fetch_stock_price(stock_id)

    if len(rows) < 130:
        return {
            "stock_id": stock_id,
            "name": name,
            "status": "NO_ENOUGH_DATA",
            "error": "資料不足"
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

        if close_5d_ago is not None and close_5d_ago != 0 and latest_close is not None:
            return_5d = ((latest_close / close_5d_ago) - 1) * 100

    market_return_5d = market.get("market_return_5d")

    relative_strength_5d = None
    stronger_than_market = False

    if return_5d is not None and market_return_5d is not None:
        relative_strength_5d = return_5d - market_return_5d
        stronger_than_market = relative_strength_5d > 0

    prev20_high = None

    if len(closes) >= 21:
        prev20_high = max(closes[i - 20:i])

    macd_golden_cross = False

    if (
        macd_line[p] is not None
        and signal_line[p] is not None
        and macd_line[i] is not None
        and signal_line[i] is not None
    ):
        macd_golden_cross = macd_line[p] <= signal_line[p] and macd_line[i] > signal_line[i]

    hist_turn_positive = False

    if hist[p] is not None and hist[i] is not None:
        hist_turn_positive = hist[p] <= 0 and hist[i] > 0

    above_ema60 = False

    if latest_close is not None and ema60[i] is not None:
        above_ema60 = latest_close > ema60[i]

    ema60_gt_ema120 = False

    if ema60[i] is not None and ema120[i] is not None:
        ema60_gt_ema120 = ema60[i] > ema120[i]

    volume_ratio = None
    volume_break = False

    if volumes[i] is not None and vol_ma20[i] is not None and vol_ma20[i] != 0:
        volume_ratio = volumes[i] / vol_ma20[i]
        volume_break = volume_ratio > 1.5

    rsi_strong = False

    if rsi14[i] is not None:
        rsi_strong = rsi14[i] > 55

    adx_trending = False

    if adx14[i] is not None:
        adx_trending = adx14[i] > 20

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

    if opens[i] is not None and highs[i] is not None and closes[i] is not None:
        body = abs(closes[i] - opens[i])
        upper_shadow = highs[i] - max(opens[i], closes[i])

        if body > 0 and upper_shadow > body * 2:
            long_upper_shadow = True

    market_filter = market.get("market_above_ma60", False)

    foreign = analyze_foreign(stock_id)

    foreign_buy_3d = foreign.get("foreign_buy_3d", False)
    foreign_buy_streak = foreign.get("foreign_buy_streak", 0)
    foreign_net_latest = foreign.get("foreign_net_latest")

    risk_count = 0

    if long_upper_shadow:
        risk_count = risk_count + 1

    if not avoid_chase:
        risk_count = risk_count + 1

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
        liquidity_ok,
        market_filter,
        foreign_buy_3d,
        stronger_than_market
    ]

    condition_count = 0

    for condition in conditions:
        if condition:
            condition_count = condition_count + 1

    grade = grade_result(condition_count, risk_count, liquidity_ok, avoid_chase)

    note_parts = []

    if long_upper_shadow:
        note_parts.append("長上影風險")

    if not avoid_chase:
        note_parts.append("單日漲幅大於7%")

    if not liquidity_ok:
        note_parts.append("流動性不足")

    if not market_filter:
        note_parts.append("大盤未站上MA60")

    if not foreign_buy_3d:
        note_parts.append("外資未連買3日")

    if not stronger_than_market:
        note_parts.append("5日表現未強於大盤")

    if len(note_parts) == 0:
        note = "無明顯風險註記"
    else:
        note = "；".join(note_parts)

    return {
        "stock_id": stock_id,
        "name": name,
        "status": "OK",
        "date": dates[i],
        "open": opens[i],
        "high": highs[i],
        "low": lows[i],
        "close": latest_close,
        "day_return": day_return,
        "return_5d": return_5d,
        "market_return_5d": market_return_5d,
        "relative_strength_5d": relative_strength_5d,
        "stronger_than_market": stronger_than_market,
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
        "volume_ratio": volume_ratio,
        "amount_ma20": amount_ma20[i],
        "condition_count": condition_count,
        "risk_count": risk_count,
        "grade": grade,
        "note": note,
        "market_filter": market_filter,
        "foreign_net_latest": foreign_net_latest,
        "foreign_buy_streak": foreign_buy_streak,
        "foreign_buy_3d": foreign_buy_3d,
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


def append_row(sheet, values):
    sheet.append(values)


def style_sheet(sheet):
    header_fill = PatternFill("solid", fgColor="1F4E78")
    header_font = Font(color="FFFFFF", bold=True)

    if sheet.max_row >= 1:
        for cell in sheetcell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal="center")

    for col in range(1, sheet.max_column + 1):
        col_letter = get_column_letter(col)
        sheet.column_dimensions[col_letter].width = 18

    sheet.freeze_panes = "A2"

    if sheet.max_row >= 1 and sheet.max_column >= 1:
        sheet.auto_filter.ref = sheet.dimensions


def apply_grade_style(summary_sheet):
    fill_a = PatternFill("solid", fgColor="C6EFCE")
    fill_b = PatternFill("solid", fgColor="FFEB9C")
    fill_c = PatternFill("solid", fgColor="F2F2F2")
    fill_error = PatternFill("solid", fgColor="FFC7CE")

    for row in range(2, summary_sheet.max_row + 1):
        grade = summary_sheet.cell(row=row, column=4).value

        if grade == "A":
            fill = fill_a
        elif grade == "B":
            fill = fill_b
        elif grade == "C":
            fill = fill_c
        else:
            fill = fill_error

        for col in range(1, summary_sheet.max_column + 1):
            summary_sheet.cell(row=row, column=col).fill = fill


def create_excel(results, market):
    make_output_dir()

    wb = Workbook()

    summary = wb.active
    summary.title = "summary"

    conditions = wb.create_sheet("conditions")
    raw_latest = wb.create_sheet("raw_latest")
    market_sheet = wb.create_sheet("market")

    append_row(summary, [
        "date",
        "stock_id",
        "name",
        "grade",
        "condition_count",
        "risk_count",
        "close",
        "day_return_pct",
        "return_5d_pct",
        "market_return_5d_pct",
        "relative_strength_5d",
        "rsi14",
        "adx14",
        "macd",
        "signal",
        "hist",
        "ema20",
        "ema60",
        "ema120",
        "volume_ratio",
        "amount_ma20",
        "foreign_net_latest",
        "foreign_buy_streak",
        "note"
    ])

    append_row(conditions, [
        "date",
        "stock_id",
        "name",
        "macd_golden_cross",
        "hist_turn_positive",
        "above_ema60",
        "ema60_gt_ema120",
        "volume_break",
        "rsi_strong",
        "adx_trending",
        "breakout_20d",
        "avoid_chase",
        "liquidity_ok",
        "market_filter",
        "foreign_buy_3d",
        "stronger_than_market",
        "long_upper_shadow"
    ])

    append_row(raw_latest, [
        "date",
        "stock_id",
        "name",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "amount"
    ])

    append_row(market_sheet, [
        "date",
        "market_close",
        "market_ma60",
        "market_above_ma60",
        "market_return_5d",
        "status"
    ])

    append_row(market_sheet, [
        market.get("date", ""),
        round_value(market.get("market_close"), 2),
        round_value(market.get("market_ma60"), 2),
        bool_text(market.get("market_above_ma60", False)),
        round_value(market.get("market_return_5d"), 2),
        market.get("status", "")
    ])

    for item in results:
        if item["status"] != "OK":
            append_row(summary, [
                "",
                item["stock_id"],
                item["name"],
                "ERROR",
                0,
                0,
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                item.get("error", "資料錯誤")
            ])
            continue

        append_row(summary, [
            item["date"],
            item["stock_id"],
            item["name"],
            item["grade"],
            item["condition_count"],
            item["risk_count"],
            round_value(item["close"], 2),
            round_value(item["day_return"], 2),
            round_value(item["return_5d"], 2),
            round_value(item["market_return_5d"], 2),
            round_value(item["relative_strength_5d"], 2),
            round_value(item["rsi14"], 2),
            round_value(item["adx14"], 2),
            round_value(item["macd"], 4),
            round_value(item["signal"], 4),
            round_value(item["hist"], 4),
            round_value(item["ema20"], 2),
            round_value(item["ema60"], 2),
            round_value(item["ema120"], 2),
            round_value(item["volume_ratio"], 2),
            round_value(item["amount_ma20"], 0),
            item["foreign_net_latest"],
            item["foreign_buy_streak"],
            item["note"]
        ])

        append_row(conditions, [
            item["date"],
            item["stock_id"],
            item["name"],
            bool_text(item["macd_golden_cross"]),
            bool_text(item["hist_turn_positive"]),
            bool_text(item["above_ema60"]),
            bool_text(item["ema60_gt_ema120"]),
            bool_text(item["volume_break"]),
            bool_text(item["rsi_strong"]),
            bool_text(item["adx_trending"]),
            bool_text(item["breakout_20d"]),
            bool_text(item["avoid_chase"]),
            bool_text(item["liquidity_ok"]),
            bool_text(item["market_filter"]),
            bool_text(item["foreign_buy_3d"]),
            bool_text(item["stronger_than_market"]),
            bool_text(item["long_upper_shadow"])
        ])

        append_row(raw_latest, [
            item["date"],
            item["stock_id"],
            item["name"],
            round_value(item["open"], 2),
            round_value(item["high"], 2),
            round_value(item["low"], 2),
            round_value(item["close"], 2),
            item["volume"],
            item["amount"]
        ])

    style_sheet(summary)
    style_sheet(conditions)
    style_sheet(raw_latest)
    style_sheet(market_sheet)

    apply_grade_style(summary)

    wb.save(EXCEL_FILE)


def build_discord_summary(results, market):
    now = taipei_now().strftime("%Y-%m-%d %H:%M:%S")

    important = []

    for item in results:
        if item["status"] == "OK" and item["grade"] in ["A", "B"]:
            important.append(item)

    important = sorted(
        important,
        key=lambda x: (x["grade"], -x["condition_count"], x["risk_count"])
    )

    lines = []
    lines.append("台股 Excel 報表已產生")
    lines.append("台灣時間：" + now)
    lines.append("報表檔案：report.xlsx")
    lines.append("說明：這是研究觀察資料，不是買賣建議。")
    lines.append("")

    lines.append("大盤濾網")
    lines.append("TAIEX日期：" + str(market.get("date", "")))
    lines.append("TAIEX收盤：" + round_text(market.get("market_close"), 2))
    lines.append("TAIEX MA60：" + round_text(market.get("market_ma60"), 2))
    lines.append("TAIEX站上MA60：" + bool_text(market.get("market_above_ma60", False)))
    lines.append("大盤5日漲跌：" + round_text(market.get("market_return_5d"), 2) + "%")
    lines.append("")

    if len(important) == 0:
        lines.append("今日沒有 A/B 級觀察標的。")
        lines.append("完整結果請下載 GitHub Actions Artifact 的 report.xlsx。")
        return "\n".join(lines)

    lines.append("今日 A/B 級觀察摘要：")
    lines.append("")

    for item in important:
        lines.append(item["grade"] + "級 " + item["stock_id"] + " " + item["name"])
        lines.append("條件：" + str(item["condition_count"]) + "/13，風險：" + str(item["risk_count"]))
        lines.append("收盤：" + round_text(item["close"], 2))
        lines.append("RSI14：" + round_text(item["rsi14"], 2))
        lines.append("ADX14：" + round_text(item["adx14"], 2))
        lines.append("5日漲跌：" + round_text(item["return_5d"], 2) + "%")
        lines.append("相對大盤5日：" + round_text(item["relative_strength_5d"], 2) + "%")
        lines.append("外資連買：" + str(item["foreign_buy_streak"]) + "日")
        lines.append("大盤濾網：" + bool_text(item["market_filter"]))
        lines.append("外資3日：" + bool_text(item["foreign_buy_3d"]))
        lines.append("強於大盤：" + bool_text(item["stronger_than_market"]))
        lines.append("備註：" + item["note"])
        lines.append("")

    lines.append("完整報表請到 GitHub Actions 的 Artifacts 下載 report.xlsx。")

    return "\n".join(lines)


def main():
    stocks = load_stocks()
    market = analyze_market()

    results = []

    for stock in stocks:
        try:
            result = analyze_stock(stock, market)
            results.append(result)
        except Exception as error:
            results.append({
                "stock_id": stock["stock_id"],
                "name": stock["name"],
                "status": "ERROR",
                "error": str(error)
            })

    create_excel(results, market)

    message = build_discord_summary(results, market)
    messages = split_message(message, 1800)

    for msg in messages:
        send_to_discord(msg)


main()
