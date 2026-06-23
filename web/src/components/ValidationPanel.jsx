import { useMemo, useRef, useState, useEffect } from 'react'
import { animate, stagger, spring } from 'animejs'
import { useLivePrices, isTWSEOpen } from '../hooks/useLivePrices'
import StockDetailModal from './StockDetailModal'

const BASE = import.meta.env.BASE_URL || '/'

const GRADE_CFG = {
  A: { color: '#FFD60A', bg: 'rgba(255,214,10,0.15)', border: 'rgba(255,214,10,0.35)', label: 'A' },
  B: { color: '#16D67E', bg: 'rgba(22,214,126,0.13)',  border: 'rgba(22,214,126,0.30)',  label: 'B' },
  C: { color: '#FF9F0A', bg: 'rgba(255,159,10,0.13)', border: 'rgba(255,159,10,0.30)', label: 'C' },
  D: { color: '#94A3B8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.22)', label: 'D' },
  X: { color: '#FF3340', bg: 'rgba(255,51,64,0.13)',  border: 'rgba(255,51,64,0.30)',  label: 'X' },
}

const SIGNAL_LABELS = {
  macd_golden_cross:      'MACD金叉',
  kd_golden_cross:        'KD金叉',
  hist_turn_positive:     '柱翻正',
  above_ema60:            '站上EMA60',
  ema60_gt_ema120:        '多頭排列',
  volume_break:           '放量突破',
  bb_squeeze_breakout:    'BB收縮突破',
  breakout_20d:           '創20日新高',
  breakout_volume_confirm:'突破量確認',
  rsi_strong:             'RSI強勢',
  adx_trending:           'ADX趨勢',
  obv_uptrend:            'OBV上揚',
  above_ichimoku_cloud:   '站上雲',
  cci_momentum:           'CCI動能',
  mfi_strong:             'MFI強',
  williams_r_recovery:    'WR回升',
  foreign_buy_3d:         '外資連買',
  invest_trust_buy_2d:    '投信買超',
  dealer_buy_3d:          '自營連買',
  is_sector_leader:       '類股旗手',
  stronger_than_market:   '強於大盤',
}

// Priority order for signal tags (show top 4)
const SIGNAL_PRIORITY = [
  'breakout_20d','bb_squeeze_breakout','volume_break','macd_golden_cross',
  'kd_golden_cross','foreign_buy_3d','invest_trust_buy_2d','is_sector_leader',
  'above_ichimoku_cloud','rsi_strong','adx_trending','obv_uptrend','ema60_gt_ema120',
]

const fmtPct  = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'
const fmtRate = v => v == null ? '—' : (v * 100).toFixed(0) + '%'
const fmtP    = v => v == null ? '—' : v >= 100 ? v.toFixed(1) : v.toFixed(2)
const winColor = r => r == null ? 'var(--ios-label3)' : r >= 0.7 ? '#16D67E' : r >= 0.5 ? '#FF9F0A' : '#FF3340'
const retColor = r => r == null ? 'var(--ios-label3)' : r > 0 ? '#FF3340' : r < 0 ? '#16D67E' : 'var(--ios-label3)'

function parseSignals(entry_reason) {
  if (!entry_reason) return []
  const raw = entry_reason.split(',').map(s => s.trim()).filter(Boolean)
  // Sort by priority
  const pri = raw.filter(k => SIGNAL_PRIORITY.includes(k)).sort((a, b) => SIGNAL_PRIORITY.indexOf(a) - SIGNAL_PRIORITY.indexOf(b))
  const rest = raw.filter(k => !SIGNAL_PRIORITY.includes(k))
  return [...pri, ...rest].slice(0, 4)
}

