import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreProxyPredictions, summarizeProxy, hitForLabel, PROXY_HORIZON }
  from '../src/utils/proxyScore.js'

// 累積報酬曲線(掃描池等權),日期升冪
const curve = (rets) => rets.map((r, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, ret_pct: r }))
const pred = (day, label, prob = 0.6) => ({ date: `2026-07-${String(day).padStart(2, '0')}`, xgb_label: label, xgb_prob_up: prob })

test('scores against the 5-day cumulative return, not the next day', () => {
  // 累積:0 → -1(隔天跌)→ ... → +4(第5日明顯高於起點)
  const c = curve([0, -1, -1.5, 0, 2, 4])
  const rows = scoreProxyPredictions([pred(1, '偏多')], c)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ret, 4, '應為 5 日累積 +4%(不是隔天的 -1%)')
  assert.equal(rows[0].hit, true, '偏多且 5 日上漲 → 命中(隔天下跌不該判失敗)')
  assert.equal(rows[0].end_date, '2026-07-06')
})

test('bearish call hits when the 5-day return is clearly down', () => {
  const c = curve([0, 1, 0.5, -1, -3, -5])
  const rows = scoreProxyPredictions([pred(1, '偏空', 0.3)], c)
  assert.equal(rows[0].hit, true)
  assert.equal(rows[0].ret, -5)
})

test('neutral call hits only when the market stays flat', () => {
  const flat = scoreProxyPredictions([pred(1, '中性', 0.5)], curve([0, 0.1, -0.1, 0.2, 0.1, 0.2]))
  assert.equal(flat[0].hit, true, '±0.3% 內走平 → 中性命中')
  const moved = scoreProxyPredictions([pred(1, '中性', 0.5)], curve([0, 1, 2, 3, 4, 5]))
  assert.equal(moved[0].hit, false, '大漲 5% → 中性未命中')
})

test('flat band matches the training threshold (0.3%)', () => {
  assert.equal(hitForLabel('偏多', 0.3), false, '正好 +0.3% 未超過門檻')
  assert.equal(hitForLabel('偏多', 0.31), true)
  assert.equal(hitForLabel('偏空', -0.31), true)
  assert.equal(hitForLabel('中性', 0.3), true)
})

test('predictions whose horizon has not matured are excluded', () => {
  const c = curve([0, 1, 2])                       // 只有 3 天 < horizon+1
  assert.deepEqual(scoreProxyPredictions([pred(1, '偏多')], c), [])
  // 曲線夠長,但預測太靠近尾端 → 該筆不打分
  const c2 = curve([0, 1, 2, 3, 4, 5, 6])
  const rows = scoreProxyPredictions([pred(1, '偏多'), pred(5, '偏多')], c2)
  assert.deepEqual(rows.map(r => r.date), ['2026-07-01'], '07-05 之後不足 5 日,應排除')
})

test('predictions on dates absent from the curve are skipped', () => {
  const c = curve([0, 1, 2, 3, 4, 5])
  const rows = scoreProxyPredictions([{ date: '2025-01-01', xgb_label: '偏多' }], c)
  assert.deepEqual(rows, [])
})

test('summarize counts only scored rows', () => {
  const c = curve([0, -1, -1.5, 0, 2, 4, 5, 6])
  const rows = scoreProxyPredictions([pred(1, '偏多'), pred(2, '偏空', 0.3), pred(3, '中性', 0.5)], c)
  const s = summarizeProxy(rows)
  assert.equal(s.total, rows.length)
  assert.ok(s.pct >= 0 && s.pct <= 100)
  assert.equal(summarizeProxy([]), null)
})

test('guards bad input and honours the default horizon', () => {
  assert.deepEqual(scoreProxyPredictions(null, curve([0, 1, 2, 3, 4, 5])), [])
  assert.deepEqual(scoreProxyPredictions([pred(1, '偏多')], null), [])
  assert.equal(PROXY_HORIZON, 5)
})
