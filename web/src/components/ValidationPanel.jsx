import { useMemo } from 'react'

const GRADE_CFG = {
  A: { color: '#FFD60A', bg: 'rgba(255,214,10,0.13)', label: 'A 精選' },
  B: { color: '#30D158', bg: 'rgba(48,209,88,0.13)',  label: 'B 優質' },
  C: { color: '#FF9F0A', bg: 'rgba(255,159,10,0.13)', label: 'C 合格' },
  D: { color: '#94A3B8', bg: 'rgba(148,163,184,0.10)', label: 'D 一般' },
  X: { color: '#FF453A', bg: 'rgba(255,69,58,0.13)', label: 'X 跳過' },
}

const fmtPct  = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'
const fmtRate = v => v == null ? '—' : (v * 100).toFixed(0) + '%'
const winColor = r => r == null ? 'var(--ios-label3)' : r >= 0.7 ? '#30D158' : r >= 0.5 ? '#FF9F0A' : '#FF453A'
const retColor = r => r == null ? 'var(--ios-label3)' : r > 0 ? '#30D158' : r < 0 ? '#FF453A' : 'var(--ios-label3)'

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{
      flex: 1, minWidth: 70, background: 'var(--ios-bg2)', borderRadius: 12,
      padding: '10px 10px 8px', border: '0.5px solid var(--ios-sep)',
    }}>
      <div style={{ fontSize: 9, color: 'var(--ios-label3)', marginBottom: 4, letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || 'var(--ios-label)', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--ios-label3)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

function GradeRow({ grade, stats }) {
  const cfg = GRADE_CFG[grade] || GRADE_CFG.D
  if (!stats || stats.total === 0) return null
  const wr = stats.wins / stats.total
  const avg = stats.returns.reduce((a, v) => a + v, 0) / stats.returns.length
  const barW = Math.round(wr * 100)
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: cfg.color, background: cfg.bg, padding: '1px 7px', borderRadius: 5, flexShrink: 0 }}>{cfg.label}</span>
        <span style={{ fontSize: 10, color: 'var(--ios-label3)' }}>{stats.total} 股次</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: winColor(wr) }}>{fmtRate(wr)}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: retColor(avg), minWidth: 52, textAlign: 'right' }}>{fmtPct(avg)}</span>
      </div>
      <div style={{ height: 4, background: 'var(--ios-fill3)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${barW}%`, height: '100%', background: winColor(wr), borderRadius: 2, transition: 'width 0.5s' }} />
      </div>
    </div>
  )
}

function DateBarChart({ byDate, sortedDates }) {
  const valid = sortedDates.filter(d => byDate[d])
  if (!valid.length) return null
  const maxReturn = Math.max(...valid.map(d => Math.abs(byDate[d].avgReturn || 0)), 0.01)
  const chartH = 64
  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', marginBottom: 2 }}>
      <svg viewBox={`0 0 ${valid.length * 28 + 8} ${chartH + 22}`} style={{ width: valid.length * 28 + 8, height: chartH + 22, display: 'block' }}>
        {valid.map((date, i) => {
          const s = byDate[date]
          const r = s.avgReturn || 0
          const barH = Math.max(3, Math.abs(r) / maxReturn * (chartH - 8))
          const y = r >= 0 ? chartH - 4 - barH : chartH - 4
          const col = r >= 0 ? '#30D158' : '#FF453A'
          const label = date.slice(5)
          return (
            <g key={date}>
              <rect x={i * 28 + 4} y={y} width={18} height={barH} rx={3} fill={col} opacity={0.85} />
              <text x={i * 28 + 13} y={chartH + 10} fontSize={7.5} textAnchor="middle" style={{ fill: 'var(--ios-label3)' }}>{label}</text>
              <text x={i * 28 + 13} y={r >= 0 ? y - 2 : y + barH + 8} fontSize={7} textAnchor="middle" fill={col} fontWeight="700">
                {(r * 100).toFixed(0)}%
              </text>
            </g>
          )
        })}
        <line x1={4} y1={chartH - 4} x2={valid.length * 28 + 4} y2={chartH - 4} stroke="var(--ios-sep)" strokeWidth={0.5} />
      </svg>
    </div>
  )
}

