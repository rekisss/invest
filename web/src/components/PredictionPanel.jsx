import { useState, useMemo, useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
gsap.registerPlugin(useGSAP)

const HIST_PAGE_SIZE = 20

const RISK_COLOR = { LOW: 'var(--ios-green)', MEDIUM: 'var(--ios-yellow)', HIGH: 'var(--ios-orange)', EXTREME: 'var(--ios-red)' }
const RISK_LABEL = { LOW: '低風險', MEDIUM: '中風險', HIGH: '高風險', EXTREME: '極高風險' }

function ProbBar({ prob }) {
  const pct = Math.round((prob ?? 0.5) * 100)
  const color = pct >= 60 ? 'var(--ios-green)' : pct <= 40 ? 'var(--ios-red)' : 'var(--ios-yellow)'
  const numRef = useRef(null)
  const barRef = useRef(null)
  useGSAP(() => {
    const obj = { val: 0 }
    gsap.to(obj, {
      val: pct, duration: 0.9, ease: 'power3.out', delay: 0.3,
      onUpdate() { if (numRef.current) numRef.current.textContent = Math.round(obj.val) + '%' },
    })
    gsap.from(barRef.current, { scaleX: 0, transformOrigin: 'left center', duration: 0.9, ease: 'power3.out', delay: 0.35 })
  }, { dependencies: [pct] })
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>空方</span>
        <span ref={numRef} style={{ color, fontWeight: 700, fontSize: 34, fontFamily: 'var(--font-mono)', letterSpacing: '-0.3px' }}>0%</span>
        <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>多方</span>
      </div>
      <div className="ios-prob-bar">
        <div ref={barRef} className="ios-prob-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

// Probability trend sparkline across recent prediction history
// Overlays actual market direction (next entry's night_change as proxy).
function ProbTrend({ history }) {
  const pts = useMemo(() => {
    const sorted = [...(history || [])]
      .filter(h => h.xgb_prob_up != null && h.date)
      .sort((a, b) => a.date.localeCompare(b.date))
    const recent = sorted.slice(-20)
    return recent.map((h, i) => {
      // actual direction proxy: next entry's night_change reflects what happened
      // after the trading day this prediction was made for (futures overnight session)
      const nextH = sorted[sorted.length - recent.length + i + 1]
      const nc = nextH?.market_data?.night_change
      const actual = nc != null ? (nc > 20 ? 1 : nc < -20 ? -1 : 0) : null
      return { date: h.date, p: h.xgb_prob_up, actual }
    })
  }, [history])
  if (pts.length < 3) return null

  const w = 300, h = 60, padY = 8
  const ps = pts.map(d => d.p)
  const lo = Math.min(...ps, 0.45), hi = Math.max(...ps, 0.55)
  const range = (hi - lo) || 1
  const xs = i => (i / (pts.length - 1)) * w
  const ys = p => padY + (1 - (p - lo) / range) * (h - padY * 2)
  const line = pts.map((d, i) => `${xs(i).toFixed(1)},${ys(d.p).toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  const lastPct = Math.round(last.p * 100)
  const lastColor = lastPct >= 60 ? 'var(--ios-green)' : lastPct <= 40 ? 'var(--ios-red)' : 'var(--ios-yellow)'
  const y50 = (lo <= 0.5 && hi >= 0.5) ? ys(0.5) : null
  const hasActual = pts.some(d => d.actual !== null)

  return (
    <Card title="預測機率走勢 vs 實際走向">
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
        {y50 != null && (
          <line x1={0} y1={y50} x2={w} y2={y50} stroke="var(--ios-label3)" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5" />
        )}
        <polyline points={line} fill="none" stroke={lastColor} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
        {pts.map((d, i) => {
          const isLast = i === pts.length - 1
          // Dot color: actual=1→green, actual=-1→red, actual=0→gray, null→default
          const dotFill = d.actual === 1 ? '#30D158'
            : d.actual === -1 ? '#FF453A'
            : isLast ? lastColor : 'var(--ios-label3)'
          const dotR = isLast ? 3.5 : d.actual !== null ? 3 : 1.8
          return (
            <circle key={d.date} cx={xs(i).toFixed(1)} cy={ys(d.p).toFixed(1)} r={dotR}
              fill={dotFill}
              stroke={d.actual !== null && !isLast ? 'rgba(0,0,0,0.4)' : 'none'}
              strokeWidth={1} />
          )
        })}
        <text x={xs(pts.length - 1)} y={ys(last.p) - 7} textAnchor="end" fontSize="10" fill={lastColor} fontWeight="700">{lastPct}%</text>
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ios-label3)', marginTop: 4 }}>
        <span>{pts[0].date.slice(5)}</span>
        {y50 != null && <span>虛線 = 50%</span>}
        <span>{last.date.slice(5)}</span>
      </div>
      {hasActual && (
        <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 10, color: 'var(--ios-label3)', flexWrap: 'wrap' }}>
          <span style={{ color: '#30D158', fontWeight: 700 }}>● 實際上漲</span>
          <span style={{ color: '#FF453A', fontWeight: 700 }}>● 實際下跌</span>
          <span style={{ color: 'var(--ios-label4)' }}>（隔日夜盤 ±20點估算）</span>
        </div>
      )}
    </Card>
  )
}

function Card({ title, accent, children }) {
  return (
    <div style={{
      background: 'var(--ios-bg2)', borderRadius: 16,
      marginBottom: 12, overflow: 'hidden',
      boxShadow: 'var(--shadow-card)',
      ...(accent ? { borderLeft: `3px solid ${accent}` } : {}),
    }}>
      {title && (
        <div style={{
          fontSize: 12, fontWeight: 700, letterSpacing: 0.5,
          color: accent || 'var(--ios-label2)',
          textTransform: 'uppercase',
          padding: '12px 16px 0',
        }}>{title}</div>
      )}
      <div style={{ padding: '12px 16px 14px' }}>{children}</div>
    </div>
  )
}

function Tag({ text, color }) {
  return (
    <span style={{
      display: 'inline-block', padding: '4px 12px', borderRadius: 9999,
      fontSize: 13, background: `${color}20`, color, fontWeight: 600,
      marginRight: 6, marginBottom: 4,
    }}>{text}</span>
  )
}

// Calibration analysis: actual win-rate per prediction confidence band
function CalibrationPanel({ history }) {
  const containerRef = useRef(null)
  const bands = useMemo(() => {
    const sorted = [...(history || [])]
      .filter(h => h.xgb_prob_up != null && h.date)
      .sort((a, b) => a.date.localeCompare(b.date))

    const defs = [
      { label: '強空', lo: 0,    hi: 0.42, center: 0.38 },
      { label: '弱空', lo: 0.42, hi: 0.50, center: 0.46 },
      { label: '中性', lo: 0.50, hi: 0.57, center: 0.53 },
      { label: '弱多', lo: 0.57, hi: 0.65, center: 0.61 },
      { label: '強多', lo: 0.65, hi: 1.01, center: 0.70 },
    ].map(d => ({ ...d, total: 0, actualUp: 0 }))

    for (let i = 0; i < sorted.length - 1; i++) {
      const nc = sorted[i + 1].market_data?.night_change
      if (nc == null) continue
      const p = sorted[i].xgb_prob_up
      const up = nc > 20
      const b = defs.find(d => p >= d.lo && p < d.hi)
      if (b) { b.total++; if (up) b.actualUp++ }
    }

    return defs.filter(b => b.total >= 3)
  }, [history])

  useGSAP(() => {
    if (!containerRef.current) return
    gsap.from('.calib-bar-fill', {
      scaleX: 0, transformOrigin: 'left center', duration: 0.6,
      stagger: 0.09, ease: 'power2.out', delay: 0.1,
    })
  }, { scope: containerRef, dependencies: [bands.length] })

  if (bands.length < 2) return null

  return (
    <Card title="預測校準分析">
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 10 }}>
        各信心區間的實際上漲率（隔日夜盤估算），與預測中心對比越近代表校準越好
      </div>
      <div ref={containerRef}>
      {bands.map(b => {
        const actualPct = Math.round(b.actualUp / b.total * 100)
        const expectedPct = Math.round(b.center * 100)
        const diff = actualPct - expectedPct
        const diffColor = Math.abs(diff) <= 8 ? 'var(--ios-green)' : Math.abs(diff) <= 18 ? 'var(--ios-yellow)' : 'var(--ios-red)'
        const barColor = actualPct >= 55 ? 'var(--ios-green)' : actualPct <= 45 ? 'var(--ios-red)' : 'var(--ios-yellow)'
        return (
          <div key={b.label} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ios-label)', minWidth: 32 }}>{b.label}</span>
              <span style={{ fontSize: 10, color: 'var(--ios-label3)', fontFamily: 'var(--font-mono)' }}>
                預測 {expectedPct}% · 實際 <b style={{ color: barColor }}>{actualPct}%</b>
                {' '}
                <span style={{ color: diffColor }}>({diff >= 0 ? '+' : ''}{diff}%)</span>
              </span>
              <span style={{ fontSize: 10, color: 'var(--ios-label4)', fontFamily: 'var(--font-mono)' }}>n={b.total}</span>
            </div>
            {/* Dual bar: expected vs actual */}
            <div style={{ position: 'relative', height: 6, background: 'var(--ios-fill3)', borderRadius: 9999, overflow: 'visible' }}>
              <div className="calib-bar-fill" style={{
                position: 'absolute', left: 0, top: 0, height: '100%',
                width: `${actualPct}%`, background: barColor, borderRadius: 9999,
                transition: 'width 0.6s cubic-bezier(0.34,1.56,0.64,1)',
              }} />
              {/* Expected marker */}
              <div style={{
                position: 'absolute', top: -2, width: 2, height: 10,
                left: `${expectedPct}%`, background: 'var(--ios-label3)',
                borderRadius: 1,
              }} />
            </div>
          </div>
        )
      })}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 4, lineHeight: 1.5 }}>
        灰色刻度線 = 模型預測中心值。若實際率持續高於預測代表模型偏保守；持續低於代表過於樂觀。
      </div>
    </Card>
  )
}

// Error pattern analysis: identify what conditions lead to wrong predictions
function ErrorPatternPanel({ history }) {
  const data = useMemo(() => {
    const sorted = [...(history || [])]
      .filter(h => h.xgb_prob_up != null && h.date)
      .sort((a, b) => a.date.localeCompare(b.date))

    if (sorted.length < 8) return null

    const strong = sorted.filter((_, i) => {
      const p = sorted[i].xgb_prob_up
      const nc = sorted[i + 1]?.market_data?.night_change
      return nc != null && Math.abs(p - 0.5) > 0.05
    })

    const errors = [], corrects = []
    for (let i = 0; i < sorted.length - 1; i++) {
      const h = sorted[i]
      const nc = sorted[i + 1].market_data?.night_change
      if (nc == null || Math.abs(h.xgb_prob_up - 0.5) <= 0.05) continue
      const predUp = h.xgb_prob_up > 0.55
      const actualUp = nc > 20
      const entry = {
        date: h.date, p: h.xgb_prob_up, actualUp,
        vix: h.market_data?.vix ?? 0,
        futures: h.market_data?.futures_net ?? 0,
        nc,
      }
      if (predUp !== actualUp) errors.push(entry); else corrects.push(entry)
    }

    if (errors.length === 0 && corrects.length === 0) return null

    const total = errors.length + corrects.length
    const errRate = Math.round(errors.length / total * 100)

    // Correlate conditions with errors
    const highVixErr = errors.filter(e => e.vix > 22).length
    const highVixTotal = [...errors, ...corrects].filter(e => e.vix > 22).length
    const highVixErrRate = highVixTotal >= 3 ? Math.round(highVixErr / highVixTotal * 100) : null

    const heavyShortErr = errors.filter(e => e.futures < -30000).length
    const heavyShortTotal = [...errors, ...corrects].filter(e => e.futures < -30000).length
    const heavyShortErrRate = heavyShortTotal >= 3 ? Math.round(heavyShortErr / heavyShortTotal * 100) : null

    const bullTrap = errors.filter(e => e.p > 0.55 && !e.actualUp)
    const bearTrap = errors.filter(e => e.p < 0.45 && e.actualUp)

    const recentErrors = errors.slice(-3)

    return { total, errRate, highVixErrRate, heavyShortErrRate, bullTrap: bullTrap.length, bearTrap: bearTrap.length, recentErrors }
  }, [history])

  if (!data) return null

  const errColor = data.errRate <= 30 ? 'var(--ios-green)' : data.errRate <= 45 ? 'var(--ios-yellow)' : 'var(--ios-red)'

  return (
    <Card title="預測錯誤模式分析">
      {/* Overall error rate */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 30, fontWeight: 700, fontFamily: 'var(--font-mono)', color: errColor, lineHeight: 1 }}>{data.errRate}%</div>
          <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 2 }}>整體錯誤率</div>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span style={{ color: 'var(--ios-label2)' }}>多殺多（看多錯）</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: data.bullTrap > 3 ? 'var(--ios-red)' : 'var(--ios-label)' }}>{data.bullTrap} 次</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span style={{ color: 'var(--ios-label2)' }}>空頭軋壓（看空錯）</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: data.bearTrap > 3 ? 'var(--ios-orange)' : 'var(--ios-label)' }}>{data.bearTrap} 次</span>
          </div>
        </div>
      </div>

      {/* Condition-specific error rates */}
      {(data.highVixErrRate != null || data.heavyShortErrRate != null) && (
        <div style={{ background: 'var(--ios-bg3)', borderRadius: 10, padding: '10px 12px', marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 6, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>高錯誤率情境</div>
          {data.highVixErrRate != null && (
            <div style={{ fontSize: 12, color: 'var(--ios-label2)', marginBottom: 4 }}>
              VIX {'>'}22 時：<b style={{ color: data.highVixErrRate > data.errRate + 10 ? 'var(--ios-red)' : 'var(--ios-label)' }}>{data.highVixErrRate}%</b> 錯誤率
              {data.highVixErrRate > data.errRate + 10 && <span style={{ color: 'var(--ios-red)', fontSize: 10, marginLeft: 4 }}>▲ 高於均值，宜降低倉位</span>}
            </div>
          )}
          {data.heavyShortErrRate != null && (
            <div style={{ fontSize: 12, color: 'var(--ios-label2)' }}>
              外資空單 {'>'}3萬口：<b style={{ color: data.heavyShortErrRate > data.errRate + 10 ? 'var(--ios-red)' : 'var(--ios-label)' }}>{data.heavyShortErrRate}%</b> 錯誤率
              {data.heavyShortErrRate > data.errRate + 10 && <span style={{ color: 'var(--ios-orange)', fontSize: 10, marginLeft: 4 }}>▲ 軋空風險高</span>}
            </div>
          )}
        </div>
      )}

      {/* Recent errors */}
      {data.recentErrors.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 6, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>近期預測失誤</div>
          {data.recentErrors.map(e => (
            <div key={e.date} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '3px 0', borderBottom: '0.5px solid var(--ios-sep)' }}>
              <span style={{ color: 'var(--ios-label3)', fontFamily: 'var(--font-mono)', minWidth: 60 }}>{e.date.slice(5)}</span>
              <span style={{ color: e.p > 0.5 ? 'var(--ios-green)' : 'var(--ios-red)', fontWeight: 700, fontFamily: 'var(--font-mono)', minWidth: 32 }}>{Math.round(e.p * 100)}%</span>
              <span style={{ color: 'var(--ios-label3)', fontSize: 10 }}>→</span>
              <span style={{ color: e.actualUp ? 'var(--ios-green)' : 'var(--ios-red)', fontWeight: 600 }}>{e.actualUp ? '實際↑' : '實際↓'}</span>
              {e.vix > 22 && <span style={{ fontSize: 10, color: 'var(--ios-orange)', background: 'rgba(255,159,10,0.12)', borderRadius: 4, padding: '1px 5px' }}>VIX高</span>}
              {e.futures < -30000 && <span style={{ fontSize: 10, color: 'var(--ios-red)', background: 'rgba(255,69,58,0.1)', borderRadius: 4, padding: '1px 5px' }}>空單重</span>}
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 8, lineHeight: 1.5 }}>
        樣本 {data.total} 筆 · 以隔日夜盤 ±20點為實際方向基準
      </div>
    </Card>
  )
}

function MarketDataGrid({ data }) {
  if (!data) return null
  const items = [
    { label: 'VIX', value: data.vix?.toFixed(1), color: data.vix > 25 ? 'var(--ios-red)' : data.vix > 18 ? 'var(--ios-yellow)' : 'var(--ios-green)' },
    { label: '那斯達克', value: data.nasdaq_ret != null ? `${(data.nasdaq_ret * 100).toFixed(2)}%` : '—', color: data.nasdaq_ret > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: '費半', value: data.sox_ret != null ? `${(data.sox_ret * 100).toFixed(2)}%` : '—', color: data.sox_ret > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: 'TSM ADR', value: data.tsm_adr_ret != null ? `${(data.tsm_adr_ret * 100).toFixed(2)}%` : '—', color: data.tsm_adr_ret > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: '外資期貨', value: data.futures_net != null ? `${data.futures_net > 0 ? '+' : ''}${Math.round(data.futures_net).toLocaleString()}口` : '—', color: data.futures_net > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: '夜盤', value: data.night_change != null ? `${data.night_change > 0 ? '+' : ''}${Math.round(data.night_change)}` : '—', color: data.night_change > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: 'PCR', value: data.pcr?.toFixed(2), color: data.pcr > 1.2 ? 'var(--ios-red)' : data.pcr < 0.8 ? 'var(--ios-green)' : 'var(--ios-label)' },
    { label: 'TAIEX RSI', value: data.taiex_rsi?.toFixed(0) || data.rsi14?.toFixed(0), color: 'var(--ios-label)' },
    { label: 'MACD 直方', value: data.macd_hist != null ? `${data.macd_hist > 0 ? '+' : ''}${data.macd_hist.toFixed(1)}` : null, color: data.macd_hist > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: '距 MA60', value: data.dist_ma60 != null ? `${data.dist_ma60 > 0 ? '+' : ''}${data.dist_ma60.toFixed(1)}%` : null, color: data.dist_ma60 > 0 ? 'var(--ios-green)' : 'var(--ios-red)' },
    { label: '夜盤趨勢', value: data.night_trend || null, color: 'var(--ios-label)' },
  ].filter(i => i.value && i.value !== 'undefined' && i.value !== 'NaN')

  return (
    <div className="ios-data-grid">
      {items.map(({ label, value, color }) => (
        <div key={label} className="ios-data-cell">
          <div className="ios-data-cell-label">{label}</div>
          <div className="ios-data-cell-value" style={{ color }}>{value}</div>
        </div>
      ))}
    </div>
  )
}

function HistoryRow({ entry }) {
  const [open, setOpen] = useState(false)
  const pct = Math.round((entry.xgb_prob_up ?? 0.5) * 100)
  const color = pct >= 60 ? 'var(--ios-green)' : pct <= 40 ? 'var(--ios-red)' : 'var(--ios-yellow)'
  const riskLevel = entry.risk?.level?.replace('RiskLevel.', '') || 'MEDIUM'

  return (
    <div style={{ borderBottom: '0.5px solid var(--ios-sep)' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }}
      >
        <div style={{ minWidth: 76, fontSize: 13, color: 'var(--ios-label2)', fontFamily: 'var(--font-mono)' }}>{entry.date}</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color, fontSize: 17, minWidth: 48 }}>{pct}%</div>
        <div style={{ flex: 1, fontSize: 14, color: 'var(--ios-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.xgb_label || (pct >= 55 ? '偏多' : pct <= 45 ? '偏空' : '中性')}
          {entry.regime?.label_zh ? ` · ${entry.regime.label_zh.slice(0, 20)}` : ''}
        </div>
        <div style={{ fontSize: 12, color: RISK_COLOR[riskLevel] || 'var(--ios-label2)', flexShrink: 0, fontWeight: 600 }}>
          {RISK_LABEL[riskLevel] || riskLevel}
        </div>
        <span style={{ color: 'var(--ios-label3)', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ padding: '0 16px 14px', background: 'var(--ios-bg3)' }}>
          {entry.scenario?.main_scenario && (
            <div style={{ fontSize: 13, color: 'var(--ios-label2)', lineHeight: 1.6, marginBottom: 8 }}>{entry.scenario.main_scenario}</div>
          )}
          {entry.scenario?.best_strategy && (
            <div style={{ fontSize: 13, color: 'var(--ios-blue)', marginBottom: 8 }}>策略：{entry.scenario.best_strategy}</div>
          )}
          {entry.market_data && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[
                ['VIX', entry.market_data.vix?.toFixed(1)],
                ['那斯達克', entry.market_data.nasdaq_ret != null ? `${(entry.market_data.nasdaq_ret * 100).toFixed(2)}%` : null],
                ['外資期貨', entry.market_data.futures_net != null ? `${Math.round(entry.market_data.futures_net).toLocaleString()}口` : null],
                ['夜盤', entry.market_data.night_change != null ? `${entry.market_data.night_change > 0 ? '+' : ''}${Math.round(entry.market_data.night_change)}` : null],
              ].filter(([, v]) => v).map(([label, val]) => (
                <span key={label} style={{ fontSize: 12, background: 'var(--ios-bg2)', borderRadius: 8, padding: '3px 9px', color: 'var(--ios-label)' }}>
                  {label} <b>{val}</b>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function PredictionPanel({ prediction, history = [] }) {
  if (!prediction) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 48 }}>🔮</div>
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ios-label)' }}>尚無盤前預測</div>
        <div style={{ fontSize: 14, color: 'var(--ios-label2)', maxWidth: 280, lineHeight: 1.6 }}>每個交易日盤前執行後，這裡會顯示 AI 預測分析、市場結構分析、風險評估</div>
      </div>
    )
  }

  const { xgb_prob_up, xgb_label, date, generated_at, regime, scenario, risk, news_sentiment, market_data, ai_insight } = prediction
  const riskLevel = risk?.level?.replace('RiskLevel.', '') || 'MEDIUM'
  const riskBarRef = useRef(null)
  const bullBearRef = useRef(null)
  useGSAP(() => {
    if (riskBarRef.current) gsap.from(riskBarRef.current, { scaleX: 0, transformOrigin: 'left center', duration: 0.7, ease: 'power3.out', delay: 0.2 })
    if (bullBearRef.current) gsap.from(bullBearRef.current, { scaleX: 0, transformOrigin: 'left center', duration: 0.7, ease: 'power3.out', delay: 0.2 })
  }, { dependencies: [date] })
  const [histPage, setHistPage] = useState(0)
  const histTotalPages = Math.ceil(history.length / HIST_PAGE_SIZE)
  const pagedHistory = useMemo(
    () => history.slice(histPage * HIST_PAGE_SIZE, (histPage + 1) * HIST_PAGE_SIZE),
    [history, histPage]
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      {/* Sticky date line */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 2,
        padding: '6px 20px',
        background: 'var(--ios-bg)',
        borderBottom: '0.5px solid var(--ios-sep)',
        fontSize: 13, color: 'var(--ios-label2)',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>{date}</span>
        <span>{generated_at} CST</span>
      </div>

      <div style={{ padding: '14px 16px 0' }}>
        {/* Prediction probability */}
        <Card title="AI 大盤預測" accent="var(--ios-blue)">
          <ProbBar prob={xgb_prob_up} />
          <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap' }}>
            <Tag text={xgb_label || (xgb_prob_up >= 0.55 ? '偏多' : xgb_prob_up <= 0.45 ? '偏空' : '中性')}
              color={xgb_prob_up >= 0.55 ? 'var(--ios-green)' : xgb_prob_up <= 0.45 ? 'var(--ios-red)' : 'var(--ios-yellow)'} />
            {regime && <Tag text={`勝率 ${regime.win_rate > 1 ? regime.win_rate : Math.round(regime.win_rate * 100)}%`} color="var(--ios-blue)" />}
          </div>
          {regime?.label_zh && (
            <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--ios-bg3)', borderRadius: 10, fontSize: 14, color: 'var(--ios-label)', lineHeight: 1.5 }}>
              {regime.label_zh}
            </div>
          )}
        </Card>

        {/* Probability trend across recent days */}
        <ProbTrend history={history} />

        {/* Calibration & error analysis */}
        <CalibrationPanel history={history} />
        <ErrorPatternPanel history={history} />

        {/* AI Insight */}
        {ai_insight && (
          <Card title="🤖 AI 操盤要點" accent="var(--ios-purple)">
            <div style={{ fontSize: 14, lineHeight: 1.9, whiteSpace: 'pre-line', color: 'var(--ios-label)' }}>
              {ai_insight}
            </div>
          </Card>
        )}

        {/* Market data */}
        {market_data && (market_data.vix != null || market_data.nasdaq_ret != null || market_data.futures_net != null || market_data.night_change != null) && (
          <Card title="市場指標">
            <MarketDataGrid data={market_data} />
          </Card>
        )}

        {/* Scenario */}
        {scenario && (
          <Card title="市場結構分析" accent="var(--ios-yellow)">
            {scenario.main_scenario && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>主力劇本</div>
                <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ios-label)' }}>{scenario.main_scenario}</div>
              </div>
            )}
            {scenario.best_strategy && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>最佳策略</div>
                <div style={{ fontSize: 14, color: 'var(--ios-blue)', lineHeight: 1.7 }}>{scenario.best_strategy}</div>
              </div>
            )}
            {scenario.danger_signals?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>⚠️ 危險訊號</div>
                {scenario.danger_signals.map((s, i) => (
                  <div key={i} style={{ fontSize: 13, color: 'var(--ios-orange)', padding: '3px 0' }}>· {s}</div>
                ))}
              </div>
            )}
            {scenario.forbidden_actions?.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>🚫 禁止操作</div>
                {scenario.forbidden_actions.map((s, i) => (
                  <div key={i} style={{ fontSize: 13, color: 'var(--ios-red)', padding: '3px 0' }}>· {s}</div>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* Risk */}
        {risk && (
          <Card title="風險評估" accent={RISK_COLOR[riskLevel]}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: RISK_COLOR[riskLevel], letterSpacing: '-0.3px' }}>
                {RISK_LABEL[riskLevel] || riskLevel}
              </div>
              <div className="ios-prob-bar" style={{ flex: 1 }}>
                <div ref={riskBarRef} className="ios-prob-fill" style={{ width: `${(risk.score || 0) * 100}%`, background: RISK_COLOR[riskLevel] }} />
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--ios-label2)', minWidth: 32 }}>{((risk.score || 0) * 100).toFixed(0)}%</div>
            </div>
            {risk.factors?.length > 0 && risk.factors.map((f, i) => (
              <div key={i} style={{ fontSize: 13, color: 'var(--ios-label2)', padding: '3px 0' }}>
                · {typeof f === 'string' ? f : (f.description || f.name || '')}
                {typeof f !== 'string' && f.action && <span style={{ color: 'var(--ios-blue)', marginLeft: 6 }}>→ {f.action}</span>}
              </div>
            ))}
          </Card>
        )}

        {/* News sentiment */}
        {news_sentiment && (
          <Card title="新聞情緒">
            <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
              {[
                { label: '利多', val: news_sentiment.bullish_count, color: 'var(--ios-green)' },
                { label: '利空', val: news_sentiment.bearish_count, color: 'var(--ios-red)' },
                { label: '市場影響', val: `${news_sentiment.market_impact > 0 ? '+' : ''}${news_sentiment.market_impact?.toFixed(2)}`, color: news_sentiment.market_impact > 0 ? 'var(--ios-green)' : news_sentiment.market_impact < 0 ? 'var(--ios-red)' : 'var(--ios-label2)' },
              ].map(({ label, val, color }) => (
                <div key={label} style={{ flex: 1, background: 'var(--ios-bg3)', borderRadius: 12, padding: '10px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: 'var(--font-mono)' }}>{val}</div>
                </div>
              ))}
            </div>
            {/* Bull/bear ratio bar */}
            {(news_sentiment.bullish_count > 0 || news_sentiment.bearish_count > 0) && (() => {
              const b = news_sentiment.bullish_count || 0
              const r = news_sentiment.bearish_count || 0
              const total = b + r
              const bp = total > 0 ? (b / total) * 100 : 50
              return (
                <div style={{ marginBottom: 12 }}>
                  <div ref={bullBearRef} style={{ display: 'flex', height: 8, borderRadius: 9999, overflow: 'hidden', background: 'var(--ios-bg3)' }}>
                    <div style={{ width: `${bp}%`, background: 'var(--ios-green)' }} />
                    <div style={{ width: `${100 - bp}%`, background: 'var(--ios-red)' }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ios-label3)', marginTop: 4 }}>
                    <span style={{ color: 'var(--ios-green)' }}>偏多 {Math.round(bp)}%</span>
                    <span style={{ color: 'var(--ios-red)' }}>偏空 {Math.round(100 - bp)}%</span>
                  </div>
                </div>
              )
            })()}
            {news_sentiment.key_events?.length > 0 && (
              <div>
                {news_sentiment.key_events.slice(0, 5).map((e, i) => (
                  <div key={i} style={{ fontSize: 13, color: 'var(--ios-label)', padding: '6px 0', borderBottom: '0.5px solid var(--ios-sep)' }}>· {e}</div>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* History with pagination */}
        {history.length > 0 && (
          <Card title={`歷史記錄（${history.length} 筆）`}>
            <div style={{ margin: '0 -16px' }}>
              {pagedHistory.map((entry, i) => <HistoryRow key={entry.date || i} entry={entry} />)}
            </div>
            {histTotalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, paddingTop: 12 }}>
                <button
                  onClick={() => setHistPage(p => Math.max(0, p - 1))}
                  disabled={histPage === 0}
                  style={{
                    background: histPage === 0 ? 'var(--ios-fill2)' : 'var(--ios-blue)',
                    color: histPage === 0 ? 'var(--ios-label3)' : '#fff',
                    border: 'none', borderRadius: 9999, padding: '5px 14px', fontSize: 12,
                    cursor: histPage === 0 ? 'default' : 'pointer',
                  }}
                >上一頁</button>
                <span style={{ fontSize: 12, color: 'var(--ios-label3)' }}>
                  {histPage + 1} / {histTotalPages}
                </span>
                <button
                  onClick={() => setHistPage(p => Math.min(histTotalPages - 1, p + 1))}
                  disabled={histPage >= histTotalPages - 1}
                  style={{
                    background: histPage >= histTotalPages - 1 ? 'var(--ios-fill2)' : 'var(--ios-blue)',
                    color: histPage >= histTotalPages - 1 ? 'var(--ios-label3)' : '#fff',
                    border: 'none', borderRadius: 9999, padding: '5px 14px', fontSize: 12,
                    cursor: histPage >= histTotalPages - 1 ? 'default' : 'pointer',
                  }}
                >下一頁</button>
              </div>
            )}
          </Card>
        )}
      </div>

      <div style={{ height: 24 }} />
    </div>
  )
}
