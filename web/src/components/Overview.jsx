import { useState } from 'react'

/* ── SVG Direction Gauge ─────────────────────────────────────────── */
function DirectionGauge({ prob = 0.5, winRate }) {
  const pct = Math.max(2, Math.min(98, Math.round((prob ?? 0.5) * 100)))
  const isBull = pct >= 55, isBear = pct <= 45
  const color = isBull ? '#22C55E' : isBear ? '#EF4444' : '#F59E0B'
  const confidence = isBull ? pct : isBear ? (100 - pct) : 50

  const cx = 80, cy = 72, r = 58
  const ang = ((-180 + pct * 1.8) * Math.PI) / 180
  const nx = (cx + r * Math.cos(ang)).toFixed(2)
  const ny = (cy + r * Math.sin(ang)).toFixed(2)
  const nx2 = (cx + (r - 16) * Math.cos(ang)).toFixed(2)
  const ny2 = (cy + (r - 16) * Math.sin(ang)).toFixed(2)

  return (
    <div style={{ flex: 1, background: '#0F172A', borderRadius: 16, padding: '12px 12px 10px', border: '1px solid #1E293B', display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2 }}>大盤方向</div>
      <svg viewBox="0 0 160 96" style={{ width: '100%', display: 'block' }}>
        {/* glow */}
        <path d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${nx},${ny}`} stroke={color} strokeWidth="18" fill="none" strokeLinecap="round" opacity="0.12" />
        {/* track */}
        <path d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`} stroke="#1E293B" strokeWidth="9" fill="none" strokeLinecap="round" />
        {/* value arc */}
        <path d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${nx},${ny}`} stroke={color} strokeWidth="9" fill="none" strokeLinecap="round" />
        {/* needle */}
        <line x1={cx} y1={cy} x2={nx2} y2={ny2} stroke="#F8FAFC" strokeWidth="2" strokeLinecap="round" />
        {/* center dot */}
        <circle cx={cx} cy={cy} r="5" fill={color} />
        <circle cx={cx} cy={cy} r="2.5" fill="#F8FAFC" />
        {/* side labels */}
        <text x={cx - r - 3} y={cy + 14} textAnchor="middle" fontSize="9" fill="#EF4444" fontWeight="700">空</text>
        <text x={cx + r + 3} y={cy + 14} textAnchor="middle" fontSize="9" fill="#22C55E" fontWeight="700">多</text>
        {/* big % */}
        <text x={cx} y={cy + 26} textAnchor="middle" fontSize="20" fontWeight="800" fill={color} fontFamily="monospace">{confidence}%</text>
      </svg>
      <div style={{ textAlign: 'center', marginTop: -2 }}>
        <span style={{ fontSize: 16, fontWeight: 800, color, letterSpacing: '-0.3px' }}>
          {isBull ? '偏多 ↑' : isBear ? '偏空 ↓' : '中性 →'}
        </span>
        {winRate != null && winRate > 0 && (
          <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 3 }}>
            勝率 ~{winRate > 1 ? Math.round(winRate) : Math.round(winRate * 100)}%
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Risk Card ───────────────────────────────────────────────────── */
function RiskCard({ risk, marketData }) {
  const level = (risk?.level || '').replace('RiskLevel.', '') || 'MEDIUM'
  const score = risk?.score || 0.5
  const cfg = {
    LOW:     { label: '低風險', color: '#22C55E', bg: 'rgba(34,197,94,0.13)' },
    MEDIUM:  { label: '中風險', color: '#F59E0B', bg: 'rgba(245,158,11,0.13)' },
    HIGH:    { label: '高風險', color: '#EF4444', bg: 'rgba(239,68,68,0.13)' },
    EXTREME: { label: '極高危', color: '#FF0000', bg: 'rgba(239,68,68,0.22)' },
  }[level] || { label: '中風險', color: '#F59E0B', bg: 'rgba(245,158,11,0.13)' }

  const rows = [
    marketData?.vix != null && ['VIX', marketData.vix.toFixed(1), marketData.vix > 25 ? '#EF4444' : marketData.vix > 18 ? '#F59E0B' : '#22C55E'],
    marketData?.futures_net != null && ['外資期貨', `${marketData.futures_net > 0 ? '+' : ''}${Math.round(marketData.futures_net).toLocaleString()}`, marketData.futures_net > 0 ? '#22C55E' : '#EF4444'],
    marketData?.night_change != null && ['夜盤', `${marketData.night_change > 0 ? '+' : ''}${Math.round(marketData.night_change)}`, marketData.night_change > 0 ? '#22C55E' : '#EF4444'],
  ].filter(Boolean)

  return (
    <div style={{ flex: 1, background: '#0F172A', borderRadius: 16, padding: '12px 12px', border: '1px solid #1E293B', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.8 }}>今日風險</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ padding: '4px 10px', borderRadius: 8, background: cfg.bg, fontSize: 13, fontWeight: 800, color: cfg.color, whiteSpace: 'nowrap' }}>{cfg.label}</div>
        <div style={{ flex: 1, height: 4, background: '#1E293B', borderRadius: 9999 }}>
          <div style={{ height: '100%', width: `${Math.round(score * 100)}%`, background: cfg.color, borderRadius: 9999 }} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {rows.map(([label, val, color]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#94A3B8' }}>{label}</span>
            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace', color }}>{val}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Scenario Block ──────────────────────────────────────────────── */
function ScenarioBlock({ scenario, prob }) {
  const pct = Math.round((prob ?? 0.5) * 100)
  const isBull = pct >= 55, isBear = pct <= 45
  const accentColor = isBull ? '#22C55E' : isBear ? '#EF4444' : '#F59E0B'

  if (!scenario?.main_scenario && !scenario?.best_strategy) return null

  return (
    <div style={{ background: '#0F172A', borderRadius: 16, padding: '14px 16px', border: '1px solid #1E293B', borderLeft: `3px solid ${accentColor}` }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>今日劇本</div>
      {scenario.market_type && (
        <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 8 }}>
          市場類型：<span style={{ color: '#F8FAFC', fontWeight: 600 }}>{scenario.market_type}</span>
        </div>
      )}
      {scenario.main_scenario && (
        <div style={{ fontSize: 14, color: '#F8FAFC', lineHeight: 1.65, marginBottom: 10 }}>{scenario.main_scenario}</div>
      )}
      {scenario.best_strategy && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(59,130,246,0.12)', borderRadius: 8, padding: '6px 12px', fontSize: 13, color: '#3B82F6', fontWeight: 600, marginBottom: scenario.forbidden_actions?.length ? 10 : 0 }}>
          🎯 {scenario.best_strategy}
        </div>
      )}
      {scenario.forbidden_actions?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {scenario.forbidden_actions.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 13, color: '#EF4444' }}>
              <span style={{ flexShrink: 0 }}>🚫</span><span>{a}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Stock Mini Row (TOP 5) ──────────────────────────────────────── */
function StockMiniRow({ stock, rank, maxScore, isLast }) {
  const normScore = Math.min(Math.round((stock.entry_score || 0) / maxScore * 100), 99)
  const isEntry = stock.entry_signal
  const scoreColor = isEntry ? '#22C55E' : normScore >= 70 ? '#3B82F6' : '#94A3B8'

  const techDots = [
    (stock.rsi14 || 0) > 50 && (stock.rsi14 || 0) < 75,
    (stock.adx14 || 0) > 20,
    (stock.volume_ratio || 0) > 1.3,
    (stock.adx14 || 0) > 27,
    (stock.rsi14 || 0) > 60,
  ].filter(Boolean).length

  const chipDots = [
    (stock.foreign_buy_streak || 0) >= 1,
    (stock.foreign_buy_streak || 0) >= 2,
    (stock.foreign_buy_streak || 0) >= 3,
    (stock.invest_trust_streak || 0) >= 1,
    (stock.invest_trust_streak || 0) >= 2,
  ].filter(Boolean).length

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderBottom: isLast ? 'none' : '1px solid #1E293B', background: isEntry ? 'rgba(34,197,94,0.04)' : 'transparent' }}>
      <div style={{ fontSize: 12, color: '#334155', fontFamily: 'monospace', minWidth: 18, textAlign: 'right' }}>{rank}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 5 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#3B82F6', fontFamily: 'monospace', flexShrink: 0 }}>{stock.stock_id}</span>
          <span style={{ fontSize: 13, color: '#F8FAFC', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stock.name}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
          <div style={{ flex: 1, height: 3, background: '#1E293B', borderRadius: 9999 }}>
            <div style={{ height: '100%', width: `${normScore}%`, background: `linear-gradient(90deg,${scoreColor}70,${scoreColor})`, borderRadius: 9999 }} />
          </div>
          <span style={{ fontSize: 11, color: scoreColor, fontWeight: 700, minWidth: 22, textAlign: 'right', fontFamily: 'monospace' }}>{normScore}</span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <span style={{ fontSize: 9, color: '#334155', marginRight: 2 }}>技</span>
            {[0,1,2,3,4].map(i => <div key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: i < techDots ? '#3B82F6' : '#1A2438' }} />)}
          </div>
          <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <span style={{ fontSize: 9, color: '#334155', marginRight: 2 }}>籌</span>
            {[0,1,2,3,4].map(i => <div key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: i < chipDots ? '#22C55E' : '#1A2438' }} />)}
          </div>
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>
        {isEntry
          ? <span style={{ fontSize: 11, color: '#22C55E', fontWeight: 700, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.28)', borderRadius: 9999, padding: '4px 10px' }}>進場</span>
          : <span style={{ fontSize: 11, color: '#3B82F6', fontWeight: 600, background: 'rgba(59,130,246,0.10)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 9999, padding: '4px 10px' }}>觀察</span>
        }
      </div>
    </div>
  )
}

/* ── AI Advice ───────────────────────────────────────────────────── */
function AIAdviceBlock({ aiInsight, dangerSignals, forbiddenActions }) {
  const bullets = []

  if (aiInsight) {
    aiInsight.split(/\n|。|【[^】]*】/).map(s => s.trim()).filter(s => s.length > 6).slice(0, 4).forEach(s => bullets.push({ text: s, type: 'info' }))
  }
  if (forbiddenActions?.length && bullets.length < 3) {
    forbiddenActions.slice(0, 2).forEach(s => bullets.push({ text: s, type: 'ban' }))
  }
  if (dangerSignals?.length && bullets.length < 3) {
    dangerSignals.slice(0, 2).forEach(s => bullets.push({ text: s, type: 'warn' }))
  }

  if (bullets.length === 0) return null

  const icons = { info: '·', ban: '🚫', warn: '⚠️' }
  const colors = { info: '#94A3B8', ban: '#EF4444', warn: '#F59E0B' }

  return (
    <div style={{ background: '#0F172A', borderRadius: 16, padding: '14px 16px', border: '1px solid #1E293B' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>🤖 AI 操作建議</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {bullets.map((b, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, lineHeight: 1.6 }}>
            <span style={{ flexShrink: 0, minWidth: 16, color: colors[b.type], marginTop: 1 }}>{icons[b.type]}</span>
            <span style={{ color: b.type === 'info' ? '#F8FAFC' : colors[b.type] }}>{b.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Risk Factors ────────────────────────────────────────────────── */
function RiskFactors({ factors }) {
  if (!factors?.length) return null
  const items = factors.slice(0, 4).map(f => typeof f === 'string' ? f : (f.description || '')).filter(Boolean)
  if (!items.length) return null
  return (
    <div style={{ background: '#0F172A', borderRadius: 16, padding: '14px 16px', border: '1px solid #1E293B' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>風險因子</div>
      {items.map((text, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: i < items.length - 1 ? 7 : 0 }}>
          <span style={{ color: '#EF4444', flexShrink: 0, fontSize: 12 }}>✓</span>
          <span style={{ fontSize: 13, color: '#94A3B8', lineHeight: 1.55 }}>{text}</span>
        </div>
      ))}
    </div>
  )
}

/* ── Main Export ─────────────────────────────────────────────────── */
export default function Overview({ data, error }) {
  const pred = data?.prediction || null
  const sortedDates = [...(data?.dates || [])].sort((a, b) => b.localeCompare(a))
  const latestDate = sortedDates[0]
  const scan = data?.scans?.[latestDate] || {}
  const stocks = scan.top_stocks || []
  const top5 = stocks.slice(0, 5)
  const maxScore = stocks.length > 0 ? Math.max(...stocks.map(s => s.entry_score || 0), 1) : 2000

  if (error && !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: '#94A3B8' }}>
        <div style={{ fontSize: 36 }}>⚠️</div>
        <div style={{ fontSize: 15, color: '#EF4444' }}>資料載入失敗</div>
        <div style={{ fontSize: 12, color: '#475569', fontFamily: 'monospace' }}>{error}</div>
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: '#94A3B8' }}>
        <div style={{ fontSize: 36 }}>📡</div>
        <div style={{ fontSize: 15 }}>載入市場資料中…</div>
      </div>
    )
  }

  const prob = pred?.xgb_prob_up ?? null
  const scenario = pred?.scenario || null
  const risk = pred?.risk || null
  const marketData = pred?.market_data || null
  const winRate = pred?.regime?.win_rate || null
  const aiInsight = pred?.ai_insight || ''

  return (
    <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch', background: '#070B14' }}>
      <div style={{ padding: '10px 14px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>

        {/* Row 1: Gauge + Risk */}
        <div style={{ display: 'flex', gap: 10 }}>
          <DirectionGauge prob={prob} winRate={winRate} />
          {(risk || marketData)
            ? <RiskCard risk={risk} marketData={marketData} />
            : <div style={{ flex: 1, background: '#0F172A', borderRadius: 16, border: '1px solid #1E293B', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 12, color: '#475569' }}>暫無風險資料</span>
              </div>
          }
        </div>

        {/* Row 2: Scenario */}
        {(scenario?.main_scenario || scenario?.best_strategy) && (
          <ScenarioBlock scenario={scenario} prob={prob} />
        )}

        {/* Row 3: TOP 5 */}
        {top5.length > 0 && (
          <div style={{ background: '#0F172A', borderRadius: 16, overflow: 'hidden', border: '1px solid #1E293B' }}>
            <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid #1E293B', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#F8FAFC' }}>⚡ 今日最強</span>
              <span style={{ fontSize: 11, color: '#475569' }}>{latestDate}</span>
            </div>
            {top5.map((stock, i) => (
              <StockMiniRow key={stock.stock_id} stock={stock} rank={i + 1} maxScore={maxScore} isLast={i === top5.length - 1} />
            ))}
            <div style={{ padding: '9px 14px', borderTop: '1px solid #1E293B', textAlign: 'center' }}>
              <span style={{ fontSize: 12, color: '#3B82F6' }}>完整排行請至掃描頁</span>
            </div>
          </div>
        )}

        {/* Row 4: AI Advice */}
        <AIAdviceBlock
          aiInsight={aiInsight}
          dangerSignals={scenario?.danger_signals}
          forbiddenActions={scenario?.forbidden_actions}
        />

        {/* Row 5: Risk Factors */}
        <RiskFactors factors={risk?.factors} />

      </div>
    </div>
  )
}
