import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recomputeRealHits } from './outcome-fix.mjs'

// 重現 2026-08 現場資料:漲跌點數缺正負號 → actual_up 全 True → hit 虛高。
// 指數 07-24→07-27 實際大跌(44850→43654)但原 hit=True。
const buggy = () => [
  { date: '2026-07-22', xgb_prob_up: 0.222, taiex_close: 44232.87, actual_up: true, hit: false },
  { date: '2026-07-23', xgb_prob_up: 0.508, taiex_close: 44825.78, actual_up: true, hit: null },
  { date: '2026-07-24', xgb_prob_up: 0.508, taiex_close: 44850.81, actual_up: true, hit: null },
  { date: '2026-07-27', xgb_prob_up: 0.567, taiex_close: 43654.84, actual_up: true, hit: true },
  { date: '2026-07-28', xgb_prob_up: 0.615, taiex_close: 43634.19, actual_up: true, hit: true },
  { date: '2026-07-29', xgb_prob_up: 0.582, taiex_close: 41603.36, actual_up: true, hit: true },
  { date: '2026-07-30', xgb_prob_up: 0.58,  taiex_close: 40039.18, actual_up: true, hit: true },
]

test('recomputes direction from close series and fixes inflated hits', () => {
  const rec = buggy()
  const flipped = recomputeRealHits(rec)
  const byDate = Object.fromEntries(rec.map(e => [e.date, e]))
  // 07-27~07-30 全部偏多、實際下跌 → 全部改為 miss
  for (const d of ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30']) {
    assert.equal(byDate[d].actual_up, false, `${d} 應為跌`)
    assert.equal(byDate[d].hit, false, `${d} 應為未命中`)
  }
  // 07-27~30 由 true→false(4 筆)+ 07-22 由 false→null(首筆無前值不可打分)= 5 筆翻正
  assert.equal(flipped, 5)
  const scored = rec.filter(e => e.hit != null)
  assert.equal(scored.filter(e => e.hit).length, 0) // 修正後命中 0
  assert.equal(scored.length, 4)                    // 07-22(無前值)與 07-23/24(中性)不計
})

test('first record (no previous close) is unscored', () => {
  const rec = buggy()
  recomputeRealHits(rec)
  assert.equal(rec[0].actual_up, null)
  assert.equal(rec[0].hit, null)
})

test('neutral band ±0.05 stays unscored', () => {
  const rec = [
    { date: '2026-07-01', xgb_prob_up: 0.6, taiex_close: 100 },
    { date: '2026-07-02', xgb_prob_up: 0.52, taiex_close: 110 }, // |0.52-0.5|=0.02 ≤ 0.05 → None
  ]
  recomputeRealHits(rec)
  assert.equal(rec[1].hit, null)
})

test('a genuinely correct bullish call is scored as hit', () => {
  const rec = [
    { date: '2026-07-01', xgb_prob_up: 0.6, taiex_close: 100 },
    { date: '2026-07-02', xgb_prob_up: 0.62, taiex_close: 105 }, // 偏多且漲 → hit
    { date: '2026-07-03', xgb_prob_up: 0.30, taiex_close: 102 }, // 偏空且跌 → hit
  ]
  recomputeRealHits(rec)
  assert.equal(rec[1].hit, true)
  assert.equal(rec[1].actual_up, true)
  assert.equal(rec[2].hit, true)
  assert.equal(rec[2].actual_up, false)
})

test('recomputes signed change/pct from close diff', () => {
  const rec = buggy()
  recomputeRealHits(rec)
  const e = rec.find(x => x.date === '2026-07-27')
  assert.equal(e.taiex_change, +(43654.84 - 44850.81).toFixed(2)) // 負值
  assert.ok(e.taiex_pct < 0)
})

test('guards non-array input', () => {
  assert.equal(recomputeRealHits(null), 0)
  assert.equal(recomputeRealHits(undefined), 0)
})

// ── 期距打分 ─────────────────────────────────────────────────────────────────
import { scoreHorizonHits } from './outcome-fix.mjs'

const closes = seq => seq.map(([c, p], i) => ({
  date: `2026-07-${String(i + 1).padStart(2, '0')}`, taiex_close: c, xgb_prob_up: p,
}))

test('horizon scoring judges at the 5th trading day, not the next day', () => {
  // 隔天跌,但第 5 個交易日大漲 → 偏多預測應命中
  const recs = closes([[100, 0.65], [98, 0.5], [97, 0.5], [99, 0.5], [101, 0.5], [105, 0.5]])
  scoreHorizonHits(recs)
  assert.equal(recs[0].hit_h5, true)
  assert.equal(recs[0].ret_h5, 5)
})

test('horizon scoring leaves immature records unscored', () => {
  const recs = closes([[100, 0.65], [101, 0.7], [102, 0.3]])
  scoreHorizonHits(recs)
  assert.ok(recs.every(e => e.hit_h5 === null), '期距未到不可打分')
})

test('horizon scoring skips neutral predictions and honours the 0.3% threshold', () => {
  const neutral = closes([[100, 0.52], [101, 0.5], [102, 0.5], [103, 0.5], [104, 0.5], [110, 0.5]])
  scoreHorizonHits(neutral)
  assert.equal(neutral[0].hit_h5, null)
  const thin = closes([[100, 0.65], [100, 0.5], [100, 0.5], [100, 0.5], [100, 0.5], [100.2, 0.5]])
  scoreHorizonHits(thin)
  assert.equal(thin[0].hit_h5, false, '+0.2% 未達 0.3% 門檻 → 不算上漲')
})
