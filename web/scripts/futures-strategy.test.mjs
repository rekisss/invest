// 自訂策略期貨預測引擎的單元測試(node --test,零依賴)。
// 引擎是純函式,所有測試都用手捏的假資料,不碰網路也不讀 output/。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FACTORS, PRESETS, makeDefaultStrategy, normalizeStrategy, applyPreset,
  scoreEntry, buildSamples, backtest, walkForward, optimize,
  exportStrategy, importStrategy,
} from '../src/utils/futuresStrategy.js'

// ── helpers ─────────────────────────────────────────────────────────────────
const mkEntry = (date, md = {}, prob = null) => ({
  date, xgb_prob_up: prob, market_data: { ...md },
})
// 只留下指定因子的策略,方便單獨驗證某個因子的行為
const onlyFactor = (key, over = {}) => {
  const st = makeDefaultStrategy()
  for (const f of FACTORS) st.factors[f.key] = { ...st.factors[f.key], enabled: f.key === key, weight: f.key === key ? 100 : 0 }
  return normalizeStrategy({ ...st, minFactors: 1, ...over })
}

// ── normalizeStrategy ───────────────────────────────────────────────────────
test('normalizeStrategy 補齊缺漏欄位並夾限異常值', () => {
  const st = normalizeStrategy({ name: '  ', horizon: 999, longThreshold: 500, shortThreshold: 50, costBps: -3 })
  assert.equal(st.name, '我的策略')
  assert.equal(st.horizon, 20)          // 夾到上限
  assert.equal(st.longThreshold, 100)
  assert.equal(st.shortThreshold, 0)    // 空方門檻不得為正
  assert.equal(st.costBps, 0)
  assert.equal(Object.keys(st.factors).length, FACTORS.length)
})

test('normalizeStrategy 不讓 minFactors 超過啟用因子數(否則策略永無訊號)', () => {
  const st = onlyFactor('foreign_oi', { minFactors: 10 })
  assert.equal(st.minFactors, 1)
})

test('normalizeStrategy 拒收 0 或非數字的 scale(除以 0 會炸成 Infinity)', () => {
  const st = normalizeStrategy({ factors: { vix: { scale: 0 }, sox_ret: { scale: 'x' } } })
  assert.equal(st.factors.vix.scale, FACTORS.find(f => f.key === 'vix').scale)
  assert.equal(st.factors.sox_ret.scale, FACTORS.find(f => f.key === 'sox_ret').scale)
})

// ── scoreEntry ──────────────────────────────────────────────────────────────
test('scoreEntry:外資淨空 → 偏空、淨多 → 偏多,並夾在 ±100', () => {
  const st = onlyFactor('foreign_oi')
  assert.equal(scoreEntry(mkEntry('d', { futures_net: -60000 }), st).score, -100)
  assert.equal(scoreEntry(mkEntry('d', { futures_net: -999999 }), st).score, -100)  // clamp
  assert.equal(scoreEntry(mkEntry('d', { futures_net: 30000 }), st).score, 50)
  assert.equal(scoreEntry(mkEntry('d', { futures_net: 0 }), st).score, 0)
})

test('scoreEntry:方向切逆向會翻轉分數(軋空反轉/逆勢派用)', () => {
  const fwd = onlyFactor('foreign_oi')
  const rev = normalizeStrategy({ ...fwd, factors: { ...fwd.factors, foreign_oi: { ...fwd.factors.foreign_oi, dir: -1 } } })
  const e = mkEntry('d', { futures_net: -30000 })
  assert.equal(scoreEntry(e, fwd).score, -50)
  assert.equal(scoreEntry(e, rev).score, 50)
})

test('scoreEntry:VIX 以 18 為中心且預設逆向 —— 高 VIX 偏空、低 VIX 偏多', () => {
  const st = onlyFactor('vix')
  assert.ok(scoreEntry(mkEntry('d', { vix: 30 }), st).score < 0)
  assert.ok(scoreEntry(mkEntry('d', { vix: 12 }), st).score > 0)
  assert.equal(scoreEntry(mkEntry('d', { vix: 18 }), st).score, 0)
})

