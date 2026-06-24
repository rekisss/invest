// Live Taiwan stock prices — hybrid approach
//
// Primary:  Browser fetches TWSE/TPEX official OpenAPI directly (CORS-friendly, truly real-time)
// Fallback: GitHub Actions price cache (live-prices.yml, updated every 3 min during open)
//           Used when official APIs are temporarily unavailable
//
// Poll interval: 60 s during market open, no poll after close (prices are final)

import { useState, useEffect, useMemo } from 'react'

const CACHE_URL = 'https://api.github.com/repos/rekisss/invest/contents/live_prices.json?ref=data'

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

function parseNum(s) { return parseFloat(String(s ?? '').replace(/,/g, '')) || null }
function parseVol(s) { return parseInt(String(s  ?? '').replace(/,/g, '')) || 0 }

// ── Tier 1: TWSE/TPEX Official OpenAPI (browser, CORS-friendly) ──────────────
export async function fetchTWSEOfficial(ids) {
  const result  = {}
  const idSet   = new Set(ids)
  const twseIds = ids.filter(id => !isOTCStock(id))
  const tpexIds = ids.filter(id =>  isOTCStock(id))
  const fetches = []

  if (twseIds.length) fetches.push(
    fetch(TWSE_URL, { signal: AbortSignal.timeout(10000) })
      .then(r => r.ok ? r.json() : []).catch(() => [])
  )
  if (tpexIds.length) fetches.push(
    fetch(TPEX_URL, { signal: AbortSignal.timeout(10000) })
      .then(r => r.ok ? r.json() : []).catch(() => [])
  )

  try {
    const [twseData = [], tpexData = []] = await Promise.all(fetches)

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
export async function fetchPriceCache(ids) {
  try {
    const r = await fetch(CACHE_URL, {
      headers: { Accept: 'application/vnd.github.raw+json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return { stocks: {}, indices: null }
    const json = await r.json()
    if (!json?.prices || !json?.updatedAt) return { stocks: {}, indices: null }

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
export function useLivePrices(stockIds, { pollInterval = 60000 } = {}) {
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
    let didFetchOnce = false

    const run = async () => {
      const open = isTWSEOpen()
      const sess = getTWSESession()
      if (!cancelled) { setIsOpen(open); setSession(sess) }

      // After close, only fetch once to get final prices
      if (!open && didFetchOnce) return
      didFetchOnce = true

      if (!cancelled) setLoading(true)
      try {
        // Tier 1: TWSE/TPEX official (real-time, browser CORS-friendly)
        const official = await fetchTWSEOfficial(ids)
        if (cancelled) return

        if (Object.keys(official).length > 0) {
          setPrices(prev => ({ ...prev, ...official }))
          setLastUpdate(new Date())
          setError(open ? null : '今日收盤')
        } else {
          // Tier 2: GH Actions cache fallback
          const { stocks: cached, updatedAt, isStale } = await fetchPriceCache(ids)
          if (cancelled) return
          if (Object.keys(cached).length > 0) {
            setPrices(prev => ({ ...prev, ...cached }))
            setLastUpdate(new Date())
            if (isStale && updatedAt) {
              const dateStr = updatedAt.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' })
              const timeStr = updatedAt.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })
              setError(`快取報價 ${dateStr} ${timeStr}`)
            } else {
              setError('快取報價（官方 API 暫時無回應）')
            }
          } else {
            const s = getTWSESession()
            if      (s === 'pre')     setError('盤前（09:00 開盤後即時更新）')
            else if (s === 'weekend') setError('休市（週末）')
            else if (s === 'open')    setError('等待報價…')
            else                      setError('收盤快取暫無資料')
          }
        }
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()
    // Only poll during market hours
    const t = isTWSEOpen() ? setInterval(run, pollInterval) : null
    return () => { cancelled = true; if (t) clearInterval(t) }
  }, [idsKey, pollInterval])

  return { prices, isOpen, session, lastUpdate, loading, error }
}
