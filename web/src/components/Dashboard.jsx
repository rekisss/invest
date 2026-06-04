import { useState, useMemo } from 'react'
import StockDetailModal from './StockDetailModal'

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

function WatchlistView({ stocks, onSelect, notionMap = {} }) {
  if (!stocks || stocks.length === 0) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>📭</div>
        <div style={{ color: 'var(--ios-label2)', fontSize: 15 }}>無資料</div>
      </div>
    )
  }

  const maxScore = Math.max(...stocks.map(s => s.entry_score || 0), 1)

  return (
    <div style={{ margin: '0 12px 16px' }}>
      <div style={{ background: 'var(--ios-bg2)', borderRadius: 16, overflow: 'hidden', border: '0.5px solid var(--ios-sep)', boxShadow: 'var(--shadow-card)' }}>
        {stocks.map((s, idx) => {
          const normScore = Math.min(Math.round((s.entry_score || 0) / maxScore * 100), 99)
          const isEntry = s.entry_signal
          const scoreColor = isEntry ? 'var(--ios-green)' : normScore >= 70 ? 'var(--ios-blue)' : 'var(--ios-label2)'
          const techDots = [
            (s.rsi14 || 0) > 50 && (s.rsi14 || 0) < 75,
            (s.adx14 || 0) > 20,
            (s.volume_ratio || 0) > 1.3,
            (s.adx14 || 0) > 27,
            (s.rsi14 || 0) > 60,
          ].filter(Boolean).length
          const chipDots = [
            (s.foreign_buy_streak || 0) >= 1,
            (s.foreign_buy_streak || 0) >= 2,
            (s.foreign_buy_streak || 0) >= 3,
            (s.invest_trust_streak || 0) >= 1,
            (s.invest_trust_streak || 0) >= 2,
          ].filter(Boolean).length

          return (
            <div
              key={s.stock_id}
              onClick={() => onSelect && onSelect(s)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px',
                borderBottom: idx < stocks.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
                background: isEntry ? 'rgba(34,197,94,0.04)' : 'transparent',
                cursor: 'pointer', transition: 'background 0.1s',
              }}
            >
              {/* Rank */}
              <div style={{ fontSize: 12, color: 'var(--ios-label4)', fontFamily: 'var(--font-mono)', minWidth: 20, textAlign: 'right' }}>{s.rank || idx + 1}</div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 5 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-blue)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{s.stock_id}</span>
                  <span style={{ fontSize: 13, color: 'var(--ios-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                  {notionMap[s.stock_id] && <span style={{ fontSize: 9, color: 'var(--ios-blue)', fontWeight: 700, flexShrink: 0 }}>N</span>}
                </div>
                {/* Score bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                  <div style={{ flex: 1, height: 3, background: 'var(--ios-fill2)', borderRadius: 9999 }}>
                    <div style={{ height: '100%', width: `${normScore}%`, background: `linear-gradient(90deg,${scoreColor === 'var(--ios-green)' ? '#22C55E' : scoreColor === 'var(--ios-blue)' ? '#3B82F6' : '#94A3B8'}70,${scoreColor === 'var(--ios-green)' ? '#22C55E' : scoreColor === 'var(--ios-blue)' ? '#3B82F6' : '#94A3B8'})`, borderRadius: 9999 }} />
                  </div>
                  <span style={{ fontSize: 11, color: scoreColor, fontWeight: 700, minWidth: 22, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{normScore}</span>
                </div>
                {/* Dots + close */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                    <span style={{ fontSize: 9, color: 'var(--ios-label3)', marginRight: 2 }}>技</span>
                    {[0,1,2,3,4].map(i => <div key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: i < techDots ? '#3B82F6' : 'var(--ios-bg4)' }} />)}
                  </div>
                  <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                    <span style={{ fontSize: 9, color: 'var(--ios-label3)', marginRight: 2 }}>籌</span>
                    {[0,1,2,3,4].map(i => <div key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: i < chipDots ? '#22C55E' : 'var(--ios-bg4)' }} />)}
                  </div>
                  {s.close != null && <span style={{ fontSize: 11, color: 'var(--ios-label3)', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>{s.close.toFixed(1)}</span>}
                </div>
              </div>

              {/* Signal */}
              {isEntry
                ? <span style={{ fontSize: 11, color: '#22C55E', fontWeight: 700, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.28)', borderRadius: 9999, padding: '4px 10px', whiteSpace: 'nowrap', flexShrink: 0 }}>進場</span>
                : <span style={{ fontSize: 11, color: '#3B82F6', fontWeight: 600, background: 'rgba(59,130,246,0.10)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 9999, padding: '4px 10px', whiteSpace: 'nowrap', flexShrink: 0 }}>觀察</span>
              }
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
      <div style={{
        background: 'var(--ios-bg2)', borderRadius: 16,
        overflow: 'hidden', boxShadow: 'var(--shadow-card)',
        border: '0.5px solid rgba(255,255,255,0.07)',
      }}>
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
  const notionMap = data?.notionMap || {}

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
  const pred = data.prediction || null
  const aiText = scan.ai_picks_text || ''
  const marginStats = scan.margin_stats || {}

  const viewOptions = [
    { id: 'all',       label: `全部` },
    { id: 'entry',     label: `進場 ${entryStocks.length > 0 ? `·${entryStocks.length}` : ''}` },
    { id: 'limitdown', label: `🔴 跌停` },
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

        {/* Segmented view selector */}
        <div style={{ marginTop: 10 }}>
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

        {/* Margin chip stats */}
        {(marginStats.clean_count > 0 || marginStats.surge_count > 0) && (
          <div style={{ margin: '10px 16px 0', padding: '10px 14px', background: 'var(--ios-bg2)', borderRadius: 12, display: 'flex', gap: 16, flexWrap: 'wrap', boxShadow: 'var(--shadow-card)' }}>
            {marginStats.clean_count > 0 && <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>📉 融資籌碼乾淨：<b style={{ color: 'var(--ios-green)' }}>{marginStats.clean_count}</b> 支</span>}
            {marginStats.surge_count > 0 && <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>⚠️ 融資暴增警告：<b style={{ color: 'var(--ios-red)' }}>{marginStats.surge_count}</b> 支</span>}
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
          {entryStocks.length > 0 && viewTab === 'all' && (
            <div style={{ padding: '0 20px 6px', fontSize: 12, fontWeight: 600, color: 'var(--ios-green)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
              進場訊號 · {entryStocks.length} 支
            </div>
          )}
          <WatchlistView
            stocks={viewTab === 'entry' ? entryStocks : viewTab === 'limitdown' ? limitDownAlerts : stocks}
            onSelect={setSelectedStock}
            notionMap={notionMap}
          />
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
      />
    </div>
  )
}
