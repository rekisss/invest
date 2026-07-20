// Live Taiwan stock prices — hybrid approach
//
// Primary:  Browser fetches TWSE/TPEX official OpenAPI directly (CORS-friendly, truly real-time)
// Fallback: GitHub Actions price cache (live-prices.yml, updated every 3 min during open)
//           Used when official APIs are temporarily unavailable
//
// Poll interval: 60 s during market open, no poll after close (prices are final)

import { useState, useEffect, useMemo } from 'react'
import { getFugleKey, fetchFugleQuotes } from '../utils/fugleLive'

// raw.githubusercontent.com is NOT subject to the api.github.com 60-req/hr limit,
// so it's safe to poll on every refresh (the cache is now a primary source).
const CACHE_URL = 'https://raw.githubusercontent.com/rekisss/invest/data/live_prices.json'
// Shioaji broker-feed cache (read-only snapshots, populated by live-prices-shioaji.yml
// when SHIOAJI_* secrets are configured). Preferred when fresh.
const SHIOAJI_CACHE_URL = 'https://raw.githubusercontent.com/rekisss/invest/data/live_prices_shioaji.json'

const TWSE_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'
const TPEX_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes'
const TWSE_IDX = 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX'

export function isOTCStock(stockId) {
  const n = parseInt(String(stockId), 10)
  return (n >= 4200 && n <= 4999) || (n >= 5000 && n <= 5999) ||
         (n >= 6000 && n <= 6999) || (n >= 7000 && n <= 7999) ||
         (n >= 8000 && n <= 8999) || (n >= 9200 && n <= 9999)
}

export function isTWSEOpen() {
  const now = new Date()
  const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
  const day = tw.getDay()
  if (day === 0 || day === 6) return false
  const min = tw.getHours() * 60 + tw.getMinutes()
  return min >= 540 && min <= 810  // 09:00–13:30
}

export function getTWSESession() {
  const now = new Date()
  const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
  const day = tw.getDay()
  if (day === 0 || day === 6) return 'weekend'
  const min = tw.getHours() * 60 + tw.getMinutes()
  if (min < 540)  return 'pre'
  if (min <= 810) return 'open'
  return 'closed'
}

function sameTWDay(a, b) {
  const fmt = d => new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
  const ta = fmt(a), tb = fmt(b)
  return ta.getFullYear() === tb.getFullYear() &&
         ta.getMonth()    === tb.getMonth()    &&
         ta.getDate()     === tb.getDate()
}

// 注意不能用 `|| null`：平盤股 Change="0.00" 是合法的 0，|| 會把它變 null，
// 造成平盤股不顯示漲跌幅。
function parseNum(s) { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : null }
function parseVol(s) { return parseInt(String(s  ?? '').replace(/,/g, '')) || 0 }

// ── Tier 1: TWSE/TPEX Official OpenAPI (browser, CORS-friendly) ──────────────
export async function fetchTWSEOfficial(ids) {
  const result  = {}
  const idSet   = new Set(ids)
  const twseIds = ids.filter(id => !isOTCStock(id))
  const tpexIds = ids.filter(id =>  isOTCStock(id))
  const fetches = []

  let twseFetchIdx = -1, tpexFetchIdx = -1
  if (twseIds.length) { twseFetchIdx = fetches.length; fetches.push(
    fetch(TWSE_URL, { signal: AbortSignal.timeout(12000) })
      .then(r => r.ok ? r.json() : null).catch(() => null)
  )}
  if (tpexIds.length) { tpexFetchIdx = fetches.length; fetches.push(
    fetch(TPEX_URL, { signal: AbortSignal.timeout(12000) })
      .then(r => r.ok ? r.json() : null).catch(() => null)
  )}

  try {
    const rawResults = await Promise.all(fetches)
    const twseData = (twseFetchIdx >= 0 && Array.isArray(rawResults[twseFetchIdx])) ? rawResults[twseFetchIdx] : []
    const tpexData = (tpexFetchIdx >= 0 && Array.isArray(rawResults[tpexFetchIdx])) ? rawResults[tpexFetchIdx] : []

    for (const item of twseData) {
      const id = item.Code
      if (!idSet.has(id)) continue
      const price  = parseNum(item.ClosingPrice)
      const change = parseNum(item.Change)
      if (!price) continue
      const prev = (change != null && !isNaN(change)) ? price - change : null
      result[id] = {
        price, prevClose: prev,
        pct:    prev ? change / prev : null,
        high:   parseNum(item.HighestPrice),
        low:    parseNum(item.LowestPrice),
        open:   parseNum(item.OpeningPrice),
        volume: parseVol(item.TradeVolume),
        time:   new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' }),
        isSnapshot: false,
      }
    }

    for (const item of tpexData) {
      const id = item.SecuritiesCompanyCode ?? item.Code
      if (!idSet.has(id)) continue
      const price  = parseNum(item.Close ?? item.ClosingPrice)
      const change = parseNum(item.Change)
      if (!price) continue
      const prev = (change != null && !isNaN(change)) ? price - change : null
      result[id] = {
        price, prevClose: prev,
        pct:    prev ? change / prev : null,
        high:   parseNum(item.High ?? item.HighestPrice),
        low:    parseNum(item.Low  ?? item.LowestPrice),
        open:   parseNum(item.Open ?? item.OpeningPrice),
        volume: parseVol(item.TradeVolume),
        time:   new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' }),
        isSnapshot: false,
      }
    }
  } catch (e) {
    console.warn('TWSE/TPEX official API error:', e.message)
  }
  return result
}

