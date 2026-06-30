# AGENTS.md — Codex 設定

Codex 會自動讀取本檔。本專案採「**Claude 寫、Codex 審**」的雙代理流程:
Claude Code 開草稿 PR,Codex 自動審查每個 PR(在 Codex 設定開啟 *Automatic reviews* 即可,
或在 PR 留言 `@codex review`)。

## Review guidelines（審查準則）

這是一個台股 invest 專案:Python 資料 pipeline(GitHub Actions 排程)+ React 靜態前端
(GitHub Pages)。審查 PR 時請特別檢查:

- **資料正確性**:價格/法人/基本面是否正確;盤後是否誤用過期的 TWSE `STOCK_DAY_ALL`;
  時區是否一律用 `Asia/Taipei`;空值是否被當成「真的 0」(法人=0 vs 法人=未取得 要分清楚)。
- **不可修改現有 Python**:除非 PR 描述載明使用者明確授權,否則核心 `.py`(main/data_loader/
  strategy/market_predictor… )不應被改;功能改進應在 `web/` 或 `build-data.mjs`。
- **安全**:任何把外部資料(新聞 RSS、Notion、API 回應)放進 `href`/`innerHTML` 的地方要做
  scheme/sanitize 檢查;不得新增會洩漏或硬編 secrets / API key / token 的程式。
- **前端為加法**:對 Dashboard/NewsFeed/PredictionPanel 應是新增,不破壞既有邏輯;動畫用 anime.js。
- **股票安全**:不得有自動下單、交易 API、或「保證獲利」敘述;策略改動需附理由與風險。
- **測試與風險**:邏輯改動是否有測試;PR 描述是否說明 改了什麼/為什麼/測試/風險。

## 限制（硬規則,與 CLAUDE.md 一致）
- 不要自動 merge;不要直接改 `main`;所有修改走 branch + PR。
- 不要讀取、輸出或修改任何 secrets / token / API key。
- 不要刪除 `output/`、`models/`、`training_data/` 等資料。
