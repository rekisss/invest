// buildReviewRows —「預測回顧」逐日清單的資料來源決策回歸測試。
//
// 守的是一個真實現場:清單原本完全由掃描池代理產生,而代理要等基準曲線累積滿
// 5 根前瞻 K 棒才算得出來 → 最新幾個預測日整列消失。實測 2026-09-11:代理最新
// 只到 09-03,但 09-04 / 09-07 / 09-08 / 09-10 的真實命中結果早就存在,
// 使用者看到最近一週全部空白(「預測結果跟真實結果沒有顯示出來」)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewRows, realRowFor, summarizeReviewRows } from '../src/utils/reviewRows.js'

// 一段夠長、日期升冪的基準曲線,讓代理算得出前面幾天
const curve = [
  '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
  '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10',
].map((date, i) => ({ date, ret_pct: i }))   // 每天 +1%

const histOf = (dates) => dates.map(date => ({ date, xgb_label: '看多', xgb_prob_up: 0.8 }))

test('關鍵回歸:代理算不出來的最新日期,仍要用真實收盤補上', () => {
  const history = histOf(['2026-09-01', '2026-09-08', '2026-09-10'])
  const realOutcomes = {
    prediction: [
      { date: '2026-09-08', pred_label: '看空', xgb_prob_up: 0.2, taiex_pct: 0.0167, hit: false, hit_h5: null, directional: true },
      { date: '2026-09-10', pred_label: '偏多', xgb_prob_up: 0.59, taiex_pct: 0.0016, hit: true, hit_h5: null, directional: true },
    ],
  }
  const rows = buildReviewRows({ history, benchCurve: curve, realOutcomes })
  const byDate = Object.fromEntries(rows.map(r => [r.date, r]))
  assert.ok(byDate['2026-09-08'], '09-08 必須出現(代理算不出,真實有)')
  assert.ok(byDate['2026-09-10'], '09-10 必須出現')
  assert.equal(byDate['2026-09-10'].hit, true)
  assert.equal(byDate['2026-09-10'].source, 'real')
  assert.equal(byDate['2026-09-10'].horizon, 1)      // hit_h5 未到期 → 用隔日
})

test('5 日期距到期後改用 hit_h5 / ret_h5(與模型訓練目標同期距)', () => {
  const r = realRowFor({
    date: '2026-09-01', pred_label: '看空', xgb_prob_up: 0.32,
    taiex_pct: 0.0033, hit: null, hit_h5: false, ret_h5: 2.6, directional: true,
  })
  assert.equal(r.hit, false)
  assert.equal(r.ret, 2.6)          // 用 5 日報酬,不是當日的 0.33%
  assert.equal(r.horizon, 5)
  assert.equal(r.pending, false)
})

test('有方向但兩種期距都沒到 → pending(⏳),不能算成未命中', () => {
  const r = realRowFor({ date: '2026-09-11', pred_label: '看空', xgb_prob_up: 0.2, taiex_pct: 0.01, hit: null, hit_h5: null, directional: true })
  assert.equal(r.hit, null)
  assert.equal(r.pending, true)
})

test('中性預測不計分也不等待', () => {
  const r = realRowFor({ date: '2026-09-09', pred_label: '中性', xgb_prob_up: 0.515, taiex_pct: -0.0047, hit: null, hit_h5: null, directional: false })
  assert.equal(r.hit, null)
  assert.equal(r.pending, false)
})

test('沒有真實紀錄的日期退回代理,並標明來源', () => {
  const history = histOf(['2026-09-01', '2026-09-02'])
  const rows = buildReviewRows({ history, benchCurve: curve, realOutcomes: { prediction: [] } })
  assert.ok(rows.length > 0, '應該還有代理列')
  for (const r of rows) assert.equal(r.source, 'proxy')
})

test('同一天真實與代理都有時,真實優先', () => {
  const history = histOf(['2026-09-01'])
  const realOutcomes = { prediction: [{ date: '2026-09-01', pred_label: '看空', xgb_prob_up: 0.3, taiex_pct: 0.02, hit: true, hit_h5: null, directional: true }] }
  const rows = buildReviewRows({ history, benchCurve: curve, realOutcomes })
  const r = rows.find(x => x.date === '2026-09-01')
  assert.equal(r.source, 'real')
  assert.equal(r.hit, true)
})

test('新→舊排序並受 limit 約束', () => {
  const dates = ['2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-07']
  const realOutcomes = { prediction: dates.map(date => ({ date, pred_label:'看空', xgb_prob_up:0.2, taiex_pct:0.01, hit:true, hit_h5:null, directional:true })) }
  const rows = buildReviewRows({ history: [], benchCurve: [], realOutcomes, limit: 3 })
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(r => r.date), ['2026-09-07','2026-09-04','2026-09-03'])
})

test('空輸入不炸,回空陣列', () => {
  assert.deepEqual(buildReviewRows({}), [])
  assert.deepEqual(buildReviewRows({ history: null, benchCurve: null, realOutcomes: null }), [])
  assert.equal(realRowFor(null), null)
  assert.equal(realRowFor({}), null)
})

test('清單統計只算真的打過分的列(中性/等待中不進分母)', () => {
  const rows = [
    { hit: true }, { hit: false }, { hit: null, pending: true }, { hit: null, pending: false }, { hit: true },
  ]
  assert.deepEqual(summarizeReviewRows(rows), { hits: 2, total: 3, pct: 67 })
  assert.equal(summarizeReviewRows([]), null)
  assert.equal(summarizeReviewRows(null), null)
})
