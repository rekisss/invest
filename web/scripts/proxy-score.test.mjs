import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreProxyPredictions, summarizeProxy, hitForProb, probForLabel, PROXY_HORIZON, NEUTRAL_BAND }
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

// 這是 2026-08 的定義修正:模型只預測「會不會漲逾 0.3%」,沒有預測「會跌」。
// 盤整時偏空預測其實說對了(沒漲逾門檻),舊的三分法卻把它記成失敗。
test('bearish call also hits on a flat market — the model only claims "not up >0.3%"', () => {
  const c = curve([0, 0.1, -0.1, 0.05, 0, 0.1])   // 5 日累積 +0.1%,未達 +0.3%
  const rows = scoreProxyPredictions([pred(1, '偏空', 0.3)], c)
  assert.equal(rows[0].ret, 0.1)
  assert.equal(rows[0].hit, true, '沒漲逾 0.3% → 偏空命中(舊三分法會誤判為失敗)')
})

test('bullish call misses on a flat market', () => {
  const c = curve([0, 0.1, -0.1, 0.05, 0, 0.1])
  assert.equal(scoreProxyPredictions([pred(1, '偏多', 0.6)], c)[0].hit, false)
})

test('neutral calls are not scored at all (the model claimed no direction)', () => {
  const flat = scoreProxyPredictions([pred(1, '中性', 0.5)], curve([0, 0.1, -0.1, 0.2, 0.1, 0.2]))
  assert.equal(flat[0].hit, null, '中性不計分,而不是「走平就算命中」')
  const moved = scoreProxyPredictions([pred(1, '中性', 0.5)], curve([0, 1, 2, 3, 4, 5]))
  assert.equal(moved[0].hit, null)
})

test('the neutral band matches the real scorer (|prob-0.5| <= 0.05)', () => {
  assert.equal(NEUTRAL_BAND, 0.05)
  assert.equal(hitForProb(0.52, 5), null, '帶內 → 不計分')
  assert.equal(hitForProb(0.48, -5), null)
  assert.equal(hitForProb(0.56, 5), true, '帶外 → 計分')
  assert.equal(hitForProb(0.44, -5), true)
  // 邊界值 0.55 / 0.45 是浮點退化案例,而且**不對稱**:
  //   Math.abs(0.55-0.5) === 0.050000000000000044  → 帶外,會計分
  //   Math.abs(0.45-0.5) === 0.04999999999999999   → 帶內,不計分
  // 這裡刻意不修:Python 的 abs() 走的是同一組 IEEE 754 double,結果逐位元相同,
  // 所以 outcome_tracker.py 與這支檔案對邊界的判定一致——一致性比對稱性重要。
  // 釘住實測值,避免日後有人只「修正」其中一邊而讓兩套計分悄悄分岔。
  assert.equal(hitForProb(0.55, 5), true, '0.55 落在帶外(浮點),會計分')
  assert.equal(hitForProb(0.45, -5), null, '0.45 落在帶內(浮點),不計分')
})

test('flat band matches the training threshold (0.3%)', () => {
  assert.equal(hitForProb(0.6, 0.3), false, '正好 +0.3% 未超過門檻 → 看多未命中')
  assert.equal(hitForProb(0.6, 0.31), true)
  assert.equal(hitForProb(0.3, 0.3), true, '正好 +0.3%:沒漲逾門檻 → 偏空命中')
  assert.equal(hitForProb(0.3, 0.31), false)
})

test('hitForProb guards missing data', () => {
  assert.equal(hitForProb(0.6, null), null)
  assert.equal(hitForProb(0.6, NaN), null)
  assert.equal(hitForProb(null, 5), null)
  assert.equal(hitForProb(undefined, 5), null)
})

test('label→prob fallback keeps records that only stored a label', () => {
  assert.ok(probForLabel('看多') > 0.55)
  assert.ok(probForLabel('看空') < 0.45)
  assert.equal(probForLabel('中性'), 0.5)
  assert.equal(probForLabel('莫名其妙'), null)
  const c = curve([0, -1, -1.5, 0, 2, 4])
  const rows = scoreProxyPredictions([{ date: '2026-07-01', xgb_label: '看多' }], c)
  assert.equal(rows[0].hit, true, '沒有 prob 時用標籤中點,不該整筆丟掉')
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

test('summarize counts only scored rows (neutral excluded)', () => {
  const c = curve([0, -1, -1.5, 0, 2, 4, 5, 6])
  const rows = scoreProxyPredictions([pred(1, '偏多'), pred(2, '偏空', 0.3), pred(3, '中性', 0.5)], c)
  assert.equal(rows.length, 3, '三筆都列出來(中性也要看得到)')
  const s = summarizeProxy(rows)
  assert.equal(s.total, 2, '但只有兩筆計分——中性 hit=null 不進分母')
  assert.ok(s.pct >= 0 && s.pct <= 100)
  assert.equal(summarizeProxy([]), null)
})

test('guards bad input and honours the default horizon', () => {
  assert.deepEqual(scoreProxyPredictions(null, curve([0, 1, 2, 3, 4, 5])), [])
  assert.deepEqual(scoreProxyPredictions([pred(1, '偏多')], null), [])
  assert.equal(PROXY_HORIZON, 5)
})
