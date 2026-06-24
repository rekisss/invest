// Real-time Taiwan stock prices — multi-tier fetch with parallel fallbacks
//
// Tier 1a: TWSE Official OpenAPI  (openapi.twse.com.tw) — CORS-friendly, no key needed
// Tier 1b: TPEX Official OpenAPI  (tpex.org.tw)         — OTC stocks, CORS-friendly
//          ↑ Tiers 1a/1b run in parallel with Yahoo; results are merged
// Tier 2:  Yahoo Finance v7 batch (query2 → query1 CDN pool, 20 symbols/req)
// Tier 3:  Yahoo Finance v8 chart per-symbol (bypasses v7 rate-limit pool)
// Tier 4:  GitHub Actions price cache (raw.githubusercontent.com/rekisss/invest/data/live_prices.json)
//          Updated every 3 min during market hours; accepted up to 8 h after market close
//
// Polls every 30 s. Yahoo + TWSE/TPEX run in parallel; cache is last resort.

import { useState, useEffect, useMemo } from 'react'

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

// Yahoo Finance symbol: TWSE → "2330.TW", OTC/TPEX → "6175.TWO"
function toYahooSymbol(id) {
  return `${id}${isOTCStock(id) ? '.TWO' : '.TW'}`
}
function fromYahooSymbol(sym) {
  return sym.replace(/\.(TW|TWO)$/, '')
}

// Parse a raw Yahoo v7 quote item into our internal shape
function parseQuoteItem(item) {
  const price = item.regularMarketPrice
  const prev  = item.regularMarketPreviousClose ?? null
  if (!price) return null
  return {
    price,
    prevClose: prev,
    pct:       prev ? (price - prev) / prev : null,
    high:      item.regularMarketHigh   ?? null,
    low:       item.regularMarketLow    ?? null,
    open:      item.regularMarketOpen   ?? null,
    volume:    item.regularMarketVolume ?? 0,
    time:      item.regularMarketTime
                 ? new Date(item.regularMarketTime * 1000)
                     .toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })
                 : '',
    isSnapshot: item.marketState !== 'REGULAR',
  }
}

// Attempt a Yahoo Finance v7 batch fetch on one host; returns parsed map or {}
async function tryV7Batch(host, symbols, timeout = 10000) {
  const result = {}
  try {
    const r = await fetch(
      `https://${host}/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketChangePercent,regularMarketHigh,regularMarketLow,regularMarketOpen,regularMarketVolume,regularMarketTime,marketState`,
      { signal: AbortSignal.timeout(timeout) }
    )
    if (!r.ok) { console.warn(`Yahoo v7 ${host} → ${r.status}`); return result }
    const json = await r.json()
    for (const item of json?.quoteResponse?.result || []) {
      const id = fromYahooSymbol(item.symbol || '')
      if (!id) continue
      const parsed = parseQuoteItem(item)
      if (parsed) result[id] = parsed
    }
  } catch (e) {
    console.warn(`Yahoo v7 ${host} error:`, e.message)
  }
  return result
}

