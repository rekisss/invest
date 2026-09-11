// K 線資料品質閘門(build 層,純函式)。
//
// 為什麼需要:回測與盯盤都吃 output/kline_cache.json 的日 K。實測 1554 檔裡只有
// 74.5% 的序列是乾淨的,其餘帶著會直接汙染績效數字的缺陷:
//
//   單日變動超過 ±10%   298 檔(19.2%)
//     台股有 ±10% 漲跌幅限制,所以「單日」不可能超過。出現就代表:
//       (a) 序列缺了交易日 —— 相鄰兩根其實跨了好幾個交易日,看起來像單日暴漲
//       (b) 除權息/分割沒還原 —— 例:緯穎(6669)2026-09-01 收 7800、
//           09-02 開 2790(−67%),那是分割不是下跌
//   零振幅 bar          92 檔
//     開=高=低=收,代表當天沒有真實成交(或資料缺漏),卻會被當成可成交的價位
//
// 這些缺陷不是隨機雜訊,而是**有方向的偏誤**:任何以報酬率為目標的最佳化,都會
// 系統性地被吸引到假跳動最大的股票上。實測「買波動最大」的變體拿到 98.31% 勝率、
// 58 天 +137% —— 那不是策略,是它找到了壞資料。
//
// 因此:先過閘門,再談報酬率。寧可少測一些股票,也不要在壞資料上調參數。

/** 台股單日漲跌幅上限 10%,留一點浮點與零股誤差的餘裕。 */
export const DAILY_LIMIT = 0.105
/** 檢查最近幾根(只看近期:更早的資料不影響目前的交易決策)。 */
export const WINDOW = 40
/** 至少要幾根才夠算指標(ATR14 + 20 日高)。 */
export const MIN_BARS = 30
/** 容許的零振幅 bar 根數。偶爾一根可能是真的跌停鎖死,連續多根就是資料問題。 */
export const MAX_ZERO_RANGE = 2

const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * inspectBars(bars, opts) → {
 *   ok, reason, bars: 有效根數, limitBreaks, worstJumpPct, zeroRange, splitSuspect
 * }
 *
 * reason 只在 ok=false 時有值:
 *   'too_few'      根數不足以算指標
 *   'limit_break'  有超過漲跌幅上限的跳動(缺交易日或未還原權值)
 *   'zero_range'   零振幅 bar 過多
 */
export function inspectBars(bars, opts = {}) {
  const {
    dailyLimit = DAILY_LIMIT, window = WINDOW,
    minBars = MIN_BARS, maxZeroRange = MAX_ZERO_RANGE,
  } = opts

  if (!Array.isArray(bars) || bars.length < minBars) {
    return { ok: false, reason: 'too_few', bars: Array.isArray(bars) ? bars.length : 0,
             limitBreaks: 0, worstJumpPct: null, zeroRange: 0, splitSuspect: false }
  }

  const tail = bars.slice(-window)
  let limitBreaks = 0, worst = 0, splitSuspect = false, zeroRange = 0

  for (let i = 1; i < tail.length; i++) {
    const prev = num(tail[i - 1]?.close), cur = num(tail[i]?.close)
    if (prev == null || cur == null || prev <= 0 || cur <= 0) continue
    const chg = cur / prev - 1
    if (Math.abs(chg) > dailyLimit) {
      limitBreaks++
      if (Math.abs(chg) > Math.abs(worst)) worst = chg
      // 單日腰斬以上幾乎只可能是分割/減資沒還原,不是真實跌幅
      if (chg < -0.3) splitSuspect = true
    }
  }

  for (const b of tail) {
    const o = num(b?.open), h = num(b?.high), l = num(b?.low), c = num(b?.close)
    if (o == null || h == null || l == null || c == null) continue
    if (o === h && h === l && l === c) zeroRange++
  }

  const worstJumpPct = worst === 0 ? null : Math.round(worst * 10000) / 100
  const base = { bars: bars.length, limitBreaks, worstJumpPct, zeroRange, splitSuspect }

  if (limitBreaks > 0) return { ok: false, reason: 'limit_break', ...base }
  if (zeroRange > maxZeroRange) return { ok: false, reason: 'zero_range', ...base }
  return { ok: true, reason: null, ...base }
}

/**
 * makeKlineQualityGate(barsFor, opts) → { isClean, report, stats }
 *
 * barsFor(stock_id) → bars。結果快取,同一檔只檢查一次。
 * isClean(stock) 可直接當 paper-trader 的 pickFilter 用。
 */
export function makeKlineQualityGate(barsFor, opts = {}) {
  const cache = new Map()
  const counts = { ok: 0, too_few: 0, limit_break: 0, zero_range: 0 }

  const report = (sidRaw) => {
    const sid = String(sidRaw ?? '')
    if (!sid) return { ok: false, reason: 'too_few' }
    let r = cache.get(sid)
    if (r === undefined) {
      r = inspectBars(barsFor(sid), opts)
      cache.set(sid, r)
      counts[r.reason || 'ok'] = (counts[r.reason || 'ok'] || 0) + 1
    }
    return r
  }

  return {
    report,
    isClean: (stock) => report(stock?.stock_id).ok,
    stats: () => {
      const total = Object.values(counts).reduce((a, x) => a + x, 0)
      return {
        total,
        ...counts,
        clean_pct: total ? Math.round(counts.ok / total * 1000) / 10 : null,
      }
    },
  }
}
