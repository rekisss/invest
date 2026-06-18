import { useState, useMemo, useEffect } from 'react'
import StockDetailModal from './StockDetailModal'

const PAGE_SIZE = 50

const SORT_OPTIONS = [
  { value: 'entry_score',       label: '分數' },
  { value: 'market_rs_rank',    label: '市場RS' },
  { value: 'sector_rs_rank',    label: '類股RS' },
  { value: 'rsi14',             label: 'RSI' },
  { value: 'adx14',             label: 'ADX' },
  { value: 'volume_ratio',      label: '量比' },
  { value: 'foreign_buy_streak',label: '外資連買' },
  { value: 'close',             label: '收盤價' },
]

const SIGNAL_FILTERS = [
  { key: 'macd_golden_cross',    label: 'MACD金叉' },
  { key: 'kd_golden_cross',      label: 'KD金叉' },
  { key: 'foreign_buy_3d',       label: '外資連買' },
  { key: 'invest_trust_buy_2d',  label: '投信買超' },
  { key: 'above_ichimoku_cloud', label: '站上雲' },
  { key: 'bb_squeeze_breakout',  label: 'BB突破' },
  { key: 'adx_trending',         label: 'ADX趨勢' },
  { key: 'rsi_strong',           label: 'RSI強勢' },
]

const GRADE_STYLE = {
  A: { color: '#FFD60A', bg: 'rgba(255,214,10,0.15)',  border: 'rgba(255,214,10,0.35)' },
  B: { color: '#30D158', bg: 'rgba(48,209,88,0.13)',   border: 'rgba(48,209,88,0.32)' },
  C: { color: '#FF9F0A', bg: 'rgba(255,159,10,0.13)',  border: 'rgba(255,159,10,0.32)' },
  D: { color: '#94A3B8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.22)' },
  X: { color: '#FF453A', bg: 'rgba(255,69,58,0.13)',   border: 'rgba(255,69,58,0.32)' },
}

function GradeBadge({ grade }) {
  if (!grade) return null
  const g = GRADE_STYLE[grade] || GRADE_STYLE.D
  return (
    <span style={{
      fontSize: 11, fontWeight: 800, color: g.color,
      background: g.bg, border: `1px solid ${g.border}`,
      borderRadius: 6, padding: '1px 6px', flexShrink: 0, letterSpacing: 0.3,
    }}>{grade}</span>
  )
}

const BASE = import.meta.env.BASE_URL

/* ── Utility micro-components ────────────────────────────────────── */