export default function ValidationPanel({ data }) {
  const { byGrade, byDate, topPerformers, byQuantile, summary, sortedDates } = useMemo(() => {
    if (!data?.scans || !data?.dates) {
      return { byGrade: {}, byDate: {}, topPerformers: [], byQuantile: {}, summary: {}, sortedDates: [] }
    }
    const { scans, dates } = data

    const allObs = []
    const sortedDates = [...dates].reverse()

    for (const date of dates) {
      const top = scans[date]?.top_stocks || []
      for (const s of top) {
        const r5 = s.return_5d
        const r1 = s.day_return
        allObs.push({ date, ...s, r1d: r1, r5d: r5 })
      }
    }

    const gradeStats = key => {
      const byG = {}
      for (const o of allObs.filter(o => o[key] != null)) {
        const g = o.grade || 'D'
        if (!byG[g]) byG[g] = { total: 0, wins: 0, returns: [] }
        byG[g].total++
        if (o[key] > 0) byG[g].wins++
        byG[g].returns.push(o[key])
      }
      return byG
    }
    const byGrade = gradeStats('r5d')

    const byDate = {}
    for (const date of sortedDates) {
      const top = (scans[date]?.top_stocks || []).filter(s => s.return_5d != null)
      if (!top.length) continue
      const r5s = top.map(s => s.return_5d)
      const r1s = top.map(s => s.day_return).filter(v => v != null)
      byDate[date] = {
        total:     top.length,
        wins:      top.filter(s => s.return_5d > 0).length,
        avgReturn: r5s.reduce((a, v) => a + v, 0) / r5s.length,
        avgR1d:    r1s.length ? r1s.reduce((a, v) => a + v, 0) / r1s.length : null,
        grades:    Object.fromEntries(Object.entries(byGrade).map(([g, _]) => [g, top.filter(s => (s.grade||'D') === g).length])),
      }
    }

    // Score quantile: sort by entry_score per date then pick top 10% / 25%
    const all5d = allObs.filter(o => o.r5d != null)
    const sorted = [...all5d].sort((a, b) => (b.entry_score || 0) - (a.entry_score || 0))
    const slice = (arr, frac) => arr.slice(0, Math.max(1, Math.ceil(arr.length * frac)))
    const calcQ = subset => {
      if (!subset.length) return { total: 0, win_rate: null, avg_r5d: null, avg_r1d: null }
      const r5 = subset.filter(o => o.r5d != null)
      const r1 = subset.filter(o => o.r1d != null)
      return {
        total:      subset.length,
        win_rate:   r5.length ? r5.filter(o => o.r5d > 0).length / r5.length : null,
        win_rate1d: r1.length ? r1.filter(o => o.r1d > 0).length / r1.length : null,
        avg_r5d:    r5.length ? r5.reduce((a, o) => a + o.r5d, 0) / r5.length : null,
        avg_r1d:    r1.length ? r1.reduce((a, o) => a + o.r1d, 0) / r1.length : null,
      }
    }
    const byQuantile = {
      top10: calcQ(slice(sorted, 0.10)),
      top25: calcQ(slice(sorted, 0.25)),
      all:   calcQ(all5d),
    }

    const topPerformers = [...all5d].sort((a, b) => b.r5d - a.r5d).slice(0, 10)

    const obs5d = all5d
    const totalWins = obs5d.filter(o => o.r5d > 0).length
    const avgR5 = obs5d.length ? obs5d.reduce((a, o) => a + o.r5d, 0) / obs5d.length : null
    const summary = {
      scans: sortedDates.filter(d => byDate[d]).length,
      total: obs5d.length,
      winRate: obs5d.length ? totalWins / obs5d.length : null,
      avgR5,
    }

    return { byGrade, byDate, topPerformers, byQuantile, summary, sortedDates }
  }, [data])

  if (!data) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ios-label3)' }}>載入中⋯</div>
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '0 16px 24px' }}>

      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, marginTop: 4 }}>
        <StatCard label="掃描批次" value={summary.scans || 0} sub="歷史可驗證" />
        <StatCard label="驗證股次" value={summary.total || 0} sub="含5日報酬" />
        <StatCard label="5日勝率" value={fmtRate(summary.winRate)} color={winColor(summary.winRate)} />
        <StatCard label="平均5日報酬" value={fmtPct(summary.avgR5)} color={retColor(summary.avgR5)} />
      </div>

      {/* Per-date chart */}
      <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '12px 14px', marginBottom: 14, border: '0.5px solid var(--ios-sep)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-label)', marginBottom: 8 }}>逐日預選股平均 5 日報酬</div>
        <DateBarChart byDate={byDate} sortedDates={sortedDates} />
        {!Object.keys(byDate).length && (
          <div style={{ textAlign: 'center', color: 'var(--ios-label3)', fontSize: 12, padding: '16px 0' }}>尚無報酬資料</div>
        )}
      </div>

      {/* Grade breakdown */}
      <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '12px 14px', marginBottom: 14, border: '0.5px solid var(--ios-sep)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-label)' }}>各等級勝率（5日）</span>
          <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--ios-label3)' }}>勝率 / 平均報酬</span>
        </div>
        {['A','B','C','D','X'].map(g => <GradeRow key={g} grade={g} stats={byGrade[g]} />)}
        {Object.keys(byGrade).length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--ios-label3)', fontSize: 12, padding: '8px 0' }}>尚無等級資料</div>
        )}
      </div>

      {/* Score quantile table */}
      <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '12px 14px', marginBottom: 14, border: '0.5px solid var(--ios-sep)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-label)', marginBottom: 10 }}>分位數精度：高分股 vs 全體</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ borderBottom: '0.5px solid var(--ios-sep)' }}>
              <th style={{ textAlign: 'left', padding: '4px 0', color: 'var(--ios-label3)', fontWeight: 500, fontSize: 9 }}>分位</th>
              <th style={{ textAlign: 'right', color: 'var(--ios-label3)', fontWeight: 500, fontSize: 9 }}>股次</th>
              <th style={{ textAlign: 'right', color: 'var(--ios-label3)', fontWeight: 500, fontSize: 9 }}>1日勝率</th>
              <th style={{ textAlign: 'right', color: 'var(--ios-label3)', fontWeight: 500, fontSize: 9 }}>5日勝率</th>
              <th style={{ textAlign: 'right', color: 'var(--ios-label3)', fontWeight: 500, fontSize: 9 }}>5日均報</th>
            </tr>
          </thead>
          <tbody>
            {[
              { key: 'top10', label: 'Top 10%', accent: '#FFD60A' },
              { key: 'top25', label: 'Top 25%', accent: '#30D158' },
              { key: 'all',   label: '全體',    accent: 'var(--ios-label3)' },
            ].map(({ key, label, accent }) => {
              const q = byQuantile[key] || {}
              return (
                <tr key={key} style={{ borderBottom: '0.5px solid var(--ios-fill3)' }}>
                  <td style={{ padding: '7px 0', fontWeight: 700, color: accent }}>{label}</td>
                  <td style={{ textAlign: 'right', color: 'var(--ios-label2)' }}>{q.total || 0}</td>
                  <td style={{ textAlign: 'right', color: winColor(q.win_rate1d), fontWeight: 600 }}>{fmtRate(q.win_rate1d)}</td>
                  <td style={{ textAlign: 'right', color: winColor(q.win_rate), fontWeight: 600 }}>{fmtRate(q.win_rate)}</td>
                  <td style={{ textAlign: 'right', color: retColor(q.avg_r5d), fontWeight: 700 }}>{fmtPct(q.avg_r5d)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Top performers */}
      <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '12px 14px', border: '0.5px solid var(--ios-sep)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-label)', marginBottom: 10 }}>
          🏆 5日最佳預選股（前10名）
        </div>
        {topPerformers.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--ios-label3)', fontSize: 12, padding: '8px 0' }}>尚無資料</div>
        )}
        {topPerformers.map((s, i) => {
          const cfg = GRADE_CFG[s.grade] || GRADE_CFG.D
          return (
            <div key={`${s.date}-${s.stock_id}`} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 0', borderBottom: i < topPerformers.length - 1 ? '0.5px solid var(--ios-fill3)' : 'none',
            }}>
              <span style={{ fontSize: 10, color: 'var(--ios-label4)', minWidth: 16, textAlign: 'right' }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-label)' }}>
                  {s.stock_id} <span style={{ fontWeight: 400, color: 'var(--ios-label2)' }}>{s.name || ''}</span>
                </div>
                <div style={{ fontSize: 9, color: 'var(--ios-label3)', marginTop: 1 }}>{s.date} · 分數 {s.entry_score || '—'}</div>
              </div>
              <span style={{ fontSize: 9, fontWeight: 700, color: cfg.color, background: cfg.bg, padding: '1px 6px', borderRadius: 4 }}>{s.grade || 'D'}</span>
              <span style={{ fontSize: 14, fontWeight: 800, color: '#30D158', minWidth: 50, textAlign: 'right' }}>
                {fmtPct(s.r5d)}
              </span>
            </div>
          )
        })}
      </div>

      <div style={{ height: 8 }} />
      <div style={{ fontSize: 9, color: 'var(--ios-label4)', textAlign: 'center', lineHeight: 1.5 }}>
        以上報酬率為預選日起算 5 個交易日後實際收盤報酬<br />
        僅供策略驗證參考，不構成投資建議
      </div>
    </div>
  )
}
