# Claude Code — Project Rules

## 核心原則 (Critical Rules)

### 絕對不能修改現有的 Python 程式
- **不要改動** `main.py`, `data_loader.py`, `strategy.py`, `indicators.py`, `market_predictor.py`, `backtest.py`, `fundamentals.py`, `notifier.py`, `notion_sync.py`, `news_service.py`, `taiwan_futures.py`, `economic_calendar.py`, `claude_insight.py`, `universe.py`, `collect_training_data.py`, `train_model.py` 等所有 Python 檔案
- **唯一例外**：用戶明確說「請修改 XXX Python 程式」才動
- 所有功能改進只在 `web/` 前端加，或在 `build-data.mjs` 做 build-time enrichment

### 前端修改原則
- 所有對 Dashboard / NewsFeed / PredictionPanel 的改動必須是**加法**（新增元件、新增欄位），不改現有邏輯
- 不刪除現有功能

### 動畫一律使用 anime.js
- 所有動畫**一律使用 anime.js**（https://github.com/juliangarnier/anime ，目前 v4，`import { animate, stagger, spring } from 'animejs'`）
- 不要新增其他動畫函式庫；既有的 GSAP 用法可保留，但新動畫優先用 anime.js
- 共用 helper 放在 `web/src/utils/animeUtils.js`
- 進場動畫用 `useLayoutEffect` 並在動畫前先以指令式設定初始狀態（`el.style.transform = ...`），避免首幀閃爍；SVG 用 `transformBox: 'fill-box'` + `transformOrigin` 控制縮放原點

### GitHub Actions
- 不改 `.github/workflows/` 的 Python 相關 workflow（`full_market_scan.yml`, `full_market_aggregate.yml`, `premarket_predict.yml` 等）
- `deploy-pages.yml` 和 `ci.yml` 可以動
- **新增的 workflow 一律不加 `schedule:` 排程**：使用者的排程統一由外部服務 cron-job.org 透過 `workflow_dispatch` API 觸發（使用者明確要求，2026-07-12）。既有 workflow 的排程維持不動。

## 開發分支
- 所有開發在 `claude/cron-job-automation-0YoJr` 分支進行
- Push 後自動建立 Draft PR

## 資料流
```
Python pipeline → output/*.csv / output/*.json
     ↓
web/scripts/build-data.mjs (build-time enrichment, OK to modify)
     ↓
web/public/data.json
     ↓
React frontend (web/src/**, OK to modify)
```

## 自動化代理規則 (Autonomous Agent Rules)
適用於每日自動排程（`claude-daily-invest.yml`）等無人值守的執行。

目標：
- 自動檢查資料更新流程是否正常
- 修正 bug、補測試、優化程式架構
- 開 Pull Request（草稿）

限制（硬規則）：
- **不要自動 merge**（PR 一律交人工審核）
- **不要改 API key、token、secrets**（不讀取、不輸出、不修改任何憑證）
- **不要刪除資料庫或重要資料**（`output/`、`models/`、`training_data/` 等）
- **不要直接改 `main`**；所有修改都開新 branch + PR
- 每個 PR 都要說明：改了什麼、為什麼、測試結果、風險、建議人工檢查處
- 仍受上面「核心原則」約束（不改現有 Python，除非用戶明確授權）

股票相關安全限制：
- **不要自動下單**、不接觸任何下單/交易 API
- **不要產生「保證獲利」之類的敘述**
- 策略修改一定要附上理由與可能風險