test('scoreEntry:缺資料的因子被跳過,不會被當成 0 稀釋分數', () => {
  const st = normalizeStrategy({
    ...makeDefaultStrategy(), minFactors: 1,
    factors: { ...makeDefaultStrategy().factors },
  })
  // 只有 futures_net 有值,其餘皆缺 → 分數等於只用該因子的結果
  const partial = scoreEntry(mkEntry('d', { futures_net: -60000 }), st)
  assert.equal(partial.score, -100)
  assert.equal(partial.used, 1)
  assert.ok(partial.components.some(c => c.missing))
})

test('scoreEntry:可用因子少於 minFactors 時判「資料不足」且不出訊號', () => {
  const st = normalizeStrategy({ ...makeDefaultStrategy(), minFactors: 5 })
  const r = scoreEntry(mkEntry('d', { futures_net: -60000 }), st)
  assert.equal(r.insufficient, true)
  assert.equal(r.direction, 0)
  assert.equal(r.label, '資料不足')
})

test('scoreEntry:門檻決定多空/中性', () => {
  const st = onlyFactor('foreign_oi', { longThreshold: 40, shortThreshold: -40 })
  assert.equal(scoreEntry(mkEntry('d', { futures_net: 30000 }), st).direction, 1)    // 50 ≥ 40
  assert.equal(scoreEntry(mkEntry('d', { futures_net: 12000 }), st).direction, 0)    // 20 → 中性
  assert.equal(scoreEntry(mkEntry('d', { futures_net: -30000 }), st).direction, -1)
})

test('scoreEntry:各因子 share 加總等於總分(貢獻拆解要對得起來)', () => {
  const st = normalizeStrategy({ ...makeDefaultStrategy(), minFactors: 1 })
  const r = scoreEntry(mkEntry('d', { futures_net: -40000, vix: 25, sox_ret: -0.01, night_change: -80 }, 0.4), st)
  const sum = r.components.filter(c => !c.missing).reduce((a, c) => a + c.share, 0)
  assert.ok(Math.abs(sum - r.score) < 0.6, `share 加總 ${sum} 應約等於 score ${r.score}`)
})

// ── buildSamples ────────────────────────────────────────────────────────────
test('buildSamples:日期升冪、去重、掛上實際漲跌與外資部位趨勢', () => {
  const history = [
    mkEntry('2026-01-05', { futures_net: -10000 }),
    mkEntry('2026-01-02', { futures_net: -30000 }),
    mkEntry('2026-01-03', { futures_net: -20000 }),
  ]
  const outcomes = [
    { date: '2026-01-02', taiex_pct: 0.01, taiex_close: 100, actual_up: true },
    { date: '2026-01-03', taiex_pct: -0.02, taiex_close: 98, actual_up: false },
  ]
  const s = buildSamples({ history, outcomes })
  assert.deepEqual(s.map(x => x.date), ['2026-01-02', '2026-01-03', '2026-01-05'])
  assert.equal(s[0].pct, 0.01)
  assert.equal(s[2].pct, null)
  assert.equal(s[1].derived.oi_trend, 10000)   // −20000 −(−30000)
})

test('buildSamples:今日 prediction 與 futuresChips 基差併進最後一筆', () => {
  const s = buildSamples({
    history: [mkEntry('2026-01-02', { futures_net: -1000 })],
    prediction: mkEntry('2026-01-03', { futures_net: -2000 }, 0.6),
    futuresChips: { basis: { basis: -45 } },
  })
  assert.equal(s.length, 2)
  assert.equal(s[1].xgb_prob_up, 0.6)
  assert.equal(s[1].derived.basis, -45)
})

// ── backtest ────────────────────────────────────────────────────────────────
// 造一段「外資淨空 → 隔天跌」的資料:純籌碼策略應該全中。
const perfectSamples = () => {
  const history = [], outcomes = []
  for (let i = 0; i < 12; i++) {
    const d = `2026-02-${String(i + 1).padStart(2, '0')}`
    const short = i % 2 === 0
    history.push(mkEntry(d, { futures_net: short ? -60000 : 60000 }))
    outcomes.push({ date: d, taiex_pct: short ? -0.01 : 0.01, actual_up: !short })
  }
  return buildSamples({ history, outcomes })
}

