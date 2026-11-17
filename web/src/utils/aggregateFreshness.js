// aggregate_latest.json 的新鮮度閘門(純函式,前端與 build 共用)。
//
// 背景——又一個「檔案看起來活著、內容其實凍了」的故障:
//   output/aggregate_latest.json 內部的 date 停在 2026-06-22,到 2026-11-16
//   已經 148 天沒動。原因是產生它的 workflow 早就被刪掉了,現在沒有任何
//   workflow 會 git add 這個檔案,但它還留在 repo 裡,所以每次 build 都照讀。
//
//   build-data.mjs 注入 scans 時**有**把關(只在 isNewer || isMissing 時注入),
//   所以六月那份沒有混進 scans。問題在 build-data.mjs 最後把原始 aggregateLatest
//   無條件寫進 data.json,而前端好幾處直接把 data.aggregateLatest 當成「最新」用:
//
//     Portfolio.jsx   價格查詢把 aggregate 展開在最前面,.find() 取第一筆就贏
//     Performance.jsx 「保留欄位最多的那筆」,aggregate 欄位多所以蓋過當日掃描
//     Overview.jsx    calendar_risk 優先取 aggregate
//     GeminiStudio    把六月的 20 檔標成「最新精選 TOP20」餵給 AI
//
//   實測(2026-11-16 的 data.json):那 20 檔在當日掃描裡全都有正確價格,但被
//   六月價蓋掉,誤差中位數 33.8%、最大 55.84%(聯茂 308 → 480)。持股只要落在
//   這 20 檔裡,損益就是用六月價算的。
//
// 教訓跟 priceFreshness.js 同一個:「檔案存在」不等於「內容是當期的」。
// 這支檔案只做一件事——先問 aggregate 是不是當期,再決定要不要採用。
//
// 為什麼用 0~1 天的窗而不是嚴格等號:
//   aggregate 的 date 是 FinMind 的**資料日**,scans 的 key 是**執行日**,
//   兩者可能差一天。build-data.mjs 的 aggExecDate 就是用 `diff >= 0 && diff <= 1`
//   這個窗把資料日對回執行日的。這裡沿用同一條規則,才不會把合法的隔日
//   執行日誤判成過期。(Dashboard.jsx 用的嚴格等號偏嚴,會誤殺這種情況。)

/** aggregate 的資料日落後掃描日幾天以內算「當期」。沿用 build-data.mjs 的對應窗。 */
export const AGG_MAX_LAG_DAYS = 1

const DAY_MS = 86400000

/** 'YYYY-MM-DD'(可帶時間後綴)→ UTC 午夜 ms;格式不對回 NaN。 */
export function parseISODate(s) {
  if (typeof s !== 'string') return NaN
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return NaN
  return Date.UTC(+m[1], +m[2] - 1, +m[3])
}

/**
 * 最新一個「真的有列」的掃描日。
 *
 * 跟 Portfolio / Performance / GeminiStudio 裡各自手寫的 latestScan() 同一套
 * 判準(有 top_stocks 或 filter_stocks 才算),只是回日期而不是回 scan 物件。
 * 空掃描要跳過——不然會拿一個沒有列的日期去跟 aggregate 比,比出來沒意義。
 */
export function latestScanDate(data) {
  const scans = data?.scans
  if (!scans || typeof scans !== 'object') return null
  for (const d of Object.keys(scans).sort().reverse()) {
    const s = scans[d]
    if (s && ((s.top_stocks && s.top_stocks.length) || (s.filter_stocks && s.filter_stocks.length))) return d
  }
  return null
}

/**
 * aggregate 落後最新掃描日幾天。
 * 回 null = 無從判斷(沒有 aggregate、沒有掃描、或日期不可解析)。
 * 負數 = aggregate 比掃描還新(它自己就是最新的那份)。
 */
export function aggregateLagDays(data) {
  const aggDate = data?.aggregateLatest?.date
  const scanDate = latestScanDate(data)
  const a = parseISODate(aggDate)
  const b = parseISODate(scanDate)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / DAY_MS)
}

/**
 * aggregate 是不是當期的?
 *
 * 不可判斷時回 false —— 刻意 fail closed。這個閘門的用途是「要不要拿它當最新
 * 資料用」,在不確定的情況下寧可不用(當日掃描本來就是更完整的來源),也不要
 * 再發生一次拿六月價算損益。
 */
export function isAggregateCurrent(data, maxLagDays = AGG_MAX_LAG_DAYS) {
  if (!data?.aggregateLatest) return false
  const lag = aggregateLagDays(data)
  if (lag == null) return false
  return lag <= maxLagDays
}

/** 當期的 aggregate 物件,過期或無從判斷則 null。給 `?.` 直接串下去用。 */
export function currentAggregate(data, maxLagDays = AGG_MAX_LAG_DAYS) {
  return isAggregateCurrent(data, maxLagDays) ? data.aggregateLatest : null
}

/**
 * 可搜尋的掃描列,依「當期優先」排序。
 *
 * 兩個刻意的設計:
 *   1. aggregate 只在當期時才納入(過期就整份不給)。
 *   2. 就算當期,也排在**最後**。因為同一天的 CSV 掃描資料較完整
 *      (有 selectable_stocks / grade_counts 等),build-data.mjs 注入時
 *      「同日已有 CSV 就不注入」正是同一個偏好。消費端用 .find() 取第一筆
 *      或用「欄位最多的贏」都會因此拿到當日掃描那筆。
 */
export function freshScanRows(data, maxLagDays = AGG_MAX_LAG_DAYS) {
  const scans = data?.scans || {}
  const d = latestScanDate(data)
  const s = d ? scans[d] : null
  const agg = currentAggregate(data, maxLagDays)
  return [
    ...(s?.top_stocks || []),
    ...(s?.filter_stocks || []),
    ...(agg?.top_stocks || []),
  ]
}
