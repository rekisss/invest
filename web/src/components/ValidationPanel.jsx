import { useMemo, useRef } from 'react'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'

const GRADE_CFG = {
  A: { color: '#FFD60A', bg: 'rgba(255,214,10,0.15)', border: 'rgba(255,214,10,0.35)', label: 'A' },
  B: { color: '#30D158', bg: 'rgba(48,209,88,0.13)',  border: 'rgba(48,209,88,0.30)',  label: 'B' },
  C: { color: '#FF9F0A', bg: 'rgba(255,159,10,0.13)', border: 'rgba(255,159,10,0.30)', label: 'C' },
  D: { color: '#94A3B8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.22)', label: 'D' },
  X: { color: '#FF453A', bg: 'rgba(255,69,58,0.13)',  border: 'rgba(255,69,58,0.30)',  label: 'X' },
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
const winColor = r => r == null ? 'var(--ios-label3)' : r >= 0.7 ? '#30D158' : r >= 0.5 ? '#FF9F0A' : '#FF453A'
const retColor = r => r == null ? 'var(--ios-label3)' : r > 0 ? '#30D158' : r < 0 ? '#FF453A' : 'var(--ios-label3)'

function parseSignals(entry_reason) {
  if (!entry_reason) return []
  const raw = entry_reason.split(',').map(s => s.trim()).filter(Boolean)
  // Sort by priority
  const pri = raw.filter(k => SIGNAL_PRIORITY.includes(k)).sort((a, b) => SIGNAL_PRIORITY.indexOf(a) - SIGNAL_PRIORITY.indexOf(b))
  const rest = raw.filter(k => !SIGNAL_PRIORITY.includes(k))
  return [...pri, ...rest].slice(0, 4)
}

function StockCard({ stock, rank, style }) {
  const cfg = GRADE_CFG[stock.grade] || GRADE_CFG.D
  const signals = parseSignals(stock.entry_reason)
  const r1 = stock.day_return
  const r5 = stock.return_5d
  const hasExit = stock.base_exit_signal

  return (
    <div style={{
      background: 'var(--ios-bg2)', borderRadius: 14,
      border: `0.5px solid ${hasExit ? 'rgba(255,69,58,0.4)' : 'var(--ios-sep)'}`,
      padding: '11px 13px', ...style,
    }}>
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
          ${fmtP(stock.close)}
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
        </div>

        {/* Return badges */}
        <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
          {/* Day return */}
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 7.5, color: 'var(--ios-label4)', marginBottom: 1 }}>當日</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: retColor(r1) }}>{fmtPct(r1)}</div>
          </div>
          {/* 5D return */}
          <div style={{ textAlign: 'center', minWidth: 42 }}>
            <div style={{ fontSize: 7.5, color: 'var(--ios-label4)', marginBottom: 1 }}>5日</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: retColor(r5) }}>{fmtPct(r5)}</div>
          </div>
        </div>
      </div>

      {/* Exit warning */}
      {hasExit && (
        <div style={{ marginTop: 5, fontSize: 9, color: '#FF453A', fontWeight: 600 }}>
          ⚠️ 出場信號：{stock.base_exit_reason || '已觸發'}
        </div>
      )}
    </div>
  )
}

