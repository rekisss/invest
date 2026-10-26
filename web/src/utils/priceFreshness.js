// 報價新鮮度閘門(build 層,純函式)。
//
// 背景——這是一個真實發生過、而且沒人察覺的故障:
//   2026-09-03 之後 output/kline_cache.json 停止更新(檔案長到 99.89 MiB,
//   撞上 GitHub 單檔 100 MiB 上限,每次 push 都被 pre-receive hook 退回)。
//   但掃描流程照常每天跑,所以:
//     - data.json 的 generated_at 每天都是新的 → data-preflight 判定 ok
//     - 前端 header 的「資料日期」顯示的是最新**掃描日**,也每天都在動
//   於是整個系統看起來完全正常,實際上 AI 操盤與盯盤用的是 7 週前的價格。
//   使用者是從「AI 交易好像沒在跑了」才發現的,中間 41 天的紀錄全是壞的。
//
// 教訓:「檔案是今天產生的」不等於「裡面的價格是今天的」。前者只證明管線有跑,
// 後者才是資料有用的條件。這支檔案專門檢查後者——看最新一根 K 棒離今天多遠。
//
// 為什麼用「交易日(週一~週五)」而不是日曆天數:
//   週末本來就沒有新 K 棒,用日曆天數會在每個星期一誤報。改數平日後,
//   正常情況恆為 0~1,只要管線斷掉這個數字就會單調成長,訊噪比高得多。

/** 落後幾個平日開始警告。1 是正常的(當天收盤前還沒有今天的 K 棒)。 */
export const WARN_WEEKDAYS = 2
/**
 * 落後幾個平日視為「確定壞了」。
 * 台股最長連續休市是農曆年(跨兩個週末,最多約 6 個平日),所以 7 以上
 * 不可能是假日造成的,一定是資料管線斷了。
 */
export const STALE_WEEKDAYS = 7

const DAY_MS = 86400000
/** 台北時間 = UTC+8。K 棒日期是台北日期,now 多半是 UTC,換算後才能比。 */
const TAIPEI_OFFSET_MS = 8 * 3600000

/** 'YYYY-MM-DD' → UTC 午夜的 ms;格式不對回 NaN。 */
export function parseBarDate(s) {
  if (typeof s !== 'string') return NaN
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return NaN
  return Date.UTC(+m[1], +m[2] - 1, +m[3])
}

