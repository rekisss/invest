// Fugle MarketData live-quote layer for the AI trader's intraday view.
//
// Design constraints this file works within:
// - The site is a static public page: the user's Fugle API key and Discord
//   webhook live ONLY in localStorage on their own device — never in code,
//   never sent anywhere except to Fugle / Discord directly.
// - WebSocket is the primary transport because the WS handshake is not
//   subject to browser CORS (the REST endpoints may be, depending on Fugle's
//   headers). REST is attempted as a best-effort fallback for symbols beyond
//   the plan's concurrent-channel limit.
// - Everything here is read-only market data + notifications. No order API
//   is touched anywhere (per project safety rules: 不自動下單).

const KEY_STORAGE = 'fugle_api_key_v1'
const WEBHOOK_STORAGE = 'discord_webhook_url_v1'
const FIRED_STORAGE = 'live_alerts_fired_v1'

export function getFugleKey() { try { return localStorage.getItem(KEY_STORAGE) || '' } catch { return '' } }
export function setFugleKey(k) { try { k ? localStorage.setItem(KEY_STORAGE, k.trim()) : localStorage.removeItem(KEY_STORAGE) } catch { /* private mode */ } }
export function getDiscordWebhook() { try { return localStorage.getItem(WEBHOOK_STORAGE) || '' } catch { return '' } }
export function setDiscordWebhook(u) { try { u ? localStorage.setItem(WEBHOOK_STORAGE, u.trim()) : localStorage.removeItem(WEBHOOK_STORAGE) } catch { /* private mode */ } }

// ── Once-per-day alert dedupe (survives reloads) ─────────────────────────────
function todayTW() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
  return p // YYYY-MM-DD
}
function loadFired() {
  try {
    const raw = JSON.parse(localStorage.getItem(FIRED_STORAGE) || '{}')
    if (raw.date !== todayTW()) return { date: todayTW(), keys: [] }
    return raw
  } catch { return { date: todayTW(), keys: [] } }
}
export function alreadyFired(key) { return loadFired().keys.includes(key) }
export function markFired(key) {
  const cur = loadFired()
  if (!cur.keys.includes(key)) {
    cur.keys.push(key)
    try { localStorage.setItem(FIRED_STORAGE, JSON.stringify(cur)) } catch { /* ignore */ }
  }
}

// ── Discord notify (fire-and-forget) ─────────────────────────────────────────
// FormData + no-cors = a "simple request": no preflight, delivered even if
// Discord omits CORS headers. We can't read the response — the panel's 測試
// button lets the user confirm delivery in their channel.
export function notifyDiscord(content) {
  const url = getDiscordWebhook()
  if (!url || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) return false
  try {
    const fd = new FormData()
    fd.append('payload_json', JSON.stringify({ content }))
    fetch(url, { method: 'POST', body: fd, mode: 'no-cors' }).catch(() => {})
    return true
  } catch { return false }
}

// ── Fugle WebSocket client ───────────────────────────────────────────────────
// Usage:
//   const client = createFugleClient({
//     onQuote: (symbol, { price, changePct, time }) => {},
//     onStatus: (status) => {},   // 'connecting'|'live'|'error'|'closed'|'auth_failed'
//   })
//   client.watch(['2330', '2603'])   // idempotent, re-callable with new list
//   client.close()
const WS_URL = 'wss://api.fugle.tw/marketdata/v1.0/stock/streaming'

