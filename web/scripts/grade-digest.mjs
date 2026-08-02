// 今日精選「評級品質」摘要(build 層,純函式)。
//
// 每檔精選有 A/B/C/D 評級(A 最強;D 只追蹤不建議)。今日精選若多為 D、A 級稀少,
// 代表當日候選品質偏弱——這是一個即時的選股品質溫度計。若 outcomeStats(以真實收盤
// 事後統計的各評級勝率)有資料,再附上各級的真實歷史勝率,讓「A 比較會贏」有據可查。
// 純規則、可測試;不改任何選股決策。

const GRADES = ['A', 'B', 'C', 'D']

// topStocks:精選列(需含 grade)。outcomeStats:{A:{total,win_rate},...} 或 null。
// 回傳 { counts, actionable, total, real } 或 null(無任何評級可統計)。
export function computeGradeDigest(topStocks, outcomeStats = null) {
  if (!Array.isArray(topStocks) || topStocks.length === 0) return null
  const counts = { A: 0, B: 0, C: 0, D: 0 }
  let total = 0
  for (const s of topStocks) {
    const g = s && typeof s.grade === 'string' ? s.grade.trim().toUpperCase() : ''
    if (g in counts) { counts[g]++; total++ }
  }
  if (total === 0) return null

  // 各評級真實勝率(僅在 outcomeStats 有樣本時附上)
  let real = null
  if (outcomeStats && typeof outcomeStats === 'object') {
    const r = {}
    for (const g of GRADES) {
      const o = outcomeStats[g]
      if (o && typeof o.win_rate === 'number' && (o.total ?? 0) > 0) {
        r[g] = { win_rate: o.win_rate, total: o.total, avg_return_pct: (typeof o.avg_return_pct === 'number' ? o.avg_return_pct : null) }
      }
    }
    if (Object.keys(r).length) real = r
  }

  return {
    counts,
    actionable: counts.A + counts.B + counts.C,   // A/B/C 才是可操作精選(D 只追蹤)
    total,
    real,
  }
}
