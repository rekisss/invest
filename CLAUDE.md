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