export function createFugleClient({ onQuote, onStatus }) {
  let ws = null
  let wanted = []            // symbols we want subscribed (priority order)
  let subscribed = new Set()
  let closedByUser = false
  let retries = 0
  let reconnectTimer = null

  const status = (s, detail) => { try { onStatus?.(s, detail) } catch { /* ui */ } }

  function connect() {
    const apikey = getFugleKey()
    if (!apikey) { status('no_key'); return }
    closedByUser = false
    status('connecting')
    try { ws = new WebSocket(WS_URL) } catch (e) { status('error', String(e?.message || e)); return }

    ws.onopen = () => {
      ws.send(JSON.stringify({ event: 'auth', data: { apikey } }))
    }
    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      const event = msg.event
      if (event === 'authenticated') {
        retries = 0
        status('live')
        resubscribe()
        return
      }
      if (event === 'error') {
        const errMsg = String(msg.data?.message || msg.message || '')
        // invalid key → don't hammer reconnects
        if (/auth|apikey|unauthor/i.test(errMsg)) { status('auth_failed', errMsg); closedByUser = true; try { ws.close() } catch { /* noop */ } }
        // channel/subscription limit → mark and let the UI show REST/靜態 fallback
        else status('limited', errMsg)
        return
      }
      if (event === 'subscribed') {
        const subs = Array.isArray(msg.data) ? msg.data : [msg.data]
        for (const s of subs) if (s?.symbol) subscribed.add(String(s.symbol))
        return
      }
      if (event === 'data' || event === 'snapshot') {
        const d = msg.data || {}
        const symbol = String(d.symbol || '')
        if (!symbol) return
        // trades channel: price on d.price; aggregates: d.lastPrice / d.close
        const price = d.price ?? d.lastPrice ?? d.close ?? d.lastTrade?.price
        if (price == null || !(price > 0)) return
        const changePct = d.changePercent ?? null
        try { onQuote?.(symbol, { price: Number(price), changePct: changePct != null ? Number(changePct) : null, time: Date.now() }) } catch { /* ui */ }
      }
    }
    ws.onclose = () => {
      subscribed = new Set()
      if (closedByUser) { status('closed'); return }
      // backoff reconnect: 2s, 4s, 8s … capped 60s
      const delay = Math.min(60000, 2000 * 2 ** Math.min(retries++, 5))
      status('reconnecting', delay)
      reconnectTimer = setTimeout(connect, delay)
    }
    ws.onerror = () => { /* onclose follows and handles retry */ }
  }

  function resubscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    for (const sym of wanted) {
      if (subscribed.has(sym)) continue
      try { ws.send(JSON.stringify({ event: 'subscribe', data: { channel: 'trades', symbol: sym } })) } catch { /* closed */ }
    }
  }

  return {
    watch(symbols) {
      wanted = [...new Set((symbols || []).map(String))]
      if (!ws || ws.readyState === WebSocket.CLOSED) connect()
      else resubscribe()
    },
    close() {
      closedByUser = true
      clearTimeout(reconnectTimer)
      try { ws?.close() } catch { /* noop */ }
      ws = null
    },
    isSubscribed(sym) { return subscribed.has(String(sym)) },
  }
}

// ── 批次即時報價(給 useLivePrices 當最優先資料源)────────────────────────────
// 準確度背景:TWSE OpenAPI 的 STOCK_DAY_ALL 是「日收盤」資料集,盤中打它拿到
// 的是前一交易日的價格 → 即時盯盤顯示不準。有富果金鑰時改以富果為第一優先。
// 策略:先試 snapshot(TSE+OTC 各 1 請求涵蓋全市場);方案不支援或失敗時,
// 退回逐檔 quote(限 15 檔/輪,守住免費方案 60 req/min);CORS 或網路錯誤一律
// 靜默回空物件,讓既有 TWSE/快取層接手 — 不會比現在更差。
// 429 冷卻:撞到 Fugle 免費方案速率上限(60 req/min)後,60 秒內跳過富果層
// 讓配額回復,期間由快取/TWSE 層接手。沒有冷卻的話每 15 秒輪詢會持續撞牆,
// 整個盤中富果層永遠失敗(2026-07-20 使用者回報「即時報價一直失敗」的根因)。
let fugleCooldownUntil = 0

