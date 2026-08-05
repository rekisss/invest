import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeModelHealth } from './model-health.mjs'

// 造一段「模型與美股隔夜完全反向」的歷史:美股漲→機率低、美股跌→機率高
const invertedHistory = () =>
  [0.02, 0.015, 0.01, 0.005, 0, -0.005, -0.01, -0.015, -0.02, -0.025].map((ret, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    xgb_prob_up: 0.4 + i * 0.02,          // 美股報酬遞減、機率卻遞增 → 反向
    market_data: { sp500_ret: ret, nasdaq_ret: ret * 1.2, vix: 15 + i },
  }))

// 正常模型:美股漲→機率高;VIX(恐慌)高→機率低
const healthyHistory = () =>
  [0.02, 0.015, 0.01, 0.005, 0, -0.005, -0.01, -0.015, -0.02, -0.025].map((ret, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    xgb_prob_up: 0.7 - i * 0.02,          // 美股報酬遞減、機率同步遞減 → 一致
    market_data: { sp500_ret: ret, nasdaq_ret: ret * 1.2, vix: 15 + i },  // 機率降時 VIX 升 → 符合預期
  }))

test('flags an inverted model (US features anti-correlated with probability)', () => {
  const h = computeModelHealth(invertedHistory())
  assert.equal(h.verdict, 'suspect_inverted')
  assert.ok(h.us_inverted_count >= 2, '至少兩個美股特徵應被標記反向')
  const sp = h.features.find(f => f.key === 'sp500_ret')
  assert.ok(sp.corr < 0 && sp.inverted, 'S&P 應為負相關且標記反向')
})

test('VIX is judged against its inverse expectation (high VIX should mean bearish)', () => {
  // invertedHistory 的 VIX 隨機率同向上升 → 與預期(-1)相反 → 應標記反向
  const h = computeModelHealth(invertedHistory())
  const vix = h.features.find(f => f.key === 'vix')
  assert.ok(vix.corr > 0, 'VIX 與機率同向')
  assert.equal(vix.inverted, true, 'VIX 越高越看多 = 反常,應標記')
})

test('healthy model is not flagged', () => {
  const h = computeModelHealth(healthyHistory())
  assert.equal(h.verdict, 'ok')
  assert.equal(h.inverted_count, 0)
})

test('respects minimum sample size (no verdict on thin data)', () => {
  const thin = invertedHistory().slice(0, 4)   // 只有 4 筆 < 預設 minN=8
  assert.equal(computeModelHealth(thin), null)
  // 放寬門檻後才給結論
  const h = computeModelHealth(thin, { minN: 3 })
  assert.ok(h && h.features.length > 0)
})

test('low_sample reflects the samples backing the verdict, not the largest feature', () => {
  const h = computeModelHealth(invertedHistory())   // 反向特徵 n=10 < 15
  assert.equal(h.low_sample, true)
  assert.equal(h.verdict_sample, 10)
  assert.equal(h.sample_max, 10)
})

test('a well-sampled unrelated feature must not mask a thin-sample verdict', () => {
  // 美股只有 10 筆(反向),夜盤有 30 筆(正常)→ 結論仍應標示樣本偏少
  const rows = invertedHistory()
  for (let i = 0; i < 30; i++) {
    rows.push({ date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      xgb_prob_up: 0.5 + (i % 5) * 0.01,
      market_data: { night_change: (i % 7) * 30 - 90 } })
  }
  const h = computeModelHealth(rows)
  assert.equal(h.verdict, 'suspect_inverted')
  assert.equal(h.verdict_sample, 10, '結論仍建立在 10 筆美股資料上')
  assert.equal(h.low_sample, true, '不可因夜盤樣本多就宣稱樣本充足')
})

test('ignores rows missing prob or market_data, and guards bad input', () => {
  const mixed = [...invertedHistory(), { date: 'x' }, { date: 'y', xgb_prob_up: 0.5 }]
  const h = computeModelHealth(mixed)
  assert.equal(h.sample_max, 10)          // 壞資料不計入
  assert.equal(computeModelHealth([]), null)
  assert.equal(computeModelHealth(null), null)
})

test('constant feature values produce no correlation (no divide-by-zero)', () => {
  const flat = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    xgb_prob_up: 0.5 + i * 0.01,
    market_data: { sp500_ret: 0.01 },     // 全部一樣 → 無變異
  }))
  assert.equal(computeModelHealth(flat), null)
})
