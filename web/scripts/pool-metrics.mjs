// 全池指標 — 從 K 線快取補齊掃描列缺少的欄位(build 層,純函式)。
//
// 為什麼需要這支:
// 掃描輸出有兩個池子,欄位密度差很多 ——
//   top_stocks    50 檔,欄位齊全(含 atr14、close_20d_high、volume_ma20)
//   filter_stocks ~1500 檔,欄位精簡,**沒有 atr14、沒有成交量、沒有 20 日高**
//
// 這造成兩個實際問題:
//   1. 期望報酬模型(expectancy.mjs)需要 atr14 當下檔風險 → 在全池上 100% 退回
//      entry_score,等於模型完全沒生效(實測 0/1503 檔算得出模型值)。
//   2. 沒有成交量就無法判斷可不可成交。全池有 19% 的股票 20 日均成交金額低於
//      200 萬,而紙上交易員每筆投入約 16.7 萬 —— 那是全天成交量的 8%,回測拿得到
//      的成交價在真實下單時並不存在。不濾掉的話,回測結果會被這些股票汙染。
//
// K 線快取(output/kline_cache.json)有全池 1503/1503 檔的完整 OHLCV,所以這些
// 指標都算得出來,不需要改動任何 Python。

/** 預設 ATR 週期。 */
export const ATR_PERIOD = 14
/** 預設回看視窗(20 日高、20 日均量)。 */
export const LOOKBACK = 20

const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * atr14(bars, period) → 真實波幅均值,或 null
 *
 * True Range = max(高−低, |高−前收|, |前收−低|),取最近 period 根的算術平均。
 * 需要 period+1 根(第一根沒有前收)。
 */
export function atr(bars, period = ATR_PERIOD) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null
  const trs = []
  for (let i = bars.length - period; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1]
    const high = num(b?.high), low = num(b?.low), pc = num(prev?.close)
    if (high == null || low == null || pc == null) return null
    trs.push(Math.max(high - low, Math.abs(high - pc), Math.abs(pc - low)))
  }
  const v = trs.reduce((a, x) => a + x, 0) / trs.length
  return Math.round(v * 10000) / 10000
}

/** 最近 n 根的最高價(含當根)。 */
export function highN(bars, n = LOOKBACK) {
  if (!Array.isArray(bars) || bars.length === 0) return null
  let h = null
  for (const b of bars.slice(-n)) {
    const x = num(b?.high) ?? num(b?.close)
    if (x != null && (h == null || x > h)) h = x
  }
  return h == null ? null : Math.round(h * 100) / 100
}

/**
 * turnover(bars, n) → 近 n 日平均成交「金額」(元),或 null
 *
 * 用金額而不是股數:200 元的股票成交 1 萬股(200 萬)跟 20 元的股票成交 1 萬股
 * (20 萬)是完全不同的流動性,只看股數會誤判。
 */
export function turnover(bars, n = LOOKBACK) {
  if (!Array.isArray(bars) || bars.length === 0) return null
  const last = bars.slice(-n)
  let sum = 0, cnt = 0
  for (const b of last) {
    const v = num(b?.volume), c = num(b?.close)
    if (v == null || c == null) continue
    sum += v * c
    cnt++
  }
  if (!cnt) return null
  return Math.round(sum / cnt)
}

/**
 * enrichFromBars(stock, bars) → 補上 atr14 / close_20d_high / gap_to_20d_high_pct /
 * turnover_20d 的新物件(不改動原物件)。
 *
 * 掃描列已經有的欄位一律保留 —— top_stocks 自己帶的值比這裡回推的精確
 * (它由完整 pipeline 算出),只在缺值時才補。
 */
export function enrichFromBars(stock, bars) {
  if (!stock) return stock
  const out = { ...stock }
  if (num(out.atr14) == null) {
    const a = atr(bars)
    if (a != null) out.atr14 = a
  }
  if (num(out.close_20d_high) == null) {
    const h = highN(bars)
    if (h != null) out.close_20d_high = h
  }
  // 到 20 日高的距離:掃描列多半已有,缺的話用收盤與 20 日高回推
  if (num(out.gap_to_20d_high_pct) == null) {
    const c = num(out.close), h = num(out.close_20d_high)
    if (c != null && c > 0 && h != null) {
      out.gap_to_20d_high_pct = Math.round((h / c - 1) * 10000) / 100
    }
  }
  const t = turnover(bars)
  if (t != null) out.turnover_20d = t
  return out
}

/** 可成交門檻的預設值(元)。低於此值的股票,紙上交易的成交價不具參考性。 */
export const MIN_TURNOVER = 20_000_000   // 2000 萬

/**
 * isTradable(stock, minTurnover) → bool
 *
 * 沒有成交金額資料時回 true(不因為缺資料就把股票排除 —— 那會讓濾網變成
 * 「只留有 K 線的股票」這種與流動性無關的偏誤)。
 */
export function isTradable(stock, minTurnover = MIN_TURNOVER) {
  const t = num(stock?.turnover_20d)
  if (t == null) return true
  return t >= minTurnover
}
