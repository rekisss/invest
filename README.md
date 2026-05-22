# Taiwan Stock MACD Scanner

This project scans Taiwan stocks with a high-selectivity MACD swing strategy, supports historical backtesting, and can monitor a small watchlist during market hours.

It is designed around three practical modes:

- `scan`: daily end-of-day candidate scan
- `hybrid-monitor`: FinMind daily prefilter + Fugle live watchlist
- `sponsor-monitor`: experimental FinMind Sponsor K-bar fetch mode
- `event-monitor`: local real-time alert monitor with Discord push on triggers

## Strategy Summary

The core strategy is a Taiwan stock swing setup based on:

- MACD golden cross
- histogram turning positive
- close above EMA60
- EMA60 above EMA120
- volume expansion
- RSI / ADX trend confirmation
- 20-day breakout
- market regime filter
- foreign investor buy streak
- liquidity filter
- relative strength vs. TAIEX

It also blocks low-quality entries such as:

- long upper shadow
- gap-up then fade
- chasing after a blowout-volume day

## Project Files

- `main.py`: main entrypoint
- `data_loader.py`: FinMind data loading
- `indicators.py`: EMA, MACD, RSI, ADX, SMA
- `strategy.py`: signal generation and ranking
- `backtest.py`: portfolio backtest engine
- `report.py`: Excel and chart output
- `universe.py`: auto-build stock universe
- `notifier.py`: Discord message sender
- `fugle_client.py`: Fugle live quote support
- `.github/workflows/report.yml`: GitHub Actions workflow

## Requirements

Install dependencies:

```powershell
pip install -r requirements.txt
```

If your local Python environment does not load user-site packages correctly, use:

```powershell
$env:PYTHONPATH="C:\Users\patri\Documents\Codex\2026-05-07\new-chat\invest\.vendor"
```

## Required Secrets / Env Vars

### FinMind

- `FINMIND_TOKEN`

Used for:

- daily scan
- backtest data download
- optional historical / sponsor-only datasets

### Discord

- `DISCORD_WEBHOOK_URL`

Optional. If set, the scanner can push messages automatically.

### Fugle

- `FUGLE_API_KEY`

Optional. Only needed for `hybrid-monitor`.

## Usage

### 1. Daily Scan

Use FinMind daily data to find the strongest Taiwan stock candidates.

```powershell
python main.py --mode scan --stocks auto --end 2026-05-07 --max-universe 120 --top-n 15 --output output
```

### 2. Hybrid Monitor

Use `watchlist.csv` or a small candidate list, then monitor it with Fugle live quotes.

```powershell
python main.py --mode hybrid-monitor --stocks watchlist.csv --end 2026-05-07 --watch-top 5 --output output
```

Best for:

- lower-cost live monitoring
- practical intraday monitoring
- low-limit setups

### 3. Sponsor Monitor

This mode is kept for users who have confirmed FinMind Sponsor K-bar access, but it should be treated as optional / experimental.

Recommended setting for a `600 requests/hour` token:

- `10` symbols
- every `120` seconds

Example:

```powershell
python main.py --mode sponsor-monitor --stocks auto --end 2026-05-07 --max-universe 120 --top-n 15 --watch-top 10 --interval-seconds 120 --repeat-count 999 --output output --notify
```

For most users, `hybrid-monitor` is the recommended live workflow instead.

### 4. Backtest

Run historical backtest from 2020-01-01 to 2024-12-31:

```powershell
python main.py --mode backtest --stocks auto --start 2020-01-01 --end 2024-12-31 --capital 1000000 --output output
```

### 5. Local Web Dashboard

Run a local website for scan / monitor / backtest:

```powershell
python -m pip install -r requirements.txt
python web_app.py
```

Then open:

```text
http://127.0.0.1:5000
```

The dashboard reuses your existing environment variables such as:

- `FINMIND_TOKEN`
- `FUGLE_API_KEY`
- `DISCORD_WEBHOOK_URL`

### 6. Local Real-Time Event Monitor

Run a local monitor that polls Fugle every 15-30 seconds and only pushes Discord when events trigger:

```powershell
python main.py --mode event-monitor --stocks auto --end 2026-05-12 --max-universe 40 --top-n 10 --watch-top 5 --max-price 120 --prefer-lower-price --include-news --interval-seconds 20 --repeat-count 999999 --notify
```

Built-in event types:

- intraday breakout to new high
- sharp rise above threshold
- sharp drop below threshold
- volume surge versus prior sample

## Output Files

Depending on mode, the project writes:

- `output/backtest_report.xlsx`
- `output/scan_report.xlsx`
- `output/hybrid_monitor_report.xlsx`
- `output/sponsor_monitor_report.xlsx`
- `output/equity_curve.png`
- `output/yearly_performance.png`

## GitHub Actions

This repo includes a workflow in:

- `.github/workflows/report.yml`
- `.github/workflows/scan.yml`

Important note:

- GitHub Actions cron cannot run every 2 minutes
- GitHub Actions minimum practical schedule is every 5 minutes
- if you want true `120-second` monitoring, run it on your own machine or server

### Scheduled jobs

- `report.yml`: runs `hybrid-monitor` every 5 minutes on weekdays during `09:00-13:55` Asia/Taipei
- `scan.yml`: runs `scan` once per weekday at `13:45` Asia/Taipei

### Required GitHub repository secrets

Set these in `GitHub -> Settings -> Secrets and variables -> Actions`:

- `FINMIND_TOKEN`
- `DISCORD_WEBHOOK_URL`
- `FUGLE_API_KEY` for `hybrid-monitor`

Without these secrets, GitHub Actions cannot fetch data or push Discord notifications.

## Recommended Practical Setup

### Recommended setup for most users

- use `scan` for end-of-day candidate discovery
- maintain a small `watchlist.csv`
- use `hybrid-monitor` during market hours

This is the most stable setup under limited API quotas.

## Notes

- Taiwan stock intraday monitoring with full-market high frequency is not realistic under low API limits.
- FinMind `TaiwanStockKBar` is not a guaranteed real-time feed for all tokens, so Fugle is the safer live-monitor path.
- This project intentionally uses a narrow, high-selectivity filter rather than frequent signals.
- The earnings-date avoidance filter is optional because source timing fields can vary.


## Code Change & Upload Flow（之後固定流程）

### 直接推 main（小改動）

```bash
# 1. 拉最新程式碼
git pull origin main

# 2. 改程式

# 3. 查看改了什麼
git status
git diff

# 4. 加入暫存區
git add <changed_file>
# 或全部加入
git add .

# 5. 建立 commit（建議格式：fix:/feat:/chore:）
git commit -m "fix: 說明你改了什麼"

# 6. 推上 GitHub
git push origin main
```

### PR 流程（大改動/不確定時，優先使用）

```bash
# 1. 拉最新
git pull origin main

# 2. 開新分支
git checkout -b fix/<change-name>

# 3. 改程式、add、commit

# 4. 推分支
git push origin fix/<change-name>

# 5. 開 PR → 等 CI 全綠 → 合併
```

### 快速規則

- 小修改（一兩行）：可直接 push main。
- 大改動或不確定：走分支 + PR，先讓 CI 驗證。
- 合併前：確認 CI 全綠（✅）。
