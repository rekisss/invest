// 真實結果資料的「日期錯位」修正 + 基準對照(build 層,不改 Python)。
//
// 2026-10 診斷(見 PR 說明):
//   1. outcome_tracker 寫進 prediction_outcomes.json 的 taiex_close,日期 D 那筆其實是
//      「D 的前一個交易日」的收盤 —— 與 K 線合成的大盤代理比對,直接對齊日報酬相關
//      只有 0.18,往前挪一個交易日變 0.93(46 天中 43 天同向)。中秋(09-25)、國慶
//      連假(10-09)這些休市日也都有紀錄,就是因為它抓到的是前一天的收盤。
//      後果:「隔日命中」拿今天的預測去對**昨天**已知的漲跌。
//   2. 偶有抓到舊值:相鄰兩筆收盤一模一樣(09-29/09-30、10-23/10-27),會被當成「平盤 = 下跌」。
//   3. top20_history 的 ret_1d/ret_5d 是「下一筆紀錄」而非「下一個交易日」,約 20% 的
//      「1 日報酬」實際跨了 0/2/3 天(出現 +19% 這種超過漲跌停的 1 日報酬)。
//
// 這裡用 K 線的交易日曆 + 大盤代理「自動偵測」錯位天數,只有證據明確時才校正;
// 若之後 Python 端修好了,偵測會得到 lag=0,自動不再平移。

const NEUTRAL = 0.05
const UP_THRESHOLD = 1.003 // 與 market_predictor.py 訓練 target 定義一致

// ── 交易日曆 ──────────────────────────────────────────────────────────────
// 以 K 線實際有 bar 的日期為準(自帶國定假日);取「至少 30% 個股有 bar」的日子,
// 避免單一檔停牌或個別髒資料影響日曆。
export function buildTradingCalendar(barsById) {
  const count = new Map()
  let stocks = 0
  for (const bars of Object.values(barsById || {})) {
    if (!Array.isArray(bars) || bars.length < 20) continue
    stocks++
    for (const b of bars) if (b?.time) count.set(b.time, (count.get(b.time) || 0) + 1)
  }
  if (!stocks) return []
  const min = Math.max(1, Math.floor(stocks * 0.3))
  return [...count.entries()].filter(([, n]) => n >= min).map(([d]) => d).sort()
}

// 日曆尾端之後(K 線還沒更新到的日子)以工作日補上,讓最新幾筆紀錄仍能對位。
export function extendCalendar(days, untilDate) {
  const out = days.slice()
  if (!out.length || !untilDate) return out
  let d = new Date(`${out[out.length - 1]}T00:00:00Z`)
  const end = new Date(`${untilDate}T00:00:00Z`)
  while (d < end) {
    d = new Date(d.getTime() + 86400000)
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10))
  }
  return out
}

