import { useState, useMemo, memo, useEffect, useRef, useCallback } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
gsap.registerPlugin(useGSAP)
import StockDetailModal from './StockDetailModal'

/* ── Live Market Constants ───────────────────────────────────────── */
const LIVE_CACHE_KEY = 'live_mkt_v1'
const LIVE_TTL = 15 * 60 * 1000
const MDT_STORE = 'mkt_data_token'
const URT_STORE = 'unirate_api_key'

function useLiveMarket(mdt, urt) {
  const [live, setLive] = useState(() => {
    try {
      const c = JSON.parse(sessionStorage.getItem(LIVE_CACHE_KEY) || 'null')
      if (c && Date.now() - c.ts < LIVE_TTL) return c
    } catch {}
    return null
  })

  useEffect(() => {
    if (!mdt && !urt) return
    // Check sessionStorage (not React state) so saveKeys()'s removeItem takes effect immediately
    try {
      const c = JSON.parse(sessionStorage.getItem(LIVE_CACHE_KEY) || 'null')
      if (c && Date.now() - c.ts < LIVE_TTL) return
    } catch {}
    let alive = true
    const go = async () => {
      const r = {}
      if (mdt) {
        try {
          const res = await fetch(
            `https://api.marketdata.app/v1/indices/quotes/SPX,SOX,NDX/?token=${mdt}`,
            { headers: { Accept: 'application/json' } }
          )
          const d = await res.json()
          if (d.s === 'ok' && Array.isArray(d.symbol)) {
            d.symbol.forEach((sym, i) => {
              r[sym.toUpperCase()] = { price: d.last?.[i] ?? null, chg: d.changepct?.[i] ?? null }
            })
          }
        } catch {}
      }
      if (urt) {
        try {
          const res = await fetch(`https://api.unirateapi.com/api/rates?api_key=${urt}&currency=USD`)
          const d = await res.json()
          if (d?.rates?.TWD) r.USDTWD = d.rates.TWD
        } catch {}
      }
      if (!alive) return
      const out = { ...r, ts: Date.now() }
      try { sessionStorage.setItem(LIVE_CACHE_KEY, JSON.stringify(out)) } catch {}
      setLive(out)
    }
    go()
    return () => { alive = false }
  }, [mdt, urt])

  return live
}

