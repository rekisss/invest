import { useState, useMemo, useRef, useLayoutEffect } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { animateListRows } from '../utils/animeUtils'
gsap.registerPlugin(useGSAP)

const HIST_PAGE_SIZE = 20

const RISK_COLOR = { LOW: 'var(--ios-green)', MEDIUM: 'var(--ios-yellow)', HIGH: 'var(--ios-orange)', EXTREME: 'var(--ios-red)' }
const RISK_LABEL = { LOW: '低風險', MEDIUM: '中風險', HIGH: '高風險', EXTREME: '極高風險' }

// 預測是用「下一次執行紀錄」的 night_change 當實際結果打分；但 cron 缺跑會讓
// history 相鄰兩筆差好幾天，硬配對會拿好幾天後的夜盤替早前的預測打分，默默污染
// 命中率/校準統計。只接受間隔 ≤5 天（涵蓋週五→週一＋連假一天），更大的缺口不配對。
function isConsecutiveRun(dateA, dateB) {
  if (!dateA || !dateB) return false
  const gap = (new Date(dateB) - new Date(dateA)) / 86400000
  return gap > 0 && gap <= 5
}

function ProbBar({ prob }) {
  const pct = Math.round((prob ?? 0.5) * 100)
  const color = pct >= 60 ? 'var(--ios-red)' : pct <= 40 ? 'var(--ios-green)' : 'var(--ios-yellow)'
  const numRef = useRef(null)
  const barRef = useRef(null)
  useGSAP(() => {
    const barEl = barRef.current
    if (!barEl) return
    const obj = { val: 0 }
    const tl = gsap.timeline({ paused: true })
    tl.to(obj, {
      val: pct, duration: 0.9, ease: 'power3.out',
      onUpdate() { if (numRef.current) numRef.current.textContent = Math.round(obj.val) + '%' },
    }, 0)
    tl.from(barEl, { scaleX: 0, transformOrigin: 'left center', duration: 0.9, ease: 'power3.out' }, 0)
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting) { tl.play(); io.disconnect() }
    }, { threshold: 0.2 })
    io.observe(barEl)
    return () => io.disconnect()
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

// Rule-based 空方 cross-check — high-conviction bearish conditions for Taiwan's
// next session, scored from the day's market_data, shown next to the model so the
// user can see agreement/divergence (a sanity check on a ~40%-precision model).
function BearishCrossCheck({ market_data, prob }) {
  const md = market_data || {}
  const n = (v) => (typeof v === 'number' && !Number.isNaN(v)) ? v : null
  const RULES = [
    { label: '費半 SOX 隔夜 ≤ −2%', hit: n(md.sox_ret) != null && md.sox_ret <= -0.02, val: n(md.sox_ret) },
    { label: '台積電 ADR 隔夜 ≤ −2%', hit: n(md.tsm_adr_ret) != null && md.tsm_adr_ret <= -0.02, val: n(md.tsm_adr_ret) },
    { label: 'Nasdaq 隔夜 ≤ −1%', hit: n(md.nasdaq_ret) != null && md.nasdaq_ret <= -0.01, val: n(md.nasdaq_ret) },
    { label: 'VIX > 22（恐慌）', hit: n(md.vix) != null && md.vix > 22, val: n(md.vix) },
    { label: '外資期貨淨空 > 3萬口', hit: n(md.futures_net) != null && md.futures_net < -30000, val: n(md.futures_net) },
    { label: '夜盤大跌 < −150', hit: n(md.night_change) != null && md.night_change < -150, val: n(md.night_change) },
  ]
  const known = RULES.filter(r => r.val != null)
  if (known.length === 0) return null
  const hits = RULES.filter(r => r.hit).length
  const modelBear = prob != null && prob <= 0.45
  const modelBull = prob != null && prob >= 0.55
  // Divergence/agreement thresholds must scale with how many rules are evaluable —
  // overnight-US fields can all be null (feed outage), leaving only 2 of 6 rules
  // scored; a fixed `hits >= 3` could then never fire even with every known rule
  // hard-bearish while the model says bullish.
  const bearishConsensus = known.length >= 2 && hits >= Math.min(3, known.length) && hits / known.length >= 0.5
  const diverge = bearishConsensus && modelBull
  const fmtVal = (label, v) => {
    if (v == null) return '—'
    if (label.includes('VIX')) return v.toFixed(1)
    if (label.includes('淨空') || label.includes('夜盤')) return Math.round(v).toLocaleString()
    return `${(v * 100).toFixed(1)}%`
  }
  return (
    <Card title="空方硬規則交叉驗證" accent="var(--ios-orange)">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 26, fontWeight: 700, fontFamily: 'var(--font-mono)', color: bearishConsensus ? 'var(--ios-red)' : hits >= 1 ? 'var(--ios-yellow)' : 'var(--ios-green)' }}>{hits}/{known.length}</span>
        <span style={{ fontSize: 12, color: 'var(--ios-label3)' }}>空方訊號成立{known.length < RULES.length ? `（${RULES.length - known.length} 條缺資料未計）` : ''}</span>
      </div>
      {diverge && (
        <div style={{ marginBottom: 8, padding: '7px 10px', background: 'rgba(255,51,64,0.1)', border: '0.5px solid rgba(255,51,64,0.35)', borderRadius: 8, fontSize: 12, color: 'var(--ios-red)', fontWeight: 600, lineHeight: 1.5 }}>
          ⚠️ 硬規則偏空({hits} 條)但模型偏多 — 兩者分歧,宜謹慎、別急著追多
        </div>
      )}
      {!diverge && bearishConsensus && modelBear && (
        <div style={{ marginBottom: 8, padding: '7px 10px', background: 'rgba(22,214,126,0.08)', border: '0.5px solid rgba(22,214,126,0.3)', borderRadius: 8, fontSize: 12, color: 'var(--ios-green)', fontWeight: 600 }}>
          ✓ 模型與硬規則一致偏空 — 高信心
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {RULES.map(r => (
          <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, opacity: r.val == null ? 0.4 : 1 }}>
            <span style={{ color: 'var(--ios-label2)' }}>{r.hit ? '🔴' : r.val == null ? '⚪' : '⚪️'} {r.label}</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: r.hit ? 'var(--ios-red)' : 'var(--ios-label3)' }}>{fmtVal(r.label, r.val)}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ios-label4)', marginTop: 8, lineHeight: 1.5 }}>
        硬規則是「機械式高勝率空方條件」,與 AI 模型獨立;兩者一致才是高信心訊號。
      </div>
    </Card>
  )
}

