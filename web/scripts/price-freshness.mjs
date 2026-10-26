// 報價新鮮度的 build 層入口。
//
// 實作放在 ../src/utils/priceFreshness.js —— 跟 tradePlan.js 一樣是「前端與
// build 共用同一份純函式」的模式。這裡只做轉出,原因有兩個:
//   1. 前端要能用同一份邏輯**即時重算**。build 時算出的 level 寫進 data.json
//      後就凍結了,但頁面可能開著好幾天,到時候那個 level 已經不準。
//   2. CI 的測試 glob 是 `node --test web/scripts/*.test.mjs`,
//      price-freshness.test.mjs 留在 scripts/ 才會被跑到。
export {
  checkPriceFreshness,
  summarizeStockFreshness,
  lastBarDateFor,
  latestBarFromHistories,
  STALE_SHARE_WARN,
  weekdaysBetween,
  taipeiToday,
  parseBarDate,
  WARN_WEEKDAYS,
  STALE_WEEKDAYS,
} from '../src/utils/priceFreshness.js'