function StockCard({ stock, rank, livePrice, showLive, style, onClick }) {
  const cfg = GRADE_CFG[stock.grade] || GRADE_CFG.D
  const signals = parseSignals(stock.entry_reason)
  const r1 = stock.return_1d
  const r5 = stock.return_5d
  const hasExit = stock.base_exit_signal

  const liveReturn = showLive && livePrice != null && stock.close > 0
    ? (livePrice - stock.close) / stock.close
    : null

  const [pressed, setPressed] = useState(false)

  return (
    <div
      onClick={onClick}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      onTouchStart={() => setPressed(true)}
      onTouchEnd={() => setPressed(false)}
      style={{
        background: 'var(--ios-bg2)', borderRadius: 14,
        border: `0.5px solid ${hasExit ? 'rgba(255,51,64,0.4)' : 'var(--ios-sep)'}`,
        padding: '11px 13px', cursor: onClick ? 'pointer' : 'default',
        transform: pressed ? 'scale(0.975)' : 'scale(1)',
        transition: 'transform 0.15s',
        ...style,
      }}
    >
      {/* Row 1: rank + grade + name + price */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: 'var(--ios-label4)', minWidth: 16, textAlign: 'center', fontWeight: 700 }}>{rank}</span>
        <span style={{
          fontSize: 11, fontWeight: 800, color: cfg.color,
          background: cfg.bg, border: `0.5px solid ${cfg.border}`,
          padding: '1px 7px', borderRadius: 6, flexShrink: 0,
        }}>{cfg.label}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-label)' }}>{stock.stock_id}</span>
          <span style={{ fontSize: 12, color: 'var(--ios-label2)', marginLeft: 5, fontWeight: 400 }}>{stock.name || ''}</span>
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ios-label)', flexShrink: 0 }}>
          {showLive && livePrice != null ? `$${fmtP(livePrice)}` : `$${fmtP(stock.close)}`}
        </span>
      </div>

      {/* Row 2: signals + returns */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* Signal tags */}
        <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {signals.map(key => (
            <span key={key} style={{
              fontSize: 9, color: 'var(--ios-label3)',
              background: 'var(--ios-fill3)', borderRadius: 4, padding: '1px 5px',
            }}>{SIGNAL_LABELS[key] || key}</span>
          ))}
          {!signals.length && <span style={{ fontSize: 9, color: 'var(--ios-label4)' }}>—</span>}
          {stock.industry_category && (
            <span style={{ fontSize: 8, color: 'var(--ios-blue)', background: 'rgba(10,132,255,0.10)', borderRadius: 4, padding: '1px 5px' }}>
              {stock.industry_category}
            </span>
          )}
        </div>

        {/* Return badges */}
        <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
          {/* Live return (when market open and histDate == null) */}
          {showLive && liveReturn != null ? (
            <div style={{ textAlign: 'center', minWidth: 42 }}>
              <div style={{ fontSize: 7.5, color: 'var(--ios-label4)', marginBottom: 1 }}>今→</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: retColor(liveReturn) }}>{fmtPct(liveReturn)}</div>
            </div>
          ) : (
            /* Next-day return */
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 7.5, color: 'var(--ios-label4)', marginBottom: 1 }}>隔日</div>
              {r1 != null
                ? <div style={{ fontSize: 12, fontWeight: 700, color: retColor(r1) }}>{fmtPct(r1)}</div>
                : <div style={{ fontSize: 9, fontWeight: 700, color: '#FF9F0A', background: 'rgba(255,159,10,0.1)', borderRadius: 4, padding: '2px 4px', marginTop: 1 }}>待驗</div>
              }
            </div>
          )}
          {/* 5D return */}
          <div style={{ textAlign: 'center', minWidth: 42 }}>
            <div style={{ fontSize: 7.5, color: 'var(--ios-label4)', marginBottom: 1 }}>5日</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: retColor(r5) }}>{fmtPct(r5)}</div>
          </div>
        </div>
      </div>

      {/* Exit warning */}
      {hasExit && (
        <div style={{ marginTop: 5, fontSize: 9, color: '#FF3340', fontWeight: 600 }}>
          ⚠️ 出場信號：{stock.base_exit_reason || '已觸發'}
        </div>
      )}
    </div>
  )
}

