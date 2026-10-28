// 型態搜尋 —— 使用者手繪一條價格曲線,找出「最近 N 根 K 棒」走勢最像它的個股。
//
// 作法:手繪點 → 依 x 重取樣成固定 SAMPLES 個點 → z-score 正規化;每檔股票取最近
// L 根收盤價做同樣處理,以 Pearson 相關係數當相似度(z-score 後等同歐氏距離的
// 單調轉換,不受股價高低與波動幅度影響,只比「形狀」)。
// 為了容忍「畫的型態比實際走得快/慢一點」,同時試 L×0.8 / L / L×1.25 三種視窗長度,
// 取最高分。全部是純函式,方便 node:test 測試,也不依賴 DOM。

export const SAMPLES = 40

/** 把 [{x,y}] 依 x 排序後,線性內插成 n 個等距 x 上的 y 值。y 以「越大越高」為準。 */
export function resampleDrawing(points, n = SAMPLES) {
  const pts = (points || [])
    .filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    .slice()
    .sort((a, b) => a.x - b.x)
  // 去掉 x 重複的點(手指停住時會連發同一個 x),保留最後一個
  const uniq = []
  for (const p of pts) {
    if (uniq.length && uniq[uniq.length - 1].x === p.x) uniq[uniq.length - 1] = p
    else uniq.push(p)
  }
  if (uniq.length < 2) return null
  const x0 = uniq[0].x
  const x1 = uniq[uniq.length - 1].x
  if (x1 - x0 <= 0) return null
  const out = new Array(n)
  let j = 0
  for (let i = 0; i < n; i++) {
    const x = x0 + (x1 - x0) * (i / (n - 1))
    while (j < uniq.length - 2 && uniq[j + 1].x < x) j++
    const a = uniq[j]
    const b = uniq[j + 1]
    const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x)
    out[i] = a.y + (b.y - a.y) * Math.min(1, Math.max(0, t))
  }
  return out
}

/** 等距序列重取樣成 n 點(線性內插)。 */
export function resampleSeries(series, n = SAMPLES) {
  const len = series.length
  if (len < 2) return null
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const pos = (len - 1) * (i / (n - 1))
    const k = Math.floor(pos)
    const t = pos - k
    out[i] = k + 1 < len ? series[k] * (1 - t) + series[k + 1] * t : series[k]
  }
  return out
}

/** z-score 正規化;序列幾乎是平的(無形狀可比)時回傳 null。 */
export function zNormalize(arr, minRelStd = 0) {
  const n = arr.length
  let mean = 0
  for (const v of arr) mean += v
  mean /= n
  let varSum = 0
  for (const v of arr) varSum += (v - mean) ** 2
  const std = Math.sqrt(varSum / n)
  if (!(std > 0) || (minRelStd > 0 && Math.abs(mean) > 0 && std / Math.abs(mean) < minRelStd)) return null
  return arr.map(v => (v - mean) / std)
}

/** 兩條已 z-normalize、等長序列的 Pearson 相關係數(-1..1)。 */
export function correlation(za, zb) {
  let s = 0
  for (let i = 0; i < za.length; i++) s += za[i] * zb[i]
  return s / za.length
}

/** 取最近 len 根「有值」的收盤價(stock_histories 的 c 陣列可能有 null 缺口)。 */
function lastCloses(closes, len) {
  const out = []
  for (let i = closes.length - 1; i >= 0 && out.length < len; i--) {
    const v = closes[i]
    if (v != null && Number.isFinite(v) && v > 0) out.push(v)
  }
  return out.length === len ? out.reverse() : null
}

function avgTail(arr, len) {
  if (!Array.isArray(arr)) return null
  let s = 0
  let k = 0
  for (let i = arr.length - 1; i >= 0 && k < len; i--) {
    if (arr[i] != null && Number.isFinite(arr[i])) { s += arr[i]; k++ }
  }
  return k ? s / k : null
}

/**
 * 在所有個股中找出最近走勢最像 template 的股票。
 * @param {number[]} template  resampleDrawing 的輸出(y 越大越高)
 * @param {Record<string,{c:number[],v?:number[]}>} stocks  stock_histories.json 的 stocks
 * @param {{lookback?:number, topN?:number, minAvgVolume?:number, flexible?:boolean}} opts
 *   minAvgVolume:近 20 日平均成交量下限(單位同資料檔,張),過濾冷門股
 * @returns {{stock_id:string, score:number, window:number, closes:number[], changePct:number}[]}
 */
export function findSimilarPatterns(template, stocks, opts = {}) {
  const { lookback = 60, topN = 30, minAvgVolume = 0, flexible = true } = opts
  const zt = template && template.length >= 2 ? zNormalize(resampleSeries(template, SAMPLES)) : null
  if (!zt) return []
  const windows = flexible
    ? [...new Set([Math.round(lookback * 0.8), lookback, Math.round(lookback * 1.25)])].filter(w => w >= 5)
    : [lookback]

  const results = []
  for (const [id, k] of Object.entries(stocks || {})) {
    const closesAll = k?.c
    if (!Array.isArray(closesAll)) continue
    if (minAvgVolume > 0) {
      const av = avgTail(k.v, 20)
      if (av == null || av < minAvgVolume) continue
    }
    let best = null
    for (const w of windows) {
      const closes = lastCloses(closesAll, w)
      if (!closes) continue
      // 0.3% 以下的相對波動視為橫盤無形狀(例如停牌、ETF 貨幣型)
      const zs = zNormalize(resampleSeries(closes, SAMPLES), 0.003)
      if (!zs) continue
      const score = correlation(zt, zs)
      if (!best || score > best.score) best = { score, window: w, closes }
    }
    if (!best) continue
    const first = best.closes[0]
    const last = best.closes[best.closes.length - 1]
    results.push({
      stock_id: id,
      score: best.score,
      window: best.window,
      closes: best.closes,
      changePct: first > 0 ? (last / first - 1) * 100 : 0,
    })
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, topN)
}

// 內建型態範本(x 0..1、y 0..1,y 越大越高)。只是起點,使用者可以在上面再修改。
export const PRESET_PATTERNS = [
  { key: 'wbottom',  label: 'W 底',   points: [[0, 0.9], [0.25, 0.1], [0.5, 0.55], [0.75, 0.12], [1, 0.95]] },
  { key: 'mtop',     label: 'M 頭',   points: [[0, 0.1], [0.25, 0.9], [0.5, 0.45], [0.75, 0.88], [1, 0.05]] },
  { key: 'vrev',     label: 'V 轉',   points: [[0, 0.9], [0.5, 0.05], [1, 0.9]] },
  { key: 'cup',      label: '杯柄',   points: [[0, 0.85], [0.15, 0.45], [0.35, 0.15], [0.55, 0.45], [0.7, 0.85], [0.8, 0.7], [0.9, 0.72], [1, 0.95]] },
  { key: 'breakout', label: '盤整突破', points: [[0, 0.3], [0.15, 0.4], [0.3, 0.28], [0.45, 0.4], [0.6, 0.3], [0.75, 0.38], [0.85, 0.35], [1, 0.95]] },
  { key: 'uptrend',  label: '多頭排列', points: [[0, 0.05], [0.2, 0.3], [0.3, 0.22], [0.5, 0.5], [0.6, 0.42], [0.8, 0.72], [0.88, 0.65], [1, 0.95]] },
  { key: 'pullback', label: '漲後回檔', points: [[0, 0.1], [0.55, 0.95], [0.75, 0.7], [1, 0.6]] },
]
