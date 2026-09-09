// 即時紙上指令測試 — 「以現價重跑進出場規則」的核心邏輯。
//
// 這支模組會直接影響使用者看到「現在該賣什麼」,所以每條出場路徑(停利/停損/
// 到期)、每個邊界(剛好觸價、拿不到現價、沒空位)都要釘住。
// 規則門檻必須跟著 aiTrader.config 走 —— build 期改了規則,即時層不能還用舊門檻。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateLiveOrders, rulesFromConfig, tradingDaysBetween, FALLBACK_RULES,
} from '../src/utils/liveOrders.js'

const CFG = { take_profit_pct: 8, stop_loss_pct: 12, max_hold: 15 }
const pos = (o) => ({ stock_id: '2330', name: '台積電', entry: 100, shares: 1000, entry_date: '2026-09-01', ...o })
const priceMap = (m) => (sid) => m[String(sid)]

test('規則門檻取自 aiTrader.config,不寫死', () => {
  const r = rulesFromConfig({ take_profit_pct: 12, stop_loss_pct: 6, max_hold: 20 })
  assert.deepEqual(r, { takeProfitPct: 12, stopLossPct: 6, maxHold: 20 })
})

test('config 缺欄位時退回保底值', () => {
  assert.deepEqual(rulesFromConfig(null), {
    takeProfitPct: FALLBACK_RULES.takeProfitPct,
    stopLossPct: FALLBACK_RULES.stopLossPct,
    maxHold: FALLBACK_RULES.maxHold,
  })
})

test('刻意停用停利(null)要保留,不可當成缺值補回 8%', () => {
  const r = rulesFromConfig({ take_profit_pct: null, stop_loss_pct: 8, max_hold: 15 })
  assert.equal(r.takeProfitPct, null, '移動停損變體會停用停利,補回去等於改了規則')
})

test('觸及停利 → 產出賣出指令,標明觸發價', () => {
  const r = evaluateLiveOrders({
    positions: [pos()], priceOf: priceMap({ 2330: 108.5 }), config: CFG, today: '2026-09-05',
  })
  assert.equal(r.exits.length, 1)
  const e = r.exits[0]
  assert.equal(e.action, 'sell')
  assert.equal(e.reason, 'take_profit')
  assert.equal(e.trigger, 108, '停利價 = 進場 100 × 1.08')
  assert.equal(e.ret_pct, 8.5)
})

test('跌破停損 → 賣出,且排在停利前面(先處理虧損)', () => {
  const r = evaluateLiveOrders({
    positions: [pos({ stock_id: 'A' }), pos({ stock_id: 'B' })],
    priceOf: priceMap({ A: 109, B: 87 }), config: CFG, today: '2026-09-05',
  })
  assert.equal(r.exits.length, 2)
  assert.equal(r.exits[0].stock_id, 'B', '停損要排在停利前面')
  assert.equal(r.exits[0].reason, 'stop')
  assert.equal(r.exits[0].trigger, 88)
  assert.equal(r.exits[1].reason, 'take_profit')
})

test('剛好等於觸發價就要觸發(用 >= / <=,不是嚴格大於)', () => {
  const tp = evaluateLiveOrders({ positions: [pos()], priceOf: priceMap({ 2330: 108 }), config: CFG, today: '2026-09-05' })
  assert.equal(tp.exits[0]?.reason, 'take_profit')
  const sl = evaluateLiveOrders({ positions: [pos()], priceOf: priceMap({ 2330: 88 }), config: CFG, today: '2026-09-05' })
  assert.equal(sl.exits[0]?.reason, 'stop')
})

test('未觸及任何門檻 → 沒有指令', () => {
  const r = evaluateLiveOrders({ positions: [pos()], priceOf: priceMap({ 2330: 103 }), config: CFG, today: '2026-09-05' })
  assert.equal(r.exits.length, 0)
  assert.equal(r.stale, false, '有拿到現價就不算資料不全')
})

test('持有到期 → 時間出場', () => {
  const r = evaluateLiveOrders({
    positions: [pos({ entry_date: '2026-08-01' })],
    priceOf: priceMap({ 2330: 103 }), config: CFG, today: '2026-09-05',
  })
  assert.equal(r.exits[0]?.reason, 'time')
  assert.equal(r.exits[0].trigger, null, '時間出場沒有觸發價')
})

test('拿不到現價的部位會被標記,不會靜靜漏掉', () => {
  const r = evaluateLiveOrders({
    positions: [pos({ stock_id: 'A' }), pos({ stock_id: 'B' })],
    priceOf: priceMap({ A: 108.5 }), config: CFG, today: '2026-09-05',
  })
  assert.equal(r.exits.length, 1)
  assert.equal(r.stale, true, 'B 沒有現價 → 清單可能不完整,必須提醒')
  assert.equal(r.priced, 1)
  assert.equal(r.total, 2)
})

test('候選股突破 20 日高 → 買進指令,依期望報酬排序', () => {
  const r = evaluateLiveOrders({
    positions: [],
    watch: [
      { stock_id: 'LOW', name: '低期望', breakout_price: 50, expectancy_pct: 0.2 },
      { stock_id: 'HIGH', name: '高期望', breakout_price: 30, expectancy_pct: 1.9 },
    ],
    priceOf: priceMap({ LOW: 51, HIGH: 31 }), config: CFG, today: '2026-09-05',
  })
  assert.equal(r.entries.length, 2)
  assert.equal(r.entries[0].stock_id, 'HIGH', '期望報酬高的排前面')
  assert.equal(r.entries[0].action, 'buy')
  assert.equal(r.entries[0].trigger, 30)
})

test('沒突破就不買', () => {
  const r = evaluateLiveOrders({
    watch: [{ stock_id: 'A', breakout_price: 50 }],
    priceOf: priceMap({ A: 49.9 }), config: CFG, today: '2026-09-05',
  })
  assert.equal(r.entries.length, 0)
})

test('已持有的股票不會再出現在買進候選', () => {
  const r = evaluateLiveOrders({
    positions: [pos({ stock_id: 'A', entry: 100 })],
    watch: [{ stock_id: 'A', breakout_price: 50 }],
    priceOf: priceMap({ A: 103 }), config: CFG, today: '2026-09-05',
  })
  assert.equal(r.entries.length, 0, '已在場內的不該再出現進場訊號')
})

test('沒空位時仍列出但標記 blocked,不隱藏訊號', () => {
  const positions = Array.from({ length: 6 }, (_, i) => pos({ stock_id: `P${i}`, entry: 100 }))
  const r = evaluateLiveOrders({
    positions,
    watch: [{ stock_id: 'NEW', breakout_price: 50 }],
    priceOf: priceMap({ NEW: 51, ...Object.fromEntries(positions.map(p => [p.stock_id, 103])) }),
    config: CFG, today: '2026-09-05', maxPositions: 6,
  })
  assert.equal(r.open_slots, 0)
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0].blocked, 'no_slot', '該讓人知道是沒空位而不是沒訊號')
})

test('交易日差:跳過週末', () => {
  assert.equal(tradingDaysBetween('2026-09-04', '2026-09-07'), 1, '週五→下週一 = 1 個交易日')
  assert.equal(tradingDaysBetween('2026-09-01', '2026-09-08'), 5)
  assert.equal(tradingDaysBetween('2026-09-05', '2026-09-05'), 0)
  assert.equal(tradingDaysBetween(null, '2026-09-05'), null)
})

test('空輸入不會炸,回傳空清單', () => {
  const r = evaluateLiveOrders({})
  assert.deepEqual(r.exits, [])
  assert.deepEqual(r.entries, [])
  assert.equal(r.stale, false)
})
