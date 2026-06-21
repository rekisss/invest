# 台股 AI 掃描儀表板

[![Deploy to GitHub Pages](https://github.com/rekisss/invest/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/rekisss/invest/actions/workflows/deploy-pages.yml)

> 台灣股市 AI 掃描 + 技術分析 + 盤前預測 + 法人追蹤，即時部署到 GitHub Pages。

**線上看盤：** `https://rekisss.github.io/invest`

---

## 功能總覽

| 頁籤 | 功能 |
|------|------|
| 📊 **總覽** | 大盤指數、漲跌家數、市場情緒、整體資金流向 |
| 🔍 **掃描** | 全市場 MACD 策略選股結果，含評分、法人、技術指標詳細圖表 |
| 💼 **持倉** | 追蹤自選持倉，計算損益、持倉天數、目前訊號狀態 |
| 📰 **新聞** | 台股即時新聞語料，依股票代號篩選，含情緒分析 |
| 🤖 **預測** | 盤前 AI 預測（ML 模型），給出多空傾向與信心度 |
| ⚡ **圓桌** | 跨股票橫截面信號、F-Score 財務評分、強弱排名 |
| 📈 **配額** | FinMind API 配額使用狀況監控 |
| 💬 **AI** | Claude AI 即時問答，可查詢個股、分析盤面 |

---

## 資料流

```
GitHub Actions (Python pipeline)
        │
        ├─ output/scan_candidates.csv      ← 掃描選股
        ├─ output/kline/*.json             ← K線資料
        ├─ output/predict_result.json      ← AI 預測
        ├─ output/news_corpus.json         ← 新聞語料
        └─ output/*.csv / *.json           ← 其他分析結果
        │
        ▼
web/scripts/build-data.mjs  (build-time enrichment)
        │  ├─ 補抓 TWSE T86 法人資料（盤後自動）
        │  ├─ 計算 DataQuality 指標
        │  └─ 合併所有來源 → data.json
        ▼
web/public/data.json
        ▼
React 前端 (web/src/**)
        ▼
GitHub Pages (靜態部署)
```

---

## GitHub Actions 工作流程

### 自動排程（不需手動觸發）

| 工作流程 | 排程 | 說明 |
|----------|------|------|
| **全市場彙整 TOP 20** | 週二～週六 20:15 CST | 自動彙整當日掃描結果，取 TOP 20 候選股 |
| **K線資料更新** | 週二～週六 20:30 CST | 收盤後自動更新所有候選股 K 線快取 |
| **更新新聞語料庫** | 每 3 小時一次 | 持續抓取台股財經新聞 |
| **Weekly Performance Report** | 週一 09:00 CST | 每週績效摘要 |

### 手動觸發（到 Actions 頁面點 Run workflow）

#### 掃描類

| 工作流程 | 何時使用 |
|----------|----------|
| **🔍 全市場掃描**（Wave 1） | 每日收盤後手動啟動，掃描全市場約 1700 支股票，分批平行執行。需要 5～10 個 FINMIND_TOKEN |
| **🔍 全盤掃描2**（Wave 2） | 接在 Wave 1 之後執行，補充橫截面信號、F-Score 財務評分 |
| **⚡ 即時 TOP N 預覽** | 想快速看目前 TOP N 結果，不等自動彙整時使用 |
| **📅 每日選股掃描**（舊版） | 已由全市場掃描取代，保留備用 |

#### 預測 / 模型類

| 工作流程 | 何時使用 |
|----------|----------|
| **🤖 盤前預測** | 開盤前手動執行，輸出 AI 多空預測 |
| **📊 Collect Training Data** | 蒐集 yfinance 歷史資料，用於訓練模型（定期執行） |
| **🧠 Train ML Model** | 訓練預測模型（更新資料後執行） |

#### 其他

| 工作流程 | 何時使用 |
|----------|----------|
| **🚀 Deploy to GitHub Pages** | 推送新功能或需要刷新 data.json 時，手動部署到 GitHub Pages |
| **📉 回測 / 參數掃描** | 指定策略參數跑歷史回測，評估績效 |
| **📈 K線全量補跑** | 首次建立或需要清空重抓 2 年歷史 K 線時使用 |
| **📋 盤後總結** | 盤後手動產出當日操盤總結 |

---

## 典型交易日流程

```
16:00  台股收盤
       ↓
16:00~18:00  TWSE 公布三大法人買賣超（自動補入）
       ↓
收盤後  手動觸發「全市場掃描」（Wave 1）
       ↓
Wave 1 完成後  手動觸發「全盤掃描2」（Wave 2）
       ↓
20:15  🤖 自動彙整 TOP 20
       ↓
20:30  📊 自動更新 K線資料
       ↓
完成後  手動觸發「Deploy to GitHub Pages」→ 儀表板更新
       ↓
隔日開盤前  手動觸發「盤前預測」→ AI 給出多空方向
```

---

## 策略說明

核心策略為台股波段選股，進場條件包含：

- MACD 黃金交叉、柱狀圖翻正
- 收盤價高於 EMA60，EMA60 高於 EMA120
- 量能擴張
- RSI / ADX 趨勢確認
- 20 日突破
- 大盤環境過濾
- 外資連買日數
- 流動性篩選
- 相對強弱 vs TAIEX

排除低品質進場：長上影線、跳空後拉回、爆量後追高。

---

## Required GitHub Secrets

到 `Settings → Secrets and variables → Actions` 設定：

### FinMind（掃描用，10 組輪替）

| Secret | 說明 |
|--------|------|
| `FINMIND_TOKEN` | 主要 token（Wave 1 掃描 segment 1） |
| `FINMIND_TOKEN_2` ～ `FINMIND_TOKEN_10` | 輪替 token（平行掃描加速，最多 10 組） |

> 最少需要 1 組，越多組越快。每組 600 requests/hr（免費方案）。

### 通知 / 整合

| Secret | 說明 |
|--------|------|
| `DISCORD_WEBHOOK_URL` | Discord 通知（掃描結果推送） |
| `NOTION_TOKEN` | Notion API（持倉同步） |
| `NOTION_DATABASE_ID` | Notion 資料庫 ID（持倉追蹤） |

---

## 本地開發

```bash
# 安裝依賴
cd web
npm install

# 啟動開發伺服器
npm run dev

# 建置（產出 data.json + static files）
npm run build
```

本地開發用的 `data.json` 從 `web/public/data.json` 讀取（從 GitHub Pages 或 Actions 產出的版本複製過來即可）。

---

## 程式碼推送流程

### 小修改（一兩行）→ 直接推 main

```bash
git pull origin main
# 修改...
git add <changed_file>
git commit -m "fix: 說明你改了什麼"
git push origin main
```

### 大改動 → 開分支 + PR

```bash
git pull origin main
git checkout -b fix/<change-name>
# 修改、add、commit...
git push origin fix/<change-name>
# 開 PR → CI 全綠 → 合併
```

### 快速規則

- 小修改（一兩行）：可直接 push main
- 大改動或不確定：走分支 + PR，先讓 CI 驗證
- 合併前：確認 CI 全綠（✅）
- 前端改動完成後：記得手動觸發 `Deploy to GitHub Pages`

---

## 專案結構

```
invest/
├── main.py                    # Python 主程式入口
├── data_loader.py             # FinMind 資料載入
├── indicators.py              # EMA / MACD / RSI / ADX
├── strategy.py                # 選股信號與排名
├── backtest.py                # 歷史回測引擎
├── market_predictor.py        # ML 預測模型
├── notifier.py                # Discord 推播
├── universe.py                # 股票池自動建立
├── web/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Dashboard.jsx       # 主儀表板（掃描結果）
│   │   │   ├── StockDetailModal.jsx # 個股詳細圖表
│   │   │   ├── Overview.jsx        # 總覽頁
│   │   │   ├── NewsFeed.jsx        # 新聞頁
│   │   │   └── PredictionPanel.jsx # 預測頁
│   │   ├── App.jsx                 # 路由 + 主題切換
│   │   └── styles/global.css       # CSS 變數（深色/淺色主題）
│   ├── scripts/
│   │   └── build-data.mjs          # Build-time 資料合併 + TWSE 法人補抓
│   └── public/
│       └── data.json               # 前端讀取的資料（由 build-data.mjs 產出）
└── .github/workflows/
    ├── full_market_scan.yml        # 全市場掃描 Wave 1
    ├── full_market_scan2.yml       # 全盤掃描 Wave 2（橫截面 + F-Score）
    ├── full_market_aggregate.yml   # 自動彙整（20:15 CST）
    ├── kline-fetch.yml             # K線自動更新（20:30 CST）
    ├── premarket_predict.yml       # 盤前 AI 預測
    ├── deploy-pages.yml            # GitHub Pages 部署
    ├── news-corpus.yml             # 新聞語料（每3小時）
    ├── backtest.yml                # 回測
    ├── train_model.yml             # 訓練 ML 模型
    └── collect_training_data.yml   # 蒐集訓練資料
```
