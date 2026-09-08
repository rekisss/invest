// tradePlan.js — 委託票與 ATR 停損停利的單元測試。
//
// 最重要的一條是「停利價永遠高於進場價」:這個掃描器選的是突破股(實測 70.5%
// 的掃描列今收 > 20日高),量度目標若從 20日高起算,會有 17% 的候選算出
// 停利 ≤ 進場價 —— 買進的同時掛一張保證虧損的停利單。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeTargets, computeEntryLimit, buildOrderTicket, summarizeTickets,
  addTradingDaysEst, GAP_CAP_PCT, LOT_SIZE,
} from '../src/utils/tradePlan.js'

// ── computeTargets ──────────────────────────────────────────────────────────
test('關鍵回歸:突破股(今收 > 20日高)的停利價必須高於進場價', () => {
  // 5443 均豪 2026-09-07 的真實數字:舊邏輯算出停利 119.5 < 進場 120,RR −0.04
  const t = computeTargets(120, { atr14: 5.81, close_20d_high: 113.5, close_10d_low: 101.5 })
  assert.ok(t.takePrft > 120, `停利 ${t.takePrft} 必須 > 進場價 120`)
  assert.equal(t.takePrft, 126)              // max(120, 113.5) + 0.5×(113.5−101.5)
  assert.ok(t.rr > 0, 'RR 不得為負')
})

test('買價 ≤ 20日高時行為與修正前完全相同(量度目標從 h20 起算)', () => {
  const t = computeTargets(100, { atr14: 3, close_20d_high: 101, close_10d_low: 91 })
  // h20(101) 不大於 buyPrice×1.02(102) → 走量度目標;max(100,101)=101
  assert.equal(t.takePrft, 106)              // 101 + 0.5×(101−91)
  assert.match(t.tpBasis, /量度目標/)
})

test('20日高仍在上方(>買價 2%)時直接當壓力價', () => {
  const t = computeTargets(100, { atr14: 3, close_20d_high: 110, close_10d_low: 90 })
  assert.equal(t.takePrft, 110)
  assert.match(t.tpBasis, /20日高點壓力/)
})

test('停損:10日低點在 −2×ATR 之上時優先用支撐,否則用 ATR', () => {
  const support = computeTargets(100, { atr14: 3, close_20d_high: 110, close_10d_low: 96 })
  assert.equal(support.stopLoss, 96)         // 96 > 100−6 → 用支撐
  assert.match(support.stopBasis, /10日低點/)

  const atrStop = computeTargets(100, { atr14: 3, close_20d_high: 110, close_10d_low: 80 })
  assert.equal(atrStop.stopLoss, 94)         // 80 < 94 → 用 −2×ATR
  assert.match(atrStop.stopBasis, /2×ATR/)
})

test('沒有技術資料時退回固定百分比,且標明是固定值', () => {
  const t = computeTargets(100, {})
  assert.equal(t.stopLoss, 92)
  assert.ok(Math.abs(t.takePrft - 115) < 1e-9)   // 100×1.15 有浮點誤差
  assert.equal(t.grounded, false)
  assert.match(t.stopBasis, /固定值/)
})

// ── computeEntryLimit ───────────────────────────────────────────────────────
test('限價 = 跳空放棄門檻:低波動股用 0.5×ATR', () => {
  const e = computeEntryLimit(100, 2)          // 0.5×ATR = 1 → 101 < 封頂 103
  assert.equal(e.limit, 101)
  assert.equal(e.capped, false)
  assert.match(e.basis, /0\.5×ATR/)
})

test('限價 = 跳空放棄門檻:高波動股由 3% 封頂', () => {
  const e = computeEntryLimit(100, 20)         // 0.5×ATR = 10 → 110 > 封頂 103
  assert.equal(e.limit, 100 * (1 + GAP_CAP_PCT))
  assert.equal(e.capped, true)
  assert.match(e.basis, /封頂/)
})

test('沒有 ATR 時退回百分比封頂;價格非法回 null', () => {
  assert.equal(computeEntryLimit(100, null).limit, 103)
  assert.equal(computeEntryLimit(0, 2), null)
  assert.equal(computeEntryLimit(-5, 2), null)
})

// ── addTradingDaysEst ───────────────────────────────────────────────────────
test('交易日推算跳過週末(不含國定假日,故為估算下限)', () => {
  assert.equal(addTradingDaysEst('2026-09-07', 1), '2026-09-08')  // 一 → 二
  assert.equal(addTradingDaysEst('2026-09-04', 1), '2026-09-07')  // 五 → 一
  assert.equal(addTradingDaysEst('2026-09-07', 15), '2026-09-28')
})

