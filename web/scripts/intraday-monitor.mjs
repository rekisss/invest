// 盤中觸價背景監控 — 由外部排程(cron-job.org)透過 workflow_dispatch 觸發。
//
// 每次執行:
//   1. 從已部署的 GitHub Pages 抓 data.json(觀察清單 = AI 持倉 + 進場候選,
//      與前端 LiveTraderPanel 同一來源、同一套觸價規則)
//   2. 用 Fugle MarketData REST 抓觀察清單即時報價(FUGLE_API_KEY)
//   3. 觸及停利 / 停損 / 突破 20 日高 → 發 Discord 通知(DISCORD_WEBHOOK_URL)
//   4. 已通知的 (事件,股票) 記在狀態檔(workflow 用 actions/cache 跨執行保存),
//      每檔每事件每日最多通知一次
//
// 設計約束:
// - 不接任何下單 API(專案硬規則:不自動下單),只做行情讀取 + 通知
// - 非開盤時間直接靜默結束(外部排程可能任何時間打進來)
// - 不寫 repo、不 commit(避免每 5 分鐘觸發一次 Pages 部署)
//
// 環境變數:FUGLE_API_KEY(必要)、DISCORD_WEBHOOK_URL(必要)、
//   STATE_FILE(預設 .intraday_state.json)、FORCE_RUN=1(略過開盤時間檢查,測試用)、
//   DRY_RUN=1(不真的發 Discord,列印訊息,測試用)

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const DATA_URL = process.env.DATA_URL || 'https://rekisss.github.io/invest/data.json'
const STATE_FILE = process.env.STATE_FILE || '.intraday_state.json'
const FUGLE_KEY = process.env.FUGLE_API_KEY || ''
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || ''
const DRY = process.env.DRY_RUN === '1'
const MAX_CANDIDATES = 4

// ── 開盤時間檢查(Asia/Taipei,週一到週五 09:00–13:35)─────────────────────
function taipeiNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date())
  const get = t => parts.find(p => p.type === t)?.value
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    weekday: get('weekday'),
  }
}
const now = taipeiNow()
const isWeekday = !['Sat', 'Sun'].includes(now.weekday)
const inSession = now.minutes >= 9 * 60 && now.minutes <= 13 * 60 + 35
if (!(isWeekday && inSession) && process.env.FORCE_RUN !== '1') {
  console.log(`非開盤時間(台北 ${now.date} ${now.weekday} ${Math.floor(now.minutes / 60)}:${String(now.minutes % 60).padStart(2, '0')}),跳過。`)
  process.exit(0)
}
if (!FUGLE_KEY) { console.error('缺 FUGLE_API_KEY,結束。'); process.exit(0) }

// ── 每日一次通知去重狀態 ─────────────────────────────────────────────────────
let state = { date: now.date, keys: [] }
try {
  if (existsSync(STATE_FILE)) {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (s.date === now.date && Array.isArray(s.keys)) state = s
  }
} catch { /* 壞檔就重來 */ }