function DateBarChart({ byDate, byDate1d = {}, sortedDates }) {
  const valid = sortedDates.filter(d => byDate[d])
  if (!valid.length) return null
  const maxR = Math.max(...valid.map(d => Math.abs(byDate[d].avgReturn || 0)), 0.01)
  const H = 90
  const BAR_W = 22, SPACING = 32, PAD = 6
  const totalW = valid.length * SPACING + PAD * 2
  const has1d = valid.some(d => byDate1d[d])
  const svgH = H + (has1d ? 36 : 24)
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 9, color: 'var(--ios-label4)' }}>柱: 5日均酬</span>
        {has1d && <span style={{ fontSize: 9, color: 'var(--ios-orange)' }}>下方數字: 隔日均酬</span>}
      </div>
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
        <svg viewBox={`0 0 ${totalW} ${svgH}`} style={{ width: Math.max(totalW, 280), height: svgH, display: 'block' }}>
          {valid.map((date, i) => {
            const s = byDate[date]
            const r = s.avgReturn || 0
            const bH = Math.max(4, Math.abs(r) / maxR * (H - 10))
            const x = PAD + i * SPACING
            const y  = r >= 0 ? H - 4 - bH : H - 4
            const col = r >= 0 ? '#FF3340' : '#16D67E'
            return (
              <g key={date}>
                <rect x={x} y={y} width={BAR_W} height={bH} rx={4} fill={col} opacity={0.85} />
                <text x={x + BAR_W / 2} y={H + 12} fontSize={7.5} textAnchor="middle" style={{ fill: 'var(--ios-label3)' }}>{date.slice(5)}</text>
                <text x={x + BAR_W / 2} y={r >= 0 ? y - 3 : y + bH + 9} fontSize={7} textAnchor="middle" fill={col} fontWeight="700">{(r * 100).toFixed(0)}%</text>
              </g>
            )
          })}
          <line x1={PAD} y1={H - 4} x2={totalW - PAD} y2={H - 4} stroke="var(--ios-sep)" strokeWidth={0.5} />
          {has1d && valid.map((date, i) => {
            const d1 = byDate1d[date]
            const r = d1?.avgReturn ?? null
            const x = PAD + i * SPACING + BAR_W / 2
            const col = r == null ? 'var(--ios-label4)' : r > 0 ? '#FF3340' : r < 0 ? '#16D67E' : 'var(--ios-label3)'
            return (
              <text key={`1d-${date}`} x={x} y={H + 25} fontSize={7.5} textAnchor="middle" fill={col} fontWeight={r != null ? '700' : '400'}>
                {r == null ? '—' : (r >= 0 ? '+' : '') + (r * 100).toFixed(1) + '%'}
              </text>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

function GradeRow({ grade, stats }) {
  const cfg = GRADE_CFG[grade] || GRADE_CFG.D
  if (!stats || stats.total === 0) return null
  const wr  = stats.wins / stats.total
  const avg = stats.returns.reduce((a, v) => a + v, 0) / stats.returns.length
  return (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: cfg.color, background: cfg.bg, padding: '1px 7px', borderRadius: 5, flexShrink: 0, minWidth: 44, textAlign: 'center' }}>{cfg.label}</span>
        <span style={{ fontSize: 10, color: 'var(--ios-label4)', flex: 1 }}>{stats.total} 股次</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: winColor(wr), minWidth: 38, textAlign: 'right' }}>{fmtRate(wr)}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: retColor(avg), minWidth: 50, textAlign: 'right' }}>{fmtPct(avg)}</span>
      </div>
      <div style={{ height: 4, background: 'var(--ios-fill3)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${Math.round(wr*100)}%`, height: '100%', background: winColor(wr), borderRadius: 2 }} />
      </div>
    </div>
  )
}

const HIST_KEY = 'tw_val_history'

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || '{}') } catch { return {} }
}

function saveHistory(dateStr, top20) {
  try {
    const existing = loadHistory()
    existing[dateStr] = top20
    // Keep only last 30 dates to avoid bloat
    const keys = Object.keys(existing).sort().slice(-30)
    const trimmed = {}
    for (const k of keys) trimmed[k] = existing[k]
    localStorage.setItem(HIST_KEY, JSON.stringify(trimmed))
  } catch { /* ignore quota errors */ }
}

