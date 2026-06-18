import { useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react'
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

const GRADE_FILTERS = ['A', 'B', 'C', 'D']

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
          const entryReason = s.entry_reason || ''
          const rs5d = s.relative_strength_5d || 0
          const marginChg = s.margin_change_5d || 0
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
                {rs5d > 0.01 && (
                  <span style={{ fontSize: 11, color: rs5d > 0.05 ? '#30D158' : '#94A3B8', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    RS <strong>+{(rs5d * 100).toFixed(1)}%</strong>
                  </span>
                )}
                {Math.abs(marginChg) >= 1 && (
                  <span style={{ fontSize: 11, color: marginChg < -1 ? '#30D158' : '#FF453A', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    融{marginChg > 0 ? '↑' : '↓'}{Math.abs(marginChg).toFixed(1)}%
                  </span>
                )}
              </div>
              {/* Entry reason (4th row — only when non-empty) */}
              {entryReason && (
                <div style={{ marginTop: 4, fontSize: 10, color: 'var(--ios-label3)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  💡 {entryReason.split(';').slice(0, 2).join(' · ')}
                </div>
              )}
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

/* ── Strategy Accuracy Panel: score-rank buckets vs baseline ──────── */
function StrategyAccuracyPanel({ accuracy }) {
  if (!accuracy) return null
  const horizons = accuracy.horizons || [1, 5, 10]
  // Require a meaningful sample at the 5-day horizon for the top bucket
  if (!(accuracy.top10?.d5?.total >= 20)) return null

  const rows = [
    { key: 'top10', label: '高分前10%', color: 'var(--ios-blue)' },
    { key: 'top25', label: '高分前25%', color: 'var(--ios-teal)' },
    { key: 'baseline', label: '全市場均值', color: 'var(--ios-label3)' },
  ]
  const fmtPct = v => (v == null ? '—' : `${v}%`)
  const cell = (v) => {
    if (v?.win_rate == null) return { wr: '—', ret: null, color: 'var(--ios-label3)' }
    const c = v.win_rate >= 55 ? 'var(--ios-green)' : v.win_rate >= 45 ? 'var(--ios-yellow)' : 'var(--ios-red)'
    return { wr: `${v.win_rate}%`, ret: v.avg_return_pct, color: c }
  }

  return (
    <div style={{
      margin: '10px 16px 0',
      background: 'var(--ios-bg2)',
      borderRadius: 16, padding: '14px 16px',
      boxShadow: 'var(--shadow-card)',
      border: '0.5px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        🎯 評分預測力驗證（高分股 vs 全市場）
      </div>
      {/* header row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr repeat(3, 1fr)', gap: 6, fontSize: 10, color: 'var(--ios-label3)', marginBottom: 6 }}>
        <div />
        {horizons.map(h => <div key={h} style={{ textAlign: 'center', fontWeight: 700 }}>{h}日後</div>)}
      </div>
      {rows.map(r => (
        <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '1.2fr repeat(3, 1fr)', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: r.color }}>{r.label}</div>
          {horizons.map(h => {
            const c = cell(accuracy[r.key]?.[`d${h}`])
            return (
              <div key={h} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 9, padding: '6px 4px', textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: c.color, fontFamily: 'var(--font-mono)', lineHeight: 1 }}>{c.wr}</div>
                {c.ret != null && (
                  <div style={{ fontSize: 9, color: c.ret >= 0 ? 'var(--ios-green)' : 'var(--ios-red)', marginTop: 2 }}>
                    {c.ret >= 0 ? '+' : ''}{c.ret}%
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 6, lineHeight: 1.5 }}>
        勝率＝N日後收盤上漲比例；下方為平均報酬。若高分股勝率與報酬持續高於全市場均值，代表評分有預測力。樣本取自近期歷史掃描，期間有限僅供參考。
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
      label: '法人資料',
      ok: dq.institutional_ok !== false,
      detail: dq.institutional_ok === false
        ? `三大法人尚未公布（僅 ${dq.institutional_ratio ?? 0}% 有資料）· 排名暫以技術面為主`
        : dq.institutional_ratio != null
          ? `外資／投信資料完整（${dq.institutional_ratio}%）`
          : '無法人資料',
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

/* ── Institutional money-flow leaderboard ────────────────────────── */
function InstitutionalLeaderboard({ stocks, onSelect }) {
  const ranked = useMemo(() => {
    return (stocks || [])
      .map(s => {
        const f = Math.max(0, s.foreign_buy_streak || 0)
        const t = Math.max(0, s.invest_trust_streak || 0)
        const d = Math.max(0, s.dealer_buy_streak || 0)
        // Taiwan convention: 投信 (trust) tends to lead short-term momentum,
        // 外資 (foreign) confirms trend, 自營 (dealer) is noisiest.
        let flow = f * 1.0 + t * 1.4 + d * 0.6
        if (s.foreign_buy_accel) flow += 2
        if (s.invest_trust_accel) flow += 2.5
        return { ...s, _flow: flow, _f: f, _t: t, _d: d }
      })
      .filter(s => s._flow > 0)
      .sort((a, b) => b._flow - a._flow)
      .slice(0, 8)
  }, [stocks])
  if (ranked.length === 0) return null

  const Chip = ({ n, label, color, accel }) => n <= 0 ? null : (
    <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}1A`, borderRadius: 5, padding: '1px 5px', whiteSpace: 'nowrap' }}>
      {label}{n}{accel ? '↑' : ''}
    </span>
  )

  return (
    <div style={{ margin: '10px 16px 0', background: 'var(--ios-bg2)', borderRadius: 16, padding: '14px 16px', boxShadow: 'var(--shadow-card)', border: '0.5px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        🏦 法人籌碼集中排行（連買強度）
      </div>
      {ranked.map((s, i) => (
        <div key={s.stock_id} onClick={() => onSelect?.(s)} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0',
          borderBottom: i < ranked.length - 1 ? '0.5px solid var(--ios-sep)' : 'none', cursor: 'pointer',
        }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: i < 3 ? 'var(--ios-yellow)' : 'var(--ios-label3)', width: 16, textAlign: 'center', flexShrink: 0 }}>{i + 1}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ios-label)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.stock_id} <span style={{ color: 'var(--ios-label2)', fontWeight: 400 }}>{s.name}</span>
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
              <Chip n={s._f} label="外" color="var(--ios-red)" accel={s.foreign_buy_accel} />
              <Chip n={s._t} label="投" color="var(--ios-orange)" accel={s.invest_trust_accel} />
              <Chip n={s._d} label="自" color="var(--ios-blue)" />
            </div>
          </div>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-teal)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{s._flow.toFixed(1)}</span>
        </div>
      ))}
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 8, lineHeight: 1.5 }}>
        強度＝外資連買×1.0＋投信×1.4＋自營×0.6，加速另計。數字越高代表法人買盤越集中、越持續。
      </div>
    </div>
  )
}

/* ── Sector rotation tracker (cross-date) ────────────────────────── */
function SectorRotationTracker({ scans, dates }) {
  const data = useMemo(() => {
    const recent = (dates || []).slice(0, 5)           // desc: [today, ..., 4d ago]
    if (recent.length < 2) return null
    // count per sector per date among that date's top stocks
    const perDate = recent.map(d => {
      const counts = {}
      for (const s of (scans?.[d]?.top_stocks || [])) {
        const sec = s.industry_category || '其他'
        counts[sec] = (counts[sec] || 0) + 1
      }
      return counts
    })
    const today = perDate[0], prev = perDate[1]
    const allSecs = new Set()
    perDate.forEach(c => Object.keys(c).forEach(k => allSecs.add(k)))
    const rows = [...allSecs].map(sec => {
      const series = perDate.map(c => c[sec] || 0).reverse()  // ascending in time
      return { sec, today: today[sec] || 0, delta: (today[sec] || 0) - (prev[sec] || 0), series }
    })
    .filter(r => r.today > 0)
    .sort((a, b) => b.today - a.today || b.delta - a.delta)
    .slice(0, 8)
    const maxCount = Math.max(...rows.map(r => Math.max(...r.series)), 1)
    return { rows, maxCount, span: recent.length }
  }, [scans, dates])
  if (!data) return null

  return (
    <div style={{ margin: '10px 16px 0', background: 'var(--ios-bg2)', borderRadius: 16, padding: '14px 16px', boxShadow: 'var(--shadow-card)', border: '0.5px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        🔄 產業輪動追蹤（近 {data.span} 個交易日入榜家數）
      </div>
      {data.rows.map((r, i) => {
        const arrow = r.delta > 0 ? '▲' : r.delta < 0 ? '▼' : '—'
        const aColor = r.delta > 0 ? 'var(--ios-green)' : r.delta < 0 ? 'var(--ios-red)' : 'var(--ios-label3)'
        return (
          <div key={r.sec} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: i < data.rows.length - 1 ? '0.5px solid var(--ios-sep)' : 'none' }}>
            <span style={{ fontSize: 12, color: 'var(--ios-label2)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.sec}</span>
            {/* mini bar trend */}
            <span style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 18, flexShrink: 0 }}>
              {r.series.map((v, j) => (
                <span key={j} style={{
                  width: 4, height: `${Math.max(2, (v / data.maxCount) * 18)}px`,
                  background: j === r.series.length - 1 ? 'var(--ios-teal)' : 'var(--ios-fill3)', borderRadius: 1,
                }} />
              ))}
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-label)', fontFamily: 'var(--font-mono)', width: 22, textAlign: 'right', flexShrink: 0 }}>{r.today}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: aColor, width: 30, textAlign: 'right', flexShrink: 0 }}>
              {arrow}{r.delta !== 0 ? Math.abs(r.delta) : ''}
            </span>
          </div>
        )
      })}
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 8, lineHeight: 1.5 }}>
        家數＝該產業有幾支進入當日強勢榜。▲ 表示比前一日增加（資金流入升溫），▼ 表示退燒。
      </div>
    </div>
  )
}

/* ── Simple strategy backtest simulator (interactive) ────────────── */
function BacktestSimulator({ accuracy }) {
  const [bucket, setBucket] = useState('top10')
  const [horizon, setHorizon] = useState(5)
  if (!accuracy) return null
  const horizons = accuracy.horizons || [1, 5, 10]
  if (!(accuracy.top10?.d5?.total >= 20)) return null

  const buckets = [
    { key: 'top10', label: '高分前10%' },
    { key: 'top25', label: '高分前25%' },
    { key: 'baseline', label: '全市場' },
  ]
  const cur = accuracy[bucket]?.[`d${horizon}`] || {}
  const base = accuracy.baseline?.[`d${horizon}`] || {}
  const avg = cur.avg_return_pct
  const wr = cur.win_rate
  const total = cur.total || 0
  const edge = (avg != null && base.avg_return_pct != null) ? avg - base.avg_return_pct : null
  // illustrative compounding over 20 independent trades
  const compounded = avg != null ? ((Math.pow(1 + avg / 100, 20) - 1) * 100) : null

  const btn = (active) => ({
    flex: 1, padding: '6px 4px', fontSize: 11, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
    border: '0.5px solid ' + (active ? 'var(--ios-blue)' : 'transparent'),
    background: active ? 'rgba(10,132,255,0.15)' : 'var(--ios-fill4)',
    color: active ? 'var(--ios-blue)' : 'var(--ios-label3)', transition: 'all 0.15s',
  })

  return (
    <div style={{ margin: '10px 16px 0', background: 'var(--ios-bg2)', borderRadius: 16, padding: '14px 16px', boxShadow: 'var(--shadow-card)', border: '0.5px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        🧪 策略回測試算
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {buckets.map(b => (
          <button key={b.key} style={btn(bucket === b.key)} onClick={() => setBucket(b.key)}>{b.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {horizons.map(h => (
          <button key={h} style={btn(horizon === h)} onClick={() => setHorizon(h)}>持有{h}日</button>
        ))}
      </div>
      {total < 10 ? (
        <div style={{ fontSize: 12, color: 'var(--ios-label3)', textAlign: 'center', padding: '8px 0' }}>此組合樣本不足</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '10px 6px', textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 4 }}>平均報酬</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: avg >= 0 ? 'var(--ios-green)' : 'var(--ios-red)', lineHeight: 1 }}>
                {avg >= 0 ? '+' : ''}{avg}%
              </div>
            </div>
            <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '10px 6px', textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 4 }}>勝率</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: wr >= 55 ? 'var(--ios-green)' : wr >= 45 ? 'var(--ios-yellow)' : 'var(--ios-red)', lineHeight: 1 }}>{wr}%</div>
            </div>
            <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '10px 6px', textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 4 }}>超額報酬</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: edge == null ? 'var(--ios-label3)' : edge >= 0 ? 'var(--ios-green)' : 'var(--ios-red)', lineHeight: 1 }}>
                {edge == null ? '—' : `${edge >= 0 ? '+' : ''}${edge.toFixed(2)}%`}
              </div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginTop: 10, lineHeight: 1.6 }}>
            每次買進<b style={{ color: 'var(--ios-label)' }}>{buckets.find(b => b.key === bucket).label}</b>並持有 <b style={{ color: 'var(--ios-label)' }}>{horizon}</b> 個交易日，
            單筆平均 <b style={{ color: avg >= 0 ? 'var(--ios-green)' : 'var(--ios-red)' }}>{avg >= 0 ? '+' : ''}{avg}%</b>
            {compounded != null && <>；若連續操作 20 次（複利示意）約 <b style={{ color: compounded >= 0 ? 'var(--ios-green)' : 'var(--ios-red)' }}>{compounded >= 0 ? '+' : ''}{compounded.toFixed(0)}%</b></>}。
            <span style={{ color: 'var(--ios-label3)' }}>　樣本 {total} 筆，未計手續費／滑價，僅供參考。</span>
          </div>
        </>
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
  // Proportional scroll collapse: scroll position directly maps to collapse progress.
  // Uses requestAnimationFrame + direct DOM style mutation — no React state re-render.
  const headerInnerRef = useRef(null)
  const maxCollapseHeightRef = useRef(null)
  const scrollRafRef = useRef(null)
  const COLLAPSE_RANGE = 90 // px of scroll → fully collapsed

  // Measure once on mount and whenever content-affecting filters change
  useLayoutEffect(() => {
    const el = headerInnerRef.current
    if (!el) return
    el.style.height = 'auto'
    const h = el.scrollHeight
    maxCollapseHeightRef.current = h
    el.style.height = h + 'px'
  }, [viewTab]) // re-measure when tab changes (grade row shows/hides)

  // RAF cleanup
  useEffect(() => () => { if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current) }, [])

  const handleListScroll = (e) => {
    const scrollTop = e.currentTarget.scrollTop
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      const el = headerInnerRef.current
      if (!el) return
      if (scrollTop <= 2) {
        // Back at top — re-measure in case content changed
        el.style.height = 'auto'
        const h = el.scrollHeight
        maxCollapseHeightRef.current = h
        el.style.height = h + 'px'
        el.style.opacity = '1'
        el.style.pointerEvents = 'auto'
        return
      }
      if (maxCollapseHeightRef.current == null) {
        maxCollapseHeightRef.current = el.scrollHeight
      }
      const progress = Math.min(1, scrollTop / COLLAPSE_RANGE)
      el.style.height = `${maxCollapseHeightRef.current * (1 - progress)}px`
      el.style.opacity = `${Math.max(0, 1 - progress * 1.5)}`
      el.style.pointerEvents = progress > 0.9 ? 'none' : 'auto'
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
  const [activeGrades, setActiveGrades] = useState(new Set())
  const toggleGrade = (g) => {
    setActiveGrades(prev => {
      const next = new Set(prev)
      if (next.has(g)) next.delete(g)
      else next.add(g)
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
  useEffect(() => { setPage(0) }, [viewTab, searchQuery, sortField, sortDir, selectedDate, activeSignals, activeGrades])

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
    if (activeGrades.size > 0 && viewTab !== 'limitdown') {
      list = list.filter(s => activeGrades.has(s.grade || 'D'))
    }
    return [...list].sort((a, b) => {
      const va = a[sortField] ?? -Infinity
      const vb = b[sortField] ?? -Infinity
      return sortDir === 'desc' ? vb - va : va - vb
    })
  }, [baseStocks, searchQuery, sortField, sortDir, activeSignals, activeGrades])

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

        {/* Collapsible secondary controls — height tied directly to scroll progress via JS */}
        <div
          ref={headerInnerRef}
          style={{ overflow: 'hidden', willChange: 'height, opacity' }}
        >
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

        {/* Grade filter chips */}
        {viewTab !== 'limitdown' && (
          <div style={{ marginTop: 8, display: 'flex', gap: 5, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, flexShrink: 0 }}>評級</span>
            {GRADE_FILTERS.map(g => {
              const isActive = activeGrades.has(g)
              const gs = GRADE_STYLE[g]
              return (
                <button key={g} onClick={() => toggleGrade(g)} style={{
                  flexShrink: 0, fontSize: 11, fontWeight: 800,
                  padding: '3px 9px', borderRadius: 9999, cursor: 'pointer',
                  border: `1px solid ${isActive ? gs.border : 'rgba(255,255,255,0.08)'}`,
                  background: isActive ? gs.bg : 'var(--ios-bg3)',
                  color: isActive ? gs.color : 'var(--ios-label3)',
                  transition: 'all 0.15s',
                }}>{g}</button>
              )
            })}
            {activeGrades.size > 0 && (
              <button onClick={() => setActiveGrades(new Set())} style={{
                flexShrink: 0, fontSize: 10, padding: '3px 8px', borderRadius: 9999,
                border: '1px solid rgba(255,69,58,0.3)', background: 'rgba(255,69,58,0.08)',
                color: 'var(--ios-red)', cursor: 'pointer', fontWeight: 600,
              }}>✕</button>
            )}
          </div>
        )}

        {/* Signal filter chips */}
        {viewTab !== 'limitdown' && (
          <div style={{ marginTop: 6, display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none' }}>
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
        </div>{/* /collapsible secondary controls */}
      </div>

      {/* ── Scrollable Content ───────────────────────────────────── */}
      <div onScroll={handleListScroll} style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>

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
        <StrategyAccuracyPanel accuracy={data.strategyAccuracy} />
        <BacktestSimulator accuracy={data.strategyAccuracy} />
        <InstitutionalLeaderboard stocks={stocks} onSelect={setSelectedStock} />
        <SectorRotationTracker scans={data.scans} dates={sortedDates} />
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
        {data.dataQuality?.institutional_ok === false && !scan.is_partial && (
          <div style={{ margin: '8px 16px 0', padding: '8px 12px', background: 'rgba(255,159,10,0.08)', borderRadius: 10, borderLeft: '3px solid var(--ios-orange)' }}>
            <span style={{ fontSize: 12.5, color: 'var(--ios-orange)' }}>
              ⚠ 三大法人資料尚未公布（盤後約 15:00 後更新），目前排名暫以技術面為主，外資／投信加分未計入，分數與名次會在法人資料更新後重排
            </span>
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