/** now(Date 或 ms)→ 當下的台北日期 'YYYY-MM-DD'。 */
export function taipeiToday(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : now
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 計算 from 之後、到 to(含)之間有幾個平日。
 * from === to → 0。to 比 from 早 → 負數(時鐘/時區有問題時用得到)。
 */
export function weekdaysBetween(from, to) {
  const a = parseBarDate(from)
  const b = parseBarDate(to)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN
  if (b === a) return 0
  const sign = b > a ? 1 : -1
  const [lo, hi] = b > a ? [a, b] : [b, a]
  let n = 0
  // 從 lo 的隔天數到 hi(含)。區間最多幾百天,直接迴圈即可。
  for (let t = lo + DAY_MS; t <= hi; t += DAY_MS) {
    const dow = new Date(t).getUTCDay()  // 0=日, 6=六
    if (dow !== 0 && dow !== 6) n++
  }
  return n * sign
}

/**
 * checkPriceFreshness({ latestBar, now }) → {
 *   level: 'ok' | 'warn' | 'stale' | 'unknown',
 *   latestBar, today, weekdaysBehind, ageDays, message
 * }
 *
 * latestBar: 資料裡最新一根日 K 的日期字串 'YYYY-MM-DD'
 * now:       現在時間(Date 或 ms),預設 Date.now()
 *
 * level 語意:
 *   ok      落後 0~1 個平日 —— 正常
 *   warn    落後 2 個平日以上但仍在假日可解釋的範圍 —— 連假就會這樣,但也可能剛開始落後
 *   stale   落後 STALE_WEEKDAYS 以上 —— 假日解釋不了,資料管線斷了
 *   unknown 沒有可解析的日期 —— 無從判斷,不當成通過
 */
export function checkPriceFreshness({ latestBar, now = Date.now() } = {}) {
  const today = taipeiToday(now)
  const barMs = parseBarDate(latestBar)
  if (!Number.isFinite(barMs)) {
    return {
      level: 'unknown',
      latestBar: latestBar ?? null,
      today,
      weekdaysBehind: null,
      ageDays: null,
      message: '找不到可解析的最新 K 棒日期,無法確認報價新鮮度。',
    }
  }
  const weekdaysBehind = weekdaysBetween(latestBar, today)
  const ageDays = Math.round((parseBarDate(today) - barMs) / DAY_MS)

  if (weekdaysBehind < 0) {
    return {
      level: 'warn',
      latestBar,
      today,
      weekdaysBehind,
      ageDays,
      message: `最新 K 棒日期 ${latestBar} 在今天(${today})之後,時區或時鐘可能有問題。`,
    }
  }
  if (weekdaysBehind >= STALE_WEEKDAYS) {
    return {
      level: 'stale',
      latestBar,
      today,
      weekdaysBehind,
      ageDays,
      message:
        `報價已停止更新:最新 K 棒是 ${latestBar},距今 ${ageDays} 天(${weekdaysBehind} 個交易日)。` +
        `台股最長連假也不會超過 ${STALE_WEEKDAYS - 1} 個交易日,所以這不是假日——` +
        `kline 抓取流程(kline-fetch / kline_cache.json)應該是斷了。` +
        `在修好之前,回測、盯盤與 AI 操盤用的都是過期價格,產生的紀錄不可信。`,
    }
  }
  if (weekdaysBehind >= WARN_WEEKDAYS) {
    return {
      level: 'warn',
      latestBar,
      today,
      weekdaysBehind,
      ageDays,
      message:
        `最新 K 棒是 ${latestBar},距今 ${ageDays} 天(${weekdaysBehind} 個交易日)。` +
        `若非連假,請確認 kline 抓取流程是否正常。`,
    }
  }
  return {
    level: 'ok',
    latestBar,
    today,
    weekdaysBehind,
    ageDays,
    message: `報價新鮮度 OK(最新 K 棒 ${latestBar},落後 ${weekdaysBehind} 個交易日)。`,
  }
}

/** 整體判定要降級時,容許多少比例的個股落後。超過就代表不是零星缺漏。 */
export const STALE_SHARE_WARN = 0.1

/**
 * 找出某檔股票自己最後一根有價格的 K 棒日期。
 *
 * 欄式結構裡每檔的陣列都對齊共用的 dates,缺的 bar 是 null。所以「這檔最後
 * 一根」要從尾端往前找第一個非 null,不能直接用 dates 的最後一個。
 */
export function lastBarDateFor(dates, closes) {
  if (!Array.isArray(dates) || !Array.isArray(closes)) return null
  for (let i = Math.min(dates.length, closes.length) - 1; i >= 0; i--) {
    if (closes[i] != null) return dates[i] ?? null
  }
  return null
}

/**
 * 逐檔檢查新鮮度,而不是只看共用 dates 的最大值。
 *
 * 為什麼必要(Codex review 指出的漏洞):dates 是**所有股票日期的聯集**。
 * 只要有一檔抓到今天的 bar,聯集的最大值就是今天 —— 即使另外 300 檔都停在
 * 三週前,只看聯集會報「新鮮度 OK」,使用者卻在畫面上看到那 300 檔的舊價格。
 * 這種「部分落後」在本專案是已知會發生的狀況(kline-supplement.mjs 就是
 * 為了補這種缺漏而存在)。
 *
 * 判定取兩者中較嚴重的:
 *   1. 聯集最大值的新鮮度 —— 抓「整個管線停掉」
 *   2. 落後個股的比例     —— 抓「部分股票停掉」
 *
 * 回傳在 checkPriceFreshness 的欄位之外,additionally 帶:
 *   totalStocks, staleStocks, staleShare, worstStaleBar
 */
export function summarizeStockFreshness({ dates, stocks, now = Date.now() } = {}) {
  const unionLatest = latestBarFromHistories({ dates })
  const base = checkPriceFreshness({ latestBar: unionLatest, now })

  const entries = stocks && typeof stocks === 'object' ? Object.entries(stocks) : []
  if (entries.length === 0) return { ...base, totalStocks: 0, staleStocks: 0, staleShare: 0, worstStaleBar: null }

  let staleStocks = 0
  let worstStaleBar = null
  let counted = 0
  for (const [, s] of entries) {
    const last = lastBarDateFor(dates, s?.c)
    if (!last) continue          // 整檔沒有任何價格,不是「落後」,是沒資料
    counted++
    const r = checkPriceFreshness({ latestBar: last, now })
    if (r.level === 'stale') {
      staleStocks++
      if (worstStaleBar == null || last < worstStaleBar) worstStaleBar = last
    }
  }
  const staleShare = counted > 0 ? staleStocks / counted : 0

  // 整體已經是 stale 就不必再降級;否則依落後比例決定是否蓋過 base。
  if (base.level !== 'stale' && staleShare > STALE_SHARE_WARN) {
    const pct = (staleShare * 100).toFixed(1)
    return {
      ...base,
      level: 'warn',
      totalStocks: counted,
      staleStocks,
      staleShare,
      worstStaleBar,
      message:
        `共用交易日的最新 K 棒是 ${unionLatest},但 ${staleStocks}/${counted} 檔(${pct}%)` +
        `自己的最後一根已落後超過 ${STALE_WEEKDAYS} 個交易日,最舊停在 ${worstStaleBar}。` +
        `部分股票的報價是過期的 —— 可跑 kline-supplement.mjs 補抓。`,
    }
  }
  return { ...base, totalStocks: counted, staleStocks, staleShare, worstStaleBar }
}

/**
 * 從 stock_histories.json 的結構取出最新一根 K 棒日期。
 * dates 是升冪排序的共用交易日陣列,最後一個就是最新。
 */
export function latestBarFromHistories(histories) {
  const dates = histories?.dates
  if (!Array.isArray(dates) || dates.length === 0) return null
  // 不假設一定排序好——取字典序最大值(ISO 日期的字典序 = 時間序)。
  let max = null
  for (const d of dates) {
    if (typeof d !== 'string') continue
    if (max == null || d > max) max = d
  }
  return max
}
