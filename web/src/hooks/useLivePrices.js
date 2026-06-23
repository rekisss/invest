// Real-time Taiwan stock prices via Yahoo Finance API (CORS-friendly)
// - Batches up to 20 stocks per request
// - Polls every 30s during market hours (09:00–13:30 Taiwan time, Mon–Fri)
// - Outside market hours: fetches once for latest available (prev-close) prices

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

async function fetchYahooBatch(ids) {
  const result = {}
  const CHUNK = 20
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const symbols = chunk.map(toYahooSymbol).join(',')
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketChangePercent,regularMarketHigh,regularMarketLow,regularMarketOpen,regularMarketVolume,regularMarketTime,marketState`,
        { signal: AbortSignal.timeout(10000) }
      )
      if (!r.ok) continue
      const json = await r.json()
      for (const item of json?.quoteResponse?.result || []) {
        const id = fromYahooSymbol(item.symbol || '')
        if (!id) continue
        const price = item.regularMarketPrice
        const prev  = item.regularMarketPreviousClose ?? null
        if (!price) continue
        // During Taiwan market hours price is live; outside it's last close
        const isSnapshot = item.marketState !== 'REGULAR'
        result[id] = {
          price,
          prevClose: prev,
          pct:       prev ? (price - prev) / prev : null,
          high:      item.regularMarketHigh  ?? null,
          low:       item.regularMarketLow   ?? null,
          open:      item.regularMarketOpen  ?? null,
          volume:    item.regularMarketVolume ?? 0,
          time:      item.regularMarketTime
                       ? new Date(item.regularMarketTime * 1000)
                           .toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })
                       : '',
          isSnapshot,
        }
      }
    } catch (e) {
      console.warn('Yahoo quote batch failed:', e.message)
    }
  }
  return result
}

// Index fetch: 加權指數 ^TWII, 櫃買指數 ^TPX
export async function fetchIndices() {
  try {
    const r = await fetch(
      'https://query1.finance.yahoo.com/v7/finance/quote?symbols=%5ETWII,%5ETPEX&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketChangePercent,regularMarketTime',
      { signal: AbortSignal.timeout(8000) }
    )
    if (!r.ok) return null
    const json = await r.json()
    const out = {}
    for (const item of json?.quoteResponse?.result || []) {
      const price = item.regularMarketPrice
      const prev  = item.regularMarketPreviousClose ?? null
      if (!price) continue
      // Map Yahoo symbols to the keys the IndexBar expects
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
    return Object.keys(out).length ? out : null
  } catch (e) {
    console.warn('Index fetch failed:', e.message)
    return null
  }
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
            setError('無法取得報價（Yahoo Finance 暫時無回應）')
          }
        }
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()  // always fetch once on mount
    const t = setInterval(run, pollInterval)  // poll 24/7 — Yahoo returns last-close outside hours
    return () => { cancelled = true; clearInterval(t) }
  }, [idsKey, pollInterval])

  return { prices, isOpen, session, lastUpdate, loading, error }
}