// ── 觀察清單(與 LiveTraderPanel 相同邏輯)──────────────────────────────────
console.log(`抓取 ${DATA_URL} ...`)
let data
try {
  if (DATA_URL.startsWith('/')) {
    data = JSON.parse(readFileSync(DATA_URL, 'utf8')) // 本機測試用
  } else {
    const res = await fetch(DATA_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data = await res.json()
  }
} catch (e) {
  console.error(`data.json 抓取失敗:${e.message}`)
  process.exit(1)
}
const ai = data.aiTrader
const latestScan = data.scans?.[data.dates?.[0]] || {}

function high20Of(s) {
  const bars = s.price_history
  if (Array.isArray(bars) && bars.length >= 5) {
    let h = 0
    for (const b of bars.slice(-20)) if ((b.high ?? b.close ?? 0) > h) h = b.high ?? b.close
    if (h > 0) return Math.round(h * 100) / 100
  }
  if (s.close > 0 && s.gap_to_20d_high_pct != null && s.gap_to_20d_high_pct >= 0) {
    return Math.round(s.close * (1 + s.gap_to_20d_high_pct / 100) * 100) / 100
  }
  return null
}

const positions = (ai?.positions || []).map(p => ({
  sym: String(p.stock_id), name: p.name, entry: p.entry, tp: p.tp_price, sl: p.sl_price,
}))
const held = new Set(positions.map(p => p.sym))
const candidates = (latestScan.top_stocks || [])
  .filter(s => s.entry_signal && !held.has(String(s.stock_id)))
  .sort((a, b) => (b.entry_score || 0) - (a.entry_score || 0))
  .slice(0, MAX_CANDIDATES)
  .map(s => ({ sym: String(s.stock_id), name: s.name, high20: high20Of(s) }))

console.log(`觀察清單:持倉 ${positions.length} 檔 + 候選 ${candidates.length} 檔`)
if (!positions.length && !candidates.length) { console.log('無標的可監控,結束。'); process.exit(0) }

// ── Fugle REST 報價 ──────────────────────────────────────────────────────────
const FUGLE_BASE = process.env.FUGLE_BASE || 'https://api.fugle.tw/marketdata/v1.0'
async function quoteOf(sym) {
  try {
    const res = await fetch(`${FUGLE_BASE}/stock/intraday/quote/${sym}`, {
      headers: { 'X-API-KEY': FUGLE_KEY },
    })
    if (!res.ok) { console.warn(`  ${sym} 報價失敗 HTTP ${res.status}`); return null }
    const d = await res.json()
    // 盤中 lastPrice 為最新成交價;closePrice 收盤後才有定值(與前端一致)
    const price = d.lastPrice ?? d.closePrice ?? d.lastTrade?.price
    return price > 0 ? Number(price) : null
  } catch (e) { console.warn(`  ${sym} 報價失敗:${e.message}`); return null }
}

async function notify(content) {
  if (DRY) { console.log(`[DRY] ${content}`); return }
  try {
    await fetch(WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  } catch (e) { console.warn(`Discord 通知失敗:${e.message}`) }
}

let fired = 0
async function fire(key, text) {
  if (state.keys.includes(key)) return
  state.keys.push(key)
  fired++
  console.log(`觸發:${text}`)
  await notify(text)
}

// ── 觸價判斷(規則與 paper-trader / LiveTraderPanel 一致)───────────────────
for (const p of positions) {
  const price = await quoteOf(p.sym)
  if (price == null) continue
  console.log(`  持倉 ${p.sym} ${p.name}:${price}(停利 ${p.tp} / 停損 ${p.sl})`)
  if (p.tp != null && price >= p.tp) {
    await fire(`tp:${p.sym}`, `🤖 **AI虛擬停利觸發**(背景)|${p.sym} ${p.name} 即時價 ${price} ≥ 停利價 ${p.tp}(+8%)。正式紀錄於今晚資料更新入帳;若有跟單可自行決定是否獲利了結。`)
  } else if (p.sl != null && price <= p.sl) {
    await fire(`sl:${p.sym}`, `⚠️ **AI虛擬停損觸發**(背景)|${p.sym} ${p.name} 即時價 ${price} ≤ 停損價 ${p.sl}(−12%)。正式紀錄於今晚資料更新入帳。`)
  } else if (p.tp != null && price >= p.tp * 0.99) {
    await fire(`near_tp:${p.sym}`, `📈 **接近停利**(背景)|${p.sym} ${p.name} 即時價 ${price},距停利價 ${p.tp} 不到 1%。`)
  }
}
for (const c of candidates) {
  if (c.high20 == null) continue
  const price = await quoteOf(c.sym)
  if (price == null) continue
  console.log(`  候選 ${c.sym} ${c.name}:${price}(20日高 ${c.high20})`)
  if (price >= c.high20) {
    await fire(`bo:${c.sym}`, `🚀 **突破警示**(背景)|${c.sym} ${c.name} 即時價 ${price} 越過 20 日高點 ${c.high20}(AI 進場候選第一線)。`)
  }
}

writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8')
console.log(`完成:本輪新觸發 ${fired} 則,今日累計 ${state.keys.length} 則。`)
