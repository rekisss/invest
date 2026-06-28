# Shioaji 即時報價 streaming 服務

零延遲盯盤的後端。一台一直開著的服務，抓住 Shioaji 的 tick streaming，透過
WebSocket 即時推送給前端盯盤頁。

**只讀、不能下單**：登入只用 API key + secret，不帶 CA 憑證，所以這支程式
無法送出任何委託單。

## 架構

```
[Railway 24h 服務]  server.py
   └─ Shioaji streaming（訂閱你觀察清單的 ticks）
   └─ WebSocket  /ws  ──即時推送──▶  [盯盤頁面]  毫秒級跳動
```

## 部署到 Railway

1. 在 Railway 建一個新 service，連到這個 GitHub repo（branch 用你的開發分支或 main）。
2. **Settings → Root Directory 設成 `shioaji_stream`**（重要，否則它會在 repo 根目錄找不到 server.py）。
3. **Variables（環境變數）** 設定：
   | 變數 | 說明 |
   |---|---|
   | `SHIOAJI_API_KEY` | 永豐金 API key |
   | `SHIOAJI_SECRET_KEY` | 永豐金 API secret |
   | `STREAM_TOKEN` | 自己取一組隨機字串（例如 32 字元），前端要輸入同一組才能連 |
   | `ALLOWED_ORIGINS` | `https://rekisss.github.io`（你的 Pages 網域；多個用逗號分隔） |
   | `MAX_SUBSCRIPTIONS` | 選填，預設 190（Shioaji 個股訂閱上限約 200） |
4. Deploy。Railway 會用 `railway.json` 的 start command 啟動，healthcheck 打 `/healthz`。
5. 部署完成後，複製 Railway 給的公開網址（例如 `https://xxx.up.railway.app`）。

## 驗證

```bash
curl https://你的網址.up.railway.app/healthz
# {"ok":true,"logged_in":true,"subscribed":0}   ← logged_in 要是 true
```

`logged_in:false` 代表金鑰沒設對或 Shioaji 登入失敗，看 Railway logs。

## 前端設定

到盯盤頁（盯盤 tab）的「即時連線設定」，貼上：
- **WebSocket 網址**：`wss://你的網址.up.railway.app/ws`
- **Token**：跟 `STREAM_TOKEN` 一樣那組

存好之後盤中就會即時跳動（資料只在開盤/收盤時段有；非交易日無 tick）。

## 本機測試

```bash
cd shioaji_stream
pip install -r requirements.txt
export SHIOAJI_API_KEY=... SHIOAJI_SECRET_KEY=... STREAM_TOKEN=devtoken
python server.py            # http://localhost:8000
curl 'http://localhost:8000/healthz'
```

## 省錢:開盤時段自動啟停（cron-job.org）

台股一週只開約 22.5 小時,沒必要 24h 開著付錢。做法:**早上用 cron-job.org 叫醒、
收盤後服務自己關機**。

### 1. 收盤自動關機（服務自己處理）
在 Railway Variables 加一個:
| 變數 | 值 |
|---|---|
| `AUTO_SHUTDOWN_CST` | `13:40` |

服務會在台灣時間 13:40（收盤後）自己 `exit(0)`。因為 `railway.json` 設了
`restartPolicyType: ON_FAILURE`,乾淨結束不會被重啟 → 容器停止 → 不再計費。
（週末若還開著也會自動關。想在非交易時段測試就先別設這個變數。）

### 2. 開盤前自動開機（cron-job.org)
先拿三樣東西:
- **Railway API token**:Railway → Account Settings → Tokens → 建一個（帳號或團隊 token）
- **serviceId** 和 **environmentId**:打開你的 Railway service 頁,網址長這樣
  `railway.com/project/<projectId>/service/<serviceId>?environmentId=<envId>`,
  把 `<serviceId>` 和 `<envId>` 抄下來。

到 [cron-job.org](https://cron-job.org) 建一個 job:
- **URL**:`https://backboard.railway.com/graphql/v2`
- **Method**:`POST`
- **Headers**:
  - `Authorization: Bearer <你的 Railway token>`
  - `Content-Type: application/json`
- **Request body**（JSON）:
  ```json
  {"query":"mutation { serviceInstanceRedeploy(serviceId: \"<serviceId>\", environmentId: \"<environmentId>\") }"}
  ```
- **排程**:時區選 `Asia/Taipei`,時間 `08:55`,星期一～五。

這樣每個交易日早上 08:55 cron-job.org 會叫醒服務,登入 Shioaji 開始 streaming;
13:40 服務自己關機。每月只付約 13% 的時間。

> 驗證:cron-job.org 那筆 job 的回應若是 `{"data":{"serviceInstanceRedeploy":true}}` 就成功。

## 成本 / 注意

- Railway 免費額度有限，長時間 24h 執行可能需付費方案；非交易時段可手動停掉省錢。
- Shioaji 有訂閱數與登入次數限制；本服務只在收到前端訂閱訊息時才訂閱該檔，並有 `MAX_SUBSCRIPTIONS` 上限。
- `STREAM_TOKEN` 不是券商密鑰，但仍請保密，避免別人連線消耗你的額度。
