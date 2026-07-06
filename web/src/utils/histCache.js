// Shared cache for stock_histories.json (several MB). Multiple components
// each lazy-load this file the first time a stock detail is opened; without
// a shared cache every one of them re-fetches and re-parses the same
// multi-MB payload independently. Module-level promise cache ensures the
// fetch + JSON.parse happens at most once per page session.
let cachedPromise = null

export function getStockHistories(base = '/') {
  if (!cachedPromise) {
    cachedPromise = fetch(`${base}stock_histories.json`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(h => h || {})
  }
  return cachedPromise
}