// ── Index fetch: TWSE MI_INDEX (browser, CORS-friendly) ───────────────────────
export async function fetchIndices() {
  try {
    const r = await fetch(TWSE_IDX, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return null
    const data = await r.json()
    const out = {}
    for (const item of (data || [])) {
      const name = item.Index || item.指數名稱 || ''
      if (!(name.includes('發行量加權') || name.includes('加權股價指數'))) continue
      const price = parseNum(item.ClosingIndex || item.收盤指數)
      const prev  = parseNum(item.PreviousClosingIndex || item.前收指數)
      const chg   = parseNum(item.Change || item.漲跌點數)
      if (!price) continue
      const p = prev || (chg != null ? price - chg : null)
      out['t00'] = {
        price, prevClose: p,
        change: chg ?? (p ? price - p : null),
        pct:    p ? (price - p) / p : null,
        time:   new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' }),
      }
    }
    return Object.keys(out).length ? out : null
  } catch (e) {
    console.warn('TWSE MI_INDEX error:', e.message)
    return null
  }
}

// ── Tier 2: GitHub Actions cache (fallback) ───────────────────────────────────
async function fetchOneCache(url) {
  // ~1-min cache-buster so the Fastly CDN serves data near the 3-min cadence.
  const bust = Math.floor(Date.now() / 60000)
  const r = await fetch(`${url}?t=${bust}`, { signal: AbortSignal.timeout(10000) })
  if (!r.ok) return null
  const json = await r.json()
  if (!json?.prices || !json?.updatedAt) return null
  return json
}

export async function fetchPriceCache(ids) {
  try {
    // Pull both caches; prefer the Shioaji broker feed when it's at least as
    // fresh. Gracefully degrades to the TWSE/Yahoo cache if Shioaji isn't
    // configured (file absent → fetchOneCache returns null).
    const [shioaji, fallback] = await Promise.all([
      fetchOneCache(SHIOAJI_CACHE_URL).catch(() => null),
      fetchOneCache(CACHE_URL).catch(() => null),
    ])
    let json = null
    if (shioaji && fallback) {
      json = new Date(shioaji.updatedAt) >= new Date(fallback.updatedAt) ? shioaji : fallback
    } else {
      json = shioaji || fallback
    }
    if (!json) return { stocks: {}, indices: null }

    const cacheDate = new Date(json.updatedAt)
    const now       = new Date()
    const isToday   = sameTWDay(cacheDate, now)
    const ageMs     = now - cacheDate
    const open      = isTWSEOpen()

    const isStale = open ? ageMs > 5 * 60 * 1000 : !isToday

    const toTime = iso => iso
      ? new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })
      : ''

    const stocks = {}
    for (const id of ids) {
      const p = json.prices[id]
      if (!p) continue
      stocks[id] = { ...p, time: toTime(p.time), isSnapshot: !isToday }
    }

    const i_t00 = json.prices['_idx_t00']
    const i_o00 = json.prices['_idx_o00']
    const indices = (i_t00 || i_o00) ? {
      ...(i_t00 ? { t00: { ...i_t00, time: toTime(i_t00.time) } } : {}),
      ...(i_o00 ? { o00: { ...i_o00, time: toTime(i_o00.time) } } : {}),
    } : null

    return { stocks, indices, updatedAt: cacheDate, isStale }
  } catch (e) {
    console.warn('Price cache fetch error:', e.message)
    return { stocks: {}, indices: null }
  }
}

/**
 * useLivePrices(stockIds, { pollInterval })
 *
 * Returns { prices, isOpen, session, lastUpdate, loading, error }
 *
 * During market hours: polls official TWSE/TPEX API every 60 s.
 * After close: fetches once (prices are final), then stops polling.
 */