/* ── Live Market Strip ───────────────────────────────────────────── */
function LiveMarketStrip() {
  const [mdt, setMdt] = useState(() => localStorage.getItem(MDT_STORE) || '')
  const [urt, setUrt] = useState(() => localStorage.getItem(URT_STORE) || '')
  const [showSetup, setShowSetup] = useState(false)
  const [mdtInput, setMdtInput] = useState('')
  const [urtInput, setUrtInput] = useState('')

  const live = useLiveMarket(mdt, urt)

  const saveKeys = () => {
    const m = mdtInput.trim(), u = urtInput.trim()
    // Always set or remove — blank input clears a previously saved key
    if (m) { localStorage.setItem(MDT_STORE, m) } else { localStorage.removeItem(MDT_STORE) }
    if (u) { localStorage.setItem(URT_STORE, u) } else { localStorage.removeItem(URT_STORE) }
    setMdt(m); setUrt(u)
    // Clear sessionStorage cache so useLiveMarket re-fetches with new keys immediately
    try { sessionStorage.removeItem(LIVE_CACHE_KEY) } catch {}
    setShowSetup(false)
  }

  const chgColor = v => v == null ? 'var(--ios-label3)'
    : v > 0 ? '#30D158' : v < 0 ? '#FF453A' : '#FF9F0A'
  const fmtChg = v => v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`

  const keysSet = mdt || urt
  const hasData = live && (live.SPX || live.SOX || live.NDX || live.USDTWD)

  // Setup panel
  if (showSetup) {
    return (
      <div className="glass-panel" style={{ padding: '12px 14px' }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>即時市場 · 設定</div>
        <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 10, lineHeight: 1.6 }}>
          輸入 API Key 後可顯示即時 SPX/SOX/NASDAQ 及 USD/TWD 匯率（15分鐘快取）。
        </div>
        {[
          { label: 'Market Data Token (SPX/SOX/NDX)', val: mdtInput, set: setMdtInput, ph: '貼上 marketdata.app token' },
          { label: 'UniRate API Key (USD/TWD)', val: urtInput, set: setUrtInput, ph: '貼上 unirateapi.com key' },
        ].map(f => (
          <div key={f.label} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 4 }}>{f.label}</div>
            <input
              style={{ width: '100%', boxSizing: 'border-box', background: 'var(--ios-fill3)', border: '1px solid var(--ios-sep)', borderRadius: 8, padding: '8px 10px', color: 'var(--ios-label)', fontSize: 12, fontFamily: 'monospace', outline: 'none' }}
              type="password"
              placeholder={f.ph}
              value={f.val}
              onChange={e => f.set(e.target.value)}
            />
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button onClick={saveKeys} style={{ flex: 1, background: '#0A84FF', color: 'var(--ios-label)', border: 'none', borderRadius: 8, padding: '8px 0', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>儲存</button>
          <button onClick={() => setShowSetup(false)} style={{ flex: 1, background: 'var(--ios-fill2)', color: 'var(--ios-label2)', border: 'none', borderRadius: 8, padding: '8px 0', fontSize: 13, cursor: 'pointer' }}>取消</button>
        </div>
      </div>
    )
  }

  // No keys configured yet
  if (!keysSet) {
    return (
      <div className="glass-panel" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--ios-label3)' }}>即時市場（未設定）</span>
        <button onClick={() => setShowSetup(true)} style={{ background: 'rgba(10,132,255,0.15)', color: '#0A84FF', border: '1px solid rgba(10,132,255,0.3)', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>⚙ 設定</button>
      </div>
    )
  }

  // Keys set but no data yet (loading or error)
  if (!hasData) {
    return (
      <div className="glass-panel" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--ios-label4)' }}>即時市場載入中…</span>
        <button onClick={() => setShowSetup(true)} style={{ background: 'transparent', color: 'var(--ios-label4)', border: 'none', fontSize: 14, cursor: 'pointer', padding: '2px 6px' }}>⚙</button>
      </div>
    )
  }

  const items = [
    live.SPX && { label: 'S&P 500', val: live.SPX.chg },
    live.SOX && { label: 'SOX',     val: live.SOX.chg },
    live.NDX && { label: 'NASDAQ',  val: live.NDX.chg },
  ].filter(Boolean)

  const now = new Date(live.ts)
  const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`

  return (
    <div className="glass-panel" style={{ padding: '10px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', textTransform: 'uppercase', letterSpacing: 0.8 }}>即時市場</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 9, color: 'var(--ios-label4)', fontFamily: 'monospace' }}>更新 {timeStr}</span>
          <button onClick={() => setShowSetup(true)} style={{ background: 'transparent', color: 'var(--ios-label4)', border: 'none', fontSize: 12, cursor: 'pointer', padding: '0 2px' }}>⚙</button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 0 }}>
        {items.map((it, idx) => (
          <div key={it.label} style={{
            flex: '1 1 0',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: '4px 6px',
            borderRight: (idx < items.length - 1 || live.USDTWD) ? '1px solid var(--ios-sep)' : 'none',
          }}>
            <span style={{ fontSize: 9, color: 'var(--ios-label3)', marginBottom: 2 }}>{it.label}</span>
            <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'monospace', color: chgColor(it.val) }}>
              {fmtChg(it.val)}
            </span>
          </div>
        ))}
        {live.USDTWD && (
          <div style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4px 6px' }}>
            <span style={{ fontSize: 9, color: 'var(--ios-label3)', marginBottom: 2 }}>USD/TWD</span>
            <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'monospace', color: '#0A84FF' }}>
              {Number(live.USDTWD).toFixed(2)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── SVG Direction Gauge ─────────────────────────────────────────── */
const DirectionGauge = memo(function DirectionGauge({ prob = 0.5, winRate }) {
  const { pct, isBull, isBear, color, confidence, cx, cy, r, nx, ny, nx2, ny2 } = useMemo(() => {
    const pct = Math.max(2, Math.min(98, Math.round((prob ?? 0.5) * 100)))
    const isBull = pct >= 55, isBear = pct <= 45
    const color = isBull ? '#30D158' : isBear ? '#FF453A' : '#FF9F0A'
    const confidence = isBull ? pct : isBear ? (100 - pct) : 50
    const cx = 80, cy = 68, r = 56
    const ang = ((-180 + pct * 1.8) * Math.PI) / 180
    return {
      pct, isBull, isBear, color, confidence, cx, cy, r,
      nx:  (cx + r * Math.cos(ang)).toFixed(2),
      ny:  (cy + r * Math.sin(ang)).toFixed(2),
      nx2: (cx + (r - 14) * Math.cos(ang)).toFixed(2),
      ny2: (cy + (r - 14) * Math.sin(ang)).toFixed(2),
    }
  }, [prob])

  const glowRef = useRef(null)
  const arcRef  = useRef(null)

  useGSAP(() => {
    const arc  = arcRef.current
    const glow = glowRef.current
    if (!arc) return
    const len = arc.getTotalLength()
    gsap.set([arc, glow], { strokeDasharray: len, strokeDashoffset: len })
    const tl = gsap.timeline({ paused: true, delay: 0.55 })
    tl.to(glow, { strokeDashoffset: 0, duration: 1.1, ease: 'power3.out' }, 0)
    tl.to(arc,  { strokeDashoffset: 0, duration: 1.0, ease: 'power3.out' }, 0.05)
    const io = new IntersectionObserver(es => {
      if (es[0].isIntersecting) { tl.play(); io.disconnect() }
    }, { threshold: 0.2 })
    io.observe(arc)
    return () => io.disconnect()
  }, { dependencies: [pct] })

  return (
    <div className="glass-panel" style={{ flex: 1, padding: '12px 12px 10px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2 }}>大盤方向</div>
      {/* viewBox height 96 → 100: prevents the confidence% text (baseline y≈94) from being clipped */}
      <svg viewBox="0 0 160 100" style={{ width: '100%', display: 'block' }}>
        {/* glow */}
        <path ref={glowRef} d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${nx},${ny}`} stroke={color} strokeWidth="18" fill="none" strokeLinecap="round" opacity="0.12" />
        {/* track */}
        <path d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`} style={{ stroke: 'var(--ios-fill2)' }} strokeWidth="9" fill="none" strokeLinecap="round" />
        {/* value arc — animated */}
        <path ref={arcRef} d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${nx},${ny}`} stroke={color} strokeWidth="9" fill="none" strokeLinecap="round" />
        {/* needle */}
        <line x1={cx} y1={cy} x2={nx2} y2={ny2} style={{ stroke: 'var(--ios-label)' }} strokeWidth="2" strokeLinecap="round" />
        {/* center dot */}
        <circle cx={cx} cy={cy} r="5" fill={color} />
        <circle cx={cx} cy={cy} r="2.5" style={{ fill: 'var(--ios-label)' }} />
        {/* side labels */}
        <text x={cx - r - 3} y={cy + 14} textAnchor="middle" fontSize="9" fill="#EF4444" fontWeight="700">空</text>
        <text x={cx + r + 3} y={cy + 14} textAnchor="middle" fontSize="9" fill="#22C55E" fontWeight="700">多</text>
        {/* big % — baseline at y=94, safely within the 100px viewBox */}
        <text x={cx} y={cy + 26} textAnchor="middle" fontSize="20" fontWeight="800" fill={color} fontFamily="monospace">{confidence}%</text>
      </svg>
      <div style={{ textAlign: 'center', marginTop: 0 }}>
        <span style={{ fontSize: 16, fontWeight: 800, color, letterSpacing: '-0.3px' }}>
          {isBull ? '偏多 ↑' : isBear ? '偏空 ↓' : '中性 →'}
        </span>
        {winRate != null && winRate > 0 && (
          <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginTop: 3 }}>
            勝率 ~{winRate > 1 ? Math.round(winRate) : Math.round(winRate * 100)}%
          </div>
        )}
      </div>
    </div>
  )
})

/* ── Risk Card ───────────────────────────────────────────────────── */
function RiskCard({ risk, marketData, calendarRisk }) {
  const level = (risk?.level || '').replace('RiskLevel.', '') || 'MEDIUM'
  const score = risk?.score || 0.5
  const cfg = {
    LOW:     { label: '低風險', color: '#30D158', bg: 'rgba(34,197,94,0.13)' },
    MEDIUM:  { label: '中風險', color: '#FF9F0A', bg: 'rgba(245,158,11,0.13)' },
    HIGH:    { label: '高風險', color: '#FF453A', bg: 'rgba(239,68,68,0.13)' },
    EXTREME: { label: '極高危', color: '#FF0000', bg: 'rgba(239,68,68,0.22)' },
  }[level] || { label: '中風險', color: '#FF9F0A', bg: 'rgba(245,158,11,0.13)' }

  const rows = [
    calendarRisk && ['日曆風險', calendarRisk, '#FF9F0A'],
    marketData?.vix != null && ['VIX', marketData.vix.toFixed(1), marketData.vix > 25 ? '#FF453A' : marketData.vix > 18 ? '#FF9F0A' : '#30D158'],
    marketData?.futures_net != null && ['外資期貨', `${marketData.futures_net > 0 ? '+' : ''}${Math.round(marketData.futures_net).toLocaleString()}`, marketData.futures_net > 0 ? '#30D158' : '#FF453A'],
    marketData?.night_change != null && ['夜盤', `${marketData.night_change > 0 ? '+' : ''}${Math.round(marketData.night_change)}`, marketData.night_change > 0 ? '#30D158' : '#FF453A'],
  ].filter(Boolean)

  const riskBarRef = useRef(null)
  useGSAP(() => {
    const el = riskBarRef.current
    if (!el) return
    const tw = gsap.from(el, { scaleX: 0, transformOrigin: 'left center', duration: 0.8, ease: 'power3.out', delay: 0.5, paused: true })
    const io = new IntersectionObserver(es => {
      if (es[0].isIntersecting) { tw.play(); io.disconnect() }
    }, { threshold: 0.2 })
    io.observe(el)
    return () => io.disconnect()
  }, { dependencies: [score] })

  return (
    <div className="glass-panel" style={{ flex: 1, padding: '12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', textTransform: 'uppercase', letterSpacing: 0.8 }}>今日風險</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ padding: '4px 10px', borderRadius: 8, background: cfg.bg, fontSize: 13, fontWeight: 800, color: cfg.color, whiteSpace: 'nowrap' }}>{cfg.label}</div>
        <div style={{ flex: 1, height: 4, background: 'var(--ios-fill2)', borderRadius: 9999 }}>
          <div ref={riskBarRef} style={{ height: '100%', width: `${Math.round(score * 100)}%`, background: cfg.color, borderRadius: 9999 }} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {rows.map(([label, val, color]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--ios-label2)' }}>{label}</span>
            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace', color }}>{val}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Market Signals Card ─────────────────────────────────────────── */
function MarketSignalsCard({ marketData }) {
  if (!marketData) return null

  const fmt = (v, digits = 1) => {
    if (v == null) return null
    const n = Number(v)
    const sign = n > 0 ? '+' : ''
    return `${sign}${(n * 100).toFixed(digits)}%`
  }
  const color = v => v == null ? 'var(--ios-label3)' : v > 0 ? '#30D158' : v < 0 ? '#FF453A' : '#FF9F0A'

  const usRows = [
    { label: 'S&P500', val: marketData.sp500_ret, fmt: fmt(marketData.sp500_ret) },
    { label: 'NASDAQ', val: marketData.nasdaq_ret, fmt: fmt(marketData.nasdaq_ret) },
    { label: 'SOX',    val: marketData.sox_ret,    fmt: fmt(marketData.sox_ret) },
    { label: 'TSM',    val: marketData.tsm_adr_ret, fmt: fmt(marketData.tsm_adr_ret) },
  ].filter(r => r.fmt != null)

  const riskRows = [
    marketData.jpy_ret  != null && { label: '日圓',  val: marketData.jpy_ret,  fmt: fmt(marketData.jpy_ret, 2) },
    marketData.hyg_ret  != null && { label: 'HYG',   val: marketData.hyg_ret,  fmt: fmt(marketData.hyg_ret) },
    marketData.arkk_ret != null && { label: 'ARKK',  val: marketData.arkk_ret, fmt: fmt(marketData.arkk_ret) },
  ].filter(Boolean)

  if (usRows.length === 0 && riskRows.length === 0) return null

  return (
    <div className="glass-panel" style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>美股夜盤 · 籌碼</div>
      <div style={{ display: 'flex', gap: 10 }}>
        {usRows.length > 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 9, color: 'var(--ios-label4)', marginBottom: 2 }}>美股</div>
            {usRows.map(r => (
              <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--ios-label2)' }}>{r.label}</span>
                <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace', color: color(r.val) }}>{r.fmt}</span>
              </div>
            ))}
          </div>
        )}
        {riskRows.length > 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, borderLeft: '1px solid var(--ios-sep)', paddingLeft: 12 }}>
            <div style={{ fontSize: 9, color: 'var(--ios-label4)', marginBottom: 2 }}>風險情緒</div>
            {riskRows.map(r => (
              <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--ios-label2)' }}>{r.label}</span>
                <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace', color: color(r.val) }}>{r.fmt}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Scenario Block ──────────────────────────────────────────────── */
function ScenarioBlock({ scenario, prob }) {
  const pct = Math.round((prob ?? 0.5) * 100)
  const isBull = pct >= 55, isBear = pct <= 45
  const accentColor = isBull ? '#30D158' : isBear ? '#FF453A' : '#FF9F0A'

  if (!scenario?.main_scenario && !scenario?.best_strategy) return null

  return (
    <div className="glass-panel" style={{ padding: '14px 16px', borderLeft: `3px solid ${accentColor}` }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>今日劇本</div>
      {scenario.market_type && (
        <div style={{ fontSize: 12, color: 'var(--ios-label2)', marginBottom: 8 }}>
          市場類型：<span style={{ color: 'var(--ios-label)', fontWeight: 600 }}>{scenario.market_type}</span>
        </div>
      )}
      {scenario.main_scenario && (
        <div style={{ fontSize: 14, color: 'var(--ios-label)', lineHeight: 1.65, marginBottom: 10 }}>{scenario.main_scenario}</div>
      )}
      {scenario.best_strategy && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(10,132,255,0.14)', borderRadius: 8, padding: '6px 12px', fontSize: 13, color: '#0A84FF', fontWeight: 600, marginBottom: scenario.forbidden_actions?.length ? 10 : 0 }}>
          🎯 {scenario.best_strategy}
        </div>
      )}
      {scenario.forbidden_actions?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {scenario.forbidden_actions.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 13, color: '#FF453A' }}>
              <span style={{ flexShrink: 0 }}>🚫</span><span>{a}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const GRADE_COLOR = { A: '#FFD60A', B: '#30D158', C: '#FF9F0A', D: '#64748B', X: '#FF453A' }

/* ── Stock Mini Row (TOP 5) ──────────────────────────────────────── */
function StockMiniRow({ stock, rank, maxScore, isLast }) {
  const normScore = Math.min(Math.round((stock.entry_score || 0) / maxScore * 100), 99)
  const isEntry = stock.entry_signal
  const scoreColor = isEntry ? '#30D158' : normScore >= 70 ? '#0A84FF' : 'var(--ios-label2)'
  const grade = stock.grade || ''

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

  const scoreBarRef = useRef(null)
  useGSAP(() => {
    const el = scoreBarRef.current
    if (!el) return
    const tw = gsap.from(el, { scaleX: 0, transformOrigin: 'left center', duration: 0.65, ease: 'power2.out', paused: true })
    const io = new IntersectionObserver(es => {
      if (es[0].isIntersecting) { tw.play(); io.disconnect() }
    }, { threshold: 0.2 })
    io.observe(el)
    return () => io.disconnect()
  }, { dependencies: [normScore] })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderBottom: isLast ? 'none' : '1px solid var(--ios-sep)', background: isEntry ? 'rgba(34,197,94,0.04)' : 'transparent' }}>
      <div style={{ fontSize: 12, color: 'var(--ios-label4)', fontFamily: 'monospace', minWidth: 18, textAlign: 'right' }}>{rank}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 5 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-blue)', fontFamily: 'monospace', flexShrink: 0 }}>{stock.stock_id}</span>
          <span style={{ fontSize: 13, color: 'var(--ios-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stock.name}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
          <div style={{ flex: 1, height: 3, background: 'var(--ios-fill2)', borderRadius: 9999 }}>
            <div ref={scoreBarRef} style={{ height: '100%', width: `${normScore}%`, background: `linear-gradient(90deg,${scoreColor}70,${scoreColor})`, borderRadius: 9999 }} />
          </div>
          <span style={{ fontSize: 11, color: scoreColor, fontWeight: 700, minWidth: 22, textAlign: 'right', fontFamily: 'monospace' }}>{normScore}</span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <span style={{ fontSize: 9, color: 'var(--ios-label4)', marginRight: 2 }}>技</span>
            {[0,1,2,3,4].map(i => <div key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: i < techDots ? 'var(--ios-blue)' : 'var(--ios-fill2)' }} />)}
          </div>
          <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <span style={{ fontSize: 9, color: 'var(--ios-label4)', marginRight: 2 }}>籌</span>
            {[0,1,2,3,4].map(i => <div key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: i < chipDots ? 'var(--ios-green)' : 'var(--ios-fill2)' }} />)}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
        {grade && (
          <span style={{ fontSize: 11, fontWeight: 800, color: GRADE_COLOR[grade] || '#64748B', background: `${GRADE_COLOR[grade] || '#64748B'}20`, borderRadius: 5, padding: '1px 6px', letterSpacing: 0.3 }}>{grade}</span>
        )}
        {isEntry
          ? <span style={{ fontSize: 11, color: '#30D158', fontWeight: 700, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.28)', borderRadius: 9999, padding: '4px 10px' }}>進場</span>
          : <span style={{ fontSize: 11, color: '#0A84FF', fontWeight: 600, background: 'rgba(59,130,246,0.10)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 9999, padding: '4px 10px' }}>觀察</span>
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
  const colors = { info: 'var(--ios-label2)', ban: 'var(--ios-red)', warn: 'var(--ios-orange)' }

  return (
    <div className="glass-panel" style={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>🤖 AI 操作建議</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {bullets.map((b, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, lineHeight: 1.6 }}>
            <span style={{ flexShrink: 0, minWidth: 16, color: colors[b.type], marginTop: 1 }}>{icons[b.type]}</span>
            <span style={{ color: b.type === 'info' ? 'var(--ios-label)' : colors[b.type] }}>{b.text}</span>
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
    <div className="glass-panel" style={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>風險因子</div>
      {items.map((text, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: i < items.length - 1 ? 7 : 0 }}>
          <span style={{ color: '#FF453A', flexShrink: 0, fontSize: 12 }}>✓</span>
          <span style={{ fontSize: 13, color: 'var(--ios-label2)', lineHeight: 1.55 }}>{text}</span>
        </div>
      ))}
    </div>
  )
}

/* ── Feature 2: Watchlist Alerts ────────────────────────────────── */
function WatchlistAlerts({ stocks }) {
  const watchlistRaw = (() => {
    try { return JSON.parse(localStorage.getItem('stock_watchlist') || '[]') } catch { return [] }
  })()
  const watchSet = new Set(watchlistRaw)
  if (watchSet.size === 0) return null
  const alerts = stocks.filter(s => watchSet.has(s.stock_id))
  if (alerts.length === 0) return null
  const entries = alerts.filter(s => s.entry_signal)
  const risky = alerts.filter(s => !s.entry_signal && (s.day_return || 0) < -0.03)
  if (entries.length === 0 && risky.length === 0) return null

  return (
    <div className="glass-panel" style={{ overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid var(--ios-sep)' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#FFD60A' }}>⭐ 自選股警示</span>
      </div>
      {entries.map(s => (
        <div key={s.stock_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: '0.5px solid var(--ios-sep)' }}>
          <span style={{ fontSize: 11, background: 'rgba(48,209,88,0.15)', color: '#30D158', borderRadius: 6, padding: '2px 7px', fontWeight: 700, flexShrink: 0 }}>進場</span>
          <span style={{ fontFamily: 'monospace', color: '#0A84FF', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{s.stock_id}</span>
          <span style={{ fontSize: 13, color: 'var(--ios-label)', flex: 1 }}>{s.name}</span>
          <span style={{ fontSize: 12, color: '#30D158', fontFamily: 'monospace' }}>{s.entry_score}</span>
        </div>
      ))}
      {risky.map(s => (
        <div key={s.stock_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: '0.5px solid var(--ios-sep)' }}>
          <span style={{ fontSize: 11, background: 'rgba(255,69,58,0.15)', color: '#FF453A', borderRadius: 6, padding: '2px 7px', fontWeight: 700, flexShrink: 0 }}>跌幅</span>
          <span style={{ fontFamily: 'monospace', color: '#0A84FF', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{s.stock_id}</span>
          <span style={{ fontSize: 13, color: 'var(--ios-label)', flex: 1 }}>{s.name}</span>
          <span style={{ fontSize: 12, color: '#FF453A', fontFamily: 'monospace' }}>{((s.day_return || 0) * 100).toFixed(2)}%</span>
        </div>
      ))}
    </div>
  )
}

/* ── Feature 5: AI Daily Briefing ───────────────────────────────── */
function AIBriefing({ scan, entryCount, totalStocks }) {
  const aiText = scan?.ai_picks_text || ''
  if (!aiText) return null
  return (
    <div className="glass-panel" style={{ overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid var(--ios-sep)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#BF5AF2' }}>🤖 今日 AI 分析</span>
        <span style={{ fontSize: 11, color: 'var(--ios-label3)' }}>進場 {entryCount} / {totalStocks} 支</span>
      </div>
      <div style={{ padding: '10px 14px 12px', fontSize: 13, color: 'var(--ios-label)', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
        {aiText.slice(0, 500)}{aiText.length > 500 ? '…' : ''}
      </div>
    </div>
  )
}

/* ── Feature 4: Sector Heatmap ──────────────────────────────────── */
// Stock ID range → sector mapping (Taiwan market convention)
function inferSector(stockId) {
  const n = parseInt(String(stockId), 10)
  if (n >= 2300 && n <= 2399) return '半導體'
  if (n >= 2400 && n <= 2499) return '電子'
  if (n >= 2600 && n <= 2699) return '航運'
  if (n >= 2800 && n <= 2899) return '金融'
  if (n >= 3000 && n <= 3099) return 'IC設計'
  if (n >= 3600 && n <= 3699) return '光電'
  if (n >= 4900 && n <= 4999) return '電信'
  if (n >= 5800 && n <= 5899) return '建設'
  if (n >= 6000 && n <= 6099) return '光電'
  if (n >= 6100 && n <= 6299) return '電子'
  if (n >= 6600 && n <= 6699) return '生技'
  if (n >= 8000 && n <= 8099) return '電子'
  if (n >= 9200 && n <= 9299) return '其他'
  if (n >= 1000 && n <= 1999) return '傳產'
  if (n >= 2000 && n <= 2199) return '傳產'
  if (n >= 2200 && n <= 2299) return '傳產'
  if (n >= 2500 && n <= 2599) return '食品'
  if (n >= 2700 && n <= 2799) return '貿易'
  return '其他'
}

function SectorHeatmap({ stocks, onStockClick }) {
  const [selectedSector, setSelectedSector] = useState(null)
  if (!stocks || stocks.length === 0) return null

  const sectorMap = {}
  for (const s of stocks) {
    const sector = (s.industry_category && s.industry_category.trim()) || inferSector(s.stock_id)
    if (!sectorMap[sector]) sectorMap[sector] = []
    sectorMap[sector].push(s)
  }

  const sectors = Object.entries(sectorMap).map(([name, members]) => {
    const avgReturn = members.reduce((sum, s) => sum + (s.day_return || 0), 0) / members.length
    const signalCount = members.filter(s => s.entry_signal).length
    return { name, count: members.length, avgReturn, signalCount }
  }).sort((a, b) => b.avgReturn - a.avgReturn)

  if (sectors.length === 0) return null

  function tileBg(ret) {
    const t = Math.max(0, Math.min(1, Math.abs(ret) / 0.05))
    const a = 0.07 + t * 0.42
    return ret >= 0 ? `rgba(255,59,48,${a})` : `rgba(48,209,88,${a})`
  }

  function tileBorder(ret, active) {
    if (active) return 'var(--ios-blue)'
    const t = Math.max(0, Math.min(1, Math.abs(ret) / 0.05))
    const a = 0.18 + t * 0.5
    return ret > 0.002 ? `rgba(255,59,48,${a})` : ret < -0.002 ? `rgba(48,209,88,${a})` : 'var(--ios-sep)'
  }

  function retColor(ret) {
    if (ret > 0.002) return 'var(--ios-red)'
    if (ret < -0.002) return 'var(--ios-green)'
    return 'var(--ios-label3)'
  }

  // Top 20 stocks in the selected sector sorted by entry_signal → sector_rs_rank → day_return
  const sectorStockList = selectedSector
    ? (sectorMap[selectedSector] || [])
        .slice()
        .sort((a, b) => {
          const aS = a.entry_signal ? 1 : 0, bS = b.entry_signal ? 1 : 0
          if (bS !== aS) return bS - aS
          const aR = a.sector_rs_rank ?? a.rs_score ?? 0
          const bR = b.sector_rs_rank ?? b.rs_score ?? 0
          if (bR !== aR) return bR - aR
          return (b.day_return || 0) - (a.day_return || 0)
        })
        .slice(0, 20)
    : []

  return (
    <div className="glass-panel" style={{ overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px 10px', borderBottom: '1px solid var(--ios-sep)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-label)' }}>🗂 板塊熱力圖</span>
        <span style={{ fontSize: 10, color: 'var(--ios-label4)' }}>
          {selectedSector ? (
            <button onClick={() => setSelectedSector(null)} style={{ background: 'none', border: 'none', color: 'var(--ios-blue)', fontSize: 10, cursor: 'pointer', padding: 0 }}>← 返回</button>
          ) : '紅=漲 綠=跌（台灣慣例）'}
        </span>
      </div>
      <div style={{ padding: '10px 12px 8px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {sectors.map(({ name, count, avgReturn, signalCount }) => {
          const miniBarW = Math.round(Math.min(1, Math.abs(avgReturn) / 0.05) * 32)
          const isActive = selectedSector === name
          return (
            <div key={name} onClick={() => setSelectedSector(prev => prev === name ? null : name)} style={{
              background: isActive ? 'rgba(10,132,255,0.12)' : tileBg(avgReturn),
              borderRadius: 12,
              padding: '9px 7px 7px',
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              border: `1.5px solid ${tileBorder(avgReturn, isActive)}`,
              minHeight: 72,
              position: 'relative',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}>
              {signalCount > 0 && (
                <div style={{ position: 'absolute', top: 6, right: 7, display: 'flex', alignItems: 'center', gap: 2 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#30D158', boxShadow: '0 0 5px #30D158' }} />
                  <span style={{ fontSize: 8, color: '#30D158', fontWeight: 700 }}>{signalCount}</span>
                </div>
              )}
              <div style={{ fontSize: 11.5, fontWeight: 700, color: isActive ? 'var(--ios-blue)' : 'var(--ios-label)', textAlign: 'center', marginBottom: 5, lineHeight: 1.2 }}>{name}</div>
              <div style={{ fontSize: 17, fontWeight: 800, color: isActive ? 'var(--ios-blue)' : retColor(avgReturn), fontFamily: 'monospace', letterSpacing: '-0.5px', lineHeight: 1 }}>
                {avgReturn >= 0 ? '+' : ''}{(avgReturn * 100).toFixed(1)}%
              </div>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <span style={{ fontSize: 9, color: 'var(--ios-label4)' }}>{count} 支</span>
                {miniBarW > 0 && (
                  <div style={{ width: 36, height: 2, background: 'var(--ios-fill2)', borderRadius: 1, overflow: 'hidden' }}>
                    <div style={{ width: miniBarW, height: '100%', background: isActive ? 'var(--ios-blue)' : retColor(avgReturn), opacity: 0.65 }} />
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Expanded sector stock list */}
      {selectedSector && sectorStockList.length > 0 && (
        <div style={{ borderTop: '1px solid var(--ios-sep)' }}>
          <div style={{ padding: '8px 14px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-blue)' }}>📊 {selectedSector} · 前{sectorStockList.length}名</span>
            <span style={{ fontSize: 10, color: 'var(--ios-label4)' }}>依 RS 排名</span>
          </div>
          {sectorStockList.map((s, i) => {
            const ret = s.day_return || 0
            const hasSignal = !!s.entry_signal
            const rs = s.sector_rs_rank != null ? Math.round(s.sector_rs_rank) : null
            return (
              <div key={s.stock_id}
                onClick={() => onStockClick && onStockClick(s)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px',
                  borderBottom: i < sectorStockList.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
                  background: hasSignal ? 'rgba(48,209,88,0.04)' : 'transparent',
                  cursor: onStockClick ? 'pointer' : 'default',
                  WebkitTapHighlightColor: 'transparent',
                }}>
                <span style={{ fontSize: 11, color: 'var(--ios-label4)', minWidth: 18, textAlign: 'right', fontFamily: 'monospace' }}>{i + 1}</span>
                {hasSignal && <span style={{ fontSize: 9, background: 'rgba(48,209,88,0.18)', color: '#30D158', borderRadius: 4, padding: '1px 5px', fontWeight: 700, flexShrink: 0 }}>進場</span>}
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ios-blue)', fontFamily: 'monospace', flexShrink: 0 }}>{s.stock_id}</span>
                <span style={{ fontSize: 12, color: 'var(--ios-label)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                {rs != null && <span style={{ fontSize: 10, color: 'var(--ios-label3)', flexShrink: 0 }}>RS{rs}%</span>}
                <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace', flexShrink: 0, color: ret > 0 ? 'var(--ios-red)' : ret < 0 ? 'var(--ios-green)' : 'var(--ios-label3)' }}>
                  {ret > 0 ? '+' : ''}{(ret * 100).toFixed(1)}%
                </span>
                {onStockClick && <span style={{ fontSize: 9, color: 'var(--ios-label4)', flexShrink: 0 }}>›</span>}
              </div>
            )
          })}
        </div>
      )}
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

  // Merge all scanned stocks for heatmap: rich top_stocks first, then slim filter_stocks extras
  const allScanStocks = useMemo(() => {
    const topIds = new Set((scan.top_stocks || []).map(s => String(s.stock_id)))
    const extras = (scan.filter_stocks || []).filter(s => !topIds.has(String(s.stock_id)))
    return [...(scan.top_stocks || []), ...extras]
  }, [scan])

  // Stock detail modal state (triggered by sector heatmap stock clicks)
  const ovHistoriesRef = useRef(null)
  const [ovSelectedStock, setOvSelectedStock] = useState(null)
  const [ovCompareHistories, setOvCompareHistories] = useState(null)
  const [ovHistoryDates, setOvHistoryDates] = useState(null)

  const openStockDetail = useCallback(async (stockObj) => {
    setOvSelectedStock({ ...stockObj })
    if (!ovHistoriesRef.current) {
      try {
        const base = import.meta.env.BASE_URL || '/'
        const h = await fetch(`${base}stock_histories.json`).then(r => r.ok ? r.json() : null)
        ovHistoriesRef.current = h || {}
        if (h?.stocks) setOvCompareHistories(h.stocks)
        if (Array.isArray(h?.dates)) setOvHistoryDates(h.dates)
      } catch { ovHistoriesRef.current = {} }
    }
    const h = ovHistoriesRef.current
    const id = String(stockObj.stock_id)
    const kline = h?.stocks?.[id]
    const scanHist = h?.scan_stocks?.[id]
    const dates = h?.dates || []
    let priceHistory = null
    if (kline?.c) {
      priceHistory = dates.map((t, i) => kline.c[i] == null ? null : {
        time: t, open: kline.o?.[i] ?? kline.c[i], high: kline.h?.[i] ?? kline.c[i],
        low: kline.l?.[i] ?? kline.c[i], close: kline.c[i], volume: kline.v?.[i] ?? 0,
      }).filter(Boolean)
    } else if (Array.isArray(scanHist) && scanHist.length >= 2) {
      priceHistory = scanHist.map(b => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] }))
    }
    if (priceHistory) {
      setOvSelectedStock(prev => prev?.stock_id === stockObj.stock_id ? { ...prev, price_history: priceHistory } : prev)
    }
  }, [])

  if (error && !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--ios-label2)' }}>
        <div style={{ fontSize: 36 }}>⚠️</div>
        <div style={{ fontSize: 15, color: '#FF453A' }}>資料載入失敗</div>
        <div style={{ fontSize: 12, color: 'var(--ios-label3)', fontFamily: 'monospace' }}>{error}</div>
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--ios-label2)' }}>
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
  const calendarRisk = data?.aggregateLatest?.calendar_risk || scan?.calendar_risk || ''
  const entryStocks = stocks.filter(s => s.entry_signal)

  return (
    <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch', background: 'transparent' }}>
      <div style={{ padding: '10px 14px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>

        {/* Row 1: Gauge + Risk */}
        <div style={{ display: 'flex', gap: 10 }}>
          <DirectionGauge prob={prob} winRate={winRate} />
          {(risk || marketData || calendarRisk)
            ? <RiskCard risk={risk} marketData={marketData} calendarRisk={calendarRisk} />
            : <div className="glass-panel" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--ios-label3)' }}>暫無風險資料</span>
              </div>
          }
        </div>

        {/* Live Market Strip: real-time SPX/SOX/NDX + USD/TWD */}
        <LiveMarketStrip />

        {/* Row 2: US Market + Risk Signals */}
        <MarketSignalsCard marketData={marketData} />

        {/* Row 3: Scenario */}
        {(scenario?.main_scenario || scenario?.best_strategy) && (
          <ScenarioBlock scenario={scenario} prob={prob} />
        )}

        {/* Row 4: TOP 5 */}
        {top5.length > 0 && (
          <div className="glass-panel" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid var(--ios-sep)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-label)' }}>⚡ 今日最強</span>
              <span style={{ fontSize: 11, color: 'var(--ios-label4)' }}>{latestDate}</span>
            </div>
            {top5.map((stock, i) => (
              <StockMiniRow key={stock.stock_id} stock={stock} rank={i + 1} maxScore={maxScore} isLast={i === top5.length - 1} />
            ))}
            <div style={{ padding: '9px 14px', borderTop: '1px solid var(--ios-sep)', textAlign: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--ios-blue)' }}>完整排行請至掃描頁</span>
            </div>
          </div>
        )}

        {/* Feature 2: Watchlist alerts — entry signals or big drops */}
        <WatchlistAlerts stocks={stocks} />

        {/* Feature 4: Sector heatmap — all scan stocks */}
        {allScanStocks.length > 0 && <SectorHeatmap stocks={allScanStocks} onStockClick={openStockDetail} />}

        {/* Feature 5: AI daily briefing from scan ai_picks_text */}
        <AIBriefing scan={scan} entryCount={entryStocks.length} totalStocks={stocks.length} />

        {/* Row 5: AI Advice */}
        <AIAdviceBlock
          aiInsight={aiInsight}
          dangerSignals={scenario?.danger_signals}
          forbiddenActions={scenario?.forbidden_actions}
        />

        {/* Row 6: Risk Factors */}
        <RiskFactors factors={risk?.factors} />

      </div>

      {/* Stock detail modal — opened from sector heatmap */}
      {ovSelectedStock && (
        <StockDetailModal
          stock={ovSelectedStock}
          notionInfo={null}
          onClose={() => setOvSelectedStock(null)}
          allScans={data?.scans}
          compareHistories={ovCompareHistories}
          historyDates={ovHistoryDates}
        />
      )}
    </div>
  )
}
