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