// Honest "本次預測輸入完整度" — surfaces how many model-input feature groups
// actually had data today. When the overnight-US feeds are down the XGB call runs
// on degraded input; showing this (rather than a single buried flag) tells the user
// *when* to trust the big 看多/看空 number. Build-time computed (input_completeness).
function InputCompletenessCard({ completeness }) {
  const ic = completeness
  if (!ic || !Array.isArray(ic.groups) || ic.groups.length === 0) return null
  // Reliability tier is driven by the CRITICAL group (US overnight) — the strongest
  // model driver. All present → green; partial → yellow; none → red.
  const cp = ic.critical_present, ct = ic.critical_total
  const tier = ct > 0 && cp === 0 ? 'red' : (cp < ct || ic.pct < 70) ? 'yellow' : 'green'
  const tierColor = tier === 'red' ? 'var(--ios-red)' : tier === 'yellow' ? 'var(--ios-yellow)' : 'var(--ios-green)'
  const tierText = tier === 'red' ? '美股隔夜訊號全缺 — 方向判讀不可信,建議只做風控'
    : tier === 'yellow' ? '部分關鍵訊號缺漏 — 可靠度打折,降低倉位' : '關鍵訊號齊全 — 輸入品質良好'
  return (
    <Card title="本次預測輸入完整度" accent={tierColor}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 26, fontWeight: 700, fontFamily: 'var(--font-mono)', color: tierColor }}>{ic.present}/{ic.total}</span>
        {ic.pct != null && <span style={{ fontSize: 13, color: 'var(--ios-label3)', fontFamily: 'var(--font-mono)' }}>{ic.pct}%</span>}
        <span style={{ fontSize: 12, color: 'var(--ios-label3)' }}>模型輸入特徵</span>
      </div>
      <div style={{ marginBottom: 10, padding: '7px 10px', background: `${tierColor}1a`, border: `0.5px solid ${tierColor}59`, borderRadius: 8, fontSize: 12, color: tierColor, fontWeight: 600, lineHeight: 1.5 }}>
        {tier === 'red' ? '🚨' : tier === 'yellow' ? '⚠️' : '✓'} {tierText}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {ic.groups.map(g => {
          const full = g.present === g.total
          const none = g.present === 0
          const dot = full ? '🟢' : none ? (g.critical ? '🔴' : '⚪') : '🟡'
          return (
            <div key={g.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
              <span style={{ color: 'var(--ios-label2)', whiteSpace: 'nowrap' }}>
                {dot} {g.label}{g.critical ? ' ★' : ''}
              </span>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {g.missing.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--ios-label4)' }}>缺 {g.missing.join('、')}</span>
                )}
                <span style={{ fontFamily: 'var(--font-mono)', color: full ? 'var(--ios-green)' : none ? 'var(--ios-label3)' : 'var(--ios-yellow)' }}>{g.present}/{g.total}</span>
              </span>
            </div>
          )
        })}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ios-label4)', marginTop: 8, lineHeight: 1.5 }}>
        ★ = 關鍵群組(美股隔夜),對模型影響最大。輸入缺漏越多,預測越應保守看待。
      </div>
    </Card>
  )
}