export async function fetchFugleQuotes(ids) {
  const apikey = getFugleKey()
  if (!apikey || !ids?.length) return {}
  if (Date.now() < fugleCooldownUntil) return {}
  let saw429 = false
  const setCooldown = () => {
    fugleCooldownUntil = Date.now() + 60_000
    console.warn('[fugle] 429 rate limited — 富果層冷卻 60 秒,改用快取報價')
  }
  const idSet = new Set(ids.map(String))
  const out = {}
  const mapQuote = (d) => {
    const price = d.lastPrice ?? d.closePrice ?? d.lastTrade?.price
    if (!(price > 0)) return null
    const prev = d.previousClose ?? d.referencePrice ?? null
    // volume 需為「股」(LiveMonitor 以 /1000 轉張)。逐檔 quote 為 total.tradeVolume,
    // snapshot 為扁平 tradeVolume——兩種來源都涵蓋,避免其中一種永遠顯示 0 張。
    const vol = d.total?.tradeVolume ?? d.tradeVolume ?? null
    return {
      price: Number(price),
      prevClose: prev != null ? Number(prev) : null,
      pct: d.changePercent != null ? Number(d.changePercent) / 100
        : (prev > 0 ? (Number(price) - prev) / prev : null),
      high: d.highPrice != null ? Number(d.highPrice) : null,
      low: d.lowPrice != null ? Number(d.lowPrice) : null,
      open: d.openPrice != null ? Number(d.openPrice) : null,
      volume: vol != null ? Number(vol) : 0,
      time: new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' }),
      isSnapshot: false,
      source: 'fugle',
    }
  }
  const perSymbol = async () => {
    // 逐檔 quote(並行,守住免費方案 60 req/min → 上限 20 檔/輪)。並行比循序快
    // 一個數量級(10 檔:10 次循序來回 → 1 波並行)。
    const syms = [...idSet].slice(0, 20)
    const results = await Promise.all(syms.map(sym =>
      fetch(`https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${sym}`, {
        headers: { 'X-API-KEY': apikey },
      }).then(r => { if (r.status === 429) saw429 = true; return r.ok ? r.json() : null })
        .then(j => [sym, j ? mapQuote(j) : null]).catch(() => [sym, null])
    ))
    for (const [sym, q] of results) if (q) out[sym] = q
    return out
  }
  try {
    // 速率預算:免費方案 60 req/min,useLivePrices 每 15 秒一輪(4 輪/分),
    // 還要留餘裕給 WS、背景監控、AI 面板共用同一把金鑰。
    // ≤8 檔逐檔並行(最多 32 req/min);9 檔以上改走 snapshot(固定 2 req/輪
    // = 8 req/min,任何清單大小都安全)。舊門檻 20 檔會到 80 req/min → 整個
    // 盤中連環 429,即時報價全面失敗。
    if (idSet.size <= 8) {
      const r = await perSymbol()
      if (saw429) setCooldown()
      return r
    }
    // snapshot 兩個請求涵蓋上市+上櫃全部,與清單大小無關。
    let snapshotOk = false
    for (const market of ['TSE', 'OTC']) {
      const res = await fetch(`https://api.fugle.tw/marketdata/v1.0/stock/snapshot/quotes/${market}`, {
        headers: { 'X-API-KEY': apikey },
      })
      if (!res.ok) { if (res.status === 429) saw429 = true; break } // 方案不含 snapshot(401/403)→ 改走逐檔
      const body = await res.json()
      for (const d of (body.data || [])) {
        const sym = String(d.symbol || '')
        if (!idSet.has(sym)) continue
        const q = mapQuote(d)
        if (q) out[sym] = q
      }
      snapshotOk = true
    }
    if (saw429) { setCooldown(); return out }
    if (snapshotOk && Object.keys(out).length) return out
    const r = await perSymbol() // snapshot 不可用(非 429)→ 逐檔並行(前 20 檔)
    if (saw429) setCooldown()
    return r
  } catch { /* CORS / 網路失敗 → 空物件,讓既有層接手 */ }
  return out
}

// ── REST fallback (best-effort; may be CORS-blocked in some browsers) ────────
export async function fetchFugleQuote(symbol) {
  const apikey = getFugleKey()
  if (!apikey) return null
  try {
    const res = await fetch(`https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${symbol}`, {
      headers: { 'X-API-KEY': apikey },
    })
    if (!res.ok) return null
    const d = await res.json()
    const price = d.closePrice ?? d.lastPrice ?? d.previousClose
    if (price == null || !(price > 0)) return null
    return { price: Number(price), changePct: d.changePercent != null ? Number(d.changePercent) : null, time: Date.now() }
  } catch { return null }
}
