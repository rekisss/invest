# Claude Code — Project Rules

## 核心原則 (Critical Rules)

### 絕對不能修改現有的 Python 程式
- **不要改動** `main.py`, `data_loader.py`, `strategy.py`, `indicators.py`, `market_predictor.py`, `backtest.py`, `fundamentals.py`, `notifier.py`, `notion_sync.py`, `news_service.py`, `taiwan_futures.py`, `economic_calendar.py`, `claude_insight.py`, `universe.py`, `collect_training_data.py`, `train_model.py` 等所有 Python 檔案
- **唯一例外**：用戶明確說「請修改 XXX Python 程式」才動
  - **已用掉的一次性授權（2026-11-17）**：使用者以選項形式明確授權修改下列三項，
    用詞為「你幫我解決」＋勾選「改 Python 3 項」。
    1. `outcome_tracker.py` —— TOP20 快照日改以掃描資料自己的日期為準（CST/UTC 錯位）
    2. `.github/workflows/` 的 `news-corpus` / `outcome-tracker` / `daily_report` /
       `full_market_scan` —— retry 迴圈吞掉 `git push` 失敗
    3. `kline_fetch.py` —— 週/月 K 加上保留上限、檔案過大時改為真的失敗
  - **此授權僅限上述三項，已執行完畢，不得延伸到其他 Python 檔案或其他需求。**
    之後要再動任何 Python，仍須重新取得明確授權。
- 所有功能改進只在 `web/` 前端加，或在 `build-data.mjs` 做 build-time enrichment

### 前端修改原則
- 所有對 Dashboard / PredictionPanel 的改動必須是**加法**（新增元件、新增欄位），不改現有邏輯
- 不刪除現有功能
  - **例外（2026-11-16 使用者明確指示）**：移除「新聞」分頁與 `NewsFeed.jsx` 元件。
    使用者在知悉本條規則的情況下，仍選擇「分頁 + 刪掉 NewsFeed 元件」。
    範圍僅限前端呈現層：`data.json` 的 `news` 欄位、`build-data.mjs` 的新聞讀取/抓取、
    以及 `news_sentiment`（`PredictionPanel` / `GeminiStudio` 的預測輸入）**全部保留不動**，
    因為那屬於策略輸入，不在此次授權範圍內。
  - 此例外不擴及其他功能；要再刪任何功能仍須個別取得明確指示。

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
- 所有開發在當次任務指定的 `claude/*` 分支進行(每個 Claude 工作階段有各自的指定分支,不要寫死分支名)
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
- **合併 PR：有條件授權**（2026-11-16 使用者明確覆寫原本的「不要自動 merge」；
  2026-11-17 使用者進一步指示「你自動幫我不用經過codex」，取消「等 review bot」這一關）
  - 原規則為「PR 一律交人工審核」。使用者於 2026-11-16 以選項形式明確授權 Claude 合併，但附帶條件。
  - **兩個條件必須同時成立才可合併**：
    1. CI 全綠（所有 check run 皆 success）
    2. 無 merge conflict（`mergeable_state` 為 `clean`）
  - **不必等 Codex / 其他 review bot 的 review 回來**（2026-11-17 使用者明確指示）。
    原本的條件②（無未解決的 review finding）就此取消。
    CI 與衝突這兩關**仍然保留** —— 使用者沒有要求跳過，且紅燈或有衝突就合併會把問題帶進 `main`。
  - 「不等 Codex」**不等於「忽視 Codex」**：
    - finding 在合併前已經出現 → 仍要自己驗證（不照單全收），真的就修，不成立就在該 thread 回覆理由
    - finding 在合併後才出現 → 依下面「合併後若發現問題，回報並修」處理，用後續 PR 修正
  - **這兩項不成立就停下來問使用者**，不得自行判斷「應該沒差」而合併。
  - 合併後若發現問題，回報並修，不得隱匿。
  - 此授權僅限合併「Claude 自己開的 PR」；他人開的 PR 一律不碰。
- **不要改 API key、token、secrets**（不讀取、不輸出、不修改任何憑證）
- **不要刪除資料庫或重要資料**（`output/`、`models/`、`training_data/` 等）
- **不要直接改 `main`**；所有修改都開新 branch + PR
- 每個 PR 都要說明：改了什麼、為什麼、測試結果、風險、建議人工檢查處
- 仍受上面「核心原則」約束（不改現有 Python，除非用戶明確授權）

股票相關安全限制：
- **不要自動下單**、不接觸任何下單/交易 API
- **不要產生「保證獲利」之類的敘述**
- 策略修改一定要附上理由與可能風險
