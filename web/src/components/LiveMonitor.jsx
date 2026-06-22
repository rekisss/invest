import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { useLivePrices } from '../hooks/useLivePrices'
import { flashPriceEl, animateListRows } from '../utils/animeUtils.js'
import StockDetailModal from './StockDetailModal'

const PORTFOLIO_KEY = 'tw_portfolio_positions'
const MONITOR_KEY   = 'tw_monitor_list'

function loadPortfolio()   { try { return JSON.parse(localStorage.getItem(PORTFOLIO_KEY) || '{}') } catch { return {} } }
function loadMonitorList() { try { return JSON.parse(localStorage.getItem(MONITOR_KEY)   || '[]') } catch { return [] } }
function saveMonitorList(list) { try { localStorage.setItem(MONITOR_KEY, JSON.stringify(list)) } catch {} }

function getLatestScan(data) {
  if (!data?.scans || !data?.dates?.length) return {}
  const latest = [...data.dates].sort((a, b) => b.localeCompare(a))[0]
  return data.scans[latest] || {}
}

function buildNameMap(data) {
  const map = {}
  if (!data?.scans) return map
  for (const scan of Object.values(data.scans))
    for (const s of scan.top_stocks || [])
      map[String(s.stock_id)] = s.name || ''
  return map
}

function buildScanMap(data) {
  const map = {}
  for (const s of (getLatestScan(data).top_stocks || []))
    map[String(s.stock_id)] = s
  return map
}

function fmtP(v) {
  if (v == null) return '—'
  if (v >= 1000) return v.toFixed(0)
  if (v >= 100)  return v.toFixed(1)
  return v.toFixed(2)
}

