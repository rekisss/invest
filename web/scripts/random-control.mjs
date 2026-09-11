// 亂數對照組的分布估計(build 層,純函式)。
//
// 問題:原本的對照組用一個固定雜湊(FNV-1a)當排序分數。那不是「亂數選股」,
// 而是**一個寫死的投資組合** —— 每次 build 都選同一批股票。它的報酬是一次抽樣,
// 不是期望值。
//
// 為什麼這件事重要:整個系統想回答的是「策略選股有沒有比亂選好」。用單一組合當
// 基準時,只要那組合運氣好,策略就會「輸給亂數」;運氣差就會「贏過亂數」——
// 結論完全由抽樣雜訊決定。實測就出現過對照組年化贏過全市場等權基準 13 個百分點
// 的情況,那在統計上不可能是真實優勢,只可能是單次抽樣。
//
// 解法:跑 N 個不同種子的雜湊,得到報酬的**分布**。策略要有加值,不是贏過某一次
// 抽樣,而是要落在分布的高百分位。
//
// ⚠️ 分布只描述這段歷史樣本,不預測未來,更不構成獲利保證。

/** 預設種子數。多一點分布較穩,但每個種子都要跑一次完整模擬。 */
export const DEFAULT_SEEDS = 20

/**
 * seededRank(seed) → (stock) => number
 *
 * FNV-1a 變體,把 seed 混進初始值。同一個 seed 永遠給出同一個排序(可重現),
 * 不同 seed 給出不相關的排序。
 */
export function seededRank(seed) {
  const s = (Number(seed) >>> 0) || 0
  return (stock) => {
    const id = String(stock?.stock_id ?? '')
    let h = (2166136261 ^ s) >>> 0
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
    return h % 100000
  }
}

const median = (xs) => {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

/** 取百分位(0..1),用最近秩次法,不內插 —— 樣本只有 20 個時內插是假精確。 */
export function percentile(xs, p) {
  if (!xs?.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const i = Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))
  return a[i]
}

/**
 * percentileRankOf(value, xs) → 0..100
 * value 贏過分布中多少 % 的樣本。策略的加值就看這個數字 ——
 * 50 代表跟亂選沒兩樣,90 以上才算有訊號(樣本夠的前提下)。
 */
export function percentileRankOf(value, xs) {
  if (value == null || !xs?.length) return null
  const below = xs.filter(x => x < value).length
  return Math.round(below / xs.length * 1000) / 10
}

const round2 = (v) => v == null ? null : Math.round(v * 100) / 100

/**
 * summarizeControl(runs) → 分布摘要
 * runs: [{ return_pct, stats:{ avg_ret, win_rate, num_trades, payoff_ratio } }]
 */
export function summarizeControl(runs) {
  const ok = (runs || []).filter(Boolean)
  if (!ok.length) return null
  const rets = ok.map(r => r.return_pct).filter(v => v != null)
  const exps = ok.map(r => r?.stats?.avg_ret).filter(v => v != null)
  const wins = ok.map(r => r?.stats?.win_rate).filter(v => v != null)
  const trades = ok.map(r => r?.stats?.num_trades ?? 0)
  const mean = (xs) => xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null
  return {
    seeds: ok.length,
    return_pct: {
      mean: round2(mean(rets)), median: round2(median(rets)),
      p10: round2(percentile(rets, 0.10)), p90: round2(percentile(rets, 0.90)),
      min: round2(Math.min(...rets)), max: round2(Math.max(...rets)),
    },
    avg_ret: {
      mean: round2(mean(exps)), median: round2(median(exps)),
      p10: round2(percentile(exps, 0.10)), p90: round2(percentile(exps, 0.90)),
    },
    win_rate: { mean: round2(mean(wins)) },
    num_trades: { mean: round2(mean(trades)) },
    // 原始序列留著,供 percentileRankOf 算各策略的百分位
    _returns: rets,
    _expectancies: exps,
  }
}

/**
 * scoreAgainstControl(entry, control) → { return_pct_rank, avg_ret_rank, verdict }
 *
 * verdict 只分三檔,刻意不給更細的結論 —— 樣本這麼小,細分是假精確:
 *   'above'   兩個指標都在對照分布的 80 百分位以上
 *   'within'  落在分布中間,與亂選無法區分
 *   'below'   兩個指標都在 20 百分位以下
 */
export function scoreAgainstControl(entry, control) {
  if (!entry || !control) return null
  const rRank = percentileRankOf(entry.return_pct, control._returns)
  const eRank = percentileRankOf(entry?.stats?.avg_ret ?? entry?.avg_ret, control._expectancies)
  let verdict = 'within'
  if (rRank != null && eRank != null) {
    if (rRank >= 80 && eRank >= 80) verdict = 'above'
    else if (rRank <= 20 && eRank <= 20) verdict = 'below'
  }
  return { return_pct_rank: rRank, avg_ret_rank: eRank, verdict }
}