test('backtest:訊號方向與實際走勢一致時命中率 100%,且累積報酬為正', () => {
  const r = backtest(perfectSamples(), onlyFactor('foreign_oi'))
  assert.equal(r.samples, 12)
  assert.equal(r.hitRate, 1)
  assert.ok(r.totalRet > 0)
  assert.equal(r.long.n + r.short.n, 12)
})

test('backtest:方向全反則命中率 0,累積報酬為負', () => {
  const st = onlyFactor('foreign_oi')
  const rev = normalizeStrategy({ ...st, factors: { ...st.factors, foreign_oi: { ...st.factors.foreign_oi, dir: -1 } } })
  const r = backtest(perfectSamples(), rev)
  assert.equal(r.hitRate, 0)
  assert.ok(r.totalRet < 0)
})

test('backtest:交易成本會吃掉報酬(同一組訊號,成本越高賺越少)', () => {
  const s = perfectSamples()
  const free = backtest(s, onlyFactor('foreign_oi'))
  const costly = backtest(s, onlyFactor('foreign_oi', { costBps: 50 }))
  assert.ok(costly.totalRet < free.totalRet)
  assert.equal(costly.hitRate, free.hitRate)   // 成本不影響方向命中率
})

test('backtest:沒有實際結果的日子不列入樣本(不灌水命中率)', () => {
  const s = buildSamples({
    history: [mkEntry('2026-03-02', { futures_net: -60000 }), mkEntry('2026-03-03', { futures_net: -60000 })],
    outcomes: [{ date: '2026-03-02', taiex_pct: -0.01, actual_up: false }],
  })
  const r = backtest(s, onlyFactor('foreign_oi'))
  assert.equal(r.samples, 1)
  assert.equal(r.days, 2)
})

test('backtest:期距 h 會用 h 日累積報酬評分', () => {
  // 第 1 天小跌、第 2 天大漲 → h=1 判空會中,h=2 兩日合計為正則不中
  const s = buildSamples({
    history: [mkEntry('2026-04-01', { futures_net: -60000 }), mkEntry('2026-04-02', { futures_net: -60000 })],
    outcomes: [
      { date: '2026-04-01', taiex_pct: -0.005, actual_up: false },
      { date: '2026-04-02', taiex_pct: 0.03, actual_up: true },
    ],
  })
  assert.equal(backtest(s, onlyFactor('foreign_oi', { horizon: 1 })).rows[0].fwd < 0, true)
  const h2 = backtest(s, onlyFactor('foreign_oi', { horizon: 2 }))
  assert.ok(h2.rows[0].fwd > 0)
  assert.equal(h2.samples, 1)   // 只有第 1 天湊得到 2 日報酬
})

test('backtest:模型基準線與買進持有一併回報,便於比較', () => {
  const s = buildSamples({
    history: [mkEntry('2026-05-04', { futures_net: -60000 }, 0.8), mkEntry('2026-05-05', { futures_net: -60000 }, 0.2)],
    outcomes: [
      { date: '2026-05-04', taiex_pct: 0.01, actual_up: true },
      { date: '2026-05-05', taiex_pct: -0.01, actual_up: false },
    ],
  })
  const r = backtest(s, onlyFactor('foreign_oi'))
  assert.equal(r.model.n, 2)
  assert.equal(r.model.hits, 2)      // 模型兩天都對
  assert.equal(r.hits, 1)            // 純籌碼策略只對一天
  assert.ok(Math.abs(r.hold - (1.01 * 0.99 - 1)) < 1e-9)
})

