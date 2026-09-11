// 「預測回顧」逐日清單的資料來源決策 —— 抽成純函式以便單元測試。
//
// 2026-09-11 修正:清單原本**完全**由掃描池代理(scoreProxyPredictions)產生,
// 真實收盤結果只被用在卡片頂端的總命中率,逐日那一列完全沒用到。
//
// 代理要等基準曲線(aiTrader.benchmark.curve)累積滿 5 根前瞻 K 棒才算得出來,
// 所以最新的幾個預測日一律算不出來 → 那幾列「整列消失」。但真實大盤收盤
// 只落後一天就有了(outcome_tracker.py → realOutcomes.prediction)。
// 現場實例:代理最新只到 2026-09-03,而 09-04 / 09-07 / 09-08 / 09-10 的真實
// 命中結果其實都已經存在,使用者卻看到最近一週全部空白。
//
// 正解:逐日清單以**真實收盤**為主(權威且只落後一天),沒有真實紀錄的日期才
// 退回代理。每列標明它的期距來源,避免把 5 日期距與隔日打分混為一談。

import { scoreProxyPredictions, PROXY_HORIZON } from './proxyScore.js'

// 真實紀錄的三種狀態:
//   h5      — 5 個交易日期距已到期,hit_h5 / ret_h5 可用(與模型訓練目標同期距,最權威)
//   d1      — 期距未到,但隔日方向已知(hit / taiex_pct)
//   pending — 有方向但兩者都還沒到位;中性預測則本來就不計分
export function realRowFor(entry) {
  if (!entry?.date) return null
  const pct = typeof entry.taiex_pct === 'number' ? Math.round(entry.taiex_pct * 10000) / 100 : null
  const base = {
    date: entry.date,
    label: entry.pred_label || '',
    prob: typeof entry.xgb_prob_up === 'number' ? entry.xgb_prob_up : null,
    source: 'real',
  }
  if (entry.hit_h5 != null) {
    return { ...base, ret: typeof entry.ret_h5 === 'number' ? entry.ret_h5 : pct, hit: entry.hit_h5, horizon: 5, pending: false }
  }
  if (entry.hit != null) {
    return { ...base, ret: pct, hit: entry.hit, horizon: 1, pending: false }
  }
  // 有方向但期距未到 → 標成等待中(不是未命中);中性預測不計分也不等待
  return { ...base, ret: pct, hit: null, horizon: 5, pending: entry.directional === true }
}

export function buildReviewRows({ history, benchCurve, realOutcomes, limit = 14 } = {}) {
  // 代理先不截斷:要拿它補真實紀錄沒涵蓋到的舊日期
  const proxyRows = scoreProxyPredictions(history, benchCurve, { limit: Number.MAX_SAFE_INTEGER })
  const proxyByDate = new Map(proxyRows.map(r => [r.date, r]))

  const realByDate = new Map()
  for (const e of (realOutcomes?.prediction || [])) {
    if (e?.date) realByDate.set(e.date, e)
  }

  const dates = [...new Set([...realByDate.keys(), ...proxyByDate.keys()])]
    .sort((a, b) => String(b).localeCompare(String(a)))   // 新→舊

  const out = []
  for (const date of dates) {
    const real = realByDate.has(date) ? realRowFor(realByDate.get(date)) : null
    if (real) { out.push(real); continue }
    const p = proxyByDate.get(date)
    if (p) out.push({ ...p, source: 'proxy', horizon: PROXY_HORIZON, pending: false })
  }
  return out.slice(0, limit)
}

// 逐日清單自己的命中統計(只算真的打過分的列)。中性/等待中不進分母。
export function summarizeReviewRows(rows) {
  const scored = (rows || []).filter(r => r && r.hit != null)
  if (!scored.length) return null
  const hits = scored.filter(r => r.hit).length
  return { hits, total: scored.length, pct: Math.round(hits / scored.length * 100) }
}
