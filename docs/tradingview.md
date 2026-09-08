# TradingView 接入說明

> 寫這份的原因:「用 TradingView 當即時報價來源」是個很自然但**行不通**的想法。
> 這裡記錄查證結果,避免之後再花時間重走一次。

## 結論先講

| 想做的事 | 可行? | 用什麼 |
|---|---|---|
| 網站顯示 TradingView 互動圖表 | ✅ | 官方嵌入 widget(`TradingViewChart.jsx`) |
| 網站抓 TradingView 即時報價數字 | ❌ | 不可能 —— 改用富果 / Shioaji |
| 對話中讓 Claude 查報價 | ⚠️ 可以,但拿到的不是 TradingView 的資料 | `.mcp.json` 的 `tradingview` server |

## 為什麼拿不到 TradingView 的報價 API

TradingView 是**資料被授權方,不是資料擁有者**。即時價格來自各交易所與資料商,
授權合約禁止它再轉授權出去。所以官方只有兩種程式化介面:

1. **Charting Library / 嵌入 widget** —— 純顯示,不給你原始資料
2. **Broker REST API** —— 給券商申請串接用(OAuth2/JWT),**沒有零售版**

**任何零售訂閱方案(含月付方案)都不含報價 API。** 訂閱買到的是 App 端功能:
更多指標、更多 alert、無廣告、分鐘線週期。

網路上搜到的「TradingView API / TradingView MCP」一律是第三方,做法只有兩種:

- 打 TradingView **內部未公開端點**(需要你的帳密/session cookie,違反 ToS,隨時會壞)
- 掛 TradingView 的名字,實際資料來自別家(常見是 Yahoo Finance)

## MCP ≠ 網站資料源

這點很容易混淆:MCP 是給 **AI 助理**(Claude、Cursor)呼叫工具的協定。
`web/` 是靜態站,跑在使用者瀏覽器裡 —— **瀏覽器無法連 MCP server**。

裝 MCP 的效果是「在對話中可以問 Claude 報價」,不會讓 Dashboard 多出即時資料。

## 目前的設定

### 1. 圖表 widget — `web/src/components/TradingViewChart.jsx`

官方免費嵌入,不需 API key。掛在 `StockDetailModal` 的「TradingView 圖表」Section。

- **預設收合,按下才注入 script** —— 不要每次開個股 Modal 都去打第三方
- 台股代號自動對應 `TWSE:` / `TPEX:` 前綴
- 支援 15分/60分/日/週/月 切換
- 載入失敗(廣告阻擋器、CSP)會退回「在 TradingView 開啟」連結
- ⚠️ **widget 的台股報價是延遲的** —— 即時需另購台交所 realtime add-on(交易所
  資料費,不含在一般訂閱裡)。所以它只當技術分析畫布用,**價格數字一律以
  富果/Shioaji 層為準**

### 2. MCP — `.mcp.json` 的 `tradingview`

用 `tradingview-mcp-server`(PyPI,MIT)。選它的理由:**不需要 TradingView
帳號或任何憑證**,符合專案「不碰 secrets」規則。

```json
"tradingview": {
  "command": "uvx",
  "args": ["--from", "tradingview-mcp-server", "tradingview-mcp"]
}
```

需要本機有 `uv`/`uvx`,且首次使用要在互動式 session 授權。

安裝 uv:

```powershell
# Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```
```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

之後在專案目錄開 Claude Code,它會提示授權 `.mcp.json` 裡的專案 MCP server,
用 `/mcp` 可確認連線狀態。**不需要 TradingView 帳號、API key 或任何憑證。**

**實測結果(v1.29.1,37 個工具):**

- 台股走 TradingView 的公開 screener 端點 `scanner.tradingview.com/taiwan/scan`,
  代號格式 `TWSE:2330` / `TPEX:6488` —— **不是** Yahoo
- `yahoo_price` 是另一個獨立工具(用 `2330.TW` 格式),Yahoo 對機房 IP 會回 403,
  在家用網路才穩
- 主要工具:`stock_prices`(注意參數名是 `tickers`,且要**逗號分隔字串**不是陣列)、
  `coin_analysis`、`stock_screener`、`backtest_strategy`、`compare_strategies`
  (9 種策略)、`multi_timeframe_analysis`、`futures_*`(CME/COMEX/NYMEX/CBOT)

仍要注意:screener 給的是**延遲**報價,盤中即時價仍以富果/Shioaji 為準。
它的價值在 backtest、技術指標評分、跨市場(美股/期貨/加密貨幣)這類對話式分析。

## 台股即時報價的真正主力

`web/src/hooks/useLivePrices.js` 的多層降級鏈:

```
富果 WS/REST(有金鑰時最優先) → Shioaji 券商快取 → GitHub Actions 快取
  → TWSE/TPEX 官方 OpenAPI(最後退路)
```

⚠️ 最後那層的 `STOCK_DAY_ALL` 是**日收盤**資料集 —— 盤中打它回的是前一交易日的
價。所以盤中降級到該層時,UI 會明講「前一交易日收盤」,不會假裝是即時價。

要真正的盤中即時價,**必須設富果金鑰**(Dashboard 的 API 設定,存 localStorage,
不進 build)。
