// fugleLive.js 速率預算測試 — 釘住 #412 修的「盤中即時報價一直失敗」根因:
// Fugle 免費方案 60 req/min,15 秒輪詢下每輪請求數必須守住預算:
//   ≤8 檔 → 逐檔並行(≤32 req/min)
//   9+ 檔 → snapshot 固定 2 req/輪(8 req/min,與清單大小無關)
//   撞 429 → 冷卻 60 秒,期間富果層直接跳過(不再連環撞牆)
// 任何人改回大清單逐檔(或拿掉冷卻)都會在這裡紅燈。
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 瀏覽器 API stub(必須在 import 模組前就位;金鑰只存在測試進程記憶體)
const store = { fugle_api_key_v1: 'unit-test-key' }
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v) },
  removeItem: (k) => { delete store[k] },
}

const calls = []
let mode = 'ok' // 'ok' | 'rate-limited' | 'snapshot-forbidden'
globalThis.fetch = async (url) => {
  calls.push(String(url))
  if (mode === 'rate-limited') return { ok: false, status: 429, json: async () => ({}) }
  if (String(url).includes('/snapshot/quotes/')) {
    if (mode === 'snapshot-forbidden') return { ok: false, status: 403, json: async () => ({}) }
    return {
      ok: true, status: 200,
      json: async () => ({ data: [
        { symbol: '2330', lastPrice: 1000, previousClose: 990, tradeVolume: 500 },
        { symbol: '2317', lastPrice: 200, previousClose: 198, tradeVolume: 300 },
      ] }),
    }
  }
  return { ok: true, status: 200, json: async () => ({ lastPrice: 100, previousClose: 99, total: { tradeVolume: 1000 } }) }
}

// WebSocket stub:記錄送出的訊息,支援手動觸發 open/authenticated
class FakeWS {
  static OPEN = 1
  constructor() { this.sent = []; this.readyState = FakeWS.OPEN; FakeWS.last = this }
  send(m) { this.sent.push(JSON.parse(m)) }
  close() { this.onclose?.() }
}
globalThis.WebSocket = FakeWS

const { fetchFugleQuotes, createFugleClient } = await import('../src/utils/fugleLive.js')

const quoteCalls = () => calls.filter(u => u.includes('/intraday/quote/')).length
const snapCalls = () => calls.filter(u => u.includes('/snapshot/quotes/')).length

test('≤8 檔:逐檔並行,一輪請求數 = 檔數', async () => {
  calls.length = 0
  const out = await fetchFugleQuotes(['1101', '1102', '2330', '2317', '2454'])
  assert.equal(quoteCalls(), 5)
  assert.equal(snapCalls(), 0)
  assert.equal(Object.keys(out).length, 5)
  assert.equal(out['2330'].price, 100)
  assert.equal(out['2330'].source, 'fugle')
})

test('9+ 檔:改走 snapshot,一輪固定 2 個請求(TSE+OTC)', async () => {
  calls.length = 0
  const ids = Array.from({ length: 12 }, (_, i) => String(1101 + i)).concat(['2330', '2317'])
  const out = await fetchFugleQuotes(ids)
  assert.equal(snapCalls(), 2)
  assert.equal(quoteCalls(), 0, '大清單不得逐檔打(速率預算)')
  assert.equal(out['2330'].price, 1000)   // snapshot 覆蓋到的檔有價
  assert.equal(out['2317'].price, 200)
})

test('snapshot 被方案拒絕(403):退回逐檔也只打 ≤8 檔,且之後不再嘗試 snapshot', async () => {
  mode = 'snapshot-forbidden'
  calls.length = 0
  const ids = Array.from({ length: 12 }, (_, i) => String(2101 + i))
  const out1 = await fetchFugleQuotes(ids)
  const q1 = calls.filter(u => u.includes('/intraday/quote/')).length
  assert.equal(snapCalls(), 1, '403 後同輪不再打第二個 snapshot')
  assert.ok(q1 <= 8, `退回逐檔一輪最多 8 檔(2026-07-21 盯盤仍失敗的殘餘路徑):${q1}`)
  assert.ok(Object.keys(out1).length >= 1)

  // 第二輪:記住 snapshot 不可用 → 零 snapshot 請求;輪替視窗涵蓋其餘檔
  calls.length = 0
  const out2 = await fetchFugleQuotes(ids)
  assert.equal(snapCalls(), 0, '之後不再浪費 snapshot 請求')
  const round2 = calls.filter(u => u.includes('/intraday/quote/')).map(u => u.split('/').pop())
  assert.ok(round2.length <= 8)
  const round1 = new Set(Object.keys(out1))
  assert.ok(round2.some(s => !round1.has(s)), '輪替視窗要涵蓋上一輪沒更新的檔')
  mode = 'ok'
})

test('WS 訂閱不超過免費方案 5 頻道,且依 wanted 順序(持倉優先)', () => {
  const client = createFugleClient({ onQuote: () => {}, onStatus: () => {} })
  client.watch(['2206', '3356', '2330', '2317', '2454', '1101', '1102']) // 7 檔
  const ws = FakeWS.last
  ws.onopen()                                                        // → 送 auth
  ws.onmessage({ data: JSON.stringify({ event: 'authenticated' }) }) // → resubscribe
  const subs = ws.sent.filter(m => m.event === 'subscribe').map(m => m.data.symbol)
  assert.equal(subs.length, 5, `超過 5 檔會被 Fugle 拒絕:${JSON.stringify(subs)}`)
  assert.deepEqual(subs, ['2206', '3356', '2330', '2317', '2454'], '必須照 wanted 順序取前 5(持倉在前)')
  client.close()
})

test('撞 429:回空並進入冷卻,下一輪完全不打富果', async () => {
  mode = 'rate-limited'
  calls.length = 0
  const out = await fetchFugleQuotes(['1101', '1102'])
  assert.deepEqual(out, {})
  assert.ok(calls.length > 0, '第一輪有嘗試')

  calls.length = 0
  mode = 'ok'
  const out2 = await fetchFugleQuotes(['1101', '1102'])
  assert.deepEqual(out2, {}, '冷卻期間直接跳過')
  assert.equal(calls.length, 0, '冷卻期間不得發出任何富果請求')
})
