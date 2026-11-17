# AGENTS.md — Codex 設定

Codex 會自動讀取本檔。本專案採「**Claude 寫、Codex 審**」的雙代理流程:
Claude Code 開草稿 PR,Codex 自動審查每個 PR(在 Codex 設定開啟 *Automatic reviews* 即可,
或在 PR 留言 `@codex review`)。

> 2026-11-17 起使用者明確指示 Claude **不必等 Codex review 即可合併自己開的 PR**,
> 所以 Codex 的 review 可能在合併後才到。屆時 finding 仍然有效,由 Claude 驗證後以
> **後續 PR** 修正(不會被忽略)。詳見下方「限制(硬規則)」。

## Review guidelines（審查準則）

這是一個台股 invest 專案:Python 資料 pipeline(GitHub Actions 排程)+ React 靜態前端
(GitHub Pages)。審查 PR 時請特別檢查:

- **資料正確性**:價格/法人/基本面是否正確;盤後是否誤用過期的 TWSE `STOCK_DAY_ALL`;
  時區是否一律用 `Asia/Taipei`;空值是否被當成「真的 0」(法人=0 vs 法人=未取得 要分清楚)。
- **不可修改現有 Python**:除非 PR 描述載明使用者明確授權,否則核心 `.py`(main/data_loader/
  strategy/market_predictor… )不應被改;功能改進應在 `web/` 或 `build-data.mjs`。
- **安全**:任何把外部資料(新聞 RSS、Notion、API 回應)放進 `href`/`innerHTML` 的地方要做
  scheme/sanitize 檢查;不得新增會洩漏或硬編 secrets / API key / token 的程式。
- **前端為加法**:對 Dashboard/PredictionPanel 應是新增,不破壞既有邏輯;動畫用 anime.js。
  (2026-11-16 使用者明確指示移除「新聞」分頁與 `NewsFeed.jsx`,該元件已不存在;
   資料層 `news` / `news_sentiment` 保留不動。詳見 CLAUDE.md「前端修改原則」。)
- **股票安全**:不得有自動下單、交易 API、或「保證獲利」敘述;策略改動需附理由與風險。
- **測試與風險**:邏輯改動是否有測試;PR 描述是否說明 改了什麼/為什麼/測試/風險。

## 限制（硬規則,與 CLAUDE.md 一致）
- 合併 PR:**有條件授權**(2026-11-16 使用者明確覆寫原本的「不要自動 merge」;
  2026-11-17 使用者進一步指示「不用經過 codex」)。
  Claude 僅可合併自己開的 PR,且必須同時滿足:**①CI 全綠 ②無 merge conflict**。
  **不必等 Codex / 其他 review bot 的 review 回來**(原條件「無未解決的 review finding」已取消)。
  但「不等」不等於「忽視」:合併前已出現的 finding 仍要驗證並處理,
  合併後才出現的以後續 PR 修正。
  任一項不成立即停下詢問使用者。他人開的 PR 一律不碰。
  完整條文見 CLAUDE.md「自動化代理規則」。
- 不改現有 Python,除非使用者明確授權。
  已用掉的一次性授權(2026-11-17):`outcome_tracker.py` 的 TOP20 快照日錯位、
  四個 workflow 吞掉 `git push` 失敗、`kline_fetch.py` 的週/月 K 上限與大小守門。
  **僅限這三項且已執行完畢**,不延伸到其他 Python 檔案。詳見 CLAUDE.md「核心原則」。
- 不要直接改 `main`;所有修改走 branch + PR。
- 不要讀取、輸出或修改任何 secrets / token / API key。
- 不要刪除 `output/`、`models/`、`training_data/` 等資料。
