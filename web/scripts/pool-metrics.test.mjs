// 全池指標測試 — 補齊 filter_stocks 缺少欄位的算式。
//
// 釘住的重點:
//   1. ATR 用標準 True Range 定義(含跳空),不是單純的高低差
//   2. 成交金額用「量×價」,不是股數 —— 只看股數會把高價低量股誤判成沒流動性
//   3. 掃描列已有的值不被覆蓋(top_stocks 自己算的比回推精確)
//   4. 缺資料時不排除股票(否則濾網會變成與流動性無關的偏誤)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  atr, highN, turnover, enrichFromBars, isTradable, MIN_TURNOVER, ATR_PERIOD,
} from './pool-metrics.mjs'

// 造 n 根固定形狀的 bar
const bars = (specs) => specs.map((s, i) => ({
  time: `2026-01-${String(i + 1).padStart(2, '0')}`,
  open: s.o ?? s.c, high: s.h ?? s.c, low: s.l ?? s.c, close: s.c,
  volume: s.v ?? 1000,
}))
// 15 根:前 14 根平盤 100,方便手算
const flat = (n, c = 100, v = 1000) => bars(Array.from({ length: n }, () => ({ c, h: c, l: c, v })))

test('ATR 需要 period+1 根,不足回 null', () => {
  assert.equal(atr(flat(ATR_PERIOD)), null, '只有 14 根時沒有第一根的前收')
  assert.notEqual(atr(flat(ATR_PERIOD + 1)), null)
  assert.equal(atr(null), null)
  assert.equal(atr([]), null)
})

test('完全平盤的 ATR 為 0', () => {
  assert.equal(atr(flat(20)), 0)
})

test('ATR 計入跳空(True Range 不只是高低差)', () => {
  // 前 14 根收 100,最後一根整根跳空到 110~112:
  // 高低差只有 2,但 |高 − 前收| = 12 才是真實波幅
  const b = [...flat(ATR_PERIOD + 1), { time: 'x', open: 110, high: 112, low: 110, close: 111, volume: 1000 }]
  const a = atr(b, ATR_PERIOD)
  assert.ok(a > 0.5, `跳空必須反映在 ATR,實得 ${a}`)
  // 14 根裡有 1 根 TR=12、13 根 TR=0 → 平均約 0.857
  assert.ok(Math.abs(a - 12 / 14) < 0.01, `應約 ${(12 / 14).toFixed(3)},實得 ${a}`)
})

test('20 日高取最近視窗的最高價', () => {
  const b = bars([{ c: 50, h: 60 }, { c: 50, h: 55 }, { c: 50, h: 58 }])
  assert.equal(highN(b, 20), 60)
  assert.equal(highN(b, 2), 58, '視窗縮小後看不到更早的 60')
  assert.equal(highN([], 20), null)
})

test('成交金額用量×價,不是股數', () => {
  const cheap = bars([{ c: 10, v: 100000 }])   // 100 萬
  const pricey = bars([{ c: 1000, v: 100000 }]) // 1 億
  assert.equal(turnover(cheap, 1), 1_000_000)
  assert.equal(turnover(pricey, 1), 100_000_000)
  assert.ok(turnover(pricey, 1) > turnover(cheap, 1),
    '同樣股數下高價股的流動性金額必須較高 —— 只看股數會誤判')
})

test('成交金額取視窗平均,跳過缺值的 bar', () => {
  const b = [
    { time: 'a', close: 10, volume: 100000 },
    { time: 'b', close: 10, volume: null },
    { time: 'c', close: 10, volume: 300000 },
  ]
  assert.equal(turnover(b, 3), 2_000_000, '兩根有效 bar 的平均 = (100萬+300萬)/2')
})

test('enrich 補上缺的欄位,但不覆蓋掃描列已有的值', () => {
  const b = [...flat(20, 100), { time: 'z', open: 100, high: 130, low: 100, close: 120, volume: 5000 }]
  const filled = enrichFromBars({ stock_id: 'A', close: 120 }, b)
  assert.ok(filled.atr14 > 0, 'atr14 應補上')
  assert.equal(filled.close_20d_high, 130)
  assert.ok(filled.turnover_20d > 0)

  const existing = enrichFromBars({ stock_id: 'A', close: 120, atr14: 9.99, close_20d_high: 111 }, b)
  assert.equal(existing.atr14, 9.99, 'top_stocks 自帶的 atr14 比回推精確,不可覆蓋')
  assert.equal(existing.close_20d_high, 111)
})

test('enrich 由收盤與 20 日高回推到高點的距離', () => {
  const b = [...flat(20, 100), { time: 'z', open: 100, high: 110, low: 100, close: 100, volume: 5000 }]
  const f = enrichFromBars({ stock_id: 'A', close: 100 }, b)
  assert.equal(f.close_20d_high, 110)
  assert.equal(f.gap_to_20d_high_pct, 10, '收盤 100 距 20 日高 110 = 10%')
})

test('enrich 不改動原物件', () => {
  const src = { stock_id: 'A', close: 100 }
  enrichFromBars(src, flat(20))
  assert.equal('atr14' in src, false, '必須回傳新物件')
})

test('流動性濾網:低於門檻排除,缺資料不排除', () => {
  assert.equal(isTradable({ turnover_20d: MIN_TURNOVER }), true, '等於門檻要通過')
  assert.equal(isTradable({ turnover_20d: MIN_TURNOVER - 1 }), false)
  assert.equal(isTradable({ turnover_20d: 2_000_000 }), false, '日均 200 萬實質不可成交')
  assert.equal(isTradable({ turnover_20d: 500_000_000 }), true)
  assert.equal(isTradable({}), true, '沒有成交資料時不可因此排除 —— 那是與流動性無關的偏誤')
  assert.equal(isTradable({ turnover_20d: null }), true)
})

test('門檻相對於單筆投入是合理的', () => {
  // 紙上交易員 100 萬本金、最多 6 檔 → 單筆約 16.7 萬
  const perTrade = 1_000_000 / 6
  assert.ok(MIN_TURNOVER / perTrade > 50,
    `單筆不該佔日均成交太大比例,目前 1/${(MIN_TURNOVER / perTrade).toFixed(0)}`)
})
