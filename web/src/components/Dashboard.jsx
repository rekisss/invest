import { useState } from 'react'

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
  const color = entry_signal ? 'var(--green)' : score > 1000 ? 'var(--yellow)' : score > 0 ? 'var(--text)' : 'var(--muted)'
  return <span style={{ color, fontWeight: entry_signal ? 700 : 400, fontFamily: 'var(--font-mono)' }}>{score.toLocaleString()}</span>
}

function StockTable({ stocks }) {
  const [expanded, setExpanded] = useState(null)

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
            <>
              <tr
                key={s.stock_id}
                onClick={() => setExpanded(expanded === s.stock_id ? null : s.stock_id)}
                style={{
                  borderBottom: '1px solid var(--border)',
                  background: s.entry_signal ? 'rgba(63,185,80,0.06)' : 'transparent',
                  cursor: 'pointer',
                }}
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
              </tr>
              {expanded === s.stock_id && (
                <tr key={s.stock_id + '_detail'} style={{ background: 'var(--surface)' }}>
                  <td colSpan={cols.length} style={{ padding: '10px 12px' }}>
                    <div style={{ color: 'var(--muted)', fontSize: 11, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <span>產業：<b style={{ color: 'var(--text)' }}>{s.industry_category || '—'}</b></span>
                      <span>F-Score：<b style={{ color: 'var(--text)' }}>{s.f_score}</b></span>
                      <span>條件達成：<b style={{ color: 'var(--text)' }}>{s.condition_count}</b></span>
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PersistentSection({ items }) {
  if (!items || items.length === 0) return null
  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        📅 跨日持續強勢（近14天 TOP 50）
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
            {items.map((s, i) => (
              <tr key={s.stock_id} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                <td style={{ padding: '7px 8px', textAlign: 'center', fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 600 }}>{s.stock_id}</td>
                <td style={{ padding: '7px 8px', textAlign: 'center' }}>{s.name}</td>
                <td style={{ padding: '7px 8px', textAlign: 'center', color: s.days_in_top >= 5 ? 'var(--green)' : s.days_in_top >= 3 ? 'var(--yellow)' : 'var(--text)', fontWeight: 700 }}>{s.days_in_top}天</td>
                <td style={{ padding: '7px 8px', textAlign: 'center', fontFamily: 'var(--font-mono)' }}>{s.latest_score.toLocaleString()}</td>
                <td style={{ padding: '7px 8px', textAlign: 'center', color: s.score_trend > 0 ? 'var(--green)' : s.score_trend < 0 ? 'var(--red)' : 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                  {s.score_trend > 0 ? '+' : ''}{s.score_trend}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function Dashboard({ data, error }) {
  const [selectedDate, setSelectedDate] = useState(() => data?.dates?.[0] || null)

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
  const entryStocks = stocks.filter(s => s.entry_signal)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header bar */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>📊 台股掃描儀表板</div>
          <select
            value={selectedDate || ''}
            onChange={e => setSelectedDate(e.target.value)}
            style={{
              background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)',
              borderRadius: 6, padding: '4px 8px', fontSize: 13, cursor: 'pointer',
            }}
          >
            {data.dates.map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
        {/* Stats */}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <StatCard label="掃描總數" value={scan.total_scanned?.toLocaleString() || '—'} />
          <StatCard label="進場訊號" value={scan.entry_count ?? '—'} color={scan.entry_count > 0 ? 'var(--green)' : 'var(--muted)'} />
          <StatCard label="TOP 50 顯示" value={stocks.length} />
        </div>
      </div>

      {/* Table area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 24px 0' }}>
        {entryStocks.length > 0 && (
          <div style={{ padding: '12px 16px 4px', fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>
            ✓ 進場訊號（{entryStocks.length} 支）
          </div>
        )}
        <div style={{ padding: '0 8px' }}>
          <StockTable stocks={stocks} />
        </div>

        {persistent.length > 0 && (
          <div style={{ padding: '0 16px' }}>
            <PersistentSection items={persistent} />
          </div>
        )}

        <div style={{ padding: '16px', color: 'var(--muted)', fontSize: 11 }}>
          點擊任一列可展開詳細資訊 · 分數 ✓ 綠色 = 進場訊號 · 外資/投信欄為連買天數
        </div>
      </div>
    </div>
  )
}