// ── Index bar ─────────────────────────────────────────────────────────────
function IndexBar({ indices, loading }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      {[{ key: 't00', label: '加權指數' }, { key: 'o00', label: '櫃買指數' }].map(({ key, label }) => {
        const d = indices[key]
        const color = d ? ((d.pct || 0) >= 0 ? '#FF3340' : '#16D67E') : 'var(--ios-label3)'
        return (
          <div key={key} style={{
            flex: 1, background: 'var(--ios-bg2)', borderRadius: 12, padding: '12px 14px',
            boxShadow: 'var(--shadow-card)', borderLeft: d ? `3px solid ${color}` : '3px solid var(--ios-sep)',
          }}>
            <div style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, marginBottom: 2 }}>{label}</div>
            {d ? (
              <>
                <div style={{ fontSize: 16, fontWeight: 800, color, fontFamily: 'var(--font-mono)', letterSpacing: '-0.5px', lineHeight: 1.1 }}>
                  {d.price?.toFixed(2)}
                </div>
                {d.pct != null && (
                  <div style={{ fontSize: 11, fontWeight: 700, color, marginTop: 2 }}>
                    {d.pct >= 0 ? '+' : ''}{(d.pct * 100).toFixed(2)}%
                    {d.change != null && <span style={{ fontWeight: 500, marginLeft: 4 }}>({d.change >= 0 ? '+' : ''}{d.change.toFixed(2)})</span>}
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--ios-label3)' }}>{loading ? '載入中…' : '—'}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Flash price number — anime.js scale+shadow when value changes ────────
function FlashPrice({ value, formatter, color, style }) {
  const ref    = useRef(null)
  const prevRef = useRef(null)
  useEffect(() => {
    if (value == null) return
    if (prevRef.current != null && prevRef.current !== value && ref.current)
      flashPriceEl(ref.current, value > prevRef.current)
    prevRef.current = value
  }, [value])
  return (
    <span ref={ref} style={{ borderRadius: 4, display: 'inline-block', color, ...style }}>
      {formatter ? formatter(value) : value}
    </span>
  )
}

// ── Stagger hook: animates [data-row] children when item key changes ──────
function useStaggerRows(containerRef, key) {
  useLayoutEffect(() => {
    if (containerRef.current) animateListRows(containerRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

// ── Stock row ─────────────────────────────────────────────────────────────
function StockRow({ id, name, live, position, scan, isLast, onSelect, onRemove, showRemove }) {
  const upColor   = '#FF3340'
  const downColor = '#16D67E'
  const pct       = live?.pct ?? null
  const color     = pct == null ? 'var(--ios-label)' : pct >= 0 ? upColor : downColor
  const pnlPct    = position && live ? (live.price - position.buyPrice) / position.buyPrice * 100 : null
  const pnlAmt    = position && live ? (live.price - position.buyPrice) * position.qty           : null
  const pnlColor  = pnlPct == null ? 'var(--ios-label3)' : pnlPct >= 0 ? upColor : downColor

  return (
    <div
      data-row
      onClick={() => onSelect({ stock_id: id, name, ...(scan || {}) })}
      style={{
        display: 'flex', alignItems: 'center', padding: '14px 14px', cursor: 'pointer',
        borderBottom: isLast ? 'none' : '0.5px solid var(--ios-sep)',
        background: pct == null ? 'transparent' : pct >= 0 ? 'rgba(255,51,64,0.025)' : 'rgba(22,214,126,0.025)',
      }}
    >
      {/* Left column */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--ios-blue)', fontFamily: 'var(--font-mono)', letterSpacing: '-0.3px' }}>{id}</span>
          <span style={{ fontSize: 13, color: 'var(--ios-label)', fontWeight: 500 }}>{name}</span>
          {scan?.grade && (
            <span style={{
              fontSize: 9, fontWeight: 800, borderRadius: 4, padding: '1px 5px',
              color: scan.grade === 'A' ? '#FFD60A' : scan.grade === 'B' ? '#16D67E' : '#94A3B8',
              background: scan.grade === 'A' ? 'rgba(255,214,10,0.15)' : scan.grade === 'B' ? 'rgba(22,214,126,0.15)' : 'var(--ios-fill4)',
            }}>{scan.grade}</span>
          )}
          {scan?.entry_signal && (
            <span style={{ fontSize: 9, fontWeight: 800, borderRadius: 4, padding: '1px 5px', color: '#FF9F0A', background: 'rgba(255,159,10,0.15)' }}>進場</span>
          )}
          {position && (
            <span style={{ fontSize: 9, fontWeight: 800, borderRadius: 4, padding: '1px 5px', color: 'var(--ios-blue)', background: 'rgba(10,132,255,0.12)' }}>持倉</span>
          )}
        </div>
        {/* Sub-row: OHLV + P&L */}
        <div style={{ display: 'flex', gap: 8, fontSize: 10, color: 'var(--ios-label4)', flexWrap: 'wrap', marginTop: 2 }}>
          {live?.open  != null && <span>開 {fmtP(live.open)}</span>}
          {live?.high  != null && <span style={{ color: upColor }}>高 {fmtP(live.high)}</span>}
          {live?.low   != null && <span style={{ color: downColor }}>低 {fmtP(live.low)}</span>}
          {live?.volume > 0    && <span>量 {Math.round(live.volume / 1000).toLocaleString()}張</span>}
          {live?.time          && <span>{live.time}</span>}
          {position && live && pnlAmt != null && (
            <span style={{ color: pnlColor, fontWeight: 700 }}>
              持倉 {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
              <span style={{ fontWeight: 500, marginLeft: 3 }}>({pnlAmt >= 0 ? '+' : ''}{Math.round(pnlAmt).toLocaleString()})</span>
            </span>
          )}
          {position && !live && (
            <span>買 {fmtP(position.buyPrice)} · {Math.round(position.qty / 1000)}張</span>
          )}
        </div>
      </div>
      {/* Right column */}
      <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 80, display: 'flex', alignItems: 'center', gap: 6 }}>
        <div>
          {live ? (
            <>
              <div style={{ fontSize: 20, fontWeight: 800, fontFamily: 'var(--font-mono)', lineHeight: 1.1, letterSpacing: '-0.5px' }}>
                <FlashPrice value={live.price} formatter={fmtP} color={color} />
              </div>
              {pct != null && (
                <div style={{ fontSize: 13, fontWeight: 700, color, marginTop: 1 }}>
                  {pct >= 0 ? '+' : ''}{(pct * 100).toFixed(2)}%
                </div>
              )}
              {live.prevClose != null && (
                <div style={{ fontSize: 9, color: 'var(--ios-label4)', marginTop: 1 }}>昨 {fmtP(live.prevClose)}</div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--ios-label4)' }}>待報價</div>
          )}
        </div>
        {showRemove && (
          <button
            onClick={e => { e.stopPropagation(); onRemove(id) }}
            style={{
              background: 'rgba(255,59,48,0.10)', border: 'none', borderRadius: 99,
              width: 22, height: 22, fontSize: 14, color: '#FF3B30', lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', flexShrink: 0, padding: 0,
            }}
          >×</button>
        )}
      </div>
    </div>
  )
}

// ── Section header ────────────────────────────────────────────────────────
function SectionHeader({ title, count, collapsed, onToggle, rightSlot }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
      <button
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--ios-label3)' }}>{title}</span>
        <span style={{ fontSize: 11, background: 'var(--ios-fill3)', borderRadius: 99, padding: '1px 7px', color: 'var(--ios-label3)', fontWeight: 700 }}>{count}</span>
        <span style={{ fontSize: 10, color: 'var(--ios-label4)', display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.18s' }}>▾</span>
      </button>
      {rightSlot}
    </div>
  )
}

// ── Portfolio summary bar ─────────────────────────────────────────────────
function PortfolioSummary({ items }) {
  if (!items.length) return null
  const totalCost  = items.reduce((s, e) => s + (e.position?.buyPrice || 0) * (e.position?.qty || 0), 0)
  const totalValue = items.reduce((s, e) => s + (e.live?.price || e.position?.buyPrice || 0) * (e.position?.qty || 0), 0)
  const totalPnl   = totalValue - totalCost
  const pnlPct     = totalCost > 0 ? totalPnl / totalCost * 100 : 0
  const todayPnl   = items.reduce((s, e) => {
    if (!e.live?.pct || !e.position) return s
    const prevPrice = e.live.price / (1 + e.live.pct)
    return s + (e.live.price - prevPrice) * e.position.qty
  }, 0)
  const color      = totalPnl >= 0 ? '#FF3340' : '#16D67E'
  const todayColor = todayPnl >= 0 ? '#FF3340' : '#16D67E'

  return (
    <div style={{
      padding: '10px 14px', background: 'var(--ios-fill4)',
      borderBottom: '0.5px solid var(--ios-sep)',
      display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4,
    }}>
      <div>
        <div style={{ fontSize: 9, color: 'var(--ios-label3)', fontWeight: 700 }}>市值</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ios-label)', fontFamily: 'var(--font-mono)' }}>
          {Math.round(totalValue).toLocaleString()}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 9, color: 'var(--ios-label3)', fontWeight: 700 }}>今日損益</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: todayColor, fontFamily: 'var(--font-mono)' }}>
          {todayPnl >= 0 ? '+' : ''}{Math.round(todayPnl).toLocaleString()}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 9, color: 'var(--ios-label3)', fontWeight: 700 }}>持倉損益</div>
        <div style={{ fontSize: 12, fontWeight: 700, color, fontFamily: 'var(--font-mono)' }}>
          {totalPnl >= 0 ? '+' : ''}{Math.round(totalPnl).toLocaleString()}
          <span style={{ fontSize: 10, marginLeft: 3 }}>({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)</span>
        </div>
      </div>
    </div>
  )
}

// ── Add stock panel (bottom sheet) ────────────────────────────────────────
function AddStockPanel({ data, monitorList, onAdd, onClose }) {
  const [query, setQuery] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 80) }, [])

  const nameMap = useMemo(() => buildNameMap(data), [data])

  const suggestions = useMemo(() => {
    const q = query.trim()
    if (!q) return []
    const lower = q.toLowerCase()
    return Object.entries(nameMap)
      .filter(([id, name]) => (id.startsWith(q) || (name || '').toLowerCase().includes(lower)) && !monitorList.includes(id))
      .slice(0, 8)
      .map(([id, name]) => ({ id, name }))
  }, [query, nameMap, monitorList])

  const handleAdd = (id) => { onAdd(id); onClose() }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 9999 }}
      onClick={onClose}
    >
      <div
        style={{ background: 'var(--ios-bg)', borderRadius: '20px 20px 0 0', padding: '20px 16px 36px', width: '100%', maxWidth: 480, boxShadow: '0 -4px 40px rgba(0,0,0,0.25)' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ width: 36, height: 4, background: 'var(--ios-fill3)', borderRadius: 99, margin: '0 auto 16px' }} />
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 14, color: 'var(--ios-label)' }}>新增自選股</div>
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && query.trim()) handleAdd(suggestions[0]?.id || query.trim().split(/\s/)[0]) }}
          placeholder="輸入股號或股名，Enter 確認"
          style={{
            width: '100%', padding: '11px 14px', borderRadius: 12, border: '1.5px solid var(--ios-sep)',
            background: 'var(--ios-bg2)', color: 'var(--ios-label)', fontSize: 15, outline: 'none', boxSizing: 'border-box',
          }}
        />
        {suggestions.length > 0 && (
          <div style={{ background: 'var(--ios-bg2)', borderRadius: 12, marginTop: 8, overflow: 'hidden', boxShadow: 'var(--shadow-card)' }}>
            {suggestions.map((s, i) => (
              <div
                key={s.id}
                onClick={() => handleAdd(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px',
                  borderBottom: i < suggestions.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ios-blue)', fontFamily: 'var(--font-mono)' }}>{s.id}</span>
                <span style={{ fontSize: 13, color: 'var(--ios-label)' }}>{s.name}</span>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={onClose}
          style={{
            width: '100%', marginTop: 14, padding: '12px 0', borderRadius: 12,
            border: '1.5px solid var(--ios-sep)', background: 'var(--ios-bg2)',
            color: 'var(--ios-label2)', fontSize: 14, cursor: 'pointer',
          }}
        >取消</button>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────
const SESSION_LABEL = { open: '🟢 盤中', pre: '⏰ 開盤前', closed: '⚫ 已收盤', weekend: '📆 假日' }

export default function LiveMonitor({ data }) {
  const [monitorList,   setMonitorList]   = useState(() => loadMonitorList())
  const [positions]                       = useState(() => loadPortfolio())
  const [showAdd,       setShowAdd]       = useState(false)
  const [sortBy,        setSortBy]        = useState('pct')      // 'pct' | 'vol' | 'id'
  const [scanScope,     setScanScope]     = useState('entry')    // 'entry' | 'top50' | 'top100'
  const [collapsed,     setCollapsed]     = useState({})
  const [indices,       setIndices]       = useState({})
  const [idxLoading,    setIdxLoading]    = useState(false)
  const [selectedStock, setSelectedStock] = useState(null)
  const [historyData,   setHistoryData]   = useState(null)
  const historiesRef = useRef(null)

  const nameMap = useMemo(() => buildNameMap(data), [data])
  const scanMap = useMemo(() => buildScanMap(data), [data])

  const scanStocks = useMemo(() => {
    const all = getLatestScan(data).top_stocks || []
    if (scanScope === 'entry')  return all.filter(s => s.entry_signal)
    if (scanScope === 'top50')  return all.slice(0, 50)
    return all.slice(0, 100)
  }, [data, scanScope])

  const allIds = useMemo(() => [...new Set([
    ...monitorList,
    ...Object.keys(positions),
    ...scanStocks.map(s => String(s.stock_id)),
  ])], [monitorList, positions, scanStocks])

  const { prices: liveData, isOpen: mktOpen, session: mktSession, lastUpdate: liveTime, loading: liveLoading }
    = useLivePrices(allIds)

  // Separate index fetch
  useEffect(() => {
    if (!mktOpen) return
    let cancelled = false
    const run = async () => {
      if (!cancelled) setIdxLoading(true)
      try {
        const r = await fetch(
          'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw|otc_o00.tw&json=1&delay=0',
          { signal: AbortSignal.timeout(8000) }
        )
        if (!r.ok) return
        const json = await r.json()
        const result = {}
        for (const item of json.msgArray || []) {
          const z = parseFloat(item.z), y = parseFloat(item.y)
          if (isNaN(z) || z <= 0) continue
          result[item.c] = {
            price: z,
            prevClose: isNaN(y) ? null : y,
            change: isNaN(y) ? null : z - y,
            pct: (!isNaN(y) && y > 0) ? (z - y) / y : null,
            time: item.t || '',
          }
        }
        if (!cancelled) setIndices(result)
      } catch {} finally {
        if (!cancelled) setIdxLoading(false)
      }
    }
    run()
    const t = setInterval(run, 30000)
    return () => { cancelled = true; clearInterval(t) }
  }, [mktOpen])

  const sortFn = useCallback((a, b) => {
    if (sortBy === 'pct') return (b.live?.pct ?? -Infinity) - (a.live?.pct ?? -Infinity)
    if (sortBy === 'vol') return (b.live?.volume || 0) - (a.live?.volume || 0)
    return String(a.id).localeCompare(String(b.id))
  }, [sortBy])

  const monSet = useMemo(() => new Set(monitorList), [monitorList])
  const posSet = useMemo(() => new Set(Object.keys(positions)), [positions])

  const watchItems = useMemo(() =>
    monitorList.map(id => ({ id, live: liveData[id] || null, name: nameMap[id] || id, position: positions[id] || null, scan: scanMap[id] || null }))
      .sort(sortFn)
  , [monitorList, liveData, nameMap, positions, scanMap, sortFn])

  const portItems = useMemo(() =>
    Object.entries(positions).map(([id, pos]) => ({ id, live: liveData[id] || null, name: pos.name || nameMap[id] || id, position: pos, scan: scanMap[id] || null }))
      .sort(sortFn)
  , [positions, liveData, nameMap, scanMap, sortFn])

  const scanItems = useMemo(() =>
    scanStocks
      .filter(s => !monSet.has(String(s.stock_id)) && !posSet.has(String(s.stock_id)))
      .map(s => ({ id: String(s.stock_id), live: liveData[String(s.stock_id)] || null, name: s.name || '', position: null, scan: s }))
      .sort(sortFn)
  , [scanStocks, liveData, monSet, posSet, sortFn])

  // Stagger: animate rows when list identity (IDs + scope) changes, not on every price tick
  const watchListRef = useRef(null)
  const portListRef  = useRef(null)
  const scanListRef  = useRef(null)
  const watchKey = monitorList.join(',') + '|' + sortBy
  const portKey  = Object.keys(positions).join(',') + '|' + sortBy
  const scanKey  = scanScope + '|' + scanStocks.map(s => s.stock_id).join(',')
  useStaggerRows(watchListRef, watchKey)
  useStaggerRows(portListRef,  portKey)
  useStaggerRows(scanListRef,  scanKey)

  const openDetail = async (stock) => {
    setSelectedStock(stock)
    if (!historiesRef.current) {
      try {
        const base = import.meta.env.BASE_URL || '/'
        const h = await fetch(`${base}stock_histories.json`).then(r => r.ok ? r.json() : null)
        historiesRef.current = h || {}
        if (h) setHistoryData(h)
      } catch { historiesRef.current = {} }
    }
    const h = historiesRef.current || {}
    const kline = h?.stocks?.[stock.stock_id]
    const dates = h?.dates || []
    let priceHistory = null
    if (kline?.c) {
      priceHistory = dates.map((t, i) => kline.c[i] == null ? null : {
        time: t, open: kline.o?.[i] ?? kline.c[i], high: kline.h?.[i] ?? kline.c[i],
        low: kline.l?.[i] ?? kline.c[i], close: kline.c[i], volume: kline.v?.[i] ?? 0,
      }).filter(Boolean)
    }
    setSelectedStock(prev => prev?.stock_id === stock.stock_id ? { ...prev, price_history: priceHistory || undefined } : prev)
  }

  const toggleCollapsed = (key) => setCollapsed(c => ({ ...c, [key]: !c[key] }))
  const addToMonitor    = (id)  => setMonitorList(prev => { const next = prev.includes(id) ? prev : [...prev, id]; saveMonitorList(next); return next })
  const removeFromMonitor = (id) => setMonitorList(prev => { const next = prev.filter(x => x !== id); saveMonitorList(next); return next })

  const sessionColor = mktSession === 'open' ? '#16D67E' : 'var(--ios-label3)'
  const hasPorts = Object.keys(positions).length > 0
  const hasScans = scanStocks.length > 0

  return (
    <>
    <style>{`@keyframes monSpin { to { transform: rotate(360deg) } }`}</style>
    <div style={{ padding: '10px 16px 80px', overflowY: 'auto', height: '100%', WebkitOverflowScrolling: 'touch' }}>

      {/* ── Market status ───────────────────────────────────────── */}
      <div style={{
        background: mktOpen ? 'linear-gradient(135deg, rgba(22,214,126,0.08) 0%, var(--ios-bg2) 65%)' : 'var(--ios-bg2)',
        borderRadius: 16, padding: '14px 16px', marginBottom: 12,
        boxShadow: 'var(--shadow-card)', borderLeft: `3px solid ${sessionColor}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: sessionColor, letterSpacing: '-0.3px' }}>
            {SESSION_LABEL[mktSession] || '—'}
          </div>
          <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 2 }}>台股 09:00–13:30 週一至週五</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {liveTime && (
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ios-label)', fontFamily: 'var(--font-mono)' }}>
              {liveTime.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </div>
          )}
          <div style={{ fontSize: 10, marginTop: 2, color: liveLoading ? 'var(--ios-blue)' : 'var(--ios-label4)', display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
            {liveLoading && <span style={{ display: 'inline-block', width: 10, height: 10, border: '1.5px solid var(--ios-fill3)', borderTop: '1.5px solid var(--ios-blue)', borderRadius: '50%', animation: 'monSpin 0.8s linear infinite' }} />}
            {liveLoading ? '更新中…' : mktOpen ? '每 30 秒更新' : '收盤停止更新'}
          </div>
        </div>
      </div>

      {/* ── Index bar (market hours only) ─────────────────────── */}
      {mktOpen && <IndexBar indices={indices} loading={idxLoading} />}

      {/* ── Sort + scope controls ─────────────────────────────── */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: 'var(--ios-label4)', fontWeight: 700 }}>排序</span>
        {[['pct', '漲跌%'], ['vol', '成交量'], ['id', '股號']].map(([k, l]) => (
          <button key={k} onClick={() => setSortBy(k)} style={{
            padding: '5px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700,
            border: 'none', cursor: 'pointer',
            background: sortBy === k ? 'var(--ios-blue)' : 'var(--ios-fill3)',
            color: sortBy === k ? '#fff' : 'var(--ios-label2)',
          }}>{l}</button>
        ))}
        <div style={{ flex: 1, minWidth: 4 }} />
        <span style={{ fontSize: 10, color: 'var(--ios-label4)', fontWeight: 700 }}>掃描</span>
        {[['entry', '進場'], ['top50', '前50'], ['top100', '前100']].map(([k, l]) => (
          <button key={k} onClick={() => setScanScope(k)} style={{
            padding: '5px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700,
            border: 'none', cursor: 'pointer',
            background: scanScope === k ? 'rgba(255,159,10,0.18)' : 'var(--ios-fill3)',
            color: scanScope === k ? '#FF9F0A' : 'var(--ios-label3)',
          }}>{l}</button>
        ))}
      </div>

      {/* ── 自選盯盤 ─────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <SectionHeader
          title="自選盯盤"
          count={monitorList.length}
          collapsed={collapsed.watch}
          onToggle={() => toggleCollapsed('watch')}
          rightSlot={
            <button onClick={() => setShowAdd(true)} style={{
              padding: '5px 14px', borderRadius: 99, fontSize: 12, fontWeight: 700,
              border: 'none', cursor: 'pointer', background: 'var(--ios-blue)', color: '#fff',
            }}>＋ 新增</button>
          }
        />
        {!collapsed.watch && (
          monitorList.length === 0 ? (
            <div style={{
              background: 'var(--ios-bg2)', borderRadius: 14, padding: '28px 16px',
              textAlign: 'center', boxShadow: 'var(--shadow-card)', border: '1.5px dashed var(--ios-sep)',
            }}>
              <div style={{ fontSize: 30, marginBottom: 8 }}>📋</div>
              <div style={{ fontSize: 14, color: 'var(--ios-label2)', fontWeight: 600 }}>尚無自選股</div>
              <div style={{ fontSize: 12, color: 'var(--ios-label3)', marginTop: 4 }}>點擊「＋ 新增」加入想盯盤的股票<br/>開盤前一天設定，開盤後即時更新</div>
              <button onClick={() => setShowAdd(true)} style={{
                marginTop: 14, padding: '9px 22px', borderRadius: 99, fontSize: 13, fontWeight: 700,
                background: 'var(--ios-blue)', color: '#fff', border: 'none', cursor: 'pointer',
              }}>＋ 新增自選股</button>
            </div>
          ) : (
            <div ref={watchListRef} style={{ background: 'var(--ios-bg2)', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-card)' }}>
              {watchItems.map((item, i) => (
                <StockRow key={item.id} {...item} isLast={i === watchItems.length - 1} onSelect={openDetail} onRemove={removeFromMonitor} showRemove />
              ))}
            </div>
          )
        )}
      </div>

      {/* ── 持倉損益 ─────────────────────────────────────────── */}
      {hasPorts && (
        <div style={{ marginBottom: 20 }}>
          <SectionHeader
            title="持倉損益"
            count={Object.keys(positions).length}
            collapsed={collapsed.port}
            onToggle={() => toggleCollapsed('port')}
          />
          {!collapsed.port && (
            !mktOpen ? (
              <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '14px 16px', textAlign: 'center', color: 'var(--ios-label3)', fontSize: 12, boxShadow: 'var(--shadow-card)' }}>
                盤後無即時報價，請至「持倉」頁查看收盤損益
              </div>
            ) : portItems.every(e => !e.live) ? (
              <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '20px', textAlign: 'center', boxShadow: 'var(--shadow-card)' }}>
                <div style={{ width: 20, height: 20, border: '2px solid var(--ios-fill3)', borderTop: '2px solid var(--ios-blue)', borderRadius: '50%', animation: 'monSpin 0.8s linear infinite', margin: '0 auto 8px' }} />
                <div style={{ fontSize: 11, color: 'var(--ios-label3)' }}>等待持倉報價…</div>
              </div>
            ) : (
              <div ref={portListRef} style={{ background: 'var(--ios-bg2)', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-card)' }}>
                <PortfolioSummary items={portItems} />
                {portItems.map((item, i) => (
                  <StockRow key={item.id} {...item} isLast={i === portItems.length - 1} onSelect={openDetail} showRemove={false} />
                ))}
              </div>
            )
          )}
        </div>
      )}

      {/* ── 掃描結果 ─────────────────────────────────────────── */}
      {hasScans && (
        <div style={{ marginBottom: 20 }}>
          <SectionHeader
            title="掃描結果盯盤"
            count={scanItems.length}
            collapsed={collapsed.scan}
            onToggle={() => toggleCollapsed('scan')}
          />
          {!collapsed.scan && (
            !mktOpen ? (
              <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '24px 16px', textAlign: 'center', boxShadow: 'var(--shadow-card)' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📴</div>
                <div style={{ fontSize: 13, color: 'var(--ios-label2)', fontWeight: 600 }}>
                  {mktSession === 'pre' ? '等待開盤（09:00 開始更新）' : '盤後停止更新'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 4 }}>明日 09:00 自動恢復即時行情</div>
              </div>
            ) : scanItems.length === 0 ? (
              <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '20px', textAlign: 'center', color: 'var(--ios-label3)', fontSize: 13, boxShadow: 'var(--shadow-card)' }}>
                {scanScope === 'entry' ? '今日尚無進場訊號' : '掃描股票均已在自選或持倉中'}
              </div>
            ) : (
              <div ref={scanListRef} style={{ background: 'var(--ios-bg2)', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-card)' }}>
                {scanItems.map((item, i) => (
                  <StockRow key={item.id} {...item} isLast={i === scanItems.length - 1} onSelect={openDetail} showRemove={false} />
                ))}
              </div>
            )
          )}
        </div>
      )}

      {!monitorList.length && !hasPorts && !hasScans && (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--ios-label3)', fontSize: 13 }}>
          開盤中可在此即時追蹤進場訊號與持倉損益
        </div>
      )}
    </div>

    {showAdd && (
      <AddStockPanel data={data} monitorList={monitorList} onAdd={addToMonitor} onClose={() => setShowAdd(false)} />
    )}

    {selectedStock && (
      <StockDetailModal
        stock={selectedStock}
        notionInfo={null}
        onClose={() => setSelectedStock(null)}
        allScans={data?.scans}
        compareHistories={historyData?.stocks || null}
        historyDates={historyData?.dates || null}
      />
    )}
    </>
  )
}
