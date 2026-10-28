// outcome-realign — 真實結果日期錯位修正 / 基準對照 / top20 報酬重算 的回歸測試。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTradingCalendar, extendCalendar, buildMarketProxyReturns, detectTaiexLag,
  realignPredictionOutcomes, computeBaselineComparison, recomputeTop20Returns,
} from './outcome-realign.mjs'

// 30 個工作日(跳過週末),其中 2026-09-25(五)休市
function makeDays() {
  const out = []
  let d = new Date('2026-09-01T00:00:00Z')
  while (out.length < 30) {
    const s = d.toISOString().slice(0, 10)
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6 && s !== '2026-09-25') out.push(s)
    d = new Date(d.getTime() + 86400000)
  }
  return out
}
const DAYS = makeDays()
// 確定性的「大盤」收盤:漲跌交錯但不重複
const TRUE = DAYS.map((_, i) => 1000 + i * 3 + (i % 3 === 0 ? -10 : 5) * (i % 2 ? 1 : -1))

function barsFor(closes, days = DAYS, vol = 1000) {
  return days.map((t, i) => ({ time: t, close: closes[i], volume: vol }))
}

test('buildTradingCalendar:只取多數個股都有 bar 的日子;extendCalendar 補工作日', () => {
  const bars = {}
  for (let k = 0; k < 10; k++) bars[`s${k}`] = barsFor(TRUE.map(c => c + k))
  bars.odd = [...barsFor(TRUE), { time: '2026-09-26', close: 1, volume: 1 }] // 單檔髒資料(週六)
  const cal = buildTradingCalendar(bars)
  assert.deepEqual(cal, DAYS)
  assert.ok(!cal.includes('2026-09-25'))
  const ext = extendCalendar(['2026-10-23'], '2026-10-28')
  assert.deepEqual(ext, ['2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28'])
})

// 模擬 outcome_tracker 的 bug:紀錄日 D 存的是 D 前一交易日的收盤;休市日也有一筆
function laggedRecords(probs = {}) {
  const recs = []
  for (let i = 1; i < DAYS.length; i++) recs.push({ date: DAYS[i], taiex_close: TRUE[i - 1], xgb_prob_up: probs[DAYS[i]] ?? 0.7 })
  recs.push({ date: '2026-09-25', taiex_close: TRUE[DAYS.indexOf('2026-09-24')], xgb_prob_up: 0.7 })
  return recs
}
const proxyFromTrue = () => new Map(DAYS.slice(1).map((d, i) => [d, TRUE[i + 1] / TRUE[i] - 1]))

test('detectTaiexLag:錯一天的資料判定 lag=1;正確的資料判定 lag=0;證據不足 null', () => {
  const proxy = proxyFromTrue()
  assert.equal(detectTaiexLag(laggedRecords(), DAYS, proxy).lag, 1)
  const correct = DAYS.map((d, i) => ({ date: d, taiex_close: TRUE[i] }))
  assert.equal(detectTaiexLag(correct, DAYS, proxy).lag, 0)
  assert.equal(detectTaiexLag(correct.slice(0, 5), DAYS, proxy).lag, null)
})

test('realignPredictionOutcomes:收盤歸位、休市日不打分、5 日期距對齊訓練 target', () => {
  const recs = laggedRecords({ [DAYS[3]]: 0.2 })
  const st = realignPredictionOutcomes(recs, DAYS, { lag: 1 })
  const by = Object.fromEntries(recs.map(e => [e.date, e]))
  // 第 3 天的紀錄,收盤應是第 3 天真正的收盤(來自第 4 天那筆紀錄)
  assert.equal(by[DAYS[3]].taiex_close, TRUE[3])
  assert.equal(by[DAYS[3]].taiex_close_raw, TRUE[2])
  assert.equal(by[DAYS[3]].actual_up, TRUE[3] > TRUE[2])
  assert.equal(by[DAYS[3]].hit, (0.2 > 0.5) === (TRUE[3] > TRUE[2]))
  // 5 日:base = D 前一交易日,target = base + 5
  const ret = (TRUE[2 + 5] - TRUE[2]) / TRUE[2]
  assert.equal(by[DAYS[3]].ret_h5, Math.round(ret * 10000) / 100)
  assert.equal(by[DAYS[3]].hit_h5, false === (TRUE[7] > TRUE[2] * 1.003))
  assert.equal(by[DAYS[3]].hit_h5_date, DAYS[7])
  // 休市日
  assert.equal(by['2026-09-25'].non_trading_day, true)
  assert.equal(by['2026-09-25'].hit, null)
  assert.equal(by['2026-09-25'].directional, false)
  assert.equal(st.non_trading, 1)
  // 最後一筆紀錄的當日收盤還不知道(要等下一筆)
  assert.equal(by[DAYS.at(-1)].taiex_close, null)
  assert.equal(by[DAYS.at(-1)].hit, null)
})

