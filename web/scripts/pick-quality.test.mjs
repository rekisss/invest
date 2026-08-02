import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeQualityPicks } from './pick-quality.mjs'

test('keeps only entry-signal picks with positive revenue YoY, sorted by score', () => {
  const out = computeQualityPicks([
    { stock_id: '2330', name: 'A', entry_signal: true, entry_score: 80, revenue_yoy: 0.15 },
    { stock_id: '2317', name: 'B', entry_signal: true, entry_score: 92, revenue_yoy: 0.05 },
    { stock_id: '2603', name: 'C', entry_signal: true, entry_score: 70, revenue_yoy: -0.1 },  // 營收衰退 → 排除
    { stock_id: '1101', name: 'D', entry_signal: false, entry_score: 99, revenue_yoy: 0.3 },   // 非進場 → 排除
  ])
  assert.equal(out.total, 2)
  assert.deepEqual(out.items.map(i => i.stock_id), ['2317', '2330']) // 分數高在前
})

test('respects limit', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ stock_id: String(2000 + i), entry_signal: true, entry_score: i, revenue_yoy: 0.1 }))
  const out = computeQualityPicks(many, { limit: 5 })
  assert.equal(out.total, 12)
  assert.equal(out.items.length, 5)
})

test('revenue_yoy exactly 0 is excluded (needs > 0)', () => {
  assert.equal(computeQualityPicks([{ stock_id: '1', entry_signal: true, entry_score: 5, revenue_yoy: 0 }]).total, 0)
})

test('handles missing revenue_yoy and empty / bad input', () => {
  assert.equal(computeQualityPicks([{ stock_id: '1', entry_signal: true, entry_score: 5 }]).total, 0)
  assert.deepEqual(computeQualityPicks([]), { total: 0, items: [] })
  assert.deepEqual(computeQualityPicks(null), { total: 0, items: [] })
})