// Last-resort: v8 chart for a single symbol — bypasses v7 rate-limit pool
async function tryV8Single(symbol, timeout = 8000) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=false`,
      { signal: AbortSignal.timeout(timeout) }
    )
    if (!r.ok) return null
    const json = await r.json()
    const meta = json?.chart?.result?.[0]?.meta
    if (!meta?.regularMarketPrice) return null
    const price = meta.regularMarketPrice
    const prev  = meta.previousClose ?? meta.chartPreviousClose ?? null
    return {
      price,
      prevClose: prev,
      pct:       prev ? (price - prev) / prev : null,
      high:      meta.regularMarketDayHigh  ?? null,
      low:       meta.regularMarketDayLow   ?? null,
      open:      meta.regularMarketOpen     ?? null,
      volume:    meta.regularMarketVolume   ?? 0,
      time:      meta.regularMarketTime
                   ? new Date(meta.regularMarketTime * 1000)
                       .toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })
                   : '',
      isSnapshot: meta.marketState !== 'REGULAR',
    }
  } catch (e) {
    console.warn(`Yahoo v8 ${symbol} error:`, e.message)
    return null
  }
}

const V7_HOSTS = ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']

// ── Tier 1: Taiwan Official OpenAPI (CORS-friendly, no API key) ────────────
// TWSE: openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL  (上市)
// TPEX: www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes     (上櫃)
// Both return snapshot prices updated during market hours; works post-market too.

const TWSE_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'
const TPEX_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes'

function parseNum(s) { return parseFloat(String(s ?? '').replace(/,/g, '')) || null }
function parseVol(s) { return parseInt(String(s  ?? '').replace(/,/g, '')) || 0 }

export async function fetchTWSEOfficial(ids) {
  const result  = {}
  const idSet   = new Set(ids)
  const twseIds = ids.filter(id => !isOTCStock(id))
  const tpexIds = ids.filter(id =>  isOTCStock(id))

  const fetches = []
  if (twseIds.length) fetches.push(
    fetch(TWSE_URL, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : [])
      .catch(() => [])
  )
  if (tpexIds.length) fetches.push(
    fetch(TPEX_URL, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : [])
      .catch(() => [])
  )

  try {
    const [twseData = [], tpexData = []] = await Promise.all(fetches)

    // TWSE: { Code, Name, OpeningPrice, HighestPrice, LowestPrice, ClosingPrice, Change, TradeVolume }
    for (const item of twseData) {
      const id = item.Code
      if (!idSet.has(id)) continue
      const price  = parseNum(item.ClosingPrice)
      const change = parseNum(item.Change)        // may be '+10' / '-5' / '0'
      if (!price) continue
      const prev = (change != null && !isNaN(change)) ? price - change : null
      result[id] = {
        price, prevClose: prev,
        pct:    prev ? change / prev : null,
        high:   parseNum(item.HighestPrice),
        low:    parseNum(item.LowestPrice),
        open:   parseNum(item.OpeningPrice),
        volume: parseVol(item.TradeVolume),
        time:   '', isSnapshot: true,
      }
    }

    // TPEX: { SecuritiesCompanyCode, Close, Change, High, Low, Open, TradeVolume }
    // Field names differ by API version; try both common naming conventions
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
        time:   '', isSnapshot: true,
      }
    }
  } catch (e) {
    console.warn('TWSE/TPEX official API error:', e.message)
  }
  return result
}

// ── Tier 4: GitHub Actions price cache ────────────────────────────────────
const CACHE_URL = 'https://raw.githubusercontent.com/rekisss/invest/data/live_prices.json'
// Context-aware max age:
//   Market open  → accept only if < 5 min (cache updated every 3 min by GH Actions)
//   Market closed → accept if same Taiwan-calendar-day and < 8 h (closing prices don't change)
const CACHE_MAX_AGE_OPEN   = 5  * 60 * 1000
const CACHE_MAX_AGE_CLOSED = 8  * 60 * 60 * 1000

function sameTWDay(a, b) {
  const fmt = d => new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
  const ta = fmt(a), tb = fmt(b)
  return ta.getFullYear() === tb.getFullYear() &&
         ta.getMonth()    === tb.getMonth()    &&
         ta.getDate()     === tb.getDate()
}

export async function fetchPriceCache(ids) {
  try {
    const r = await fetch(CACHE_URL, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return { stocks: {}, indices: null }
    const json = await r.json()
    if (!json?.prices || !json?.updatedAt) return { stocks: {}, indices: null }

    const cacheDate = new Date(json.updatedAt)
    const now       = new Date()
    const ageMs     = now - cacheDate
    const maxAge    = isTWSEOpen() ? CACHE_MAX_AGE_OPEN : CACHE_MAX_AGE_CLOSED

    // During market hours: strict freshness. After close: same-day cache is always valid.
    if (isTWSEOpen() && ageMs > maxAge) return { stocks: {}, indices: null }
    if (!isTWSEOpen() && (ageMs > maxAge || !sameTWDay(now, cacheDate)))
      return { stocks: {}, indices: null }

    const toTime = iso => iso
      ? new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })
      : ''

    const stocks = {}
    for (const id of ids) {
      const p = json.prices[id]
      if (!p) continue
      stocks[id] = { ...p, time: toTime(p.time), isSnapshot: true }
    }

    const i_t00 = json.prices['_idx_t00']
    const i_o00 = json.prices['_idx_o00']
    const indices = (i_t00 || i_o00) ? {
      ...(i_t00 ? { t00: { ...i_t00, time: toTime(i_t00.time) } } : {}),
      ...(i_o00 ? { o00: { ...i_o00, time: toTime(i_o00.time) } } : {}),
    } : null

    return { stocks, indices }
  } catch (e) {
    return { stocks: {}, indices: null }
  }
}

async function fetchYahooBatch(ids) {
  const result = {}
  const CHUNK = 20

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)

    for (const host of V7_HOSTS) {
      const missing = chunk.filter(id => !result[id])
      if (!missing.length) break
      const r = await tryV7Batch(host, missing.map(toYahooSymbol).join(','))
      Object.assign(result, r)
    }

    const stillMissing = chunk.filter(id => !result[id])
    if (stillMissing.length) {
      await Promise.all(stillMissing.map(async id => {
        const r = await tryV8Single(toYahooSymbol(id))
        if (r) result[id] = r
      }))
    }
  }

  return result
}

// Index fetch: 加權指數 ^TWII, 櫃買指數 ^TPEX
export async function fetchIndices() {
  const IDX_SYMBOLS = '%5ETWII,%5ETPEX'
  const IDX_FIELDS  = 'regularMarketPrice,regularMarketPreviousClose,regularMarketChangePercent,regularMarketTime'

  for (const host of V7_HOSTS) {
    try {
      const r = await fetch(
        `https://${host}/v7/finance/quote?symbols=${IDX_SYMBOLS}&fields=${IDX_FIELDS}`,
        { signal: AbortSignal.timeout(8000) }
      )
      if (!r.ok) continue
      const json = await r.json()
      const out  = {}
      for (const item of json?.quoteResponse?.result || []) {
        const price = item.regularMarketPrice
        const prev  = item.regularMarketPreviousClose ?? null
        if (!price) continue
        const key = item.symbol === '^TWII' ? 't00' : 'o00'
        out[key] = {
          price, prevClose: prev,
          change: prev != null ? price - prev : null,
          pct:    prev ? (price - prev) / prev : null,
          time:   item.regularMarketTime
                    ? new Date(item.regularMarketTime * 1000)
                        .toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })
                    : '',
        }
      }
      if (Object.keys(out).length) return out
    } catch (e) {
      console.warn(`Index fetch ${host} error:`, e.message)
    }
  }
  return null
}

