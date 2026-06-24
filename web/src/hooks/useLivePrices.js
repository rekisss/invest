// Live Taiwan stock prices — reads GitHub Actions price cache only
//
// The `live-prices.yml` workflow runs every 3 min during market hours
// (09:00–13:30 Taiwan) and saves to the `data` branch as live_prices.json.
// This hook reads only that cache — no browser-side API calls, no CORS issues.

import { useState, useEffect, useMemo } from 'react'

const CACHE_URL = 'https://raw.githubusercontent.com/rekisss/invest/data/live_prices.json'

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

/**
 * Fetch the GH Actions price cache.
 * ids: stock IDs to extract (pass [] to get indices only).
 * Returns { stocks, indices, updatedAt } — all may be empty/null when cache is missing or stale.
 */
export async function fetchPriceCache(ids) {
  try {
    // Cache-bust via query string so browser/CDN doesn't serve a stale file
    const r = await fetch(`${CACHE_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) })
    if (!r.ok) return { stocks: {}, indices: null }
    const json = await r.json()
    if (!json?.prices || !json?.updatedAt) return { stocks: {}, indices: null }

    const cacheDate = new Date(json.updatedAt)
    const now       = new Date()
    const ageMs     = now - cacheDate
    const open      = isTWSEOpen()

    // During open: reject if > 5 min stale (GH Actions runs every 3 min)
    // After close: accept same-day cache up to 8 h (closing prices are final)
    if (open  && ageMs > 5 * 60 * 1000)         return { stocks: {}, indices: null }
    if (!open && !sameTWDay(now, cacheDate))     return { stocks: {}, indices: null }

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

    return { stocks, indices, updatedAt: cacheDate }
  } catch (e) {
    console.warn('Price cache fetch error:', e.message)
    return { stocks: {}, indices: null }
  }
}

// Fetch index data (加權指數 / 櫃買指數) from the GH Actions cache
export async function fetchIndices() {
  const { indices } = await fetchPriceCache([])
  return indices
}

/**
 * useLivePrices(stockIds, { pollInterval })
 *
 * Returns { prices, isOpen, session, lastUpdate, loading, error }
 * Polls the GH Actions cache every 3 minutes (matching the workflow update frequency).
 */
export function useLivePrices(stockIds, { pollInterval = 3 * 60 * 1000 } = {}) {
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
      if (!cancelled) {
        setIsOpen(isTWSEOpen())
        setSession(getTWSESession())
        setLoading(true)
      }
      try {
        const { stocks } = await fetchPriceCache(ids)
        if (cancelled) return
        if (Object.keys(stocks).length > 0) {
          setPrices(prev => ({ ...prev, ...stocks }))
          setLastUpdate(new Date())
          setError(null)
        } else {
          const sess = getTWSESession()
          if      (sess === 'pre')     setError('盤前（09:00 開盤後後台自動更新）')
          else if (sess === 'weekend') setError('休市（週末）')
          else if (sess === 'open')    setError('等待後台更新（每3分鐘）…')
          else                         setError('今日收盤快取不可用')
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