// 期貨籌碼面板 — 三大法人 TX 期貨未平倉(build 層抓的 futuresChips)+ 夜盤。
// 台股慣例:淨多=紅、淨空=綠。futuresChips 缺席時退回 prediction.market_data
// 既有的 futures_net(外資期貨淨部位),整卡在完全無資料時才隱藏。
function FuturesChipsPanel({ futuresChips, market_data, history = [] }) {
  const fc = futuresChips
  const md = market_data || {}
  const hasInst = fc && Array.isArray(fc.institutions) && fc.institutions.some(i => i.net != null)
  const foreignNet = hasInst ? (fc.institutions.find(i => i.key === 'foreign')?.net ?? null) : (md.futures_net ?? null)
  const night = typeof md.night_change === 'number' ? md.night_change : null
  const nightTrend = md.night_trend || ''
  const pcr = typeof md.pcr === 'number' ? md.pcr : null

  // Trend series (外資期貨淨部位):prefer futuresChips history, else predictionHistory futures_net.
  const series = useMemo(() => {
    const fromFc = (fc?.history || []).filter(h => typeof h.foreign_net === 'number').map(h => ({ date: h.date, v: h.foreign_net }))
    if (fromFc.length >= 3) return fromFc.slice(-20)
    const fromHist = [...(history || [])]
      .filter(h => h.date && typeof h.market_data?.futures_net === 'number')
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(h => ({ date: h.date, v: h.market_data.futures_net }))
    return fromHist.slice(-20)
  }, [fc, history])

  if (foreignNet == null && night == null && !hasInst) return null

  const netColor = n => n == null ? 'var(--ios-label3)' : n > 0 ? 'var(--ios-red)' : n < 0 ? 'var(--ios-green)' : 'var(--ios-label3)'
  const netStr = n => n == null ? '—' : `${n > 0 ? '淨多' : n < 0 ? '淨空' : '持平'} ${Math.abs(n).toLocaleString()} 口`

  // Sparkline geometry.
  let spark = null
  if (series.length >= 3) {
    const W = 300, H = 44, PX = 4, PY = 6
    const vs = series.map(d => d.v)
    const lo = Math.min(...vs), hi = Math.max(...vs)
    const range = (hi - lo) || 1
    const n = series.length - 1
    const xs = i => PX + (i / n) * (W - PX * 2)
    const ys = v => PY + (1 - (v - lo) / range) * (H - PY * 2)
    const pts = series.map((d, i) => `${xs(i).toFixed(1)},${ys(d.v).toFixed(1)}`)
    const line = `M ${pts[0]} ` + pts.slice(1).map(p => `L ${p}`).join(' ')
    const lastV = vs[vs.length - 1]
    const zeroY = (lo <= 0 && hi >= 0) ? ys(0) : null
    spark = { W, H, line, lastV, zeroY, xs, ys, n }
  }

  return (
    <Card title="期貨籌碼 · 三大法人未平倉" accent="var(--ios-teal)">
      {hasInst ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          {fc.institutions.map(i => (
            <div key={i.key} style={{ flex: '1 1 30%', minWidth: 92, background: 'var(--ios-bg3)', borderRadius: 10, padding: '8px 10px' }}>
              <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 3 }}>{i.label}</div>
              <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)', color: netColor(i.net) }}>
                {i.net == null ? '—' : (i.net > 0 ? '+' : '') + i.net.toLocaleString()}
              </div>
              <div style={{ fontSize: 10, color: 'var(--ios-label4)' }}>{i.net == null ? '' : i.net > 0 ? '淨多口' : '淨空口'}</div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: netColor(foreignNet) }}>{netStr(foreignNet)}</span>
          <span style={{ fontSize: 12, color: 'var(--ios-label3)' }}>外資期貨</span>
        </div>
      )}

      {spark && (
        <svg width="100%" viewBox={`0 0 ${spark.W} ${spark.H}`} style={{ display: 'block', marginBottom: 6, overflow: 'visible' }}>
          {spark.zeroY != null && (
            <line x1="0" y1={spark.zeroY} x2={spark.W} y2={spark.zeroY} stroke="var(--ios-sep)" strokeWidth="1" strokeDasharray="3 3" />
          )}
          <path d={spark.line} fill="none" stroke={netColor(spark.lastV)} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={spark.xs(spark.n)} cy={spark.ys(spark.lastV)} r="2.6" fill={netColor(spark.lastV)} />
        </svg>
      )}
      {spark && <div style={{ fontSize: 10, color: 'var(--ios-label4)', marginBottom: 8 }}>外資期貨淨部位近 {series.length} 日走勢(線越低 = 空單越重)</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {night != null && (
          <div style={{ flex: '1 1 45%', minWidth: 120, background: 'var(--ios-bg3)', borderRadius: 10, padding: '8px 10px' }}>
            <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 2 }}>夜盤 {nightTrend}</div>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)', color: night > 0 ? 'var(--ios-red)' : night < 0 ? 'var(--ios-green)' : 'var(--ios-label3)' }}>
              {night > 0 ? '+' : ''}{Math.round(night).toLocaleString()} 點
            </div>
          </div>
        )}
        {pcr != null && (
          <div style={{ flex: '1 1 45%', minWidth: 120, background: 'var(--ios-bg3)', borderRadius: 10, padding: '8px 10px' }}>
            <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 2 }}>Put/Call 比</div>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ios-label)' }}>{pcr.toFixed(2)}</div>
          </div>
        )}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ios-label4)', marginTop: 8, lineHeight: 1.5 }}>
        籌碼為三大法人期貨「未平倉」淨部位(非當日買賣)。外資大額淨空常伴隨避險/看空,惟軋空風險亦高。{hasInst ? '' : '（三大法人明細待資料更新後顯示，目前僅外資期貨淨額）'}
      </div>
    </Card>
  )
}