/**
 * useLivePrices(stockIds, { pollInterval })
 *
 * Returns { prices, isOpen, session, lastUpdate, loading, error }
 */
export function useLivePrices(stockIds, { pollInterval = 30000 } = {}) {
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

    const run = async () => {
      const open = isTWSEOpen()
      const sess = getTWSESession()
      if (!cancelled) { setIsOpen(open); setSession(sess) }
      if (!cancelled) setLoading(true)
      try {
        // Tier 1+2: Run TWSE/TPEX official API and Yahoo Finance in parallel.
        // Yahoo takes precedence (real-time tick); TWSE/TPEX fills any gaps.
        const [officialResult, yahooResult] = await Promise.allSettled([
          fetchTWSEOfficial(ids),
          fetchYahooBatch(ids),
        ])
        const official = officialResult.status === 'fulfilled' ? officialResult.value : {}
        const yahoo    = yahooResult.status    === 'fulfilled' ? yahooResult.value    : {}

        // Merge: Yahoo wins on overlap (fresher tick data); official fills missing
        const result = { ...official, ...yahoo }

        if (!cancelled) {
          if (Object.keys(result).length > 0) {
            setPrices(prev => ({ ...prev, ...result }))
            setLastUpdate(new Date())
            // Show source hint only when falling back to snapshot-only
            const yahooCount    = Object.keys(yahoo).length
            const officialOnly  = Object.keys(result).filter(id => !yahoo[id]).length
            setError(yahooCount > 0 ? null
              : officialOnly > 0 ? '官方快照報價（非即時）'
              : null)
          } else {
            // Tier 4: GH Actions cache — server-side fetch, no CORS issues
            const { stocks: cached } = await fetchPriceCache(ids)
            if (!cancelled) {
              if (Object.keys(cached).length > 0) {
                setPrices(prev => ({ ...prev, ...cached }))
                setLastUpdate(new Date())
                setError('快取報價（GH Actions，每3分鐘更新）')
              } else {
                setError('無法取得報價（所有資料源暫時無回應，請稍後重試）')
              }
            }
          }
        }
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()
    const t = setInterval(run, pollInterval)
    return () => { cancelled = true; clearInterval(t) }
  }, [idsKey, pollInterval])

  return { prices, isOpen, session, lastUpdate, loading, error }
}
