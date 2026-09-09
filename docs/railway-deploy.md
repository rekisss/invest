# Railway 部署指南（discord_bot.py 24/7 常駐）

> 目的：把 `discord_bot.py` 放到 Railway 常駐執行，取代「本機開著電腦」。
> GitHub Actions 已經負責所有排程工作（掃描、日報、K線、Pages 部署），Railway **只跑 bot**。

---

## 一、$5 Hobby 方案夠不夠？

Railway 的 $5 **不是**固定月租買一台機器，而是「$5 的用量額度」。
超過才另外收費，用不完也不退。計費是**依實際用量、每秒計費**：

| 項目 | 費率 |
|---|---|
| 記憶體 | $10 / GB / 月 |
| CPU | $20 / vCPU / 月 |
| 網路外流 (egress) | $0.05 / GB |
| Volume 磁碟 | $0.15 / GB / 月 |

### 本專案 bot 的實測用量

在 Python 3.11 實際 import 一遍 bot 的相依套件，常駐記憶體：

```
baseline python      :    7.5 MB
+ pandas/numpy/req   :   74.9 MB
+ discord.py         :   92.6 MB
+ xgboost            :  127.0 MB
+ yfinance           :  143.7 MB
```

也就是 **idle 約 145 MB**；跑 `/top`、`/ai` 時 pandas 會短暫拉高到 300–500 MB。
平均抓 0.2–0.3 GB、CPU 平均 0.02–0.05 vCPU（大部分時間在等 Discord websocket 和 API 回應）：

| 項目 | 估算 |
|---|---|
| 記憶體 0.2–0.3 GB × $10 | $2.0 – $3.0 |
| CPU 0.02–0.05 vCPU × $20 | $0.4 – $1.0 |
| Egress（Discord + FinMind，量很小） | < $0.10 |
| Volume（**不需要**，見下方） | $0 |
| **合計** | **約 $2.5 – $4.0 / 月** |

**結論：只跑 Discord bot 的話，$5 夠用，還有約 20–50% 餘裕。**

### 什麼情況會爆掉

| 想搬上 Railway 的東西 | 額外成本 | 建議 |
|---|---|---|
| `discord_bot.py` 常駐 | $2.5–4 | ✅ 適合 |
| `intraday_monitor`（盤中每 5 分鐘） | +$0.2 左右 | ✅ 可以，但 GitHub Actions 已經免費在做 |
| `full_market_scan`（90 分鐘 × 4 次/日 × 22 天） | +$2–3 | ⚠️ 加上 bot 會壓線甚至超過 $5 |
| 同時常駐 `web_app.py` Flask | +$1.5–2.5 | ⚠️ 前端已經在 GitHub Pages，沒必要 |

**建議維持現狀分工**：重計算留在 GitHub Actions（免費額度內），Railway 只負責「必須 24/7 在線」的 bot。

### 不需要 Volume 的原因

bot 只寫兩個東西，都可以丟：

- `output/bot_scan_cache.json` — 掃描結果快取，重跑會重建
- `output/cache/` — FinMind API 快取，`.gitignore` 內，`FinMindClient` 啟動時會自己 `mkdir`

重新部署時這些檔案會消失，但不影響功能（下次查詢重抓即可）。
所以 **不用掛 Volume**，省下 $0.15/GB/月。

---

## 二、架設步驟

### 0. 前置

- Railway 帳號（用 GitHub 登入最快）：https://railway.com
- 訂閱 Hobby 方案（$5/月）
- `rekisss/invest` 這個 repo 已在 GitHub 上

### 1. 建立專案

1. Railway → **New Project** → **Deploy from GitHub repo**
2. 授權 Railway 讀取 `rekisss/invest`
3. 選 `rekisss/invest`，branch 選 `main`

Railway 會偵測到 `requirements.txt`，用 Nixpacks 自動建置 Python 環境。
repo 連 `.git` 約 400 MB，第一次 build 大約 3–6 分鐘，屬正常。

### 2. 確認啟動指令

本 repo 已附 `railway.json`，會自動套用：

```json
{
  "deploy": {
    "startCommand": "python discord_bot.py",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

> 根目錄的 `Procfile` 只有 `worker:` 沒有 `web:`，Railway 不一定認得，
> 所以用 `railway.json` 明確指定，比較保險。
>
> ⚠️ 根目錄的 `railway.json` 會套用到專案內**所有** service。
> 之後若要在同一個專案加第二個 service（例如 cron），
> 記得到該 service 的 Settings → **Config as code** 指定另一個設定檔路徑，
> 否則它也會被指定成跑 `python discord_bot.py`。

### 3. 設定環境變數

Service → **Variables** → 逐一新增（值從你本機 `.env` 複製）：

| 變數 | 必填 | 用途 |
|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ | 沒設 bot 會直接 exit |
| `DISCORD_CHANNEL_ID` | ✅ | 定時推播的頻道 |
| `FINMIND_TOKEN` | ✅ | 台股資料來源 |
| `FUGLE_API_KEY` | 選用 | 盤中即時報價，沒設就跳過 |
| `TZ` | 建議 | 設 `Asia/Taipei`（bot 內部已用 UTC+8 換算，但 log 時間會比較好讀） |

> 🔒 不要把 `.env` commit 進 repo，`.gitignore` 已經擋掉了。

### 4. 選 Region

Service → **Settings** → **Region** → 選 **Southeast Asia (Singapore)**。
離 FinMind / 富果 / TWSE 最近，API 延遲最低。

### 5. 關掉 App Sleeping

Service → **Settings** → **Serverless / App Sleeping** → **關閉**。

App Sleeping 會在沒有對外流量約 5–15 分鐘後把服務睡掉，靠「有人打進來」才叫醒。
Discord bot 是**自己對外**維持 gateway websocket，沒有 inbound HTTP 可以叫醒它，
睡著就等於離線。務必關掉。

### 6. 設用量警示（重要）

Account → **Usage** → 設 **Usage Limit**：

- Soft limit（寄信通知）：`$5`
- Hard limit（超過就停機）：`$8`

這樣就算哪天寫了 bug 讓 CPU 打滿，也不會收到爆炸帳單。

### 7. 驗證

1. **Deployments** → 看 build log 跑完
2. **Logs** 應該看到 discord.py 的 `logged in as ...`
3. 在 Discord 打 `/top`、`/market` 測試斜線指令有沒有回應
4. **Metrics** 分頁看實際 Memory / CPU 曲線 —— 對照上面的估算，跑幾天後就知道真實月費

---

## 三、日常維運

| 情況 | 做法 |
|---|---|
| 改了 bot 程式 | push 到 `main`，Railway 自動重新 build + 部署 |
| 想暫時停用 | Service → Settings → **Remove**，或把 replicas 設 0 |
| Bot 掛掉 | `restartPolicyType: ON_FAILURE` 會自動重啟最多 10 次 |
| 想看花多少錢 | Account → Usage，可以看到分 service 的即時累計 |
| 費用逼近 $5 | 先看 Metrics 哪個時段記憶體飆高，通常是 `/top` 全市場掃描 |

---

## 四、參考來源

- [Railway Pricing](https://railway.com/pricing)
- [Railway Docs — Pricing Plans](https://docs.railway.com/pricing/plans)
- [Railway Docs — App Sleeping / Serverless](https://docs.railway.com/reference/app-sleeping)
- [Railway Docs — Cron Jobs](https://docs.railway.com/cron-jobs)
- [Railway Docs — Cron Jobs vs Background Workers vs Queues](https://docs.railway.com/guides/cron-workers-queues)
- [Railway Docs — Build & Deploy](https://docs.railway.com/build-deploy)
