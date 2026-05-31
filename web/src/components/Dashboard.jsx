import { useState } from 'react'
import StockDetailModal from './StockDetailModal'

const BASE = import.meta.env.BASE_URL  // '/invest/' on GitHub Pages, '/' in dev

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '12px 16px',
      minWidth: 0,
      flex: 1,
    }}>
      <div style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || 'var(--text)', fontFamily: 'var(--font-mono)' }}>{value}</div>
      {sub && <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function SignalBadge({ entry_signal }) {
  return entry_signal
    ? <span style={{ color: 'var(--green)', fontWeight: 700, fontSize: 13 }}>✓</span>
    : <span style={{ color: 'var(--muted)', fontSize: 13 }}>—</span>
}

function StreakBadge({ value }) {
  if (!value || value <= 0) return <span style={{ color: 'var(--muted)' }}>—</span>
  const color = value >= 3 ? 'var(--green)' : value >= 1 ? 'var(--yellow)' : 'var(--muted)'
  return <span style={{ color, fontWeight: value >= 3 ? 700 : 400 }}>{value}天</span>
}

function ScoreCell({ score, entry_signal }) {
  const color = entry_signal ? 'var(--green)' : score > 800 ? 'var(--yellow)' : score > 400 ? 'var(--text)' : 'var(--muted)'
  return <span style={{ color, fontWeight: entry_signal ? 700 : 400, fontFamily: 'var(--font-mono)' }}>{score.toLocaleString()}</span>
}

function StockTable({ stocks, onSelect, notionMap = {} }) {
  if (!stocks || stocks.length === 0) {
    return <div style={{ color: 'var(--muted)', padding: 24, textAlign: 'center' }}>無資料</div>
  }

  const cols = [
    { key: 'rank', label: '#', width: 36 },
    { key: 'stock_id', label: '股號', width: 60 },
    { key: 'name', label: '名稱', width: 80 },
    { key: 'entry_score', label: '分數', width: 72 },
    { key: 'entry_signal', label: '進場', width: 44 },
    { key: 'close', label: '收盤', width: 60 },
    { key: 'rsi14', label: 'RSI', width: 48 },
    { key: 'adx14', label: 'ADX', width: 48 },
    { key: 'volume_ratio', label: '量比', width: 48 },
    { key: 'foreign_buy_streak', label: '外資', width: 48 },
    { key: 'invest_trust_streak', label: '投信', width: 48 },
    { key: 'notion', label: 'N', width: 24 },
  ]

  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 560 }}>
        <thead>
          <tr style={{ background: 'var(--surface2)', position: 'sticky', top: 0 }}>
            {cols.map(c => (
              <th key={c.key} style={{
                padding: '8px 6px', textAlign: c.key === 'name' ? 'left' : 'center',
                color: 'var(--muted)', fontWeight: 600, fontSize: 11,
                width: c.width, whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)',
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stocks.map(s => (
            <tr
              key={s.stock_id}
              onClick={() => onSelect && onSelect(s)}
              style={{
                borderBottom: '1px solid var(--border)',
                background: s.entry_signal ? 'rgba(63,185,80,0.06)' : 'transparent',
                cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(96,165,250,0.07)' }}
              onMouseLeave={e => { e.currentTarget.style.background = s.entry_signal ? 'rgba(63,185,80,0.06)' : 'transparent' }}
            >
              <td style={{ padding: '7px 6px', textAlign: 'center', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{s.rank}</td>
              <td style={{ padding: '7px 6px', textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--accent)' }}>{s.stock_id}</td>
              <td style={{ padding: '7px 6px', textAlign: 'left', maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</td>
              <td style={{ padding: '7px 6px', textAlign: 'center' }}><ScoreCell score={s.entry_score} entry_signal={s.entry_signal} /></td>
              <td style={{ padding: '7px 6px', textAlign: 'center' }}><SignalBadge entry_signal={s.entry_signal} /></td>
              <td style={{ padding: '7px 6px', textAlign: 'center', fontFamily: 'var(--font-mono)' }}>{s.close.toFixed(1)}</td>
              <td style={{ padding: '7px 6px', textAlign: 'center', color: s.rsi14 > 70 ? 'var(--red)' : s.rsi14 < 30 ? 'var(--green)' : 'var(--text)', fontFamily: 'var(--font-mono)' }}>{s.rsi14.toFixed(0)}</td>
              <td style={{ padding: '7px 6px', textAlign: 'center', color: s.adx14 > 25 ? 'var(--yellow)' : 'var(--text)', fontFamily: 'var(--font-mono)' }}>{s.adx14.toFixed(0)}</td>
              <td style={{ padding: '7px 6px', textAlign: 'center', color: s.volume_ratio > 2 ? 'var(--orange)' : 'var(--text)', fontFamily: 'var(--font-mono)' }}>{s.volume_ratio.toFixed(1)}x</td>
              <td style={{ padding: '7px 6px', textAlign: 'center' }}><StreakBadge value={s.foreign_buy_streak} /></td>
              <td style={{ padding: '7px 6px', textAlign: 'center' }}><StreakBadge value={s.invest_trust_streak} /></td>
              <td style={{ padding: '7px 6px', textAlign: 'center' }}>
                {notionMap[s.stock_id] && (
                  <span title={notionMap[s.stock_id].type || 'Notion'} style={{ fontSize: 10, color: '#60a5fa' }}>N</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

function ConsecutiveDropSection({ stocks, onSelect }) {
  const droppers = (stocks || [])
    .map(s => ({ ...s, _drop: calcDropStreak(s.price_history) }))
    .filter(s => s._drop >= 2)
    .sort((a, b) => b._drop - a._drop)

  if (droppers.length === 0) return null

  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: '#fb923c', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        📉 連跌警示（K線連續收低）
        <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)', marginLeft: 4 }}>共 {droppers.length} 支</span>
      </h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 480 }}>
          <thead>
            <tr style={{ background: 'rgba(251,146,60,0.08)' }}>
              {['股號', '名稱', '收盤', '連跌天數', '最新漲跌%', '入場分數', '產業'].map(h => (
                <th key={h} style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--muted)', fontSize: 11, borderBottom: '1px solid var(--border)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {droppers.map((s, i) => {
              const ph = s.price_history || []
              const last = ph[ph.length - 1]
              const prev = ph[ph.length - 2]
              const dayPct = last && prev && prev.close ? ((last.close - prev.close) / prev.close * 100).toFixed(2) : null
              const bgColor = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'
              return (
                <tr
                  key={s.stock_id}
                  onClick={() => onSelect && onSelect(s)}
                  style={{ borderBottom: '1px solid var(--border)', background: bgColor, cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(251,146,60,0.1)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = bgColor }}
                >
                  <td style={{ padding: '7px 8px', textAlign: 'center', fontFamily: 'var(--font-mono)', color: '#fb923c', fontWeight: 600 }}>{s.stock_id}</td>
                  <td style={{ padding: '7px 8px', textAlign: 'center', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</td>
                  <td style={{ padding: '7px 8px', textAlign: 'center', fontFamily: 'var(--font-mono)' }}>{s.close?.toFixed(2)}</td>
                  <td style={{ padding: '7px 8px', textAlign: 'center' }}>
                    <span style={{
                      color: '#fff',
                      background: s._drop >= 6 ? '#431407' : s._drop >= 4 ? '#9a3412' : '#c2410c',
                      borderRadius: 4, padding: '2px 8px', fontWeight: 700, fontSize: 12, fontFamily: 'var(--font-mono)',
                    }}>↓{s._drop}天</span>
                  </td>
                  <td style={{ padding: '7px 8px', textAlign: 'center', fontFamily: 'var(--font-mono)', color: '#fb923c' }}>
                    {dayPct != null ? `${dayPct}%` : '—'}
                  </td>
                  <td style={{ padding: '7px 8px', textAlign: 'center', fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>
                    {s.entry_score?.toLocaleString() ?? '—'}
                  </td>
                  <td style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--muted)', fontSize: 11 }}>{s.industry_category || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function LimitDownSection({ items, onSelect }) {
  if (!items || items.length === 0) return null
  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--red)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        🔴 連續跌停警示（≥3天）
        <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)', marginLeft: 4 }}>共 {items.length} 支</span>
      </h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 400 }}>
          <thead>
            <tr style={{ background: 'rgba(239,68,68,0.08)' }}>
              {['股號', '名稱', '收盤', '連跌天數', '產業'].map(h => (
                <th key={h} style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--muted)', fontSize: 11, borderBottom: '1px solid var(--border)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((s, i) => (
              <tr
                key={s.stock_id}
                onClick={() => onSelect && onSelect(s)}
                style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)', cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.1)' }}
                onMouseLeave={e => { e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}
              >
                <td style={{ padding: '7px 8px', textAlign: 'center', fontFamily: 'var(--font-mono)', color: 'var(--red)', fontWeight: 600 }}>{s.stock_id}</td>
                <td style={{ padding: '7px 8px', textAlign: 'center' }}>{s.name}</td>
                <td style={{ padding: '7px 8px', textAlign: 'center', fontFamily: 'var(--font-mono)' }}>{s.close?.toFixed(2)}</td>
                <td style={{ padding: '7px 8px', textAlign: 'center' }}>
                  <span style={{
                    color: '#fff',
                    background: s.limit_down_streak >= 5 ? '#7f1d1d' : s.limit_down_streak >= 4 ? '#b91c1c' : '#ef4444',
                    borderRadius: 4, padding: '2px 8px', fontWeight: 700, fontSize: 12, fontFamily: 'var(--font-mono)',
                  }}>↓{s.limit_down_streak}天</span>
                </td>
                <td style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--muted)', fontSize: 11 }}>{s.industry_category || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PersistentSection({ items, onSelect }) {
  if (!items || items.length === 0) return null
  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        📅 跨日持續強勢（近14天 TOP 50）
        {onSelect && <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--muted)' }}>點擊查看K線</span>}
      </h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 400 }}>
          <thead>
            <tr style={{ background: 'var(--surface2)' }}>
              {['股號', '名稱', '連續天數', '最新分數', '分數趨勢'].map(h => (
                <th key={h} style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--muted)', fontSize: 11, borderBottom: '1px solid var(--border)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((s, i) => {
              const bg = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'
              return (
                <tr
                  key={s.stock_id}
                  onClick={() => onSelect && onSelect(s)}
                  style={{ borderBottom: '1px solid var(--border)', background: bg, cursor: onSelect ? 'pointer' : 'default' }}
                  onMouseEnter={e => { if (onSelect) e.currentTarget.style.background = 'rgba(96,165,250,0.07)' }}
                  onMouseLeave={e => { if (onSelect) e.currentTarget.style.background = bg }}
                >
                  <td style={{ padding: '7px 8px', textAlign: 'center', fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 600 }}>{s.stock_id}</td>
                  <td style={{ padding: '7px 8px', textAlign: 'center' }}>{s.name}</td>
                  <td style={{ padding: '7px 8px', textAlign: 'center', color: s.days_in_top >= 5 ? 'var(--green)' : s.days_in_top >= 3 ? 'var(--yellow)' : 'var(--text)', fontWeight: 700 }}>{s.days_in_top}天</td>
                  <td style={{ padding: '7px 8px', textAlign: 'center', fontFamily: 'var(--font-mono)' }}>{s.latest_score.toLocaleString()}</td>
                  <td style={{ padding: '7px 8px', textAlign: 'center', color: s.score_trend > 0 ? 'var(--green)' : s.score_trend < 0 ? 'var(--red)' : 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                    {s.score_trend > 0 ? '+' : ''}{s.score_trend}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function Dashboard({ data, error }) {
  const [selectedDate, setSelectedDate] = useState(() => data?.dates?.[0] || null)
  const [selectedStock, setSelectedStock] = useState(null)
  const [viewTab, setViewTab] = useState('all')
  const notionMap = data?.notionMap || {}

  if (error || !data || !data.dates || data.dates.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted)', gap: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>📭</div>
        <div style={{ fontSize: 15, color: 'var(--text)' }}>尚無掃描資料</div>
        <div style={{ fontSize: 12 }}>等待 GitHub Actions 完成掃描後自動更新</div>
        {error && <div style={{ fontSize: 11, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>{error}</div>}
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

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header bar */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>📊 台股掃描儀表板</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              value={selectedDate || ''}
              onChange={e => setSelectedDate(e.target.value)}
              style={{
                background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)',
                borderRadius: 6, padding: '4px 8px', fontSize: 13, cursor: 'pointer',
              }}
            >
              {data.dates.map(d => {
                const s = data.scans[d]
                const partial = s?.is_partial ? ' ⚠' : ''
                return <option key={d} value={d}>{d}（{s?.total_scanned ?? 0}支）{partial}</option>
              })}
            </select>
            <a
              href={`${BASE}downloads/scan_${selectedDate}_top50.csv`}
              download
              title="下載 TOP 50 完整欄位 CSV（Excel 可直接開啟）"
              style={{
                background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)',
                borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
                textDecoration: 'none', display: 'inline-block',
              }}
            >↓ TOP 50</a>
            <a
              href={`${BASE}downloads/scan_${selectedDate}_all.csv`}
              download
              title="下載全部掃描股票 CSV（含所有 key 欄位）"
              style={{
                background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--accent)',
                borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
                textDecoration: 'none', display: 'inline-block',
              }}
            >↓ 全部</a>
          </div>
        </div>
        {/* Stats */}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <StatCard label="掃描總數" value={scan.total_scanned?.toLocaleString() || '—'} />
          <StatCard label="進場訊號" value={scan.entry_count ?? '—'} color={scan.entry_count > 0 ? 'var(--green)' : 'var(--muted)'} />
          <StatCard label="TOP 50 顯示" value={stocks.length} />
        </div>
        {/* View tabs */}
        <div style={{ display: 'flex', gap: 4, marginTop: 10, flexWrap: 'wrap' }}>
          {[
            { id: 'all',       label: '全部',      count: stocks.length,         color: null },
            { id: 'entry',     label: '✓ 進場訊號', count: entryStocks.length,    color: 'var(--green)' },
            { id: 'limitdown', label: '🔴 連跌停',  count: limitDownAlerts.length, color: '#ef4444' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setViewTab(tab.id)}
              style={{
                background: viewTab === tab.id ? 'rgba(96,165,250,0.15)' : 'var(--surface2)',
                border: `1px solid ${viewTab === tab.id ? 'var(--accent)' : 'var(--border)'}`,
                color: viewTab === tab.id ? 'var(--accent)' : tab.color || 'var(--muted)',
                borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
                fontWeight: viewTab === tab.id ? 700 : 400, whiteSpace: 'nowrap',
              }}
            >
              {tab.label} <span style={{ fontSize: 11, opacity: 0.8 }}>({tab.count})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Table area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 24px 0' }}>

        {/* Market summary (from prediction + aggregate) */}
        {pred && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'rgba(30,41,59,0.6)' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: pred.scenario ? 8 : 0 }}>
              <span style={{ fontSize: 12, color: pred.xgb_label === '偏多' ? 'var(--red)' : pred.xgb_label === '偏空' ? 'var(--green)' : 'var(--muted)', fontWeight: 700 }}>
                {pred.xgb_label === '偏多' ? '📈' : pred.xgb_label === '偏空' ? '📉' : '➡'} 大盤預測 {Math.round((pred.xgb_prob_up || 0) * 100)}% 上漲
              </span>
              {pred.market_data?.vix != null && <span style={{ fontSize: 11, color: 'var(--muted)' }}>VIX {pred.market_data.vix}</span>}
              {pred.market_data?.futures_net != null && <span style={{ fontSize: 11, color: pred.market_data.futures_net < 0 ? 'var(--green)' : 'var(--red)' }}>外資期貨 {pred.market_data.futures_net?.toLocaleString()}口</span>}
              {pred.market_data?.night_change != null && <span style={{ fontSize: 11, color: pred.market_data.night_change > 0 ? 'var(--red)' : 'var(--green)' }}>夜盤 {pred.market_data.night_change > 0 ? '+' : ''}{pred.market_data.night_change}點</span>}
              {pred.regime?.label_zh && <span style={{ fontSize: 11, color: 'var(--accent)', background: 'rgba(96,165,250,0.1)', borderRadius: 4, padding: '1px 6px' }}>{pred.regime.label_zh}</span>}
            </div>
            {pred.scenario?.main_scenario && (
              <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>
                <b style={{ color: '#e2e8f0' }}>主力劇本：</b>{pred.scenario.main_scenario}
              </div>
            )}
            {pred.scenario?.best_strategy && (
              <div style={{ fontSize: 11, color: '#86efac', marginTop: 3 }}>
                <b>最佳策略：</b>{pred.scenario.best_strategy}
              </div>
            )}
            {pred.scenario?.forbidden_actions?.length > 0 && (
              <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 2 }}>
                <b>🚫 禁止：</b>{pred.scenario.forbidden_actions.join(' · ')}
              </div>
            )}
          </div>
        )}

        {/* AI picks */}
        {aiText && (
          <div style={{ padding: '10px 16px', background: 'rgba(15,23,42,0.8)', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa', marginBottom: 6 }}>🤖 AI 精選推薦</div>
            <pre style={{ fontSize: 11, color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'inherit', lineHeight: 1.6 }}>{aiText}</pre>
          </div>
        )}

        {/* Margin chip stats */}
        {(marginStats.clean_count > 0 || marginStats.surge_count > 0) && (
          <div style={{ padding: '6px 16px', fontSize: 11, color: 'var(--muted)', background: 'rgba(30,41,59,0.4)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 16 }}>
            {marginStats.clean_count > 0 && <span>📉 融資籌碼乾淨（5日縮&gt;3%）：<b style={{ color: '#4ade80' }}>{marginStats.clean_count}</b> 支</span>}
            {marginStats.surge_count > 0 && <span>⚠️ 融資暴增警告：<b style={{ color: '#fca5a5' }}>{marginStats.surge_count}</b> 支</span>}
          </div>
        )}

        {entryStocks.length > 0 && (
          <div style={{ padding: '10px 16px 4px', fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>
            ✓ 進場訊號（{entryStocks.length} 支）
          </div>
        )}
        {scan.is_partial && (
          <div style={{ padding: '4px 16px', fontSize: 11, color: 'var(--yellow)', background: 'rgba(234,179,8,0.07)', borderBottom: '1px solid rgba(234,179,8,0.2)' }}>
            ⚠ 部分掃描（{scan.total_scanned} 支），完整掃描後數字會更新
          </div>
        )}
        {scan.from_aggregate_json && (
          <div style={{ padding: '4px 16px', fontSize: 11, color: 'var(--accent)', opacity: 0.7 }}>
            ℹ 資料來源：彙整結果（全掃描已合併）
          </div>
        )}
        {scan.from_notion_fallback && (
          <div style={{ padding: '4px 16px', fontSize: 11, color: 'var(--yellow)', opacity: 0.8 }}>
            ℹ 資料來源：Notion 歷史同步（今日掃描尚未完成，顯示最近完整掃描）
          </div>
        )}
        <div style={{ padding: '0 8px' }}>
          <StockTable
            stocks={viewTab === 'entry' ? entryStocks : viewTab === 'limitdown' ? limitDownAlerts : stocks}
            onSelect={setSelectedStock}
            notionMap={notionMap}
          />
        </div>

        {persistent.length > 0 && (
          <div style={{ padding: '0 16px' }}>
            <PersistentSection
              items={persistent}
              onSelect={item => {
                const full = stocks.find(s => s.stock_id === item.stock_id)
                setSelectedStock(full || { stock_id: item.stock_id, name: item.name, industry_category: item.industry_category || '', entry_score: item.latest_score || 0, price_history: item.price_history || [], condition_count: 0, entry_signal: false })
              }}
            />
          </div>
        )}

        {limitDownAlerts.length > 0 && (
          <div style={{ padding: '0 16px' }}>
            <LimitDownSection items={limitDownAlerts} onSelect={setSelectedStock} />
          </div>
        )}

        <div style={{ padding: '0 16px' }}>
          <ConsecutiveDropSection stocks={stocks} onSelect={setSelectedStock} />
        </div>

        <div style={{ padding: '16px', color: 'var(--muted)', fontSize: 11 }}>
          點擊任一列查看詳細資料與K線圖 · 分數 ✓ 綠色 = 進場訊號 · 外資/投信欄為連買天數
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