function StatCard({ label, value, sub, color }) {
  const accents = {
    'var(--ios-green)':  { from: 'rgba(48,209,88,0.16)',  border: 'rgba(48,209,88,0.55)' },
    'var(--ios-red)':    { from: 'rgba(255,69,58,0.14)',  border: 'rgba(255,69,58,0.55)' },
    'var(--ios-blue)':   { from: 'rgba(10,132,255,0.14)', border: 'rgba(10,132,255,0.50)' },
    'var(--ios-yellow)': { from: 'rgba(255,214,10,0.13)', border: 'rgba(255,214,10,0.50)' },
  }
  const a = accents[color] || { from: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.09)' }
  return (
    <div style={{
      flex: 1, minWidth: 0,
      background: `linear-gradient(155deg, ${a.from} 0%, var(--ios-bg2) 62%)`,
      borderRadius: 16, padding: '14px 16px 12px',
      boxShadow: 'var(--shadow-card)',
      borderTop: `1.5px solid ${a.border}`,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.8px', color: color || 'var(--ios-label)', fontFamily: 'var(--font-mono)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

function SignalBadge({ entry_signal }) {
  if (!entry_signal) return <span style={{ color: 'var(--ios-label3)', fontSize: 13 }}>—</span>
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 20, height: 20, background: 'var(--ios-green)', borderRadius: '50%',
      color: '#fff', fontSize: 11, fontWeight: 700,
    }}>✓</span>
  )
}

function StreakBadge({ value }) {
  if (!value || value <= 0) return <span style={{ color: 'var(--ios-label3)', fontSize: 13 }}>—</span>
  const color = value >= 3 ? 'var(--ios-green)' : 'var(--ios-yellow)'
  return (
    <span style={{
      display: 'inline-block',
      background: value >= 3 ? 'rgba(48,209,88,0.15)' : 'rgba(255,214,10,0.15)',
      color, borderRadius: 6, padding: '1px 6px', fontSize: 12, fontWeight: 600,
    }}>{value}天</span>
  )
}

function ScoreCell({ score, entry_signal }) {
  const color = entry_signal ? 'var(--ios-green)' : score > 800 ? 'var(--ios-yellow)' : score > 400 ? 'var(--ios-label)' : 'var(--ios-label3)'
  return (
    <span style={{ color, fontWeight: entry_signal ? 700 : 500, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
      {score.toLocaleString()}
    </span>
  )
}

function WatchlistView({ stocks, onSelect, notionMap = {}, globalMaxScore, watchlist = new Set(), toggleWatchlist, persistentMap = {} }) {
  if (!stocks || stocks.length === 0) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>📭</div>
        <div style={{ color: 'var(--ios-label2)', fontSize: 15 }}>無資料</div>
      </div>
    )
  }

  const maxScore = globalMaxScore || Math.max(...stocks.map(s => s.entry_score || 0), 1)

  return (
    <div style={{ margin: '0 12px 16px' }}>
      <div className="glass-panel" style={{ overflow: 'hidden' }}>
        {stocks.map((s, idx) => {
          const normScore = Math.min(Math.round((s.entry_score || 0) / maxScore * 100), 99)
          const isEntry = s.entry_signal
          const rsi = s.rsi14 || 0
          const adx = s.adx14 || 0
          const vol = s.volume_ratio || 0
          const foreignStreak = s.foreign_buy_streak || 0
          const investStreak = s.invest_trust_streak || 0
          const grade = s.grade || ''
          const isSectorLeader = !!s.is_sector_leader
          const marketRsRank = s.market_rs_rank || 0
          const scorePct = s.score_pct || 0
          const scoreColor = isEntry ? '#30D158' : normScore >= 70 ? '#0A84FF' : '#94A3B8'
          const rsiColor = rsi > 65 ? '#30D158' : rsi < 40 ? '#FF453A' : '#94A3B8'
          const adxColor = adx > 25 ? '#5AC8FA' : '#94A3B8'
          const volColor = vol > 1.8 ? '#FF9F0A' : vol > 1.3 ? '#94A3B8' : '#475569'

          return (
            <div
              key={s.stock_id}
              className={`glass-row${isEntry ? ' glass-row--entry' : ''}`}
              onClick={() => onSelect && onSelect(s)}
              style={{
                padding: '10px 14px',
                borderBottom: idx < stocks.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
                cursor: 'pointer',
                animation: `rowIn 0.35s ${Math.min(idx * 30, 300)}ms cubic-bezier(0.22,1,0.36,1) both`,
              }}
            >
              {/* Row 1: ID + Name + Signal tag */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: 'var(--ios-label4)', fontFamily: 'var(--font-mono)', minWidth: 18 }}>
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-blue)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                  {s.stock_id}
                </span>
                <span style={{ fontSize: 13, color: 'var(--ios-label)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.name}
                  {notionMap[s.stock_id] && <span style={{ fontSize: 9, color: 'var(--ios-blue)', fontWeight: 700, marginLeft: 4 }}>N</span>}
                </span>
                <GradeBadge grade={grade} />
                {scorePct >= 90 && (
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#FFD60A', background: 'rgba(255,214,10,0.12)', borderRadius: 5, padding: '1px 5px', flexShrink: 0, letterSpacing: 0.2 }}>
                    前{Math.max(1, Math.round(100 - scorePct))}%
                  </span>
                )}
                {isEntry
                  ? <span style={{ fontSize: 10, fontWeight: 700, color: '#30D158', background: 'rgba(48,209,88,0.14)', border: '1px solid rgba(34,197,94,0.28)', borderRadius: 9999, padding: '2px 8px', flexShrink: 0 }}>進場</span>
                  : <span style={{ fontSize: 10, fontWeight: 600, color: '#0A84FF', background: 'rgba(10,132,255,0.12)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 9999, padding: '2px 8px', flexShrink: 0 }}>觀察</span>
                }
                <button
                  onClick={e => { e.stopPropagation(); toggleWatchlist && toggleWatchlist(s.stock_id) }}
                  style={{
                    background: 'none', border: 'none', padding: '0 2px',
                    cursor: 'pointer', flexShrink: 0, lineHeight: 1,
                    color: watchlist.has(s.stock_id) ? '#FFD60A' : 'var(--ios-label4)',
                    fontSize: 15, transition: 'color 0.15s',
                  }}
                  title={watchlist.has(s.stock_id) ? '移出自選股' : '加入自選股'}
                >
                  {watchlist.has(s.stock_id) ? '★' : '☆'}
                </button>
              </div>

              {/* Row 2: Score bar + score + sparkline + price */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ flex: 1, height: 4, background: 'var(--ios-fill2)', borderRadius: 9999, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${normScore}%`,
                    background: `linear-gradient(90deg,${scoreColor}60,${scoreColor})`,
                    borderRadius: 9999,
                    transition: 'width 0.7s cubic-bezier(0.34,1.56,0.64,1)',
                  }} />
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: scoreColor, fontFamily: 'var(--font-mono)', minWidth: 24, textAlign: 'right' }}>{normScore}</span>
                <Sparkline data={s.price_history} />
                {s.close != null && (
                  <span style={{ fontSize: 12, color: 'var(--ios-label3)', fontFamily: 'var(--font-mono)' }}>
                    {s.close > 100 ? s.close.toFixed(0) : s.close.toFixed(1)}
                  </span>
                )}
              </div>

              {/* Row 3: Real indicator numbers */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'nowrap', overflow: 'hidden' }}>
                <span style={{ fontSize: 11, color: rsiColor, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                  RSI <strong>{rsi.toFixed(0)}</strong>
                </span>
                <span style={{ fontSize: 11, color: adxColor, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                  ADX <strong>{adx.toFixed(0)}</strong>
                </span>
                {vol > 0 && (
                  <span style={{ fontSize: 11, color: volColor, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    量 <strong>{vol.toFixed(1)}x</strong>
                  </span>
                )}
                {foreignStreak > 0 && (
                  <span style={{ fontSize: 11, color: '#30D158', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    外+<strong>{foreignStreak}</strong>天{s.foreign_buy_accel ? <span style={{ fontSize: 9, color: 'var(--ios-orange)', fontWeight: 700 }}>↑</span> : null}
                  </span>
                )}
                {investStreak > 0 && (
                  <span style={{ fontSize: 11, color: '#BF5AF2', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    投+<strong>{investStreak}</strong>天{s.invest_trust_accel ? <span style={{ fontSize: 9, color: 'var(--ios-orange)', fontWeight: 700 }}>↑</span> : null}
                  </span>
                )}
                {marketRsRank > 0 && (
                  <span style={{ fontSize: 11, color: marketRsRank >= 90 ? '#FFD60A' : '#64748B', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    RS<strong>{Math.round(marketRsRank)}</strong>
                  </span>
                )}
                {isSectorLeader && (
                  <span style={{ fontSize: 11, color: '#FFD60A', whiteSpace: 'nowrap' }}>⭐旗手</span>
                )}
                {(persistentMap[s.stock_id] || 0) >= 2 && (
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ios-green)', background: 'rgba(48,209,88,0.13)', borderRadius: 5, padding: '1px 5px', whiteSpace: 'nowrap', flexShrink: 0 }} title="近14天入榜次數">
                    📅{persistentMap[s.stock_id]}次
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Feature 1: Sparkline ────────────────────────────────────────── */
function Sparkline({ data, width = 56, height = 20 }) {
  if (!data || data.length < 2) return null
  const closes = data.map(p => p.close).filter(v => v != null)
  if (closes.length < 2) return null
  const min = Math.min(...closes), max = Math.max(...closes)
  const range = max - min || 1
  const pts = closes.map((c, i) => {
    const x = (i / (closes.length - 1)) * width
    const y = height - ((c - min) / range) * (height - 3) - 1.5
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const isUp = closes[closes.length - 1] >= closes[0]
  const color = isUp ? '#30D158' : '#FF453A'
  return (
    <svg width={width} height={height} style={{ flexShrink: 0, opacity: 0.85 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={closes.map((_, i) => (i / (closes.length - 1)) * width).pop().toFixed(1)} cy={(height - ((closes[closes.length - 1] - min) / range) * (height - 3) - 1.5).toFixed(1)} r="2" fill={color} />
    </svg>
  )
}

/* ── Feature 3: Sector Heatmap ───────────────────────────────────── */
function SectorHeatmap({ stocks }) {
  const sectors = useMemo(() => {
    const map = {}
    for (const s of stocks) {
      const sec = s.industry_category || '其他'
      if (!map[sec]) map[sec] = { count: 0, entries: 0, totalScore: 0 }
      map[sec].count++
      if (s.entry_signal) map[sec].entries++
      map[sec].totalScore += s.entry_score || 0
    }
    return Object.entries(map)
      .map(([name, d]) => ({ name, ...d, entryRate: Math.round(d.entries / d.count * 100) }))
      .sort((a, b) => b.entries - a.entries || b.entryRate - a.entryRate)
      .slice(0, 30)
  }, [stocks])

  if (sectors.length === 0) return null
  const maxEntries = Math.max(...sectors.map(s => s.entries), 1)

  return (
    <div style={{ padding: '12px 16px 8px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 10 }}>
        🌡 族群輪動熱圖
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {sectors.map(sec => {
          const intensity = sec.entries / maxEntries
          const r = Math.round(48 + intensity * (48 - 48))
          const g = Math.round(209 * intensity)
          const b = Math.round(88 * intensity)
          const bg = sec.entries > 0
            ? `rgba(${48 + Math.round(intensity * 20)},${Math.round(209 * intensity)},${Math.round(88 * intensity)},${0.10 + intensity * 0.25})`
            : 'rgba(148,163,184,0.07)'
          const textColor = sec.entries > 0
            ? (intensity > 0.5 ? '#30D158' : '#A8D8B9')
            : 'var(--ios-label3)'
          const borderColor = sec.entries > 0
            ? `rgba(48,209,88,${0.15 + intensity * 0.4})`
            : 'var(--ios-sep)'
          return (
            <div key={sec.name} style={{
              padding: '6px 10px', borderRadius: 10,
              background: bg, border: `0.5px solid ${borderColor}`,
              display: 'flex', flexDirection: 'column', gap: 2, minWidth: 80,
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: textColor, lineHeight: 1.3, letterSpacing: '-0.1px' }}>
                {sec.name.length > 6 ? sec.name.slice(0, 6) + '…' : sec.name}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                {sec.entries > 0 && (
                  <span style={{ fontSize: 10, color: '#30D158', fontWeight: 700 }}>↑{sec.entries}</span>
                )}
                <span style={{ fontSize: 10, color: 'var(--ios-label4)' }}>{sec.count}支</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function calcDropStreak(priceHistory) {
  if (!priceHistory || priceHistory.length < 2) return 0
  let streak = 0
  for (let i = priceHistory.length - 1; i > 0; i--) {
    if (priceHistory[i].close < priceHistory[i - 1].close) streak++
    else break
  }
  return streak
}

function AlertTable({ title, accentColor, stocks, columns, onSelect }) {
  if (!stocks || stocks.length === 0) return null
  return (
    <div style={{ margin: '0 16px 20px' }}>
      <div style={{
        fontSize: 13, fontWeight: 600, color: accentColor,
        padding: '0 4px 8px', display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {title}
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ios-label2)', background: 'var(--ios-bg3)', borderRadius: 10, padding: '1px 7px' }}>
          {stocks.length}
        </span>
      </div>
      <div className="glass-panel" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="ios-table" style={{ minWidth: 400 }}>
            <thead>
              <tr style={{ background: `${accentColor}10` }}>
                {columns.map(c => (
                  <th key={c.key} style={{ color: accentColor, opacity: 0.8 }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stocks.map((s, i) => (
                <tr key={s.stock_id || i}
                  onClick={() => onSelect && onSelect(s)}
                  style={{ cursor: onSelect ? 'pointer' : 'default' }}
                >
                  {columns.map(c => <td key={c.key}>{c.render(s, i)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function ConsecutiveDropSection({ stocks, onSelect }) {
  const droppers = (stocks || [])
    .map(s => ({ ...s, _drop: calcDropStreak(s.price_history) }))
    .filter(s => s._drop >= 2)
    .sort((a, b) => b._drop - a._drop)

  const cols = [
    { key: 'stock_id', label: '股號', render: s => <span style={{ color: 'var(--ios-orange)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{s.stock_id}</span> },
    { key: 'name',     label: '名稱', render: s => <span style={{ fontSize: 13 }}>{s.name}</span> },
    { key: 'close',    label: '收盤', render: s => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{s.close?.toFixed(2)}</span> },
    { key: 'drop',     label: '連跌', render: s => (
      <span style={{
        background: s._drop >= 6 ? '#431407' : s._drop >= 4 ? '#9a3412' : 'rgba(255,159,10,0.2)',
        color: s._drop >= 4 ? '#fff' : 'var(--ios-orange)',
        borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12,
      }}>↓{s._drop}天</span>
    )},
    { key: 'pct', label: '漲跌%', render: s => {
      const ph = s.price_history || []
      const last = ph[ph.length - 1], prev = ph[ph.length - 2]
      const pct = last && prev && prev.close ? ((last.close - prev.close) / prev.close * 100).toFixed(2) : null
      return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--ios-orange)' }}>{pct != null ? `${pct}%` : '—'}</span>
    }},
    { key: 'industry', label: '產業', render: s => <span style={{ color: 'var(--ios-label2)', fontSize: 12 }}>{s.industry_category || '—'}</span> },
  ]

  return <AlertTable title="📉 連跌警示" accentColor="var(--ios-orange)" stocks={droppers} columns={cols} onSelect={onSelect} />
}

function LimitDownSection({ items, onSelect }) {
  const cols = [
    { key: 'stock_id', label: '股號', render: s => <span style={{ color: 'var(--ios-red)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{s.stock_id}</span> },
    { key: 'name',     label: '名稱', render: s => <span style={{ fontSize: 13 }}>{s.name}</span> },
    { key: 'close',    label: '收盤', render: s => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{s.close?.toFixed(2)}</span> },
    { key: 'streak',   label: '連跌天', render: s => (
      <span style={{
        background: s.limit_down_streak >= 5 ? '#7f1d1d' : 'rgba(255,69,58,0.18)',
        color: s.limit_down_streak >= 5 ? '#fff' : 'var(--ios-red)',
        borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12,
      }}>↓{s.limit_down_streak}天</span>
    )},
    { key: 'industry', label: '產業', render: s => <span style={{ color: 'var(--ios-label2)', fontSize: 12 }}>{s.industry_category || '—'}</span> },
  ]
  return <AlertTable title="🔴 連續跌停警示（≥3天）" accentColor="var(--ios-red)" stocks={items} columns={cols} onSelect={onSelect} />
}

function PersistentSection({ items, onSelect }) {
  const cols = [
    { key: 'stock_id',    label: '股號',  render: s => <span style={{ color: 'var(--ios-blue)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{s.stock_id}</span> },
    { key: 'name',        label: '名稱',  render: s => <span style={{ fontSize: 13 }}>{s.name}</span> },
    { key: 'days_in_top', label: '天數',  render: s => (
      <span style={{ color: s.days_in_top >= 5 ? 'var(--ios-green)' : s.days_in_top >= 3 ? 'var(--ios-yellow)' : 'var(--ios-label)', fontWeight: 700, fontSize: 13 }}>{s.days_in_top}天</span>
    )},
    { key: 'score',       label: '最新分', render: s => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{s.latest_score?.toLocaleString()}</span> },
    { key: 'trend',       label: '分數趨勢', render: s => (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: s.score_trend > 0 ? 'var(--ios-green)' : s.score_trend < 0 ? 'var(--ios-red)' : 'var(--ios-label2)' }}>
        {s.score_trend > 0 ? '+' : ''}{s.score_trend}
      </span>
    )},
  ]
  return <AlertTable title="📅 跨日持續強勢（近14天 TOP 50）" accentColor="var(--ios-blue)" stocks={items} columns={cols} onSelect={onSelect} />
}

/* ── Outcome Stats Panel ─────────────────────────────────────────── */
function OutcomeStatsPanel({ outcomeStats }) {
  if (!outcomeStats) return null
  const grades = ['A', 'B', 'C', 'D']
  const hasData = grades.some(g => (outcomeStats[g]?.total || 0) >= 10)
  if (!hasData) return null

  return (
    <div style={{
      margin: '10px 16px 0',
      background: 'var(--ios-bg2)',
      borderRadius: 16, padding: '14px 16px',
      boxShadow: 'var(--shadow-card)',
      border: '0.5px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        📊 系統勝率驗證（5日後實際表現）
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {grades.map(g => {
          const st = outcomeStats[g] || {}
          const wr = st.win_rate
          const enough = (st.total || 0) >= 10
          const gStyle = GRADE_STYLE[g] || GRADE_STYLE.D
          const wr_color = !enough ? 'var(--ios-label3)' : wr >= 55 ? 'var(--ios-green)' : wr >= 45 ? 'var(--ios-yellow)' : 'var(--ios-red)'
          return (
            <div key={g} style={{
              flex: 1, background: 'rgba(255,255,255,0.03)',
              borderRadius: 12, padding: '10px 8px', textAlign: 'center',
              border: `0.5px solid ${gStyle.border}`,
            }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: gStyle.color, marginBottom: 5 }}>{g}</div>
              <div style={{ fontSize: 19, fontWeight: 700, color: wr_color, fontFamily: 'var(--font-mono)', lineHeight: 1 }}>
                {enough ? `${wr}%` : '—'}
              </div>
              {enough && st.avg_return_pct != null && (
                <div style={{ fontSize: 10, color: st.avg_return_pct >= 0 ? 'var(--ios-green)' : 'var(--ios-red)', marginTop: 3 }}>
                  均{st.avg_return_pct >= 0 ? '+' : ''}{st.avg_return_pct}%
                </div>
              )}
              <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 2 }}>
                {enough ? `${st.total}筆` : '資料不足'}
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 8, textAlign: 'right' }}>
        基於歷史掃描交叉驗算（入場後第5個交易日收盤）
      </div>
    </div>
  )
}

/* ── Daily Action Panel ──────────────────────────────────────────── */
function DataQualityPanel({ dq }) {
  const [open, setOpen] = useState(false)
  if (!dq) return null
  const fresh = dq.is_fresh
  const statusColor = fresh ? 'var(--ios-green)' : 'var(--ios-orange)'
  const statusBg = fresh ? 'rgba(48,209,88,0.10)' : 'rgba(255,159,10,0.10)'
  const statusBorder = fresh ? 'rgba(48,209,88,0.28)' : 'rgba(255,159,10,0.3)'
  const checks = [
    {
      label: '資料新鮮度',
      ok: fresh,
      detail: fresh
        ? `最新資料 ${dq.latest_data_date}（T+${dq.days_behind ?? 0}，正常延遲）`
        : `資料落後 ${dq.days_behind} 個交易日（${dq.latest_data_date}）`,
    },
    {
      label: '股票數量',
      ok: (dq.total_stocks || 0) >= 1000,
      detail: `掃描 ${(dq.total_stocks || 0).toLocaleString()} 支`,
    },
    {
      label: '欄位完整性',
      ok: dq.fields_ok !== false,
      detail: dq.top_valid_ratio != null
        ? `指標欄位有效率 ${dq.top_valid_ratio}%`
        : '無 TOP 股票資料',
    },
    {
      label: '建置時間',
      ok: true,
      detail: dq.build_time
        ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(dq.build_time)) + ' CST'
        : '未知',
    },
  ]
  const allOk = checks.every(c => c.ok !== false)

  return (
    <div style={{ margin: '10px 16px 0' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', background: statusBg, border: `0.5px solid ${statusBorder}`,
          borderRadius: 12, padding: '9px 14px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: statusColor }}>
          {allOk ? '✓' : '⚠'} 資料驗證
        </span>
        <span style={{ fontSize: 12, color: statusColor, flex: 1, textAlign: 'left' }}>
          {fresh ? `正常 · 最新 ${dq.latest_data_date}` : `延遲 T+${dq.days_behind} · ${dq.latest_data_date}`}
        </span>
        <span style={{ fontSize: 12, color: 'var(--ios-label3)', fontFamily: 'var(--font-mono)' }}>
          {(dq.total_stocks || 0).toLocaleString()} 支
        </span>
        <span style={{ fontSize: 11, color: 'var(--ios-label3)' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          marginTop: 4, background: 'var(--ios-bg2)', borderRadius: 12,
          border: '0.5px solid var(--ios-sep)', overflow: 'hidden',
        }}>
          {checks.map((c, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 14px',
              borderBottom: i < checks.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
            }}>
              <span style={{ fontSize: 13, color: c.ok !== false ? 'var(--ios-green)' : 'var(--ios-orange)', flexShrink: 0 }}>
                {c.ok !== false ? '✓' : '⚠'}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-label)', minWidth: 72 }}>{c.label}</span>
              <span style={{ fontSize: 12, color: 'var(--ios-label2)', flex: 1 }}>{c.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DailyActionPanel({ scan, prevScan, persistent }) {
  if (!scan) return null
  const stocks = scan.top_stocks || []

  const prevIds = new Set((prevScan?.top_stocks || []).map(s => s.stock_id))
  const newAGrade = stocks.filter(s => s.grade === 'A' && !prevIds.has(s.stock_id)).slice(0, 5)
  const multiDay = (persistent || []).filter(p => p.days_in_top >= 3).slice(0, 5)
  const decayWarnings = stocks.filter(s => s.momentum_decay_signal && s.entry_signal).slice(0, 3)

  if (newAGrade.length === 0 && multiDay.length === 0 && decayWarnings.length === 0) return null

  return (
    <div style={{
      margin: '10px 16px 0',
      background: 'linear-gradient(135deg, rgba(10,132,255,0.08) 0%, var(--ios-bg2) 65%)',
      borderRadius: 16, padding: '14px 16px',
      boxShadow: 'var(--shadow-card)',
      borderLeft: '3px solid var(--ios-blue)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-blue)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        🎯 今日行動重點
      </div>

      {newAGrade.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-yellow)', marginBottom: 4 }}>✦ 新進 A 級候選</div>
          {newAGrade.map(s => (
            <div key={s.stock_id} style={{ fontSize: 13, color: 'var(--ios-label)', marginLeft: 12, lineHeight: 2 }}>
              <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{s.stock_id}</b>
              {' '}{s.name}
              {s.expected_hold_days > 0 && (
                <span style={{ color: 'var(--ios-label3)', fontSize: 11 }}> · 預估持股 {s.expected_hold_days} 天</span>
              )}
              {s.entry_reason && (
                <span style={{ color: 'var(--ios-label3)', fontSize: 11 }}> · {s.entry_reason.split(';')[0]}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {multiDay.length > 0 && (
        <div style={{ marginBottom: decayWarnings.length > 0 ? 8 : 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-green)', marginBottom: 4 }}>↗ 持續強勢（{multiDay.length} 支連續入榜）</div>
          {multiDay.map(s => (
            <div key={s.stock_id} style={{ fontSize: 13, color: 'var(--ios-label)', marginLeft: 12, lineHeight: 2 }}>
              <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{s.stock_id}</b>
              {' '}{s.name}
              <span style={{ color: 'var(--ios-green)', fontWeight: 600 }}> {s.days_in_top}天</span>
              {s.score_trend > 0 && <span style={{ color: 'var(--ios-green)', fontSize: 11 }}> ↑分數持續上升</span>}
              {s.score_trend < -50 && <span style={{ color: 'var(--ios-yellow)', fontSize: 11 }}> ↓分數滑落，留意出場</span>}
            </div>
          ))}
        </div>
      )}

      {decayWarnings.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-red)', marginBottom: 4 }}>⚠ 動能衰退留意</div>
          {decayWarnings.map(s => (
            <div key={s.stock_id} style={{ fontSize: 13, color: 'var(--ios-label3)', marginLeft: 12, lineHeight: 2 }}>
              {s.stock_id} {s.name} — 5日動能高於2日均值，趨勢可能減速
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Main Component ──────────────────────────────────────────────── */
export default function Dashboard({ data, error }) {
  const sortedDates = useMemo(
    () => [...(data?.dates || [])].sort((a, b) => b.localeCompare(a)),
    [data?.dates]
  )
  const [selectedDate, setSelectedDate] = useState(() => {
    if (!data?.dates?.length) return null
    const sorted = [...data.dates].sort((a, b) => b.localeCompare(a))
    const todayTW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
    return sorted.includes(todayTW) ? todayTW : (sorted[0] || null)
  })
  const [selectedStock, setSelectedStock] = useState(null)
  const [viewTab, setViewTab] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortField, setSortField] = useState('entry_score')
  const [sortDir, setSortDir] = useState('desc')
  const [page, setPage] = useState(0)
  const notionMap = data?.notionMap || {}

  const [watchlist, setWatchlist] = useState(() => {
    try {
      const saved = localStorage.getItem('stock_watchlist')
      return new Set(saved ? JSON.parse(saved) : [])
    } catch { return new Set() }
  })
  const toggleWatchlist = (stock_id) => {
    setWatchlist(prev => {
      const next = new Set(prev)
      if (next.has(stock_id)) next.delete(stock_id)
      else next.add(stock_id)
      try { localStorage.setItem('stock_watchlist', JSON.stringify([...next])) } catch {}
      return next
    })
  }
  const [activeSignals, setActiveSignals] = useState(new Set())
  const toggleSignal = (key) => {
    setActiveSignals(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (error || !data || !data.dates || data.dates.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 4 }}>📭</div>
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ios-label)' }}>尚無掃描資料</div>
        <div style={{ fontSize: 14, color: 'var(--ios-label2)', maxWidth: 260, lineHeight: 1.5 }}>等待 GitHub Actions 完成掃描後自動更新</div>
        {error && <div style={{ fontSize: 12, color: 'var(--ios-red)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>錯誤：{error}</div>}
      </div>
    )
  }

  const scan = data.scans[selectedDate] || {}
  const stocks = scan.top_stocks || []
  const persistent = scan.persistent || []
  const limitDownAlerts = scan.limit_down_alerts || []
  const entryStocks = stocks.filter(s => s.entry_signal)
  const globalMaxScore = Math.max(...stocks.map(s => s.entry_score || 0), 1)
  const pred = data.prediction || null
  const aiText = scan.ai_picks_text || ''
  const aggLatest = data?.aggregateLatest
  const calendarRisk = scan.calendar_risk || (aggLatest?.date === selectedDate ? aggLatest.calendar_risk : '') || ''
  const marginStats = scan.margin_stats || {}
  const outcomeStats = data.outcomeStats || null
  const prevDateIdx = sortedDates.indexOf(selectedDate)
  const prevScan = prevDateIdx >= 0 && prevDateIdx + 1 < sortedDates.length
    ? (data.scans[sortedDates[prevDateIdx + 1]] || null)
    : null

  const watchlistStocks = useMemo(() => stocks.filter(s => watchlist.has(s.stock_id)), [stocks, watchlist])
  const persistentMap = useMemo(() => {
    const m = {}
    ;(persistent || []).forEach(p => { m[p.stock_id] = p.days_in_top })
    return m
  }, [persistent])

  // Reset page whenever filters or tab/date change
  useEffect(() => { setPage(0) }, [viewTab, searchQuery, sortField, sortDir, selectedDate, activeSignals])

  const baseStocks = viewTab === 'entry' ? entryStocks : viewTab === 'limitdown' ? limitDownAlerts : viewTab === 'watchlist' ? watchlistStocks : viewTab === 'heatmap' ? [] : stocks

  const filteredAndSorted = useMemo(() => {
    let list = baseStocks
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      list = list.filter(s =>
        String(s.stock_id).includes(q) ||
        (s.name || '').toLowerCase().includes(q)
      )
    }
    if (activeSignals.size > 0 && viewTab !== 'limitdown') {
      list = list.filter(s => [...activeSignals].every(key => !!s[key]))
    }
    return [...list].sort((a, b) => {
      const va = a[sortField] ?? -Infinity
      const vb = b[sortField] ?? -Infinity
      return sortDir === 'desc' ? vb - va : va - vb
    })
  }, [baseStocks, searchQuery, sortField, sortDir, activeSignals])

  const totalPages = Math.ceil(filteredAndSorted.length / PAGE_SIZE)
  const pagedStocks = filteredAndSorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const viewOptions = [
    { id: 'all',       label: `全部` },
    { id: 'entry',     label: `進場${entryStocks.length > 0 ? ` ·${entryStocks.length}` : ''}` },
    { id: 'watchlist', label: `⭐${watchlist.size > 0 ? ` ·${watchlist.size}` : ''}` },
    { id: 'limitdown', label: `🔴 跌停` },
    { id: 'heatmap',   label: `🌡 族群` },
  ]

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Controls Header ──────────────────────────────────────── */}
      <div style={{
        padding: '8px 16px 12px',
        background: 'linear-gradient(180deg, rgba(28,28,30,0.90) 0%, var(--ios-bg) 100%)',
        borderBottom: '0.5px solid var(--ios-sep)',
        flexShrink: 0,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      }}>
        {/* Date selector + download row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <select
            value={selectedDate || ''}
            onChange={e => setSelectedDate(e.target.value)}
            style={{
              flex: 1, background: 'var(--ios-bg3)', border: 'none', color: 'var(--ios-label)',
              borderRadius: 10, padding: '8px 12px', fontSize: 14, cursor: 'pointer',
              WebkitAppearance: 'none', appearance: 'none',
            }}
          >
            {sortedDates.map(d => {
              const s = data.scans[d]
              const partial = s?.is_partial ? ' ⚠' : ''
              return <option key={d} value={d}>{d}（{s?.total_scanned ?? 0} 支）{partial}</option>
            })}
          </select>
          <a
            href={`${BASE}downloads/scan_${selectedDate}_top50.csv`} download
            style={{
              background: 'var(--ios-bg3)', color: 'var(--ios-label2)', borderRadius: 10,
              padding: '8px 12px', fontSize: 13, textDecoration: 'none', whiteSpace: 'nowrap',
            }}
          >↓ TOP50</a>
          <a
            href={`${BASE}downloads/scan_${selectedDate}_all.csv`} download
            style={{
              background: 'rgba(10,132,255,0.12)', color: 'var(--ios-blue)', borderRadius: 10,
              padding: '8px 12px', fontSize: 13, textDecoration: 'none', whiteSpace: 'nowrap', fontWeight: 600,
            }}
          >↓ 全部</a>
        </div>

        {/* Scan execution date hint + data quality badge */}
        {(data.last_scan_exec_date || data.generated_at || data.dataQuality) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingRight: 2, marginBottom: 4, flexWrap: 'wrap' }}>
            {data.dataQuality && (() => {
              const dq = data.dataQuality
              const fresh = dq.is_fresh
              return (
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 9999,
                  background: fresh ? 'rgba(48,209,88,0.12)' : 'rgba(255,159,10,0.12)',
                  color: fresh ? 'var(--ios-green)' : 'var(--ios-orange)',
                  border: `0.5px solid ${fresh ? 'rgba(48,209,88,0.3)' : 'rgba(255,159,10,0.35)'}`,
                  flexShrink: 0,
                }}>
                  {fresh ? '✓ 資料正常' : `⚠ 資料T+${dq.days_behind}`}
                </span>
              )
            })()}
            <div style={{ fontSize: 11, color: 'var(--ios-label3)', flex: 1, textAlign: 'right' }}>
              {data.last_scan_exec_date && `掃描 ${data.last_scan_exec_date}`}
              {(() => {
                const dd = scan.data_date
                if (dd && dd !== selectedDate) return ` · 資料日 ${dd.slice(5)}`
                return null
              })()}
              {data.generated_at && ` · 建置 ${new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(data.generated_at))} CST`}
            </div>
          </div>
        )}

        {/* Search + Sort row */}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <input
            type="search"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="🔍 搜尋股號/名稱…"
            style={{
              flex: 1, background: 'var(--ios-bg3)', border: 'none', color: 'var(--ios-label)',
              borderRadius: 10, padding: '7px 12px', fontSize: 13, outline: 'none',
              WebkitAppearance: 'none',
            }}
          />
          <select
            value={sortField}
            onChange={e => setSortField(e.target.value)}
            style={{
              background: 'var(--ios-bg3)', border: 'none', color: 'var(--ios-label2)',
              borderRadius: 10, padding: '7px 10px', fontSize: 12, cursor: 'pointer',
              WebkitAppearance: 'none', appearance: 'none', flexShrink: 0,
            }}
          >
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button
            onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
            style={{
              background: 'var(--ios-bg3)', border: 'none', color: 'var(--ios-label2)',
              borderRadius: 10, padding: '7px 10px', fontSize: 13, cursor: 'pointer', flexShrink: 0,
            }}
          >{sortDir === 'desc' ? '↓' : '↑'}</button>
        </div>

        {/* Segmented view selector */}
        <div style={{ marginTop: 8 }}>
          <div className="ios-segmented">
            {viewOptions.map(v => (
              <button
                key={v.id}
                className={`ios-seg-btn${viewTab === v.id ? ' active' : ''}`}
                onClick={() => setViewTab(v.id)}
                style={{ fontSize: 12 }}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>

        {/* Signal filter chips */}
        {viewTab !== 'limitdown' && (
          <div style={{ marginTop: 8, display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none' }}>
            {SIGNAL_FILTERS.map(f => {
              const isActive = activeSignals.has(f.key)
              return (
                <button
                  key={f.key}
                  onClick={() => toggleSignal(f.key)}
                  style={{
                    flexShrink: 0, fontSize: 11, fontWeight: 600,
                    padding: '4px 10px', borderRadius: 9999, cursor: 'pointer',
                    border: isActive ? '1px solid var(--ios-green)' : '1px solid rgba(255,255,255,0.1)',
                    background: isActive ? 'rgba(48,209,88,0.15)' : 'var(--ios-bg3)',
                    color: isActive ? 'var(--ios-green)' : 'var(--ios-label3)',
                    transition: 'all 0.15s',
                  }}
                >
                  {isActive ? '✓ ' : ''}{f.label}
                </button>
              )
            })}
            {activeSignals.size > 0 && (
              <button
                onClick={() => setActiveSignals(new Set())}
                style={{
                  flexShrink: 0, fontSize: 11, padding: '4px 10px', borderRadius: 9999,
                  border: '1px solid rgba(255,69,58,0.3)', background: 'rgba(255,69,58,0.08)',
                  color: 'var(--ios-red)', cursor: 'pointer', fontWeight: 600,
                }}
              >✕ 清除</button>
            )}
          </div>
        )}
      </div>

      {/* ── Scrollable Content ───────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>

        {/* Market summary banner */}
        {pred && (() => {
          const isBull = pred.xgb_label === '偏多', isBear = pred.xgb_label === '偏空'
          const pColor = isBull ? '#30D158' : isBear ? '#FF453A' : '#0A84FF'
          return (
          <div style={{
            margin: '12px 16px 0',
            background: `linear-gradient(135deg, ${pColor}13 0%, var(--ios-bg2) 55%)`,
            borderRadius: 16,
            padding: '14px 16px',
            boxShadow: `var(--shadow-card), inset 0 0 0 0.5px ${pColor}28`,
            borderLeft: `3px solid ${pColor}`,
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 15, fontWeight: 600,
                color: pred.xgb_label === '偏多' ? 'var(--ios-green)' : pred.xgb_label === '偏空' ? 'var(--ios-red)' : 'var(--ios-label)',
              }}>
                {pred.xgb_label === '偏多' ? '📈' : pred.xgb_label === '偏空' ? '📉' : '➡️'} 大盤預測 {Math.round((pred.xgb_prob_up || 0) * 100)}% 上漲
              </span>
              {pred.regime?.label_zh && (
                <span style={{
                  fontSize: 12, color: 'var(--ios-blue)',
                  background: 'rgba(10,132,255,0.12)', borderRadius: 8, padding: '2px 8px', fontWeight: 600,
                }}>{pred.regime.label_zh}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {pred.market_data?.vix != null && <span style={{ fontSize: 12, color: 'var(--ios-label2)' }}>VIX <b style={{ color: 'var(--ios-label)' }}>{pred.market_data.vix}</b></span>}
              {pred.market_data?.futures_net != null && <span style={{ fontSize: 12, color: pred.market_data.futures_net < 0 ? 'var(--ios-green)' : 'var(--ios-red)' }}>外資期貨 {pred.market_data.futures_net?.toLocaleString()}口</span>}
              {pred.market_data?.night_change != null && <span style={{ fontSize: 12, color: pred.market_data.night_change > 0 ? 'var(--ios-green)' : 'var(--ios-red)' }}>夜盤 {pred.market_data.night_change > 0 ? '+' : ''}{pred.market_data.night_change}pt</span>}
            </div>
            {pred.scenario?.main_scenario && (
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--ios-label2)', lineHeight: 1.5, borderTop: '0.5px solid var(--ios-sep)', paddingTop: 8 }}>
                <b style={{ color: 'var(--ios-label)', fontWeight: 600 }}>主力劇本 </b>{pred.scenario.main_scenario}
              </div>
            )}
            {pred.scenario?.best_strategy && (
              <div style={{ fontSize: 12, color: 'var(--ios-green)', marginTop: 4 }}>
                最佳策略：{pred.scenario.best_strategy}
              </div>
            )}
            {pred.scenario?.forbidden_actions?.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--ios-red)', marginTop: 3 }}>
                🚫 {pred.scenario.forbidden_actions.join(' · ')}
              </div>
            )}
          </div>
          )
        })()}

        {/* AI picks */}
        {aiText && (
          <div style={{
            margin: '10px 16px 0',
            background: 'linear-gradient(135deg, rgba(191,90,242,0.10) 0%, var(--ios-bg2) 55%)',
            borderRadius: 16,
            padding: '14px 16px',
            boxShadow: 'var(--shadow-card)',
            border: '0.5px solid rgba(191,90,242,0.22)',
            borderLeft: '3px solid var(--ios-purple)',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ios-purple)', marginBottom: 8, letterSpacing: 0.3, textTransform: 'uppercase' }}>🤖 AI 精選推薦</div>
            <pre style={{ fontSize: 13, color: 'var(--ios-label)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'inherit', lineHeight: 1.65 }}>{aiText}</pre>
          </div>
        )}

        {/* Data quality verification panel */}
        <DataQualityPanel dq={data.dataQuality} />

        {/* Outcome stats + daily action panels */}
        <OutcomeStatsPanel outcomeStats={outcomeStats} />
        <DailyActionPanel scan={scan} prevScan={prevScan} persistent={persistent} />

        {/* Margin chip stats */}
        {(marginStats.clean_count > 0 || marginStats.surge_count > 0) && (
          <div style={{ margin: '10px 16px 0', padding: '10px 14px', background: 'var(--ios-bg2)', borderRadius: 12, display: 'flex', gap: 16, flexWrap: 'wrap', boxShadow: 'var(--shadow-card)' }}>
            {marginStats.clean_count > 0 && <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>📉 融資籌碼乾淨：<b style={{ color: 'var(--ios-green)' }}>{marginStats.clean_count}</b> 支</span>}
            {marginStats.surge_count > 0 && <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>⚠️ 融資暴增警告：<b style={{ color: 'var(--ios-red)' }}>{marginStats.surge_count}</b> 支</span>}
          </div>
        )}

        {/* Calendar risk notice */}
        {calendarRisk && (
          <div style={{ margin: '8px 16px 0', padding: '8px 12px', background: 'rgba(255,159,10,0.08)', borderRadius: 10, borderLeft: '3px solid var(--ios-orange)' }}>
            <span style={{ fontSize: 13, color: 'var(--ios-orange)' }}>📅 {calendarRisk}</span>
          </div>
        )}

        {/* Status notes */}
        {scan.is_partial && (
          <div style={{ margin: '8px 16px 0', padding: '8px 12px', background: 'rgba(255,214,10,0.08)', borderRadius: 10, borderLeft: '3px solid var(--ios-yellow)' }}>
            <span style={{ fontSize: 13, color: 'var(--ios-yellow)' }}>⚠ 部分掃描（{scan.total_scanned} 支），完整結果待更新</span>
          </div>
        )}
        {scan.from_notion_fallback && (
          <div style={{ margin: '8px 16px 0', padding: '8px 12px', background: 'rgba(10,132,255,0.07)', borderRadius: 10, borderLeft: '3px solid var(--ios-blue)' }}>
            <span style={{ fontSize: 12, color: 'var(--ios-blue)' }}>ℹ 顯示最近 Notion 完整掃描（今日尚未完成）</span>
          </div>
        )}

        {/* Main stock table */}
        <div style={{ marginTop: 12 }}>
          <div style={{ padding: '0 20px 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
            {entryStocks.length > 0 && viewTab === 'all' && !searchQuery && (
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-green)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                進場訊號 · {entryStocks.length} 支
              </span>
            )}
            {searchQuery && (
              <span style={{ fontSize: 12, color: 'var(--ios-label3)' }}>
                找到 {filteredAndSorted.length} 支
              </span>
            )}
          </div>
          {viewTab === 'heatmap' ? (
            <SectorHeatmap stocks={stocks} />
          ) : viewTab === 'watchlist' && watchlistStocks.length === 0 ? (
            <div style={{ padding: '48px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>☆</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ios-label)', marginBottom: 6 }}>尚無自選股</div>
              <div style={{ fontSize: 13, color: 'var(--ios-label3)' }}>點選股票列右側的 ☆ 即可加入</div>
            </div>
          ) : (
            <WatchlistView
              stocks={pagedStocks}
              globalMaxScore={globalMaxScore}
              onSelect={setSelectedStock}
              notionMap={notionMap}
              watchlist={watchlist}
              toggleWatchlist={toggleWatchlist}
              persistentMap={persistentMap}
            />
          )}
          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '12px 20px 4px' }}>
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                style={{
                  background: page === 0 ? 'var(--ios-fill2)' : 'var(--ios-blue)',
                  color: page === 0 ? 'var(--ios-label3)' : '#fff',
                  border: 'none', borderRadius: 9999, padding: '6px 16px', fontSize: 13, cursor: page === 0 ? 'default' : 'pointer',
                }}
              >上一頁</button>
              <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                style={{
                  background: page >= totalPages - 1 ? 'var(--ios-fill2)' : 'var(--ios-blue)',
                  color: page >= totalPages - 1 ? 'var(--ios-label3)' : '#fff',
                  border: 'none', borderRadius: 9999, padding: '6px 16px', fontSize: 13, cursor: page >= totalPages - 1 ? 'default' : 'pointer',
                }}
              >下一頁</button>
            </div>
          )}
        </div>

        {/* Secondary sections */}
        {persistent.length > 0 && (
          <PersistentSection
            items={persistent}
            onSelect={item => {
              const full = stocks.find(s => s.stock_id === item.stock_id)
              setSelectedStock(full || { stock_id: item.stock_id, name: item.name, industry_category: item.industry_category || '', entry_score: item.latest_score || 0, price_history: item.price_history || [], condition_count: 0, entry_signal: false })
            }}
          />
        )}

        {limitDownAlerts.length > 0 && (
          <LimitDownSection items={limitDownAlerts} onSelect={setSelectedStock} />
        )}

        <ConsecutiveDropSection stocks={stocks} onSelect={setSelectedStock} />

        <div style={{ padding: '12px 20px 24px', fontSize: 12, color: 'var(--ios-label3)', textAlign: 'center' }}>
          點擊任一列查看詳細資料與 K 線圖
        </div>
      </div>

      <StockDetailModal
        stock={selectedStock}
        notionInfo={selectedStock ? notionMap[selectedStock.stock_id] : null}
        onClose={() => setSelectedStock(null)}
        allScans={data?.scans}
      />
    </div>
  )
}
