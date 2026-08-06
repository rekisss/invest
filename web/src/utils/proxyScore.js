// 盤前預測的「掃描池代理」打分(純函式,前端與日報共用)。
//
// 2026-08 診斷:MarketPredictor(horizon=5) 預測的是「5 個交易日後」,但這個代理
// 命中率原本拿**單日**報酬打分——跟真實收盤打分犯的是同一個錯(見 outcome-fix.mjs)。
// 拿五天後的預報去對隔天結果,命中率結構上就不可能對。這裡改成用同一段期距的
// 累積報酬打分,並把門檻對齊模型訓練時的定義(漲跌逾 0.3% 才算有方向)。
//
// benchCurve:[{date, ret_pct}] 的**累積**報酬曲線(掃描池等權),日期升冪。

export const PROXY_HORIZON = 5
export const FLAT_BAND = 0.3      // 與訓練 target 的 0.3% 門檻一致

const isBull = (label) => label === '偏多' || label === '看多'
const isBear = (label) => label === '偏空' || label === '看空'

// 單筆判定:期距內累積報酬 ret(%) 對上預測方向是否命中。
export function hitForLabel(label, ret) {
  if (ret == null || !Number.isFinite(ret)) return null
  if (isBull(label)) return ret > FLAT_BAND
  if (isBear(label)) return ret < -FLAT_BAND
  return Math.abs(ret) <= FLAT_BAND     // 中性:走平才算命中
}

// 對每筆預測算出「期距內累積報酬」與命中與否。
// 回傳 [{date, label, prob, ret, hit, end_date}],僅含期距已到期的預測(新到舊)。
export function scoreProxyPredictions(history, benchCurve, opts = {}) {
  const horizon = opts.horizon ?? PROXY_HORIZON
  const limit = opts.limit ?? 14
  const curve = Array.isArray(benchCurve) ? benchCurve : []
  if (curve.length < horizon + 1 || !Array.isArray(history) || history.length === 0) return []

  const asc = [...curve]
    .filter(p => p && p.date && typeof p.ret_pct === 'number')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const idxOf = new Map(asc.map((p, i) => [p.date, i]))

  const out = []
  for (const p of history) {
    if (!p || !p.date || !p.xgb_label) continue
    const i = idxOf.get(p.date)
    if (i == null) continue
    const j = i + horizon
    if (j >= asc.length) continue            // 期距未到期,先不打分
    // 累積曲線相減 = 這段期間的報酬(小數量級下近似區間報酬)
    const ret = Math.round((asc[j].ret_pct - asc[i].ret_pct) * 100) / 100
    out.push({
      date: p.date,
      label: p.xgb_label,
      prob: p.xgb_prob_up,
      ret,
      hit: hitForLabel(p.xgb_label, ret),
      end_date: asc[j].date,
    })
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)))
  return out.slice(0, limit)
}

// 便利函式:回傳 {hits, total, pct} 或 null。
export function summarizeProxy(rows) {
  const scored = (rows || []).filter(r => r.hit != null)
  if (!scored.length) return null
  const hits = scored.filter(r => r.hit).length
  return { hits, total: scored.length, pct: Math.round(hits / scored.length * 100) }
}