// Probability trend chart — redesigned with gradient area + animated line drawing.
function ProbTrend({ history }) {
  const lineRef = useRef(null)

  const pts = useMemo(() => {
    const sorted = [...(history || [])]
      .filter(h => h.xgb_prob_up != null && h.date)
      .sort((a, b) => a.date.localeCompare(b.date))
    const recent = sorted.slice(-20)
    return recent.map((h, i) => {
      const nextH = sorted[sorted.length - recent.length + i + 1]
      const nc = nextH?.market_data?.night_change
      const paired = nc != null && isConsecutiveRun(h.date, nextH?.date)
      const actual = paired ? (nc > 20 ? 1 : nc < -20 ? -1 : 0) : null
      return { date: h.date, p: h.xgb_prob_up, actual }
    })
  }, [history])

  useGSAP(() => {
    const el = lineRef.current
    if (!el) return
    let started = false
    let raf = null
    let io = null
    const startAnim = () => {
      if (started) return
      const len = el.getTotalLength()
      if (!len) return
      started = true
      io?.disconnect()
      gsap.set(el, { strokeDasharray: len, strokeDashoffset: len })
      gsap.to(el, { strokeDashoffset: 0, duration: 1.4, ease: 'power2.out', delay: 0.15 })
    }
    // Try immediately (handles already-visible case)
    raf = requestAnimationFrame(startAnim)
    // Also watch for visibility (handles hidden-tab case where SVG length is 0 until visible)
    io = new IntersectionObserver(es => {
      if (es[0].isIntersecting) requestAnimationFrame(startAnim)
    }, { threshold: 0.2 })
    io.observe(el)
    return () => { if (raf) cancelAnimationFrame(raf); io?.disconnect() }
  }, { dependencies: [pts.length] })

  if (pts.length < 3) return null

  const W = 300, H = 88, PX = 8, PY = 12
  const ps = pts.map(d => d.p)
  const lo = Math.min(...ps, 0.42), hi = Math.max(...ps, 0.58)
  const range = (hi - lo) || 1
  const n = pts.length - 1
  const xs = i => PX + (i / n) * (W - PX * 2)
  const ys = p => PY + (1 - (p - lo) / range) * (H - PY * 2 - 6)

  const linePts = pts.map((d, i) => `${xs(i).toFixed(1)},${ys(d.p).toFixed(1)}`)
  const linePath = `M ${linePts[0]} ` + linePts.slice(1).map(p => `L ${p}`).join(' ')
  const areaPath = linePath +
    ` L ${xs(n).toFixed(1)},${H - 4} L ${xs(0).toFixed(1)},${H - 4} Z`

  const last = pts[pts.length - 1]
  const lastPct = Math.round(last.p * 100)
  const lastColor = lastPct >= 60 ? '#FF3340' : lastPct <= 40 ? '#16D67E' : '#FF9F0A'
  const y50 = (lo <= 0.5 && hi >= 0.5) ? ys(0.5) : null
  const hasActual = pts.some(d => d.actual !== null)
  const gradId = 'ptGrad'

  return (
    <Card title="機率走勢 vs 實際方向">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible', marginBottom: 4 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={lastColor} stopOpacity="0.22" />
            <stop offset="100%" stopColor={lastColor} stopOpacity="0.01" />
          </linearGradient>
          <filter id="ptGlow">
            <feGaussianBlur stdDeviation="1.5" result="blur" />
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>

        {/* 50% reference line */}
        {y50 != null && (
          <line x1={PX} y1={y50} x2={W - PX} y2={y50}
            stroke="var(--ios-sep)" strokeWidth="1" strokeDasharray="4,4" />
        )}
        {y50 != null && (
          <text x={PX + 2} y={y50 - 3} fontSize="8" fill="var(--ios-label4)" fontWeight="600">50%</text>
        )}

        {/* Gradient area fill */}
        <path d={areaPath} fill={`url(#${gradId})`} />

        {/* Main trend line — animated */}
        <path ref={lineRef} d={linePath}
          fill="none" stroke={lastColor} strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round"
          filter="url(#ptGlow)" opacity="0.9" />

        {/* Outcome dots */}
        {pts.map((d, i) => {
          const isLast = i === pts.length - 1
          const cx = xs(i).toFixed(1), cy = ys(d.p).toFixed(1)
          const dotColor = d.actual === 1 ? '#FF3340'
            : d.actual === -1 ? '#16D67E'
            : isLast ? lastColor : 'var(--ios-label4)'
          const r = isLast ? 4 : d.actual !== null ? 3.5 : 2
          return (
            <g key={d.date}>
              {isLast && <circle cx={cx} cy={cy} r="7" fill={lastColor} opacity="0.15" />}
              <circle cx={cx} cy={cy} r={r} fill={dotColor}
                stroke={d.actual !== null && !isLast ? 'rgba(0,0,0,0.5)' : 'none'}
                strokeWidth="1" />
            </g>
          )
        })}

        {/* Latest value label */}
        <rect x={xs(n) - 22} y={ys(last.p) - 17} width="26" height="14" rx="4"
          fill={lastColor} opacity="0.18" />
        <text x={xs(n) - 9} y={ys(last.p) - 7} textAnchor="middle"
          fontSize="9.5" fill={lastColor} fontWeight="800">{lastPct}%</text>
      </svg>

      {/* Date range + 50% label */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ios-label4)', marginBottom: 6 }}>
        <span>{pts[0].date.slice(5)}</span>
        {y50 != null && <span style={{ color: 'var(--ios-label4)' }}>— 50%</span>}
        <span>{last.date.slice(5)}</span>
      </div>

      {/* Outcome legend */}
      {hasActual && (
        <div style={{ display: 'flex', gap: 12, fontSize: 11, flexWrap: 'wrap', padding: '7px 10px', background: 'var(--ios-fill3)', borderRadius: 10 }}>
          <span style={{ color: '#FF3340', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
            <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#FF3340"/></svg>實際上漲
          </span>
          <span style={{ color: '#16D67E', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
            <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#16D67E"/></svg>實際下跌
          </span>
          <span style={{ color: 'var(--ios-label4)', fontSize: 10, marginLeft: 'auto' }}>夜盤 ±20點估算</span>
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
// 預測回顧:盤前預測(偏多/中性/偏空)逐日對照「掃描池等權當日報酬」打分。
// 與 Discord 日報的 🔮 預測回顧完全同一套判定(等權日報酬 = 基準曲線相鄰兩點
// 累計值相減;中性 ±0.4% 內算命中),前端看到的命中率和日報數字一致。
function PredictionReviewPanel({ history, benchCurve, realOutcomes }) {
  const listRef = useRef(null)
  const rows = useMemo(() => {
    const curve = benchCurve || []
    if (curve.length < 2 || !history?.length) return []
    const dayRet = {}
    for (let i = 1; i < curve.length; i++) {
      dayRet[curve[i].date] = Math.round((curve[i].ret_pct - curve[i - 1].ret_pct) * 100) / 100
    }
    const isHit = (label, r) => {
      if (label === '偏多' || label === '看多') return r > 0
      if (label === '偏空' || label === '看空') return r < 0
      return Math.abs(r) <= 0.4
    }
    return history
      .filter(p => p.date && p.xgb_label && dayRet[p.date] != null)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 14)
      .map(p => ({
        date: p.date,
        label: p.xgb_label,
        prob: p.xgb_prob_up,
        ret: dayRet[p.date],
        hit: isHit(p.xgb_label, dayRet[p.date]),
      }))
  }, [history, benchCurve])

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || !rows.length) return
    for (const r of el.querySelectorAll('[data-row]')) { r.style.opacity = '0' }
    animateListRows(el)
  }, [rows.length])

  if (rows.length < 3) return null

  const hits = rows.filter(r => r.hit).length
  const hitPct = Math.round(hits / rows.length * 100)
  const rateColor = hitPct >= 60 ? 'var(--ios-green)' : hitPct >= 45 ? 'var(--ios-yellow)' : 'var(--ios-red)'
  const labelColor = (label) => label.includes('多') ? 'var(--ios-red)' : label.includes('空') ? 'var(--ios-green)' : 'var(--ios-yellow)'

  // 真實收盤打分(outcome_tracker → realOutcomes.prediction_hit):比下方的
  // 「掃描池等權代理」更準,但要等每日真實收盤累積。樣本足夠(≥REAL_MIN)才
  // 當權威顯示,否則顯示累積進度。
  const REAL_MIN = 5
  const rh = realOutcomes?.prediction_hit
  const realHit = rh && rh.total > 0
    ? { total: rh.total, hits: rh.hits, pct: Math.round(rh.hits / rh.total * 100), ready: rh.total >= REAL_MIN }
    : null
  const realColor = realHit && (realHit.pct >= 60 ? 'var(--ios-green)' : realHit.pct >= 45 ? 'var(--ios-yellow)' : 'var(--ios-red)')

  return (
    <Card title="🔮 預測回顧" accent={realHit?.ready ? realColor : rateColor}>
      {realHit?.ready && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 24, fontWeight: 700, color: realColor, fontFamily: 'var(--font-mono)', letterSpacing: '-0.5px' }}>{realHit.pct}%</span>
          <span style={{ fontSize: 12, color: 'var(--ios-label2)' }}>真實收盤打分 · 近 {realHit.total} 日命中 {realHit.hits} 次</span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: realHit?.ready ? 4 : 10 }}>
        <span style={{ fontSize: realHit?.ready ? 15 : 24, fontWeight: 700, color: rateColor, fontFamily: 'var(--font-mono)', letterSpacing: '-0.5px' }}>{hitPct}%</span>
        <span style={{ fontSize: realHit?.ready ? 10.5 : 12, color: 'var(--ios-label3)' }}>
          {realHit?.ready ? '掃描池代理估算 · ' : ''}近 {rows.length} 個可驗證交易日命中 {hits} 次
        </span>
      </div>
      {realHit && !realHit.ready && (
        <div style={{ fontSize: 10.5, color: 'var(--ios-label3)', marginBottom: 8, background: 'var(--ios-fill4)', borderRadius: 6, padding: '4px 8px' }}>
          🎯 真實收盤打分累積中({realHit.total}/{REAL_MIN} 日)— 足夠後改用更準的真實命中率
        </div>
      )}
      <div ref={listRef}>
        {rows.map(r => (
          <div key={r.date} data-row style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '0.5px solid var(--ios-sep)' }}>
            <span style={{ fontSize: 11, color: 'var(--ios-label3)', fontFamily: 'var(--font-mono)', minWidth: 40 }}>{r.date.slice(5)}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: labelColor(r.label), minWidth: 34 }}>{r.label}</span>
            {r.prob != null && (
              <span style={{ fontSize: 10, color: 'var(--ios-label4)', fontFamily: 'var(--font-mono)', minWidth: 32 }}>{Math.round(r.prob * 100)}%</span>
            )}
            <span style={{ flex: 1, textAlign: 'right', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono)', color: r.ret > 0 ? 'var(--ios-red)' : r.ret < 0 ? 'var(--ios-green)' : 'var(--ios-label2)' }}>
              {r.ret > 0 ? '+' : ''}{r.ret.toFixed(2)}%
            </span>
            <span style={{ fontSize: 13, minWidth: 20, textAlign: 'right' }}>{r.hit ? '✅' : '❌'}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 8, lineHeight: 1.5 }}>
        實際 = 掃描池等權當日報酬(與 AI操盤基準、Discord 日報同一基準);中性預測在 ±0.4% 內算命中
      </div>
    </Card>
  )
}

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
      if (nc == null || !isConsecutiveRun(sorted[i].date, sorted[i + 1].date)) continue
      const p = sorted[i].xgb_prob_up
      const up = nc > 20
      const b = defs.find(d => p >= d.lo && p < d.hi)
      if (b) { b.total++; if (up) b.actualUp++ }
    }

    return defs.filter(b => b.total >= 3)
  }, [history])

  useGSAP(() => {
    const el = containerRef.current
    if (!el) return
    const tw = gsap.from('.calib-bar-fill', {
      scaleX: 0, transformOrigin: 'left center', duration: 0.6,
      stagger: 0.09, ease: 'power2.out', paused: true,
    })
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting) { tw.play(); io.disconnect() }
    }, { threshold: 0.2 })
    io.observe(el)
    return () => io.disconnect()
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

    const errors = [], corrects = []
    for (let i = 0; i < sorted.length - 1; i++) {
      const h = sorted[i]
      const nc = sorted[i + 1].market_data?.night_change
      if (nc == null || Math.abs(h.xgb_prob_up - 0.5) <= 0.05) continue
      if (!isConsecutiveRun(h.date, sorted[i + 1].date)) continue
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
  // Trust-first framing: lead with hit rate + sample size (small samples flagged honestly)
  const hitRate = 100 - data.errRate
  const hitColor = hitRate >= 55 ? 'var(--ios-green)' : hitRate >= 45 ? 'var(--ios-yellow)' : 'var(--ios-red)'
  const smallSample = data.total < 15

  return (
    <Card title="預測命中率追蹤">
      {/* Overall track record — hit rate + sample size */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 30, fontWeight: 700, fontFamily: 'var(--font-mono)', color: hitColor, lineHeight: 1 }}>{hitRate}%</div>
          <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 2 }}>預測命中率</div>
          <div style={{ fontSize: 9, color: smallSample ? 'var(--ios-orange)' : 'var(--ios-label4)', marginTop: 1 }}>
            近 {data.total} 筆{smallSample ? '·樣本少僅參考' : ''}
          </div>
          <div style={{ fontSize: 9, color: 'var(--ios-label4)', marginTop: 1 }}>錯誤率 {data.errRate}%</div>
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
              <span style={{ color: e.p > 0.5 ? 'var(--ios-red)' : 'var(--ios-green)', fontWeight: 700, fontFamily: 'var(--font-mono)', minWidth: 32 }}>{Math.round(e.p * 100)}%</span>
              <span style={{ color: 'var(--ios-label3)', fontSize: 10 }}>→</span>
              <span style={{ color: e.actualUp ? 'var(--ios-red)' : 'var(--ios-green)', fontWeight: 600 }}>{e.actualUp ? '實際↑' : '實際↓'}</span>
              {e.vix > 22 && <span style={{ fontSize: 10, color: 'var(--ios-orange)', background: 'rgba(255,159,10,0.12)', borderRadius: 4, padding: '1px 5px' }}>VIX高</span>}
              {e.futures < -30000 && <span style={{ fontSize: 10, color: 'var(--ios-red)', background: 'rgba(255,51,64,0.1)', borderRadius: 4, padding: '1px 5px' }}>空單重</span>}
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
    { label: '外資期貨', value: data.futures_net != null ? `${data.futures_net > 0 ? '+' : ''}${Math.round(data.futures_net).toLocaleString()}口` : '—', color: data.futures_net > 0 ? 'var(--ios-red)' : 'var(--ios-green)' },
    { label: '夜盤', value: data.night_change != null ? `${data.night_change > 0 ? '+' : ''}${Math.round(data.night_change)}` : '—', color: data.night_change > 0 ? 'var(--ios-red)' : 'var(--ios-green)' },
    { label: 'PCR', value: data.pcr?.toFixed(2), color: data.pcr > 1.2 ? 'var(--ios-red)' : data.pcr < 0.8 ? 'var(--ios-green)' : 'var(--ios-label)' },
    { label: 'TAIEX RSI', value: data.taiex_rsi?.toFixed(0) || data.rsi14?.toFixed(0), color: 'var(--ios-label)' },
    { label: 'MACD 直方', value: data.macd_hist != null ? `${data.macd_hist > 0 ? '+' : ''}${data.macd_hist.toFixed(1)}` : null, color: data.macd_hist > 0 ? 'var(--ios-red)' : 'var(--ios-green)' },
    { label: '距 MA60', value: data.dist_ma60 != null ? `${data.dist_ma60 > 0 ? '+' : ''}${data.dist_ma60.toFixed(1)}%` : null, color: data.dist_ma60 > 0 ? 'var(--ios-red)' : 'var(--ios-green)' },
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
  const color = pct >= 60 ? 'var(--ios-red)' : pct <= 40 ? 'var(--ios-green)' : 'var(--ios-yellow)'
  const riskLevel = (entry.risk?.level?.replace('RiskLevel.', '') || 'MEDIUM').toUpperCase()

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