// ── buildOrderTicket ────────────────────────────────────────────────────────
const STOCK = { stock_id: '2330', name: '台積電', entry_score: 900, grade: 'A', close: 100, atr14: 3, close_20d_high: 110, close_10d_low: 96 }

test('委託票:張數以整張計,風險金額 = (進場價 − 停損價) × 股數', () => {
  const t = buildOrderTicket(STOCK, { budget: 500000, entryDate: '2026-09-08', equity: 1000000 })
  assert.equal(t.lots, 4)                       // 500000 / (100×1000×1.001425) = 4.99 → 4
  assert.equal(t.shares, 4 * LOT_SIZE)
  assert.equal(t.sl_price, 96)
  assert.equal(t.tp_price, 110)
  assert.equal(t.risk_amount, (100 - 96) * 4000)   // 16000
  assert.equal(t.risk_pct, 1.6)
  assert.equal(t.reward_amount, (110 - 100) * 4000)
  assert.equal(t.exit_by_est, addTradingDaysEst('2026-09-08', 15))
})

test('委託票:預算不足一張時標記 lots_zero,不會算出假的風險金額', () => {
  const t = buildOrderTicket(STOCK, { budget: 50000, entryDate: '2026-09-08', equity: 1000000 })
  assert.equal(t.lots, 0)
  assert.equal(t.shares, 0)
  assert.equal(t.lots_zero, true)
  assert.equal(t.risk_amount, null)
  assert.equal(t.est_cost, 0)
})

test('委託票:風報比 < 1 會被標記出來', () => {
  // 停損寬(−2×ATR=90)、停利近(量度目標 109) → RR 0.9
  const poor = { ...STOCK, atr14: 5, close_20d_high: 101, close_10d_low: 85 }
  const t = buildOrderTicket(poor, { budget: 500000, entryDate: '2026-09-08', equity: 1000000 })
  assert.ok(t.rr < 1, `RR ${t.rr} 應 < 1`)
  assert.equal(t.rr_warn, true)

  const good = buildOrderTicket(STOCK, { budget: 500000, entryDate: '2026-09-08', equity: 1000000 })
  assert.ok(good.rr >= 1)
  assert.equal(good.rr_warn, false)
})

test('委託票:收盤價非法直接回 null(不產生無法執行的單)', () => {
  assert.equal(buildOrderTicket({ ...STOCK, close: 0 }, { budget: 1e6 }), null)
  assert.equal(buildOrderTicket({ ...STOCK, close: null }, { budget: 1e6 }), null)
  assert.equal(buildOrderTicket(null, { budget: 1e6 }), null)
})

test('委託票保留原始輸入,讓價位可被稽核', () => {
  const t = buildOrderTicket(STOCK, { budget: 500000, entryDate: '2026-09-08', equity: 1000000 })
  assert.equal(t.atr14, 3)
  assert.equal(t.close_20d_high, 110)
  assert.equal(t.close_10d_low, 96)
  assert.equal(t.sl_atr_offset, 6)
})

// ── summarizeTickets ────────────────────────────────────────────────────────
test('曝險彙總:全部觸及停損的最壞損失', () => {
  const a = buildOrderTicket(STOCK, { budget: 300000, entryDate: '2026-09-08', equity: 1000000 })
  const b = buildOrderTicket({ ...STOCK, stock_id: '2454' }, { budget: 300000, entryDate: '2026-09-08', equity: 1000000 })
  const s = summarizeTickets([a, b], 1000000)
  assert.equal(s.count, 2)
  assert.equal(s.total_risk, a.risk_amount + b.risk_amount)
  assert.equal(s.risk_pct, Math.round((a.risk_amount + b.risk_amount) / 1000000 * 100 * 100) / 100)
  assert.equal(s.rr_warn_count, 0)
})

test('曝險彙總:沒有可執行的單時回 null(不足一張的不算)', () => {
  const tiny = buildOrderTicket(STOCK, { budget: 1000, entryDate: '2026-09-08', equity: 1000000 })
  assert.equal(summarizeTickets([tiny], 1000000), null)
  assert.equal(summarizeTickets([], 1000000), null)
  assert.equal(summarizeTickets(null, 1000000), null)
})