export default function ValidationPanel({ data }) {
  const listRef      = useRef(null)
  const statsRef     = useRef(null)
  const historiesRef = useRef(null)
  const winRateRef   = useRef(null)
  const avgR5Ref     = useRef(null)

  const [selectedStock, setSelectedStock] = useState(null)
  const [histDate, setHistDate] = useState(null)
  const [gradeFilter, setGradeFilter] = useState(null)

  const { top20, scanDate, batchStats, byGrade, byDate, byDate1d, summary, sortedDates } = useMemo(() => {
    if (!data?.scans || !data?.dates) {
      return { top20: [], scanDate: null, batchStats: {}, byGrade: {}, byDate: {}, byDate1d: {}, summary: {}, sortedDates: [] }
    }
    const { scans, dates, aggregateLatest } = data

    // Exclude today (Taiwan time) — today's scan hasn't been verified by 5-day return yet
    const todayTW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
    const validDates = dates.filter(d => d < todayTW)

    const top20   = scans[validDates[0]]?.top_stocks?.slice(0, 20) || aggregateLatest?.top_stocks || []
    const scanDate = validDates[0] || aggregateLatest?.date?.slice(0, 10)

    const bWith  = top20.filter(s => s.return_5d != null)
    const b1With = top20.filter(s => s.return_1d != null)
    const batchStats = {
      total:      top20.length,
      wins5d:     bWith.filter(s => s.return_5d > 0).length,
      winRate:    bWith.length ? bWith.filter(s => s.return_5d > 0).length / bWith.length : null,
      avgR5d:     bWith.length ? bWith.reduce((a, s) => a + s.return_5d, 0) / bWith.length : null,
      wins1d:     b1With.filter(s => s.return_1d > 0).length,
      winRate1d:  b1With.length ? b1With.filter(s => s.return_1d > 0).length / b1With.length : null,
      avgR1d:     b1With.length ? b1With.reduce((a, s) => a + s.return_1d, 0) / b1With.length : null,
      exits:      top20.filter(s => s.base_exit_signal).length,
    }

    const allObs = []
    const sortedDates = [...validDates].reverse()
    for (const date of validDates) {
      for (const s of (scans[date]?.top_stocks || [])) {
        allObs.push({ date, ...s, r5d: s.return_5d, r1d: s.return_1d })
      }
    }

    const byG = {}
    for (const o of allObs.filter(o => o.r5d != null)) {
      const g = o.grade || 'D'
      if (!byG[g]) byG[g] = { total: 0, wins: 0, returns: [] }
      byG[g].total++
      if (o.r5d > 0) byG[g].wins++
      byG[g].returns.push(o.r5d)
    }

    const byDate = {}
    for (const date of sortedDates) {
      const top = (scans[date]?.top_stocks || []).filter(s => s.return_5d != null)
      if (!top.length) continue
      const r5s = top.map(s => s.return_5d)
      byDate[date] = {
        total: top.length,
        wins: top.filter(s => s.return_5d > 0).length,
        avgReturn: r5s.reduce((a, v) => a + v, 0) / r5s.length,
      }
    }

    const byDate1d = {}
    for (const date of sortedDates) {
      const top = (scans[date]?.top_stocks || []).filter(s => s.return_1d != null)
      if (!top.length) continue
      const r1s = top.map(s => s.return_1d)
      byDate1d[date] = {
        total: top.length,
        wins:  top.filter(s => s.return_1d > 0).length,
        avgReturn: r1s.reduce((a, v) => a + v, 0) / r1s.length,
      }
    }

    const all5d = allObs.filter(o => o.r5d != null)
    const summary = {
      scans: sortedDates.filter(d => byDate[d]).length,
      total: all5d.length,
      winRate: all5d.length ? all5d.filter(o => o.r5d > 0).length / all5d.length : null,
      avgR5: all5d.length ? all5d.reduce((a, o) => a + o.r5d, 0) / all5d.length : null,
    }

    return { top20, scanDate, batchStats, byGrade: byG, byDate, byDate1d, summary, sortedDates }
  }, [data])

  // Persist top20 to localStorage
  useEffect(() => {
    if (top20.length > 0 && scanDate) {
      const hist = loadHistory()
      if (!hist[scanDate]) {
        saveHistory(scanDate, top20)
      }
    }
  }, [top20, scanDate])

  // Saved history dates for the pill row
  const [histDates, setHistDates] = useState([])
  useEffect(() => {
    const hist = loadHistory()
    setHistDates(Object.keys(hist).sort().reverse())
  }, [top20, scanDate])

  // Determine which stocks to show
  const displayStocks = useMemo(() => {
    const base = histDate == null ? top20 : (loadHistory()[histDate] || [])
    return gradeFilter ? base.filter(s => s.grade === gradeFilter) : base
  }, [top20, histDate, gradeFilter])

  // Live prices (only for current scan, not history)
  const marketOpen = isTWSEOpen()
  const liveIds = histDate == null ? top20.map(s => String(s.stock_id)) : []
  const { prices: livePrices } = useLivePrices(liveIds)
  const showLive = histDate == null && marketOpen

  // Anime.js: stagger cards when displayStocks changes
  useEffect(() => {
    if (!listRef.current) return
    const cards = listRef.current.querySelectorAll('.stock-card')
    if (!cards.length) return
    animate(cards, {
      opacity: [0, 1],
      translateY: [20, 0],
      delay: stagger(40, { start: 20 }),
      ease: spring({ stiffness: 320, damping: 26, mass: 0.85 }),
    })
  }, [displayStocks])

  // Fade list container on history date change
  useEffect(() => {
    if (!listRef.current) return
    animate(listRef.current, { opacity: [0.3, 1], duration: 220, ease: 'outQuad' })
  }, [histDate])

  // Anime.js: scale-in stat blocks
  useEffect(() => {
    if (!statsRef.current) return
    const blocks = statsRef.current.querySelectorAll('.stat-block')
    if (!blocks.length) return
    animate(blocks, {
      opacity: [0, 1],
      scale: [0.88, 1],
      delay: stagger(55, { start: 60 }),
      ease: spring({ stiffness: 360, damping: 28, mass: 0.8 }),
    })
  }, [summary.scans])

  // Anime.js number counter: winRate
  useEffect(() => {
    if (!winRateRef.current || summary.winRate == null) return
    const obj = { val: 0 }
    animate(obj, {
      val: summary.winRate * 100,
      duration: 900,
      ease: 'outCubic',
      onUpdate: () => { if (winRateRef.current) winRateRef.current.textContent = Math.round(obj.val) + '%' },
    })
  }, [summary.winRate])

  // Anime.js number counter: avgR5
  useEffect(() => {
    if (!avgR5Ref.current || summary.avgR5 == null) return
    const obj = { val: 0 }
    animate(obj, {
      val: summary.avgR5 * 100,
      duration: 900,
      ease: 'outCubic',
      onUpdate: () => {
        if (avgR5Ref.current) {
          const v = obj.val
          avgR5Ref.current.textContent = (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
        }
      },
    })
  }, [summary.avgR5])

  // Open stock detail modal
  const handleStockClick = async (stock) => {
    const baseStock = {
      ...stock,
      stock_id: stock.stock_id,
      name: stock.name,
      close: livePrices[String(stock.stock_id)]?.price ?? stock.close,
      price_history_loading: true,
    }
    setSelectedStock(baseStock)

    try {
      if (!historiesRef.current) {
        const base = BASE.endsWith('/') ? BASE : BASE + '/'
        const resp = await fetch(`${base}stock_histories.json`)
        historiesRef.current = resp.ok ? await resp.json() : {}
      }
      const h = historiesRef.current
      const sid = String(stock.stock_id)
      let history = null

      // Try OHLCV kline history (stocks section: {o,h,l,c,v} aligned to dates array)
      const rec = h.stocks?.[sid]
      if (rec && Array.isArray(h.dates) && rec.c) {
        const bars = []
        for (let i = 0; i < h.dates.length; i++) {
          if (rec.c[i] == null) continue
          bars.push({ time: h.dates[i], open: rec.o?.[i], high: rec.h?.[i], low: rec.l?.[i], close: rec.c[i], volume: rec.v?.[i] })
        }
        if (bars.length >= 2) history = bars
      }

      // Fall back to scan_stocks (compact [date,o,h,l,c,v] tuples)
      if (!history) {
        const scanRec = h.scan_stocks?.[sid]
        if (Array.isArray(scanRec) && scanRec.length >= 2) {
          history = scanRec.map(b => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] }))
        }
      }

      setSelectedStock(prev => prev ? { ...prev, price_history: history, price_history_loading: false } : null)
    } catch {
      setSelectedStock(prev => prev ? { ...prev, price_history: null, price_history_loading: false } : null)
    }
  }

  if (!data) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ios-label3)' }}>載入中⋯</div>
  )

  const isViewingHistory = histDate != null

  return (
    <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '0 14px 32px' }}>

      {/* ── 最新精選 TOP 20 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ios-label)' }}>
          {isViewingHistory ? '查歷史' : '精選 TOP 20'}
        </span>
        {(isViewingHistory ? histDate : scanDate) && (
          <span style={{ fontSize: 10, background: isViewingHistory ? 'rgba(255,159,10,0.15)' : 'rgba(10,132,255,0.15)', color: isViewingHistory ? '#FF9F0A' : '#0A84FF', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>
            {isViewingHistory ? histDate : scanDate}
          </span>
        )}
        {!isViewingHistory && batchStats.exits > 0 && (
          <span style={{ fontSize: 9, color: '#FF3340', background: 'rgba(255,51,64,0.12)', borderRadius: 5, padding: '2px 6px', marginLeft: 'auto' }}>
            ⚠️ {batchStats.exits} 檔出場信號
          </span>
        )}
        {isViewingHistory && (
          <button
            onClick={() => setHistDate(null)}
            style={{ marginLeft: 'auto', fontSize: 10, color: '#0A84FF', background: 'rgba(10,132,255,0.12)', border: '0.5px solid rgba(10,132,255,0.3)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}
          >
            回最新
          </button>
        )}
      </div>

      {/* History date pills */}
      {histDates.length > 0 && (
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 6, paddingBottom: 2, width: 'max-content' }}>
            <button
              onClick={() => setHistDate(null)}
              style={{
                fontSize: 10, padding: '4px 10px', borderRadius: 20, border: '0.5px solid',
                cursor: 'pointer', fontWeight: 600, flexShrink: 0,
                background: histDate == null ? 'rgba(10,132,255,0.18)' : 'var(--ios-fill3)',
                borderColor: histDate == null ? 'rgba(10,132,255,0.5)' : 'var(--ios-sep)',
                color: histDate == null ? '#0A84FF' : 'var(--ios-label3)',
              }}
            >最新</button>
            {histDates.map(d => (
              <button
                key={d}
                onClick={() => setHistDate(d)}
                style={{
                  fontSize: 10, padding: '4px 10px', borderRadius: 20, border: '0.5px solid',
                  cursor: 'pointer', fontWeight: 600, flexShrink: 0,
                  background: histDate === d ? 'rgba(255,159,10,0.18)' : 'var(--ios-fill3)',
                  borderColor: histDate === d ? 'rgba(255,159,10,0.5)' : 'var(--ios-sep)',
                  color: histDate === d ? '#FF9F0A' : 'var(--ios-label3)',
                }}
              >{d.slice(5)}</button>
            ))}
          </div>
        </div>
      )}

      {/* Batch summary row */}
      {!isViewingHistory && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8, background: 'var(--ios-bg2)', borderRadius: 14, padding: '10px 14px', border: '0.5px solid var(--ios-sep)' }}>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 8, color: 'var(--ios-label4)', marginBottom: 2 }}>5日勝率</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: winColor(batchStats.winRate) }}>{fmtRate(batchStats.winRate)}</div>
            </div>
            <div style={{ width: 0.5, background: 'var(--ios-sep)' }} />
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 8, color: 'var(--ios-label4)', marginBottom: 2 }}>均5日報</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: retColor(batchStats.avgR5d) }}>{fmtPct(batchStats.avgR5d)}</div>
            </div>
            <div style={{ width: 0.5, background: 'var(--ios-sep)' }} />
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 8, color: 'var(--ios-label4)', marginBottom: 2 }}>隔日勝率</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: winColor(batchStats.winRate1d) }}>{fmtRate(batchStats.winRate1d)}</div>
            </div>
            <div style={{ width: 0.5, background: 'var(--ios-sep)' }} />
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 8, color: 'var(--ios-label4)', marginBottom: 2 }}>均隔日報</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: retColor(batchStats.avgR1d) }}>{fmtPct(batchStats.avgR1d)}</div>
            </div>
            <div style={{ width: 0.5, background: 'var(--ios-sep)' }} />
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 8, color: 'var(--ios-label4)', marginBottom: 2 }}>精選檔數</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--ios-label)' }}>{batchStats.total}</div>
            </div>
          </div>
        </div>
      )}

      {/* Grade filter pills */}
      {!isViewingHistory && top20.some(s => s.grade) && (
        <div style={{ display: 'flex', gap: 5, marginBottom: 8, flexWrap: 'wrap' }}>
          {['A','B','C','D'].map(g => {
            const cfg = GRADE_CFG[g]
            const count = top20.filter(s => s.grade === g).length
            if (!count) return null
            const active = gradeFilter === g
            return (
              <button
                key={g}
                onClick={() => setGradeFilter(prev => prev === g ? null : g)}
                style={{
                  fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 9999, cursor: 'pointer',
                  border: active ? `1.5px solid ${cfg.color}` : `0.5px solid ${cfg.border}`,
                  background: active ? cfg.bg : 'transparent',
                  color: cfg.color, transition: 'all 0.15s',
                }}
              >{g} <span style={{ fontSize: 9, opacity: 0.7 }}>{count}</span></button>
            )
          })}
          {gradeFilter && (
            <button
              onClick={() => setGradeFilter(null)}
              style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 9999, cursor: 'pointer', border: '0.5px solid var(--ios-sep)', background: 'none', color: 'var(--ios-label3)' }}
            >全部</button>
          )}
        </div>
      )}

      {/* Stock cards */}
      <div ref={listRef} style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 18 }}>
        {displayStocks.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--ios-label3)', fontSize: 13, padding: '24px 0' }}>尚無精選資料</div>
        )}
        {displayStocks.map((s, i) => {
          const livePrice = showLive ? (livePrices[String(s.stock_id)]?.price ?? null) : null
          return (
            <div key={`${s.stock_id}-${i}`} className="stock-card" style={{ opacity: 0 }}>
              <StockCard
                stock={s}
                rank={i + 1}
                livePrice={livePrice}
                showLive={showLive}
                onClick={() => handleStockClick(s)}
              />
            </div>
          )
        })}
      </div>

      {/* ── 歷史驗證 ── */}
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ios-label)', marginBottom: 10, paddingTop: 4, borderTop: '0.5px solid var(--ios-sep)' }}>
        歷史驗證
      </div>

      {/* Summary stat cards */}
      <div ref={statsRef} style={{ display: 'flex', gap: 7, marginBottom: 12 }}>
        {[
          { label: '驗證批次', value: summary.scans || 0 },
          { label: '股次',     value: summary.total || 0 },
          { label: '歷史勝率', value: null, color: winColor(summary.winRate), ref: winRateRef },
          { label: '均5日報',  value: null, color: retColor(summary.avgR5),   ref: avgR5Ref },
        ].map(({ label, value, color, ref: elRef }) => (
          <div key={label} className="stat-block" style={{
            flex: 1, background: 'var(--ios-bg2)', borderRadius: 10,
            padding: '8px 6px', border: '0.5px solid var(--ios-sep)',
            textAlign: 'center', opacity: 0, overflow: 'hidden',
          }}>
            <div style={{ fontSize: 7, color: 'var(--ios-label4)', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
            {elRef ? (
              <div ref={elRef} style={{ fontSize: 13, fontWeight: 700, color: color || 'var(--ios-label)', lineHeight: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {label === '歷史勝率' ? fmtRate(summary.winRate) : fmtPct(summary.avgR5)}
              </div>
            ) : (
              <div style={{ fontSize: 13, fontWeight: 700, color: color || 'var(--ios-label)', lineHeight: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
            )}
          </div>
        ))}
      </div>

      {/* Per-date chart */}
      <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '12px 12px', marginBottom: 12, border: '0.5px solid var(--ios-sep)' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ios-label)', marginBottom: 7 }}>逐日均5日報酬</div>
        <DateBarChart byDate={byDate} byDate1d={byDate1d} sortedDates={sortedDates} />
        {!Object.keys(byDate).length && (
          <div style={{ textAlign: 'center', color: 'var(--ios-label3)', fontSize: 11, padding: '12px 0' }}>尚無資料</div>
        )}
      </div>

      {/* Grade breakdown */}
      <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '12px 12px', border: '0.5px solid var(--ios-sep)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ios-label)' }}>各等級勝率（5日）</span>
          <span style={{ marginLeft: 'auto', fontSize: 8, color: 'var(--ios-label4)' }}>勝率 / 均報酬</span>
        </div>
        {['A','B','C','D','X'].map(g => <GradeRow key={g} grade={g} stats={byGrade[g]} />)}
        {Object.keys(byGrade).length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--ios-label3)', fontSize: 11, padding: '8px 0' }}>尚無等級資料</div>
        )}
      </div>

      {/* Stock detail modal */}
      {selectedStock && (
        <StockDetailModal
          stock={selectedStock}
          onClose={() => setSelectedStock(null)}
          allScans={data?.scans}
        />
      )}

    </div>
  )
}
