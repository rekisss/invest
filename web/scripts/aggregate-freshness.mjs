// aggregate 新鮮度閘門的 build 層入口。
//
// 實作放在 ../src/utils/aggregateFreshness.js —— 跟 tradePlan.js / priceFreshness.js
// 一樣是「前端與 build 共用同一份純函式」的模式。這裡只做轉出,因為 CI 的測試 glob
// 是 `node --test web/scripts/*.test.mjs`,測試檔留在 scripts/ 才會被跑到。
export {
  parseISODate,
  latestScanDate,
  aggregateLagDays,
  isAggregateCurrent,
  currentAggregate,
  freshScanRows,
  AGG_MAX_LAG_DAYS,
} from '../src/utils/aggregateFreshness.js'