function DateBarChart({ byDate, sortedDates }) {
  const valid = sortedDates.filter(d => byDate[d])
  if (!valid.length) return null
  const maxR = Math.max(...valid.map(d => Math.abs(byDate[d].avgReturn || 0)), 0.01)
  const H = 60
  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
      <svg viewBox={`0 0 ${valid.length * 26 + 8} ${H + 20}`} style={{ width: valid.length * 26 + 8, height: H + 20, display: 'block' }}>
        {valid.map((date, i) => {
          const s = byDate[date]
          const r = s.avgReturn || 0
          const bH = Math.max(3, Math.abs(r) / maxR * (H - 6))
          const y  = r >= 0 ? H - 3 - bH : H - 3
          const col = r >= 0 ? '#30D158' : '#FF453A'
          return (
            <g key={date}>
              <rect x={i * 26 + 4} y={y} width={16} height={bH} rx={3} fill={col} opacity={0.85} />
              <text x={i * 26 + 12} y={H + 10} fontSize={7} textAnchor="middle" style={{ fill: 'var(--ios-label3)' }}>{date.slice(5)}</text>
              <text x={i * 26 + 12} y={r >= 0 ? y - 2 : y + bH + 8} fontSize={6.5} textAnchor="middle" fill={col} fontWeight="700">{(r*100).toFixed(0)}%</text>
            </g>
          )
        })}
        <line x1={4} y1={H - 3} x2={valid.length * 26 + 4} y2={H - 3} stroke="var(--ios-sep)" strokeWidth={0.5} />
      </svg>
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

export default function ValidationPanel({ data }) {
  const listRef  = useRef(null)
  const statsRef = useRef(null)

  const { top20, scanDate, batchStats, byGrade, byDate, summary, sortedDates } = useMemo(() => {
    if (!data?.scans || !data?.dates) {
      return { top20: [], scanDate: null, batchStats: {}, byGrade: {}, byDate: {}, summary: {}, sortedDates: [] }
    }
    const { scans, dates, aggregateLatest } = data

    // Use scans[dates[0]].top_stocks for correct normalized grades (aggregateLatest
    // marks nearly all TOP 20 as grade A, bypassing the per-stock CSV grades).
    const top20   = scans[dates[0]]?.top_stocks?.slice(0, 20) || aggregateLatest?.top_stocks || []
    const scanDate = dates[0] || aggregateLatest?.date?.slice(0, 10)

    // Batch stats for the latest top 20
    const bWith = top20.filter(s => s.return_5d != null)
    const batchStats = {
      total:   top20.length,
      wins5d:  bWith.filter(s => s.return_5d > 0).length,
      winRate: bWith.length ? bWith.filter(s => s.return_5d > 0).length / bWith.length : null,
      avgR5d:  bWith.length ? bWith.reduce((a, s) => a + s.return_5d, 0) / bWith.length : null,
      exits:   top20.filter(s => s.base_exit_signal).length,
    }

    // Historical: all top_stocks across all dates
    const allObs = []
    const sortedDates = [...dates].reverse()
    for (const date of dates) {
      for (const s of (scans[date]?.top_stocks || [])) {
        allObs.push({ date, ...s, r5d: s.return_5d, r1d: s.day_return })
      }
    }

    // Grade breakdown (5d)
    const byG = {}
    for (const o of allObs.filter(o => o.r5d != null)) {
      const g = o.grade || 'D'
      if (!byG[g]) byG[g] = { total: 0, wins: 0, returns: [] }
      byG[g].total++
      if (o.r5d > 0) byG[g].wins++
      byG[g].returns.push(o.r5d)
    }

    // Per-date chart data
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

    const all5d = allObs.filter(o => o.r5d != null)
    const summary = {
      scans: sortedDates.filter(d => byDate[d]).length,
      total: all5d.length,
      winRate: all5d.length ? all5d.filter(o => o.r5d > 0).length / all5d.length : null,
      avgR5: all5d.length ? all5d.reduce((a, o) => a + o.r5d, 0) / all5d.length : null,
    }

    return { top20, scanDate, batchStats, byGrade: byG, byDate, summary, sortedDates }
  }, [data])

  // Animate stock cards in with stagger
  useGSAP(() => {
    if (!listRef.current) return
    const cards = listRef.current.querySelectorAll('.stock-card')
    if (!cards.length) return
    gsap.fromTo(cards,
      { opacity: 0, y: 18 },
      { opacity: 1, y: 0, duration: 0.35, stagger: 0.045, ease: 'power2.out', clearProps: 'transform' }
    )
  }, { scope: listRef, dependencies: [top20] })

  // Animate summary stats fade in
  useGSAP(() => {
    if (!statsRef.current) return
    gsap.fromTo(statsRef.current.querySelectorAll('.stat-block'),
      { opacity: 0, scale: 0.92 },
      { opacity: 1, scale: 1, duration: 0.4, stagger: 0.07, ease: 'back.out(1.4)', clearProps: 'transform' }
    )
  }, { scope: statsRef, dependencies: [summary] })

  if (!data) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ios-label3)' }}>載入中⋯</div>
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '0 14px 32px' }}>

      {/* ── 最新精選 TOP 20 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, marginBottom: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ios-label)' }}>精選 TOP 20</span>
        {scanDate && (
          <span style={{ fontSize: 10, background: 'rgba(10,132,255,0.15)', color: '#0A84FF', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>
            {scanDate}
          </span>
        )}
        {batchStats.exits > 0 && (
          <span style={{ fontSize: 9, color: '#FF453A', background: 'rgba(255,69,58,0.12)', borderRadius: 5, padding: '2px 6px', marginLeft: 'auto' }}>
            ⚠️ {batchStats.exits} 檔出場信號
          </span>
        )}
      </div>

      {/* Batch summary row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, background: 'var(--ios-bg2)', borderRadius: 14, padding: '10px 14px', border: '0.5px solid var(--ios-sep)' }}>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 8, color: 'var(--ios-label4)', marginBottom: 2 }}>本批勝率</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: winColor(batchStats.winRate) }}>{fmtRate(batchStats.winRate)}</div>
        </div>
        <div style={{ width: 0.5, background: 'var(--ios-sep)' }} />
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 8, color: 'var(--ios-label4)', marginBottom: 2 }}>均5日報酬</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: retColor(batchStats.avgR5d) }}>{fmtPct(batchStats.avgR5d)}</div>
        </div>
        <div style={{ width: 0.5, background: 'var(--ios-sep)' }} />
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 8, color: 'var(--ios-label4)', marginBottom: 2 }}>精選檔數</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--ios-label)' }}>{batchStats.total}</div>
        </div>
      </div>

      {/* Stock cards */}
      <div ref={listRef} style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 18 }}>
        {top20.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--ios-label3)', fontSize: 13, padding: '24px 0' }}>尚無精選資料</div>
        )}
        {top20.map((s, i) => (
          <div key={`${s.stock_id}-${i}`} className="stock-card" style={{ opacity: 0 }}>
            <StockCard stock={s} rank={i + 1} />
          </div>
        ))}
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
          { label: '歷史勝率', value: fmtRate(summary.winRate), color: winColor(summary.winRate) },
          { label: '均5日報',  value: fmtPct(summary.avgR5),   color: retColor(summary.avgR5) },
        ].map(({ label, value, color }) => (
          <div key={label} className="stat-block" style={{ flex: 1, background: 'var(--ios-bg2)', borderRadius: 10, padding: '8px 6px', border: '0.5px solid var(--ios-sep)', textAlign: 'center', opacity: 0 }}>
            <div style={{ fontSize: 8, color: 'var(--ios-label4)', marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: color || 'var(--ios-label)', lineHeight: 1 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Per-date chart */}
      <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '12px 12px', marginBottom: 12, border: '0.5px solid var(--ios-sep)' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ios-label)', marginBottom: 7 }}>逐日均5日報酬</div>
        <DateBarChart byDate={byDate} sortedDates={sortedDates} />
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

    </div>
  )
}