export default function PredictionPanel({ prediction, history = [], benchCurve = [], realOutcomes = null, futuresChips = null }) {
  // NOTE: all hooks must run before the empty-state return — `prediction` can flip
  // from null to an object on the SAME mounted component (刷新 after the morning
  // prediction lands), and an early return above hooks would change the hook count
  // between renders and crash the whole tab.
  const { xgb_prob_up, xgb_label, date, generated_at, regime, scenario, risk, news_sentiment, market_data, ai_insight, input_completeness } = prediction || {}
  // data.json ships lowercase levels ('medium'); legacy entries may carry a
  // 'RiskLevel.' prefix — normalize both into the uppercase RISK_COLOR/LABEL keys.
  const riskLevel = (risk?.level?.replace('RiskLevel.', '') || 'MEDIUM').toUpperCase()
  const riskBarRef = useRef(null)
  const bullBearRef = useRef(null)
  useGSAP(() => {
    const arm = (el) => {
      if (!el) return null
      const tw = gsap.from(el, { scaleX: 0, transformOrigin: 'left center', duration: 0.7, ease: 'power3.out', paused: true })
      const io = new IntersectionObserver((es) => {
        if (es[0].isIntersecting) { tw.play(); io.disconnect() }
      }, { threshold: 0.25 })
      io.observe(el)
      return io
    }
    const ios = [arm(riskBarRef.current), arm(bullBearRef.current)].filter(Boolean)
    return () => ios.forEach(io => io.disconnect())
  }, { dependencies: [date] })
  const [histPage, setHistPage] = useState(0)
  const histTotalPages = Math.ceil(history.length / HIST_PAGE_SIZE)
  const pagedHistory = useMemo(
    () => history.slice(histPage * HIST_PAGE_SIZE, (histPage + 1) * HIST_PAGE_SIZE),
    [history, histPage]
  )

  if (!prediction) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 48 }}>🔮</div>
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ios-label)' }}>尚無盤前預測</div>
        <div style={{ fontSize: 14, color: 'var(--ios-label2)', maxWidth: 280, lineHeight: 1.6 }}>每個交易日盤前執行後，這裡會顯示 AI 預測分析、市場結構分析、風險評估</div>
      </div>
    )
  }

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
              color={xgb_prob_up >= 0.55 ? 'var(--ios-red)' : xgb_prob_up <= 0.45 ? 'var(--ios-green)' : 'var(--ios-yellow)'} />
            {regime && <Tag text={`勝率 ${regime.win_rate > 1 ? regime.win_rate : Math.round(regime.win_rate * 100)}%`} color="var(--ios-blue)" />}
          </div>
          {(() => {
            // Honest low-confidence flag — don't let an unreliable call be treated as gospel.
            const md = market_data || {}
            const reasons = []
            if (md.sox_ret == null && md.nasdaq_ret == null) reasons.push('隔夜美股資料缺')
            if (Math.abs((xgb_prob_up ?? 0.5) - 0.5) < 0.05) reasons.push('機率接近五五波')
            const rwin = regime?.win_rate == null ? null : (regime.win_rate > 1 ? regime.win_rate : regime.win_rate * 100)
            if (rwin != null && rwin < 40) reasons.push('此盤勢歷史勝率偏低')
            // 模型 vs 明確空方事實的分歧:夜盤重挫且外資大空單,模型卻看多。
            // 這種日子(如 07-17:夜盤 −735、期空 −84,453 口,模型 64% 看多,
            // 且美股特徵缺失)方向判讀不可信——紅色警告直接放標題卡,不讓
            // 大大的「看多」誤導(詳細逐條驗證在下方交叉驗證卡)。
            const hardBear = (md.night_change != null && md.night_change < -150 ? 1 : 0)
              + (md.futures_net != null && md.futures_net < -30000 ? 1 : 0)
            const divergeBull = hardBear >= 2 && (xgb_prob_up ?? 0.5) >= 0.55
            return (
              <>
                {divergeBull && (
                  <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(255,51,64,0.1)', border: '0.5px solid rgba(255,51,64,0.4)', borderRadius: 10, fontSize: 12, color: 'var(--ios-red)', fontWeight: 700, lineHeight: 1.6 }}>
                    🚨 模型看多,但夜盤重挫({Math.round(md.night_change)} 點)+ 外資期貨大空單({Math.round(md.futures_net).toLocaleString()} 口)——訊號與模型嚴重分歧,今日方向判讀不可信,建議只做風控不做方向
                  </div>
                )}
                {reasons.length > 0 && (
                  <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(255,159,10,0.1)', border: '0.5px solid rgba(255,159,10,0.35)', borderRadius: 10, fontSize: 12, color: 'var(--ios-yellow)', fontWeight: 600, lineHeight: 1.5 }}>
                    ⚠️ 低信心：{reasons.join('、')} — 建議降低倉位、別當鐵口
                  </div>
                )}
              </>
            )
          })()}
          {regime?.label_zh && (
            <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--ios-bg3)', borderRadius: 10, fontSize: 14, color: 'var(--ios-label)', lineHeight: 1.5 }}>
              {regime.label_zh}
            </div>
          )}
        </Card>

        {/* Honest input-completeness breakdown — when to trust the call */}
        <InputCompletenessCard completeness={input_completeness} />

        {/* 期貨籌碼 — 三大法人未平倉 + 夜盤 */}
        <FuturesChipsPanel futuresChips={futuresChips} market_data={market_data} history={history} />

        {/* Rule-based bearish cross-check vs the model */}
        <BearishCrossCheck market_data={market_data} prob={xgb_prob_up} />

        {/* Probability trend across recent days */}
        <ProbTrend history={history} />

        {/* Daily prediction vs actual scoreboard */}
        <PredictionReviewPanel history={history} benchCurve={benchCurve} realOutcomes={realOutcomes} />

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
                // 台股慣例（與本頁其他區塊一致）：紅=多/漲、綠=空/跌
                { label: '利多', val: news_sentiment.bullish_count, color: 'var(--ios-red)' },
                { label: '利空', val: news_sentiment.bearish_count, color: 'var(--ios-green)' },
                { label: '市場影響', val: news_sentiment.market_impact == null ? '—' : `${news_sentiment.market_impact > 0 ? '+' : ''}${news_sentiment.market_impact.toFixed(2)}`, color: news_sentiment.market_impact > 0 ? 'var(--ios-red)' : news_sentiment.market_impact < 0 ? 'var(--ios-green)' : 'var(--ios-label2)' },
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
                  {/* 左段=偏多(紅)、右段=偏空(綠)，標籤顏色與所指區段一致（台股慣例） */}
                  <div ref={bullBearRef} style={{ display: 'flex', height: 8, borderRadius: 9999, overflow: 'hidden', background: 'var(--ios-bg3)' }}>
                    <div style={{ width: `${bp}%`, background: 'var(--ios-red)' }} />
                    <div style={{ width: `${100 - bp}%`, background: 'var(--ios-green)' }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ios-label3)', marginTop: 4 }}>
                    <span style={{ color: 'var(--ios-red)' }}>偏多 {Math.round(bp)}%</span>
                    <span style={{ color: 'var(--ios-green)' }}>偏空 {Math.round(100 - bp)}%</span>
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