// ── walkForward / optimize ──────────────────────────────────────────────────
test('walkForward:樣本太少回 null,足夠時切出訓練/驗證兩段', () => {
  assert.equal(walkForward(perfectSamples().slice(0, 5), onlyFactor('foreign_oi')), null)
  const wf = walkForward(perfectSamples(), onlyFactor('foreign_oi'))
  assert.ok(wf.train.n > 0 && wf.test.n > 0)
  assert.equal(wf.train.hitRate, 1)
  assert.equal(wf.test.hitRate, 1)
})

test('optimize:同一顆種子必得同樣結果(可重現)', () => {
  const s = perfectSamples()
  const a = optimize(s, makeDefaultStrategy(), { iterations: 60, seed: 7 })
  const b = optimize(s, makeDefaultStrategy(), { iterations: 60, seed: 7 })
  assert.deepEqual(a.strategy.factors, b.strategy.factors)
  assert.equal(a.result.hitRate, b.result.hitRate)
})

test('optimize:訊號數不足最低樣本門檻的權重組合不會被選上', () => {
  const s = perfectSamples()
  const o = optimize(s, makeDefaultStrategy(), { iterations: 80, seed: 3, minSamples: 12 })
  assert.ok(o.result.samples >= 12 || o.result.hitRate == null)
  assert.equal(o.overfitRisk, true)   // 12 筆遠低於 OVERFIT_SAMPLE_FLOOR
})

test('optimize:全部因子關閉時回 null(沒東西可搜)', () => {
  const st = makeDefaultStrategy()
  for (const f of FACTORS) st.factors[f.key] = { ...st.factors[f.key], enabled: false, weight: 0 }
  assert.equal(optimize(perfectSamples(), st, { iterations: 10 }), null)
})

// ── presets / 匯出匯入 ──────────────────────────────────────────────────────
test('每個預設策略都至少啟用一個因子,且能對今日資料打出分數', () => {
  const e = mkEntry('2026-06-01', {
    futures_net: -50000, sox_ret: 0.02, tsm_adr_ret: 0.01, nasdaq_ret: 0.005,
    vix: 16, night_change: 60, taiex_rsi: 58, macd_hist: 100, dist_ma20: 2,
  }, 0.55)
  e.derived = { oi_trend: 5000, basis: -20 }
  for (const p of PRESETS) {
    const st = applyPreset(p.id, makeDefaultStrategy())
    const enabled = FACTORS.filter(f => st.factors[f.key].enabled && st.factors[f.key].weight > 0)
    assert.ok(enabled.length > 0, `${p.name} 應至少啟用一個因子`)
    const r = scoreEntry(e, st)
    assert.equal(typeof r.score, 'number', `${p.name} 應算得出分數`)
    assert.ok(r.score >= -100 && r.score <= 100)
  }
})

test('逆勢派把 RSI / 距均線 / 外資部位都設成逆向', () => {
  const st = applyPreset('contrarian', makeDefaultStrategy())
  assert.equal(st.factors.taiex_rsi.dir, -1)
  assert.equal(st.factors.dist_ma20.dir, -1)
  assert.equal(st.factors.foreign_oi.dir, -1)
})

test('匯出再匯入是等價的(round-trip 不走味)', () => {
  const st = applyPreset('overnight', makeDefaultStrategy())
  const back = importStrategy(exportStrategy(st))
  assert.equal(back.ok, true)
  for (const f of FACTORS) {
    assert.equal(back.strategy.factors[f.key].enabled, st.factors[f.key].enabled && st.factors[f.key].weight > 0, f.key)
    if (st.factors[f.key].enabled) assert.equal(back.strategy.factors[f.key].weight, st.factors[f.key].weight, f.key)
  }
  assert.equal(back.strategy.horizon, st.horizon)
})

test('匯入壞掉的 JSON 只回錯誤,不丟例外', () => {
  const r = importStrategy('{ 這不是 JSON')
  assert.equal(r.ok, false)
  assert.equal(typeof r.error, 'string')
})

test('backtest 對空輸入不炸(尚無歷史資料的第一天)', () => {
  const r = backtest([], makeDefaultStrategy())
  assert.equal(r.samples, 0)
  assert.equal(r.hitRate, null)
  assert.deepEqual(r.curve, [])
})
