// Real-time Taiwan stock prices via TWSE 即時行情 API
// - Batches up to 50 stocks per request (free, no API key)
// - Polls every 30s while market is open (09:00–13:30 Taiwan time, Mon–Fri)
// - Returns empty prices outside market hours

import { useState, useEffect, useMemo } from 'react'

function isOTCStock(stockId) {
  const n = parseInt(String(stockId), 10)
  return (n >= 4200 && n <= 4999) || (n >= 5000 && n <= 5999) ||
         (n >= 6000 && n <= 6999) || (n >= 8000 && n <= 8999) || (n >= 9200 && n <= 9999)
}

export function isTWSEOpen() {
  const now = new Date()
  const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
  const day = tw.getDay()
  if (day === 0 || day === 6) return false
  const min = tw.getHours() * 60 + tw.getMinutes()
  // 09:00 = 540, 13:30 = 810
  return min >= 540 && min <= 810
}

export function getTWSESession() {
  const now = new Date()
  const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
  const day = tw.getDay()
  if (day === 0 || day === 6) return 'weekend'
  const min = tw.getHours() * 60 + tw.getMinutes()
  if (min < 540) return 'pre'       // before 09:00
  if (min <= 810) return 'open'     // 09:00–13:30
  return 'closed'                   // after 13:30
}

async function fetchTWSEBatch(ids) {
  const result = {}
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const exCh = chunk.map(id => `${isOTCStock(id) ? 'otc' : 'tse'}_${id}.tw`).join('|')
    try {
      const r = await fetch(
        `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0`,
        { signal: AbortSignal.timeout(8000) }
      )
      if (!r.ok) continue
      const data = await r.json()
      for (const item of data.msgArray || []) {
        const z = parseFloat(item.z)
        if (isNaN(z) || z <= 0) continue   // '-' = no trade yet
        const y = parseFloat(item.y)
        const h = parseFloat(item.h)
        const l = parseFloat(item.l)
        const o = parseFloat(item.o)
        const v = parseFloat(item.v)
        result[item.c] = {
          price:     z,
          prevClose: isNaN(y) ? null : y,
          pct:       (!isNaN(y) && y > 0) ? (z - y) / y : null,
          high:      isNaN(h) ? null : h,
          low:       isNaN(l) ? null : l,
          open:      isNaN(o) ? null : o,
          volume:    isNaN(v) ? 0 : v,
          time:      item.t || '',
        }
      }
    } catch { /* network/CORS error — skip chunk, return what we have */ }
  }
  return result
}

/**
 * useLivePrices(stockIds, { pollInterval })
 *
 * Returns { prices, isOpen, session, lastUpdate, loading, error }
 *   prices: { [stockId]: { price, prevClose, pct, high, low, open, volume, time } }
 *   isOpen: boolean — true during 09:00–13:30 Taiwan time
 *   session: 'pre' | 'open' | 'closed' | 'weekend'
 *   lastUpdate: Date | null
 *   loading: boolean
 *   error: string | null
 */
export function useLivePrices(stockIds, { pollInterval = 30000 } = {}) {
  const [prices, setPrices]       = useState({})
  const [isOpen, setIsOpen]       = useState(() => isTWSEOpen())
  const [session, setSession]     = useState(() => getTWSESession())
  const [lastUpdate, setLastUpdate] = useState(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState(null)

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
      if (!open) return

      if (!cancelled) setLoading(true)
      try {
        const result = await fetchTWSEBatch(ids)
        if (!cancelled && Object.keys(result).length > 0) {
          setPrices(prev => ({ ...prev, ...result }))
          setLastUpdate(new Date())
          setError(null)
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