export function useLivePrices(stockIds, { pollInterval = 60000, refreshTrigger = 0 } = {}) {
  const [prices, setPrices]         = useState({})
  const [isOpen, setIsOpen]         = useState(() => isTWSEOpen())
  const [session, setSession]       = useState(() => getTWSESession())
  const [lastUpdate, setLastUpdate] = useState(null)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState(null)

  const idsKey = useMemo(
    () => [...new Set((stockIds || []).map(String).filter(Boolean))].sort().join(','),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [(stockIds || []).join(',')]
  )

  useEffect(() => {
    const ids = idsKey.split(',').filter(Boolean)
    if (!ids.length) return

    let cancelled = false
    let closedFetchDone = false

    const run = async () => {
      const open = isTWSEOpen()
      const sess = getTWSESession()
      if (!cancelled) { setIsOpen(open); setSession(sess) }

      // 收盤後只再抓「一次」拿最終定價。flag 只在收盤狀態設立、開盤中一律重置：
      // 舊寫法在第一次執行就設 flag，導致 (a) 跨越 13:30 的分頁抓不到收盤定價、
      // (b) 盤前開著的分頁在 09:00 開盤後不會開始更新（配合下方 interval 常駐）。
      if (!open) {
        if (closedFetchDone) return
        closedFetchDone = true
      } else {
        closedFetchDone = false
      }

      if (!cancelled) setLoading(true)
      try {
        // Fetch the broker/official cache (Shioaji-preferred) and the browser-direct
        // TWSE/TPEX quotes in parallel. The cache WINS when fresh: it's the broker
        // feed (more accurate) and, crucially, after close TWSE's STOCK_DAY_ALL goes
        // stale while the cache holds the correct close. Browser quotes fill symbols
        // the cache lacks, and serve as the fallback when the cache is missing/stale.
        // 富果層(有金鑰時):盤中最準的即時源。TWSE STOCK_DAY_ALL 是日收盤
        // 資料集,盤中會給前一日價 → 有富果時讓它蓋過其他所有來源。
        const [official, cache, fugle] = await Promise.all([
          fetchTWSEOfficial(ids).catch(() => ({})),
          fetchPriceCache(ids).catch(() => ({ stocks: {}, isStale: true, updatedAt: null })),
          (open && getFugleKey()) ? fetchFugleQuotes(ids).catch(() => ({})) : Promise.resolve({}),
        ])
        if (cancelled) return

        const cacheStocks = cache.stocks || {}
        const cacheFresh  = Object.keys(cacheStocks).length > 0 && !cache.isStale
        const officialHas = Object.keys(official).length > 0
        const fugleHas    = Object.keys(fugle).length > 0

        if (fugleHas) {
          setPrices(prev => ({ ...prev, ...official, ...(cacheFresh ? cacheStocks : {}), ...fugle }))
          setLastUpdate(new Date())
          setError(null)
        } else if (cacheFresh) {
          // 開盤中:cache(可能是 Shioaji 券商即時盤)優先蓋過 official
          //   (STOCK_DAY_ALL 盤中回的是昨日收盤,最不即時)。
          // 收盤後:反過來,新抓的 official(STOCK_DAY_ALL 已結算=今日收盤)
          //   才權威;cache 可能停在盤中/昨日值(如聯電 07-15=166 vs 07-16=160),
          //   讓 official 蓋過 cache,修正「持倉現價慢一天」。
          setPrices(prev => open
            ? ({ ...prev, ...official, ...cacheStocks })
            : ({ ...prev, ...cacheStocks, ...official }))
          setLastUpdate(new Date())
          setError(open ? null : '今日收盤')
        } else if (officialHas) {
          setPrices(prev => ({ ...prev, ...official }))
          setLastUpdate(new Date())
          setError(open ? null : '今日收盤')
        } else if (Object.keys(cacheStocks).length > 0) {
          // Last resort: stale cache.
          setPrices(prev => ({ ...prev, ...cacheStocks }))
          setLastUpdate(new Date())
          const u = cache.updatedAt
          if (u) {
            const dateStr = u.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' })
            const timeStr = u.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })
            setError(`快取報價 ${dateStr} ${timeStr}`)
          } else {
            setError('快取報價')
          }
        } else {
          const s = getTWSESession()
          if      (s === 'pre')     setError('盤前（09:00 開盤後即時更新）')
          else if (s === 'weekend') setError('休市（週末）')
          else if (s === 'open')    setError('等待報價…')
          else                      setError('收盤報價暫時無法取得，可點「刷新」重試')
        }
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()
    // Only poll during market hours
    // interval 常駐（不只開盤時建立）：盤前載入的分頁才會在 09:00 開盤後自動開始
    // 輪詢。收盤時段 run() 會早退（見上方 closedFetchDone），空轉成本可忽略。
    // 輪詢加密到 15 秒(原 60 秒,頁面價位跟不上盤中波動)。固定用短間隔:
    // 收盤/盤前 run() 抓一次最終定價後就早退(closedFetchDone),不會多耗
    // 流量;開盤瞬間(09:00)同一個 interval 自動開始即時更新,不用重整頁面。
    // 富果批次層 15 秒一輪:≤8 檔逐檔並行(≤32 req/min)、9 檔以上 snapshot
    // (2 req/輪 = 8 req/min),皆低於免費方案 60 req/min;撞 429 時富果層
    // 自帶 60 秒冷卻(見 fugleLive.js),期間本 hook 自然退回快取層。
    const t = setInterval(run, Math.min(pollInterval, 15000))
    return () => { cancelled = true; if (t) clearInterval(t) }
  }, [idsKey, pollInterval, refreshTrigger])

  return { prices, isOpen, session, lastUpdate, loading, error }
}
