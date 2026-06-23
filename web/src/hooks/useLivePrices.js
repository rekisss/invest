// Real-time Taiwan stock prices via Yahoo Finance API (CORS-friendly)
// - Primary:  query2.finance.yahoo.com  (v7 batch, 20 symbols/req)
// - Fallback: query1.finance.yahoo.com  (same endpoint, different CDN pool)
// - Tier 3:   v8 chart API per-symbol for any still-missing symbols
// - Tier 4:   GitHub Actions price cache (raw.githubusercontent.com/rekisss/invest/data/live_prices.json)
//             Updated every 3 min during market hours by the 盤中即時報價快取 workflow
// - Polls every 30s; outside market hours returns last-close snapshot

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
    if (!r.ok) {
      console.warn(`Yahoo v7 ${host} → ${r.status}`)
      return result
    }
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

// ── Tier 4: GitHub Actions price cache (server-side, no CORS issues) ─────
const CACHE_URL     = 'https://raw.githubusercontent.com/rekisss/invest/data/live_prices.json'
const CACHE_MAX_AGE = 30 * 60 * 1000  // reject if older than 30 min (covers post-market users)

export async function fetchPriceCache(ids) {
  try {
    const r = await fetch(CACHE_URL, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return { stocks: {}, indices: null }
    const json = await r.json()
    if (!json?.prices || !json?.updatedAt) return { stocks: {}, indices: null }
    if (Date.now() - new Date(json.updatedAt).getTime() > CACHE_MAX_AGE)
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

    // Each host gets only the symbols still missing from result
    for (const host of V7_HOSTS) {
      const missing = chunk.filter(id => !result[id])
      if (!missing.length) break
      const r = await tryV7Batch(host, missing.map(toYahooSymbol).join(','))
      Object.assign(result, r)
    }

    // v8 per-symbol fallback for anything still missing after both v7 hosts
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
          price,
          prevClose: prev,
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
        const result = await fetchYahooBatch(ids)
        if (!cancelled) {
          if (Object.keys(result).length > 0) {
            setPrices(prev => ({ ...prev, ...result }))
            setLastUpdate(new Date())
            setError(null)
          } else {
            // Tier 4: GH Actions cache — server-side fetch every 3 min, no CORS issues
            const { stocks: cached } = await fetchPriceCache(ids)
            if (!cancelled) {
              if (Object.keys(cached).length > 0) {
                setPrices(prev => ({ ...prev, ...cached }))
                setLastUpdate(new Date())
                setError('快取報價（每3分鐘更新）')
              } else {
                setError('無法取得報價（Yahoo Finance 暫時無回應，請稍後重試）')
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

    run()  // always fetch once on mount
    const t = setInterval(run, pollInterval)  // poll 24/7
    return () => { cancelled = true; clearInterval(t) }
  }, [idsKey, pollInterval])

  return { prices, isOpen, session, lastUpdate, loading, error }
}