// 最後一個 < date(strict)或 <= date 的交易日 index
function tdIndex(days, date, strict) {
  let lo = 0, hi = days.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (strict ? days[mid] < date : days[mid] <= date) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

// ── 大盤代理(只用來偵測方向/錯位,不拿來打分)──────────────────────────────
// 2330 × 45% + 近 120 日成交額前 100 檔等權 × 55%;實測與加權指數日報酬相關 0.93。
export function buildMarketProxyReturns(barsById, days) {
  const closeMaps = {}
  const turnover = []
  for (const [id, bars] of Object.entries(barsById || {})) {
    if (!Array.isArray(bars) || bars.length < 60) continue
    closeMaps[id] = new Map(bars.map(b => [b.time, b.close]))
    if (id === '2330') continue
    const tail = bars.slice(-120)
    turnover.push([id, tail.reduce((a, b) => a + (b.close || 0) * (b.volume || 0), 0) / tail.length])
  }
  const top = turnover.sort((a, b) => b[1] - a[1]).slice(0, 100).map(x => x[0])
  const ret = new Map()
  for (let i = 1; i < days.length; i++) {
    const r = id => {
      const m = closeMaps[id]
      const a = m?.get(days[i - 1]), b = m?.get(days[i])
      return a > 0 && b > 0 ? b / a - 1 : null
    }
    const rs = top.map(r).filter(x => x != null && Math.abs(x) < 0.2)
    if (!rs.length) continue
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length
    const tsmc = r('2330')
    ret.set(days[i], 0.45 * (tsmc ?? mean) + 0.55 * mean)
  }
  return ret
}

// 把紀錄依 lag 對到「它真正代表的交易日」:lag=1 → 嚴格早於紀錄日的最後一個交易日。
function closesByTradingDay(records, days, lag) {
  const byIdx = new Map()
  const asc = (records || [])
    .filter(e => e?.date && typeof e.taiex_close === 'number' && e.taiex_close > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  for (const e of asc) {
    const i = lag === 1 ? tdIndex(days, e.date, true) : tdIndex(days, e.date, false)
    if (i < 0) continue
    if (!byIdx.has(i)) byIdx.set(i, e.taiex_close)
  }
  return byIdx
}

/** 偵測 taiex_close 相對交易日的錯位天數(0 或 1)。證據不足回傳 lag:null。 */
export function detectTaiexLag(records, days, proxyRet, { minPairs = 15 } = {}) {
  const res = { lag: null, n0: 0, n1: 0, agree0: null, agree1: null }
  for (const lag of [0, 1]) {
    const m = closesByTradingDay(records, days, lag)
    let n = 0, agree = 0
    for (const [i, c] of m) {
      const prev = m.get(i - 1)
      const p = proxyRet.get(days[i])
      if (prev == null || p == null || c === prev || p === 0) continue
      n++
      if (Math.sign(c - prev) === Math.sign(p)) agree++
    }
    res[`n${lag}`] = n
    res[`agree${lag}`] = n ? Math.round((agree / n) * 1000) / 1000 : null
  }
  const { agree0, agree1, n0, n1 } = res
  if (n1 >= minPairs && agree1 >= 0.7 && agree1 - (agree0 ?? 0) >= 0.15) res.lag = 1
  else if (n0 >= minPairs && agree0 >= 0.7 && agree0 - (agree1 ?? 0) >= 0.15) res.lag = 0
  return res
}

/**
 * 依偵測到的 lag 重建「每個交易日的真實收盤」,再以預測日 D 重新打分:
 *   隔日:close(D) vs close(D 前一交易日)
 *   5 日:close(D 前一交易日 + 5 交易日) > close(D 前一交易日) × 1.003(與訓練 target 相同)
 * 就地修改紀錄;原始值留在 taiex_close_raw 方便對照。回傳統計。
 */
export function realignPredictionOutcomes(records, days, { lag = 1, horizon = 5 } = {}) {
  const stats = { lag, duplicates: 0, non_trading: 0, scored_d1: 0, scored_h: 0 }
  if (!Array.isArray(records) || !days.length) return stats
  const raw = closesByTradingDay(records, days, lag)
  // 與「前一筆已知收盤」完全相同(到小數第二位)→ 幾乎可以確定是抓到舊值,當成未知。
  // 不只比相鄰交易日:10-27 那筆重複的是 10-23 的值,中間隔了缺漏的一天。
  const C = new Map()
  let prevVal = null
  for (const i of [...raw.keys()].sort((a, b) => a - b)) {
    const c = raw.get(i)
    if (c === prevVal) { stats.duplicates++; continue }
    C.set(i, c)
    prevVal = c
  }
  const hKey = `hit_h${horizon}`
  const rKey = `ret_h${horizon}`
  for (const e of records) {
    if (!e?.date) continue
    if (e.taiex_close_raw === undefined) e.taiex_close_raw = e.taiex_close ?? null
    const prob = typeof e.xgb_prob_up === 'number' ? e.xgb_prob_up : null
    const directional = prob != null && Math.abs(prob - 0.5) > NEUTRAL
    const i = tdIndex(days, e.date, false)
    const isTd = i >= 0 && days[i] === e.date
    // 清掉舊的(錯位的)打分欄位,重算
    for (const k of ['hit', hKey, rKey, `${hKey}_date`, `${hKey}_span_bdays`, 'prev_gap_bdays']) delete e[k]
    e.hit = null
    e[hKey] = null
    e.actual_up = null
    e.taiex_change = null
    e.taiex_pct = null
    e.taiex_close = isTd ? (C.get(i) ?? null) : null
    if (!isTd) {
      // 休市日的「預測」沒有對應的交易日可驗證
      stats.non_trading++
      e.non_trading_day = true
      e.directional = false
      continue
    }
    e.directional = directional
    const base = C.get(i - 1)
    const today = C.get(i)
    if (base != null && today != null) {
      e.taiex_change = Math.round((today - base) * 100) / 100
      e.taiex_pct = (today - base) / base
      e.actual_up = today > base
      if (directional) { e.hit = (prob > 0.5) === e.actual_up; stats.scored_d1++ }
    }
    const t = i - 1 + horizon
    const target = C.get(t)
    if (base != null && target != null) {
      e[rKey] = Math.round(((target - base) / base) * 10000) / 100
      e[`${hKey}_date`] = days[t]
      e[`${hKey}_span_bdays`] = horizon
      if (directional) { e[hKey] = (prob > 0.5) === (target > base * UP_THRESHOLD); stats.scored_h++ }
    }
  }
  return stats
}

/**
 * 模型 vs 天真基準:同一批已到期的日子,模型命中率 vs「一律猜漲」「一律猜跌」,
 * 加上 Brier 分數與機率分桶校準。用來回答「這個預測到底有沒有用」。
 */
export function computeBaselineComparison(records, { horizon = 5 } = {}) {
  const rKey = `ret_h${horizon}`
  const rows = (records || []).filter(e =>
    e && !e.non_trading_day && typeof e.xgb_prob_up === 'number' && typeof e[rKey] === 'number')
  if (!rows.length) return null
  const y = rows.map(e => e[rKey] / 100 > UP_THRESHOLD - 1)
  const upRate = y.filter(Boolean).length / rows.length
  const brier = rows.reduce((a, e, j) => a + (e.xgb_prob_up - (y[j] ? 1 : 0)) ** 2, 0) / rows.length
  const brierNaive = rows.reduce((a, _e, j) => a + (upRate - (y[j] ? 1 : 0)) ** 2, 0) / rows.length

  const dIdx = rows.map((e, j) => j).filter(j => Math.abs(rows[j].xgb_prob_up - 0.5) > NEUTRAL)
  const n = dIdx.length
  const modelHits = dIdx.filter(j => (rows[j].xgb_prob_up > 0.5) === y[j]).length
  const upHits = dIdx.filter(j => y[j]).length
  const r = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null)
  const modelRate = r(modelHits, n)
  const bestNaive = Math.max(r(upHits, n) ?? 0, r(n - upHits, n) ?? 0)

  const buckets = [[0, 0.35], [0.35, 0.45], [0.45, 0.55], [0.55, 0.65], [0.65, 1.01]].map(([lo, hi]) => {
    const js = rows.map((_, j) => j).filter(j => rows[j].xgb_prob_up >= lo && rows[j].xgb_prob_up < hi)
    return {
      lo, hi: Math.min(hi, 1), n: js.length,
      up_rate: js.length ? r(js.filter(j => y[j]).length, js.length) : null,
      avg_ret: js.length ? Math.round((js.reduce((a, j) => a + rows[j][rKey], 0) / js.length) * 100) / 100 : null,
    }
  }).filter(b => b.n > 0)

  const edge = modelRate != null ? Math.round((modelRate - bestNaive) * 1000) / 1000 : null
  return {
    horizon,
    n_all: rows.length,
    n,
    model_hits: modelHits,
    model_rate: modelRate,
    always_up_rate: r(upHits, n),
    always_down_rate: r(n - upHits, n),
    best_naive_rate: n ? bestNaive : null,
    edge,
    brier: Math.round(brier * 1000) / 1000,
    brier_naive: Math.round(brierNaive * 1000) / 1000,
    buckets,
    first_date: rows.map(e => e.date).sort()[0],
    last_date: rows.map(e => e.date).sort().at(-1),
    low_sample: n < 30,
    // ±5 個百分點內視為「跟天真猜法差不多」
    verdict: edge == null ? null : edge >= 0.05 ? 'better' : edge <= -0.05 ? 'worse' : 'similar',
  }
}

/**
 * 以 K 線依「真實交易日」重算 top20_history 每檔的 ret_{h}d,並算同期全市場等權報酬當基準。
 * 就地修改;回傳 { rows, changed, market: {ret_5d: avg,...} }。
 */
export function recomputeTop20Returns(snapshots, barsById, days, horizons = [1, 5, 10, 20]) {
  const closeMaps = {}
  for (const [id, bars] of Object.entries(barsById || {}))
    if (Array.isArray(bars)) closeMaps[id] = new Map(bars.map(b => [b.time, b.close]))
  const dayIdx = new Map(days.map((d, i) => [d, i]))
  const fwd = (id, i, h) => {
    const m = closeMaps[id]
    const a = m?.get(days[i]), b = m?.get(days[i + h])
    return a > 0 && b > 0 ? b / a - 1 : null
  }
  let rows = 0, changed = 0
  const mkt = Object.fromEntries(horizons.map(h => [h, []]))
  for (const s of snapshots || []) {
    const i = dayIdx.get(s?.date)
    for (const h of horizons) {
      if (i == null || i + h >= days.length) continue
      const all = Object.keys(closeMaps).map(id => fwd(id, i, h)).filter(x => x != null && Math.abs(x) < 1)
      if (all.length) mkt[h].push(all.reduce((a, b) => a + b, 0) / all.length)
    }
    for (const st of s?.stocks || []) {
      const id = String(st.stock_id)
      if (!closeMaps[id]) continue // 沒有 K 線就保留原值
      rows++
      for (const h of horizons) {
        const key = `ret_${h}d`
        const v = i == null ? null : fwd(id, i, h)
        const nv = v == null ? null : Math.round(v * 10000) / 10000
        if (st[key] !== undefined && st[key] !== nv) {
          if (st[`${key}_raw`] === undefined) st[`${key}_raw`] = st[key]
          changed++
        }
        st[key] = nv
      }
    }
  }
  const market = {}
  for (const h of horizons) {
    const a = mkt[h]
    if (a.length) market[`ret_${h}d`] = { snapshots: a.length, avg: Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10000) / 10000 }
  }
  return { rows, changed, market }
}
