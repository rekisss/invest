// useShioajiStream — real-time tick prices over WebSocket from the Shioaji
// streaming service (shioaji_stream/server.py, deployed to Railway).
//
// Returns { prices, connected, error } where `prices` is keyed by stock id with
// the same entry schema as useLivePrices ({price, prevClose, pct, high, low,
// open, volume, time, isSnapshot}). When no wsUrl is configured the hook is a
// no-op, so callers transparently fall back to useLivePrices.
//
// The wsUrl + token are user-supplied (stored client-side), never bundled —
// keeping the access token out of the public static build.

import { useState, useEffect, useRef, useMemo } from 'react'

export const STREAM_CFG_KEY = 'shioaji_stream_cfg'

export function loadStreamCfg() {
  try { return JSON.parse(localStorage.getItem(STREAM_CFG_KEY) || '{}') } catch { return {} }
}
export function saveStreamCfg(cfg) {
  try { localStorage.setItem(STREAM_CFG_KEY, JSON.stringify(cfg || {})) } catch {}
}

function buildUrl(wsUrl, token) {
  try {
    const u = new URL(wsUrl)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    if (token) u.searchParams.set('token', token)
    return u.toString()
  } catch {
    return null
  }
}

export function useShioajiStream(stockIds, { wsUrl, token, enabled = true } = {}) {
  const [prices, setPrices]       = useState({})
  const [connected, setConnected] = useState(false)
  const [error, setError]         = useState(null)
  const wsRef    = useRef(null)
  const retryRef = useRef(0)

  const idsKey = useMemo(
    () => [...new Set((stockIds || []).map(String).filter(Boolean))].sort().join(','),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [(stockIds || []).join(',')]
  )
  // onmessage 活在 [url] effect 的閉包裡，直接讀 idsKey 會是連線當下的舊值；
  // 用 ref 讓過濾永遠拿到最新訂閱清單。
  const idsRef = useRef(idsKey)
  idsRef.current = idsKey
  const url = useMemo(() => (enabled && wsUrl) ? buildUrl(wsUrl, token) : null, [enabled, wsUrl, token])

  useEffect(() => {
    if (!url) { setConnected(false); return }

    let cancelled = false
    let reconnectTimer = null

    const connect = () => {
      if (cancelled) return
      let ws
      try {
        ws = new WebSocket(url)
      } catch (e) {
        setError(e.message); scheduleReconnect(); return
      }
      wsRef.current = ws

      ws.onopen = () => {
        if (cancelled) return
        retryRef.current = 0
        setConnected(true); setError(null)
        const ids = idsKey.split(',').filter(Boolean)
        if (ids.length) ws.send(JSON.stringify({ action: 'subscribe', ids }))
      }
      ws.onmessage = (ev) => {
        if (cancelled) return
        try {
          const msg = JSON.parse(ev.data)
          if (msg?.prices && (msg.type === 'snapshot' || msg.type === 'tick')) {
            // 只合併目前訂閱清單內的代號：伺服器不支援退訂，改訂閱後舊代號的 tick
            // 仍會推來，不過濾會讓已移除的股票永遠殘留在 prices state 裡。
            const want = new Set(idsRef.current.split(',').filter(Boolean))
            const incoming = Object.fromEntries(
              Object.entries(msg.prices).filter(([sid]) => want.has(sid) || sid.startsWith('_'))
            )
            if (Object.keys(incoming).length) setPrices(prev => ({ ...prev, ...incoming }))
          }
        } catch { /* ignore malformed frame */ }
      }
      ws.onerror = () => { if (!cancelled) setError('連線錯誤') }
      ws.onclose = () => {
        if (cancelled) return
        setConnected(false)
        scheduleReconnect()
      }
    }

    const scheduleReconnect = () => {
      if (cancelled) return
      const delay = Math.min(1000 * 2 ** retryRef.current, 30000)  // 1s→30s backoff
      retryRef.current += 1
      reconnectTimer = setTimeout(connect, delay)
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { wsRef.current?.close() } catch {}
      wsRef.current = null
    }
  }, [url])

  // Re-send the subscription list when the watched ids change (same socket).
  useEffect(() => {
    const ws = wsRef.current
    if (!connected || !ws || ws.readyState !== 1) return
    const ids = idsKey.split(',').filter(Boolean)
    if (ids.length) ws.send(JSON.stringify({ action: 'subscribe', ids }))
  }, [idsKey, connected])

  return { prices, connected, error }
}
