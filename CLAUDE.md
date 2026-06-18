# Claude Code — Project Rules

## 核心原則 (Critical Rules)

### 絕對不能修改現有的 Python 程式
- **不要改動** `main.py`, `data_loader.py`, `strategy.py`, `indicators.py`, `market_predictor.py`, `backtest.py`, `fundamentals.py`, `notifier.py`, `notion_sync.py`, `news_service.py`, `taiwan_futures.py`, `economic_calendar.py`, `claude_insight.py`, `universe.py`, `collect_training_data.py`, `train_model.py` 等所有 Python 檔案
- **唯一例外**：用戶明確說「請修改 XXX Python 程式」才動
- 所有功能改進只在 `web/` 前端加，或在 `build-data.mjs` 做 build-time enrichment

### 前端修改原則
- 所有對 Dashboard / NewsFeed / PredictionPanel 的改動必須是**加法**（新增元件、新增欄位），不改現有邏輯
- 不刪除現有功能

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
