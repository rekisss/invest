// Shared cache for stock_histories.json (several MB). Multiple components
// each lazy-load this file the first time a stock detail is opened; without
// a shared cache every one of them re-fetches and re-parses the same
// multi-MB payload independently. Module-level promise cache ensures the
// fetch + JSON.parse happens at most once per page session.
//
// Callers pass the app BASE_URL so the fetch resolves under any deploy path.
let cachedPromise = null

export function getStockHistories(base = '/') {
  if (!cachedPromise) {
    // cache:'no-cache' 沿用 Dashboard 原本的語意——每次連線向伺服器驗證一次新鮮度
    // (檔案每日重建)。未改動的話會拿到 304,不會重下 8MB;而 module 層的 promise
    // 保證整個 session 只發一次請求。
    cachedPromise = fetch(`${base}stock_histories.json`, { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(h => h || {})
  }
  return cachedPromise
}
