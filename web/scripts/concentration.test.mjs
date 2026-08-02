import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeSectorConcentration } from './concentration.mjs'

const mk = (secs) => secs.map((s, i) => ({ stock_id: String(1000 + i), industry_category: s }))

test('flags over-concentration when top sector ≥ warnShare', () => {
  const c = computeSectorConcentration(mk(['半導體', '半導體', '半導體', '半導體', '金融', '航運']))
  assert.equal(c.total, 6)
  assert.equal(c.top_sector, '半導體')
  assert.equal(c.top_count, 4)
  assert.equal(c.top_share_pct, 66.7)
  assert.equal(c.warn, true)
})

test('does not flag when picks are spread out', () => {
  const c = computeSectorConcentration(mk(['半導體', '金融', '航運', '生技', '電子', '鋼鐵']))
  assert.equal(c.warn, false)
  assert.equal(c.sectors, 6)
  assert.ok(c.hhi < 0.2)
})

test('returns null when classifiable sample < minStocks', () => {
  assert.equal(computeSectorConcentration(mk(['半導體', '金融'])), null)
  assert.equal(computeSectorConcentration([]), null)
  assert.equal(computeSectorConcentration(null), null)
})

test('falls back to stock-ID sector inference when industry_category is empty', () => {
  // industry_category 空/缺 → 用股號推斷(2300-2399 半導體、2603 航運、2801 金融)
  const rows = [
    { stock_id: '2330' }, { stock_id: '2303', industry_category: '' }, { stock_id: '2344' },
    { stock_id: '2603' }, { stock_id: '2801' },
  ]
  const c = computeSectorConcentration(rows)
  assert.equal(c.total, 5)
  assert.equal(c.top_sector, '半導體')
  assert.equal(c.top_count, 3)
  assert.equal(c.warn, true)
})

test('industry_category takes precedence over inference when present', () => {
  const c = computeSectorConcentration([
    { stock_id: '2330', industry_category: '金融' },  // 明確指定,不用推斷的半導體
    { stock_id: '2801', industry_category: '金融' },
    { stock_id: '2802', industry_category: '金融' },
    { stock_id: '1101', industry_category: '水泥' },
    { stock_id: '2603', industry_category: '航運' },
  ])
  assert.equal(c.top_sector, '金融')
  assert.equal(c.top_count, 3)
})

test('hhi reflects concentration (single sector = 1.0)', () => {
  const c = computeSectorConcentration(mk(['A', 'A', 'A', 'A', 'A']))
  assert.equal(c.hhi, 1)
  assert.equal(c.top_share_pct, 100)
})

test('respects custom warnShare', () => {
  const rows = mk(['A', 'A', 'A', 'B', 'B', 'C']) // top share 50%
  assert.equal(computeSectorConcentration(rows, { warnShare: 0.6 }).warn, false)
  assert.equal(computeSectorConcentration(rows, { warnShare: 0.5 }).warn, true)
})