test('realignPredictionOutcomes:與前一筆已知收盤相同(抓到舊值)→ 當成未知,即使中間隔了缺漏', () => {
  const recs = laggedRecords()
  // 第 10 天那筆缺漏;第 11 天那筆重複了第 9 天那筆的值
  const i9 = recs.findIndex(e => e.date === DAYS[9])
  recs.splice(recs.findIndex(e => e.date === DAYS[10]), 1)
  recs.find(e => e.date === DAYS[11]).taiex_close = recs[i9].taiex_close
  const st = realignPredictionOutcomes(recs, DAYS, { lag: 1 })
  assert.equal(st.duplicates, 1)
  const by = Object.fromEntries(recs.map(e => [e.date, e]))
  // 第 11 天那筆代表第 10 天 → 被判為舊值,所以第 11 天的「前一日收盤」未知 → 不打分
  assert.equal(by[DAYS[11]].taiex_close, TRUE[11])
  assert.equal(by[DAYS[11]].taiex_pct, null)
  assert.equal(by[DAYS[11]].hit, null)
  // 第 8 天不受影響(來自第 9 天那筆);第 9 天的收盤在被刪掉的那筆 → 未知
  assert.equal(by[DAYS[8]].taiex_close, TRUE[8])
  assert.equal(by[DAYS[9]].taiex_close, null)
})

test('computeBaselineComparison:模型 vs 一律猜漲/猜跌、Brier、分桶', () => {
  // 10 天實際上漲(+1%)、10 天下跌;模型永遠說 0.7(看多)
  const recs = Array.from({ length: 20 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, '0')}`, xgb_prob_up: 0.7, ret_h5: i < 10 ? 1 : -1,
  }))
  recs.push({ date: '2026-08-25', xgb_prob_up: 0.5, ret_h5: 1 })       // 中性:算 Brier 不算命中
  recs.push({ date: '2026-08-26', xgb_prob_up: 0.9, non_trading_day: true, ret_h5: 1 })
  const b = computeBaselineComparison(recs)
  assert.equal(b.n, 20)
  assert.equal(b.n_all, 21)
  assert.equal(b.model_rate, 0.5)
  assert.equal(b.always_up_rate, 0.5)
  assert.equal(b.always_down_rate, 0.5)
  assert.equal(b.edge, 0)
  assert.equal(b.verdict, 'similar')
  assert.equal(b.low_sample, true)
  assert.ok(b.brier > b.brier_naive)
  assert.deepEqual(b.buckets.map(x => x.n), [1, 20])
  assert.equal(computeBaselineComparison([]), null)
  // 0.3% 門檻:+0.2% 不算上漲
  const thr = computeBaselineComparison([{ date: 'x', xgb_prob_up: 0.8, ret_h5: 0.2 }])
  assert.equal(thr.model_rate, 0)
})

test('recomputeTop20Returns:依真實交易日重算報酬、保留原值、算全市場基準', () => {
  const a = TRUE.map(c => c / 10)
  const bars = { A: barsFor(a), B: barsFor(TRUE.map(c => c / 20)) }
  const snaps = [{ date: DAYS[2], stocks: [{ stock_id: 'A', ret_1d: 0.19, ret_5d: 0.5 }, { stock_id: 'Z', ret_1d: 0.01 }] }]
  const r = recomputeTop20Returns(snaps, bars, DAYS, [1, 5])
  const A = snaps[0].stocks[0]
  assert.equal(A.ret_1d, Math.round((a[3] / a[2] - 1) * 10000) / 10000)
  assert.equal(A.ret_1d_raw, 0.19)
  assert.equal(A.ret_5d, Math.round((a[7] / a[2] - 1) * 10000) / 10000)
  assert.equal(snaps[0].stocks[1].ret_1d, 0.01)  // 沒 K 線 → 保留原值
  assert.equal(r.rows, 1)
  assert.equal(r.market.ret_1d.snapshots, 1)
  // 期距超出日曆 → null
  const late = [{ date: DAYS.at(-2), stocks: [{ stock_id: 'A', ret_5d: 0.1 }] }]
  recomputeTop20Returns(late, bars, DAYS, [5])
  assert.equal(late[0].stocks[0].ret_5d, null)
})

test('buildMarketProxyReturns:方向與成分股一致', () => {
  const bars = {}
  for (let k = 0; k < 5; k++) bars[`s${k}`] = barsFor(TRUE.map(c => c * (1 + k / 10)))
  bars['2330'] = barsFor(TRUE)
  const many = {}
  for (const [id, b] of Object.entries(bars)) many[id] = [...b, ...b.map(x => ({ ...x, time: 'z' + x.time }))]
  const pr = buildMarketProxyReturns(Object.fromEntries(Object.entries(many).map(([k, v]) => [k, v.slice(0, 60)])), DAYS)
  for (let i = 1; i < DAYS.length; i++) assert.equal(Math.sign(pr.get(DAYS[i])), Math.sign(TRUE[i] - TRUE[i - 1]))
})
