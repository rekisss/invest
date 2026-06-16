import { useState, useRef, useMemo } from 'react'

const fmt = (v, dec = 2) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(dec))
const pct = (v) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`)
const colorNum = (v, pos = 'var(--ios-red)', neg = 'var(--ios-green)') => {
  const n = Number(v)
  if (isNaN(n) || n === 0) return 'var(--ios-label3)'
  return n > 0 ? pos : neg
}

// Taiwan convention: red = up, green = down
function candleColor(open, close) { return close >= open ? '#FF453A' : '#30D158' }

function isOTC(stockId) {
  const n = parseInt(String(stockId), 10)
  return (n >= 4200 && n <= 4999) || (n >= 5000 && n <= 5999) ||
         (n >= 6000 && n <= 6999) || (n >= 8000 && n <= 8999) || (n >= 9200 && n <= 9999)
}

// ── Technical indicator computation ─────────────────────────────────────────

function smaCalc(arr, n) {
  return arr.map((_, i) => {
    if (i < n - 1) return null
    return arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n
  })
}

function emaCalc(arr, n) {
  const k = 2 / (n + 1)
  const result = new Array(arr.length).fill(null)
  let prev = null
  for (let i = 0; i < arr.length; i++) {
    if (prev === null) {
      if (i === n - 1) {
        prev = arr.slice(0, n).reduce((a, b) => a + b, 0) / n
        result[i] = prev
      }
    } else {
      prev = arr[i] * k + prev * (1 - k)
      result[i] = prev
    }
  }
  return result
}

function bollingerCalc(arr, n = 20, mult = 2) {
  return arr.map((_, i) => {
    if (i < n - 1) return null
    const slice = arr.slice(i - n + 1, i + 1)
    const mean = slice.reduce((a, b) => a + b, 0) / n
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / n)
    return { mid: mean, upper: mean + mult * std, lower: mean - mult * std }
  })
}

function macdCalc(arr, fast = 12, slow = 26, sig = 9) {
  const eFast = emaCalc(arr, fast)
  const eSlow = emaCalc(arr, slow)
  const macdLine = arr.map((_, i) =>
    eFast[i] != null && eSlow[i] != null ? eFast[i] - eSlow[i] : null
  )
  const nonNull = macdLine.map((v, i) => ({ v, i })).filter(x => x.v != null)
  const k = 2 / (sig + 1)
  let sigVal = null
  let nCount = 0
  const signalLine = new Array(arr.length).fill(null)
  for (const { v, i } of nonNull) {
    nCount++
    if (sigVal === null) {
      if (nCount === sig) {
        const startI = nonNull[0].i
        const vals = macdLine.slice(startI, startI + sig).filter(x => x != null)
        sigVal = vals.reduce((a, b) => a + b, 0) / sig
        signalLine[i] = sigVal
      }
    } else {
      sigVal = v * k + sigVal * (1 - k)
      signalLine[i] = sigVal
    }
  }
  const hist = macdLine.map((m, i) =>
    m != null && signalLine[i] != null ? m - signalLine[i] : null
  )
  return { macdLine, signalLine, hist }
}

function rsiCalc(arr, n = 14) {
  const result = new Array(arr.length).fill(null)
  if (arr.length < n + 1) return result
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= n; i++) {
    const d = arr[i] - arr[i - 1]
    if (d > 0) avgGain += d; else avgLoss -= d
  }
  avgGain /= n; avgLoss /= n
  result[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = n + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1]
    avgGain = (avgGain * (n - 1) + (d > 0 ? d : 0)) / n
    avgLoss = (avgLoss * (n - 1) + (d < 0 ? -d : 0)) / n
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return result
}

function kdCalc(bars, n = 9, m = 3) {
  const kArr = new Array(bars.length).fill(null)
  const dArr = new Array(bars.length).fill(null)
  let prevK = 50, prevD = 50
  for (let i = n - 1; i < bars.length; i++) {
    const slice = bars.slice(i - n + 1, i + 1)
    const hh = Math.max(...slice.map(b => b.high))
    const ll = Math.min(...slice.map(b => b.low))
    const rsv = hh === ll ? 50 : (bars[i].close - ll) / (hh - ll) * 100
    const k = ((m - 1) * prevK + rsv) / m
    const d = ((m - 1) * prevD + k) / m
    kArr[i] = k; dArr[i] = d
    prevK = k; prevD = d
  }
  return { kArr, dArr }
}

// Build a polyline points string, splitting at nulls into segments
function toPolySegs(values, toXFn, toYFn) {
  const segments = []
  let cur = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v == null) {
      if (cur.length >= 2) segments.push(cur.join(' '))
      cur = []
    } else {
      cur.push(`${toXFn(i).toFixed(1)},${toYFn(v).toFixed(1)}`)
    }
  }
  if (cur.length >= 2) segments.push(cur.join(' '))
  return segments
}

// ── Sub-chart panel (MACD / RSI / KD) ───────────────────────────────────────

const CHART_W = 460
const CHART_PL = 42
const CHART_PR = 6

function SubChartSVG({ bars, label, lines, histSeries, hBands, hoveredIdx, onHoverIdx, yFixed }) {
  const subTouchRef = useRef(null)
  const H = 72, PT = 6
  const n = bars.length
  const slotW = (CHART_W - CHART_PL - CHART_PR) / n
  const toX = i => CHART_PL + (i + 0.5) * slotW

  const allVals = [
    ...(lines || []).flatMap(l => l.values.filter(v => v != null)),
    ...(histSeries ? histSeries.values.filter(v => v != null) : []),
  ]
  const rawMin = allVals.length ? Math.min(...allVals) : 0
  const rawMax = allVals.length ? Math.max(...allVals) : 1
  const pad = (rawMax - rawMin) * 0.08 || 1
  const minV = yFixed ? yFixed[0] : rawMin - pad
  const maxV = yFixed ? yFixed[1] : rawMax + pad
  const range = maxV - minV || 1
  const toY = v => PT + (1 - (v - minV) / range) * (H - PT * 2)

  const bW = Math.max(slotW * 0.6, 1)

  const handleMove = (clientX, svgEl) => {
    if (!onHoverIdx) return
    const rect = svgEl.getBoundingClientRect()
    const svgX = (clientX - rect.left) / rect.width * CHART_W
    const idx = Math.floor((svgX - CHART_PL) / slotW)
    onHoverIdx(idx >= 0 && idx < n ? idx : null)
  }

  const handleTouchStart = (e) => {
    const t = e.touches[0]
    subTouchRef.current = { startX: t.clientX, startY: t.clientY, svgEl: e.currentTarget }
  }
  const handleTouchMove = (e) => {
    if (!subTouchRef.current) return
    const t = e.touches[0]
    const dx = Math.abs(t.clientX - subTouchRef.current.startX)
    const dy = Math.abs(t.clientY - subTouchRef.current.startY)
    if (dx > dy && dx > 5) {
      e.stopPropagation()
      handleMove(t.clientX, subTouchRef.current.svgEl)
    }
  }
  const handleTouchEnd = () => { subTouchRef.current = null; onHoverIdx?.(null) }

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${H + PT + 4}`}
      style={{ width: '100%', display: 'block', background: 'rgba(20,20,22,0.85)', borderTop: '0.5px solid #2C2C2E', marginTop: 2, touchAction: 'pan-y' }}
      onMouseMove={e => handleMove(e.clientX, e.currentTarget)}
      onMouseLeave={() => onHoverIdx?.(null)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Zero line or reference lines */}
      {(hBands || []).map((b, i) => (
        <g key={i}>
          <line x1={CHART_PL} y1={toY(b.value)} x2={CHART_W - CHART_PR} y2={toY(b.value)}
            stroke={b.color || '#48484A'} strokeWidth={0.5} strokeDasharray="4,3" opacity={0.65} />
          <text x={CHART_W - CHART_PR + 3} y={toY(b.value) + 3.5} fontSize={7} fill={b.color || '#48484A'} opacity={0.85}>{b.label ?? b.value}</text>
        </g>
      ))}

      {/* Histogram bars */}
      {histSeries && histSeries.values.map((v, i) => {
        if (v == null) return null
        const x = toX(i), zero = toY(0), y = toY(v), h = Math.abs(y - zero)
        return <rect key={i} x={x - bW / 2} y={Math.min(y, zero)} width={bW} height={Math.max(h, 0.5)}
          fill={v >= 0 ? '#FF453A' : '#30D158'} opacity={0.75} />
      })}

      {/* Line series */}
      {(lines || []).map((series, si) =>
        toPolySegs(series.values, toX, toY).map((pts, sj) => (
          <polyline key={`${si}-${sj}`} points={pts} fill="none"
            stroke={series.color} strokeWidth={series.width || 1.2} opacity={series.opacity || 0.9} />
        ))
      )}

      {/* Y-axis labels (3 levels) */}
      {[0, 0.5, 1].map(t => {
        const v = minV + t * range
        const y = PT + (1 - t) * (H - PT * 2)
        const label = Math.abs(v) < 0.01 ? v.toFixed(3) : Math.abs(v) < 1 ? v.toFixed(2) : Math.abs(v) < 10 ? v.toFixed(1) : v.toFixed(0)
        return (
          <text key={t} x={CHART_PL - 3} y={y + 3.5} fontSize={7.5} fill="#48484A" textAnchor="end">{label}</text>
        )
      })}

      {/* Chart label */}
      <text x={CHART_PL + 3} y={PT + 9} fontSize={8} fill="#636366" fontWeight="bold">{label}</text>

      {/* Hover values */}
      {hoveredIdx != null && (lines || []).map((series, si) => {
        const v = series.values[hoveredIdx]
        if (v == null) return null
        const disp = Math.abs(v) < 0.01 ? v.toFixed(3) : Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(1)
        return (
          <text key={si} x={CHART_PL + 36 + si * 58} y={PT + 9} fontSize={8} fill={series.color}>
            {series.label}:{disp}
          </text>
        )
      })}

      {/* Crosshair */}
      {hoveredIdx != null && hoveredIdx >= 0 && hoveredIdx < n && (
        <line x1={toX(hoveredIdx)} y1={0} x2={toX(hoveredIdx)} y2={H + PT}
          stroke="#0A84FF" strokeWidth={0.6} strokeDasharray="2,2" opacity={0.55} />
      )}
    </svg>
  )
}

// ── Candlestick chart ────────────────────────────────────────────────────────

function CandleSVG({ data, maLines, bbBands, onHoverIdx }) {
  const [hovered, setHovered] = useState(null)
  const touchRef = useRef(null)

  const chart = useMemo(() => {
    if (!data || data.length < 2) return null
    const bars = data.slice(-60)
    const W = CHART_W, CH = 200, VH = 45, GAP = 6, H = CH + GAP + VH
    const PL = CHART_PL, PR = CHART_PR, PT = 8
    const maxP = Math.max(...bars.map(d => d.high), ...(bbBands?.upper?.filter(Boolean) || []))
    const minP = Math.min(...bars.map(d => d.low),  ...(bbBands?.lower?.filter(Boolean) || []))
    const pRange = maxP - minP || 1
    const maxVol = Math.max(...bars.map(d => d.volume), 1)
    const n = bars.length
    const slotW = (W - PL - PR) / n
    const bW = Math.max(slotW * 0.65, 1.5)
    const toY = p => PT + (1 - (p - minP) / pRange) * CH
    const toX = i => PL + (i + 0.5) * slotW
    const gridLevels = [0, 1/3, 2/3, 1].map(t => ({
      price: minP + t * pRange, y: PT + (1 - t) * CH,
    }))
    const xStep = Math.max(1, Math.floor(n / 5))
    const xLabels = bars.map((d, i) => ({ i, label: d.time.slice(5) })).filter((_, i) => i % xStep === 0 || i === n - 1)
    return { bars, W, CH, VH, GAP, H, PL, PR, PT, maxVol, n, slotW, bW, toY, toX, gridLevels, xLabels }
  }, [data, bbBands])

  if (!chart) return (
    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ios-label3)', fontSize: 12, background: 'var(--ios-bg)', borderRadius: 10 }}>
      暫無歷史 K 線資料
    </div>
  )

  const { bars, W, CH, VH, GAP, H, PL, PR, PT, maxVol, slotW, bW, toY, toX, gridLevels, xLabels } = chart

  const getIdx = (clientX, svgEl) => {
    const rect = svgEl.getBoundingClientRect()
    const svgX = (clientX - rect.left) / rect.width * W
    return Math.floor((svgX - PL) / slotW)
  }

  const setBar = (idx, svgEl) => {
    if (idx >= 0 && idx < bars.length) {
      setHovered({ idx, bar: bars[idx], x: toX(idx) })
      onHoverIdx?.(idx)
    } else {
      setHovered(null)
      onHoverIdx?.(null)
    }
  }

  const handleMouseMove = (e) => setBar(getIdx(e.clientX, e.currentTarget), e.currentTarget)
  const handleMouseLeave = () => { setHovered(null); onHoverIdx?.(null) }

  const handleTouchStart = (e) => {
    const t = e.touches[0]
    touchRef.current = { startX: t.clientX, startY: t.clientY, svgEl: e.currentTarget, active: false }
  }
  const handleTouchMove = (e) => {
    if (!touchRef.current) return
    const t = e.touches[0]
    const dx = Math.abs(t.clientX - touchRef.current.startX)
    const dy = Math.abs(t.clientY - touchRef.current.startY)
    if (dx > dy && dx > 5) {
      e.stopPropagation()
      touchRef.current.active = true
      setBar(getIdx(t.clientX, touchRef.current.svgEl))
    } else if (dy > 8 && !touchRef.current.active) {
      setHovered(null); onHoverIdx?.(null)
    }
  }
  const handleTouchEnd = () => {
    touchRef.current = null
    setHovered(null); onHoverIdx?.(null)
  }

  const tipW = 118, tipH = 94
  const tipX = hovered ? (hovered.x > W / 2 ? hovered.x - tipW - 6 : hovered.x + 8) : 0
  const tipY = PT + 4

  // Build polyline segments for MA/BB
  const bbSegs = bbBands ? {
    upper: toPolySegs(bbBands.upper, toX, toY),
    mid:   toPolySegs(bbBands.mid,   toX, toY),
    lower: toPolySegs(bbBands.lower, toX, toY),
  } : null

  return (
    <svg
      viewBox={`0 0 ${W} ${H + PT + 18}`}
      style={{ width: '100%', display: 'block', background: 'var(--ios-bg)', borderRadius: '10px 10px 0 0', cursor: 'crosshair', touchAction: 'pan-y', userSelect: 'none', WebkitUserSelect: 'none' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Grid */}
      {gridLevels.map(({ y, price }, j) => (
        <g key={j}>
          <line x1={PL} y1={y} x2={W - 6} y2={y} stroke="#2C2C2E" strokeWidth={0.5} />
          <text x={PL - 3} y={y + 3.5} fontSize={8.5} fill="#636366" textAnchor="end">
            {price >= 100 ? price.toFixed(0) : price.toFixed(1)}
          </text>
        </g>
      ))}

      {/* Bollinger Bands */}
      {bbSegs && <>
        {bbSegs.upper.map((pts, i) => <polyline key={`bbu${i}`} points={pts} fill="none" stroke="rgba(10,132,255,0.45)" strokeWidth={0.8} strokeDasharray="4,3" />)}
        {bbSegs.mid.map((pts, i)   => <polyline key={`bbm${i}`} points={pts} fill="none" stroke="rgba(10,132,255,0.28)" strokeWidth={0.8} />)}
        {bbSegs.lower.map((pts, i) => <polyline key={`bbl${i}`} points={pts} fill="none" stroke="rgba(10,132,255,0.45)" strokeWidth={0.8} strokeDasharray="4,3" />)}
      </>}

      {/* Candles + volume */}
      {bars.map((d, i) => {
        const x = toX(i), color = candleColor(d.open, d.close)
        const bodyTop = toY(Math.max(d.open, d.close))
        const bodyBot = toY(Math.min(d.open, d.close))
        const bodyH = Math.max(bodyBot - bodyTop, 1)
        const volH = (d.volume / maxVol) * VH
        const isHovered = hovered?.idx === i
        return (
          <g key={i} opacity={hovered && !isHovered ? 0.45 : 1}>
            <line x1={x} y1={toY(d.high)} x2={x} y2={toY(d.low)} stroke={color} strokeWidth={isHovered ? 1.4 : 0.8} />
            <rect x={x - bW / 2} y={bodyTop} width={bW} height={bodyH} fill={color} stroke={isHovered ? '#fff' : 'none'} strokeWidth={0.5} />
            <rect x={x - bW / 2} y={CH + GAP + PT + VH - volH} width={bW} height={volH} fill={color} opacity={isHovered ? 0.75 : 0.45} />
          </g>
        )
      })}

      {/* MA overlays */}
      {(maLines || []).map((ma, mi) =>
        toPolySegs(ma.values, toX, toY).map((pts, sj) => (
          <polyline key={`ma${mi}-${sj}`} points={pts} fill="none" stroke={ma.color} strokeWidth={1.2} opacity={0.85} />
        ))
      )}

      {/* X-axis labels */}
      {xLabels.map(({ i, label }) => (
        <text key={i} x={toX(i)} y={H + PT + 12} fontSize={8.5} fill="#636366" textAnchor="middle">{label}</text>
      ))}

      {/* Tooltip */}
      {hovered && (() => {
        const b = hovered.bar
        const closeColor = candleColor(b.open, b.close)
        const vol = b.volume >= 1000000 ? `${(b.volume / 1000000).toFixed(1)}M` : `${(b.volume / 1000).toFixed(0)}K`
        return (
          <g>
            <line x1={hovered.x} y1={PT} x2={hovered.x} y2={H + PT} stroke="#0A84FF" strokeWidth={0.6} strokeDasharray="3,3" opacity={0.7} />
            <line x1={PL} y1={toY(b.close)} x2={W - PR} y2={toY(b.close)} stroke="#0A84FF" strokeWidth={0.4} strokeDasharray="2,3" opacity={0.5} />
            <rect x={0} y={toY(b.close) - 7} width={PL - 2} height={13} fill="#1C1C1E" rx={2} />
            <text x={PL - 5} y={toY(b.close) + 4} fontSize={8} fill={closeColor} textAnchor="end" fontWeight="bold">
              {b.close >= 100 ? b.close.toFixed(1) : b.close.toFixed(2)}
            </text>
            <rect x={tipX} y={tipY} width={tipW} height={tipH} fill="#1C1C1E" rx={6} stroke="#3A3A3C" strokeWidth={0.8} />
            <text x={tipX + 7} y={tipY + 13} fontSize={9} fill="#8E8E93" fontWeight="bold">{b.time}</text>
            <line x1={tipX + 4} y1={tipY + 17} x2={tipX + tipW - 4} y2={tipY + 17} stroke="#2C2C2E" strokeWidth={0.5} />
            <text x={tipX + 7} y={tipY + 30} fontSize={8.5} fill="#636366">開 <tspan fill="#EBEBF5">{b.open.toFixed(b.open >= 100 ? 1 : 2)}</tspan></text>
            <text x={tipX + 7} y={tipY + 43} fontSize={8.5} fill="#636366">高 <tspan fill="#FF453A">{b.high.toFixed(b.high >= 100 ? 1 : 2)}</tspan></text>
            <text x={tipX + 7} y={tipY + 56} fontSize={8.5} fill="#636366">低 <tspan fill="#30D158">{b.low.toFixed(b.low >= 100 ? 1 : 2)}</tspan></text>
            <text x={tipX + 7} y={tipY + 69} fontSize={8.5} fill="#636366">收 <tspan fill={closeColor} fontWeight="bold">{b.close.toFixed(b.close >= 100 ? 1 : 2)}</tspan></text>
            <text x={tipX + 7} y={tipY + 82} fontSize={8.5} fill="#636366">量 <tspan fill="#8E8E93">{vol}</tspan></text>
          </g>
        )
      })()}
    </svg>
  )
}

// ── Interval + resample ──────────────────────────────────────────────────────

const INTERVAL_LABELS = [
  { id: '1d',  label: '日' },
  { id: '1wk', label: '週' },
  { id: '1mo', label: '月' },
]

function resampleBars(dailyBars, unit) {
  if (!dailyBars || dailyBars.length < 2) return []
  const buckets = {}
  for (const bar of dailyBars) {
    let key
    if (unit === 'week') {
      const d = new Date(bar.time)
      const dow = d.getUTCDay()
      const daysBack = dow === 0 ? 6 : dow - 1
      const mon = new Date(d)
      mon.setUTCDate(d.getUTCDate() - daysBack)
      key = mon.toISOString().slice(0, 10)
    } else {
      key = bar.time.slice(0, 7) + '-01'
    }
    if (!buckets[key]) {
      buckets[key] = { time: key, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }
    } else {
      buckets[key].high = Math.max(buckets[key].high, bar.high)
      buckets[key].low  = Math.min(buckets[key].low,  bar.low)
      buckets[key].close = bar.close
      buckets[key].volume += bar.volume
    }
  }
  return Object.values(buckets).sort((a, b) => a.time.localeCompare(b.time))
}

// ── Dynamic value strip (updates with crosshair) ─────────────────────────────

function ChartValueStrip({ bars, indicators, active, hoveredIdx }) {
  const i = hoveredIdx != null ? hoveredIdx : bars.length - 1
  const bar = bars[i]
  if (!bar || !indicators) return null

  const rsi  = indicators.rsi[i]
  const macdL = indicators.macd.macdLine[i]
  const macdH = indicators.macd.hist[i]
  const k = indicators.kd.kArr[i]
  const d = indicators.kd.dArr[i]
  const vn = (val, dec = 1) => val != null ? Number(val).toFixed(dec) : '—'

  return (
    <div style={{
      display: 'flex', gap: 10, padding: '5px 2px 5px', fontSize: 10.5,
      flexWrap: 'wrap', alignItems: 'center', borderBottom: '0.5px solid var(--ios-sep)',
      marginBottom: 1, minHeight: 26,
    }}>
      <span style={{ color: 'var(--ios-label3)', fontSize: 10, minWidth: 44, flexShrink: 0 }}>
        {hoveredIdx != null ? bar.time.slice(5) : '最新'}
      </span>
      {active.rsi && rsi != null && (
        <span style={{ color: 'var(--ios-label3)' }}>
          RSI <b style={{ color: rsi > 70 ? '#FF453A' : rsi < 30 ? '#30D158' : '#BF5AF2' }}>{vn(rsi)}</b>
        </span>
      )}
      {active.macd && macdL != null && (
        <span style={{ color: 'var(--ios-label3)' }}>
          MACD <b style={{ color: '#0A84FF' }}>{vn(macdL, 2)}</b>
          {macdH != null && <> <b style={{ color: macdH >= 0 ? '#FF453A' : '#30D158' }}>({macdH >= 0 ? '+' : ''}{vn(macdH, 2)})</b></>}
        </span>
      )}
      {active.kd && k != null && (
        <span style={{ color: 'var(--ios-label3)' }}>
          K <b style={{ color: '#FF9F0A' }}>{vn(k)}</b>{' '}
          D <b style={{ color: '#0A84FF' }}>{vn(d)}</b>
        </span>
      )}
    </div>
  )
}

// ── KLineChart: orchestrates candlestick + all sub-charts ────────────────────

const MA_LINES_DEF = [
  { label: 'MA5',   color: '#5AC8FA', fn: c => smaCalc(c, 5),  },
  { label: 'MA10',  color: '#FF9F0A', fn: c => smaCalc(c, 10), },
  { label: 'EMA20', color: '#BF5AF2', fn: c => emaCalc(c, 20), },
  { label: 'EMA60', color: '#FFD60A', fn: c => emaCalc(c, 60), },
]

const TOGGLE_DEFS = [
  { key: 'ma',   label: 'MA',   color: '#5AC8FA' },
  { key: 'bb',   label: 'BB',   color: '#0A84FF' },
  { key: 'macd', label: 'MACD', color: '#FF9F0A' },
  { key: 'rsi',  label: 'RSI',  color: '#BF5AF2' },
  { key: 'kd',   label: 'KD',   color: '#30D158' },
]

function KLineChart({ stockId, priceHistory, priceHistoryWk, priceHistoryMo }) {
  const cnyesUrl = `https://www.cnyes.com/twstock/${stockId}`
  const wantgooUrl = `https://www.wantgoo.com/stock/${stockId}`

  const daily   = Array.isArray(priceHistory) ? priceHistory : []
  const weekly  = (Array.isArray(priceHistoryWk) && priceHistoryWk.length >= 2) ? priceHistoryWk : resampleBars(daily, 'week')
  const monthly = (Array.isArray(priceHistoryMo) && priceHistoryMo.length >= 2) ? priceHistoryMo : resampleBars(daily, 'month')
  const dataMap = { '1d': daily, '1wk': weekly, '1mo': monthly }

  const [chartInterval, setChartInterval] = useState(
    () => INTERVAL_LABELS.find(t => dataMap[t.id].length >= 2)?.id || '1d'
  )
  const [active, setActive] = useState({ ma: true, bb: false, macd: true, rsi: true, kd: false })
  const [hoveredIdx, setHoveredIdx] = useState(null)

  const toggle = key => setActive(prev => ({ ...prev, [key]: !prev[key] }))

  const bars = (dataMap[chartInterval] || []).slice(-60)

  const indicators = useMemo(() => {
    if (bars.length < 2) return null
    const closes = bars.map(d => d.close)
    const bb = bollingerCalc(closes, 20, 2)
    return {
      maLines: MA_LINES_DEF.map(m => ({ ...m, values: m.fn(closes) })),
      bbBands: {
        upper: bb.map(v => v?.upper ?? null),
        mid:   bb.map(v => v?.mid   ?? null),
        lower: bb.map(v => v?.lower ?? null),
      },
      macd: macdCalc(closes),
      rsi: rsiCalc(closes),
      kd: kdCalc(bars),
    }
  }, [bars])

  const unitLabel = { '1d': '個交易日', '1wk': '週', '1mo': '個月' }

  return (
    <div>
      {/* Top controls row */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Interval */}
        <div style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--ios-fill4)', borderRadius: 8 }}>
          {INTERVAL_LABELS.map(t => {
            const avail = dataMap[t.id].length >= 2
            const isActive = chartInterval === t.id
            return (
              <button key={t.id} onClick={() => avail && setChartInterval(t.id)} style={{
                background: isActive ? 'var(--ios-bg3)' : 'transparent',
                border: 'none', color: isActive ? 'var(--ios-label)' : 'var(--ios-label3)',
                borderRadius: 6, padding: '4px 14px', fontSize: 12,
                cursor: avail ? 'pointer' : 'default', fontWeight: isActive ? 600 : 400,
                boxShadow: isActive ? '0 1px 4px rgba(0,0,0,0.3)' : 'none', transition: 'all 0.15s',
              }}>{t.label}</button>
            )
          })}
        </div>
        {/* Indicator toggles */}
        {TOGGLE_DEFS.map(({ key, label, color }) => (
          <button key={key} onClick={() => toggle(key)} style={{
            background: active[key] ? `${color}20` : 'var(--ios-fill4)',
            color: active[key] ? color : 'var(--ios-label3)',
            border: `0.5px solid ${active[key] ? color : 'transparent'}`,
            borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 600,
            transition: 'all 0.15s',
          }}>{label}</button>
        ))}
      </div>

      {/* MA legend */}
      {active.ma && indicators && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 5, flexWrap: 'wrap', paddingLeft: 2 }}>
          {MA_LINES_DEF.map(m => (
            <span key={m.label} style={{ fontSize: 10, color: m.color, fontWeight: 600 }}>— {m.label}</span>
          ))}
          {active.bb && <span style={{ fontSize: 10, color: 'rgba(10,132,255,0.7)', fontWeight: 600 }}>— BB(20)</span>}
        </div>
      )}

      {/* Main candlestick chart */}
      {bars.length >= 2 ? (
        <CandleSVG
          data={bars}
          maLines={active.ma && indicators ? indicators.maLines : []}
          bbBands={active.bb && indicators ? indicators.bbBands : null}
          onHoverIdx={setHoveredIdx}
        />
      ) : (
        <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ios-label3)', fontSize: 12, background: 'var(--ios-bg)', borderRadius: 10 }}>
          暫無歷史 K 線資料
        </div>
      )}

      {/* Dynamic indicator value strip — updates with crosshair */}
      {bars.length >= 2 && indicators && (
        <ChartValueStrip bars={bars} indicators={indicators} active={active} hoveredIdx={hoveredIdx} />
      )}

      {/* MACD sub-chart */}
      {active.macd && indicators && bars.length >= 26 && (
        <SubChartSVG
          bars={bars}
          label="MACD(12,26,9)"
          histSeries={{ values: indicators.macd.hist }}
          lines={[
            { color: '#0A84FF', label: 'MACD', values: indicators.macd.macdLine, width: 1 },
            { color: '#FF453A', label: 'Signal', values: indicators.macd.signalLine, width: 1 },
          ]}
          hBands={[{ value: 0, color: '#48484A', label: '' }]}
          hoveredIdx={hoveredIdx}
          onHoverIdx={setHoveredIdx}
        />
      )}

      {/* RSI sub-chart */}
      {active.rsi && indicators && bars.length >= 15 && (
        <SubChartSVG
          bars={bars}
          label="RSI(14)"
          lines={[{ color: '#BF5AF2', label: 'RSI', values: indicators.rsi, width: 1.2 }]}
          hBands={[
            { value: 70, color: '#FF453A', label: '70' },
            { value: 50, color: '#48484A', label: '50' },
            { value: 30, color: '#30D158', label: '30' },
          ]}
          hoveredIdx={hoveredIdx}
          onHoverIdx={setHoveredIdx}
          yFixed={[0, 100]}
        />
      )}

      {/* KD sub-chart */}
      {active.kd && indicators && bars.length >= 9 && (
        <SubChartSVG
          bars={bars}
          label="KD(9,3)"
          lines={[
            { color: '#FF9F0A', label: 'K', values: indicators.kd.kArr, width: 1 },
            { color: '#0A84FF', label: 'D', values: indicators.kd.dArr, width: 1 },
          ]}
          hBands={[
            { value: 80, color: '#FF453A', label: '80' },
            { value: 20, color: '#30D158', label: '20' },
          ]}
          hoveredIdx={hoveredIdx}
          onHoverIdx={setHoveredIdx}
          yFixed={[0, 100]}
        />
      )}

      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, flexWrap: 'wrap', gap: 6 }}>
        {bars.length >= 2 && <span style={{ fontSize: 10, color: 'var(--ios-label3)' }}>近 {bars.length} {unitLabel[chartInterval]}</span>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href={cnyesUrl} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 11, color: 'var(--ios-blue)', textDecoration: 'none', padding: '4px 10px', background: 'var(--ios-fill4)', borderRadius: 8, border: '0.5px solid var(--ios-sep)' }}>
            鉅亨網 ↗
          </a>
          <a href={wantgooUrl} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 11, color: 'var(--ios-label2)', textDecoration: 'none', padding: '4px 10px', background: 'var(--ios-fill4)', borderRadius: 8, border: '0.5px solid var(--ios-sep)' }}>
            玩股網 ↗
          </a>
        </div>
      </div>
    </div>
  )
}

// ── Shared layout components ─────────────────────────────────────────────────

function Row({ label, value, valueStyle }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '0.5px solid var(--ios-sep)' }}>
      <span style={{ color: 'var(--ios-label2)', fontSize: 13 }}>{label}</span>
      <span style={{ color: 'var(--ios-label)', fontSize: 13, fontWeight: 600, ...valueStyle }}>{value}</span>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ background: 'var(--ios-bg2)', borderRadius: 12, padding: '10px 14px', marginBottom: 10, boxShadow: 'var(--shadow-card)' }}>
      <div style={{ color: 'var(--ios-blue)', fontSize: 11, fontWeight: 700, marginBottom: 8, letterSpacing: 0.8, textTransform: 'uppercase' }}>{title}</div>
      {children}
    </div>
  )
}

// ── Main modal ───────────────────────────────────────────────────────────────

export default function StockDetailModal({ stock, notionInfo, onClose }) {
  if (!stock) return null
  const s = stock
  const n = notionInfo || null
  const scoreColor = s.entry_score >= 1000 ? 'var(--ios-yellow)' : s.entry_score >= 700 ? 'var(--ios-orange)' : 'var(--ios-label)'

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex' }}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div style={{ flex: 1, background: 'rgba(0,0,0,0.55)' }} />

      {/* Panel */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(460px, 100vw)',
          height: '100vh',
          background: 'var(--ios-bg)',
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '20px 14px 48px',
          borderLeft: '0.5px solid var(--ios-sep)',
          borderRadius: '16px 0 0 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          boxShadow: '-8px 0 32px rgba(0,0,0,0.5)',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ios-label)', letterSpacing: '-0.3px' }}>
              {s.stock_id} <span style={{ fontSize: 16, color: 'var(--ios-label2)', fontWeight: 400 }}>{s.name}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--ios-label3)', marginTop: 3 }}>{s.industry_category}</div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'var(--ios-fill3)', border: 'none',
              color: 'var(--ios-label2)', borderRadius: 9999, width: 28, height: 28,
              cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
          >✕</button>
        </div>

        {/* K 線圖 + 指標子圖 */}
        <Section title="K 線圖 &amp; 技術指標">
          <KLineChart key={s.stock_id} stockId={s.stock_id} priceHistory={s.price_history} priceHistoryWk={s.price_history_wk} priceHistoryMo={s.price_history_mo} />
        </Section>

        {/* Notion 連結 */}
        {n && (
          <Section title="Notion 同步">
            {n.type && <Row label="類型" value={n.type} valueStyle={{ color: n.type === 'TOP 20' ? 'var(--ios-yellow)' : n.type === '候選進場' ? 'var(--ios-green)' : 'var(--ios-label2)' }} />}
            {n.regime && <Row label="市場氛圍" value={n.regime} />}
            {n.confidence != null && <Row label="信心分數" value={`${n.confidence}%`} />}
            {n.note && <Row label="觀察建議" value={n.note} valueStyle={{ color: 'var(--ios-blue)', fontSize: 11 }} />}
            {n.date && <Row label="同步日期" value={n.date} valueStyle={{ color: 'var(--ios-label3)' }} />}
            {n.notion_url && (
              <a
                href={n.notion_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'block', marginTop: 10, textAlign: 'center',
                  background: 'var(--ios-fill4)', border: '0.5px solid var(--ios-sep)',
                  borderRadius: 10, padding: '8px 12px',
                  color: 'var(--ios-blue)', fontSize: 13, textDecoration: 'none', fontWeight: 500,
                }}
              >
                在 Notion 查看 ↗
              </a>
            )}
          </Section>
        )}

        {/* 評分 */}
        <Section title="入場評分">
          <Row label="入場分數" value={s.entry_score} valueStyle={{ color: scoreColor, fontSize: 16 }} />
          <Row label="條件達成數" value={`${s.condition_count} 個`} />
          <Row label="入場訊號" value={s.entry_signal ? '✅ 是' : '❌ 否'} />
          {s.grade && (() => {
            const gc = { A: '#FFD60A', B: 'var(--ios-green)', C: 'var(--ios-orange)', D: 'var(--ios-label3)', X: 'var(--ios-red)' }
            return <Row label="評級" value={s.grade} valueStyle={{ color: gc[s.grade] || 'var(--ios-label3)', fontSize: 18, fontWeight: 800 }} />
          })()}
          {s.regime_label && s.regime_label !== '未知' && (
            <Row label="市場體制" value={s.regime_label} valueStyle={{ color: s.regime_label === '牛市' ? 'var(--ios-green)' : s.regime_label === '熊市' ? 'var(--ios-red)' : 'var(--ios-yellow)' }} />
          )}
          {s.entry_reason && <Row label="入場理由" value={s.entry_reason} valueStyle={{ color: 'var(--ios-green)', fontSize: 11 }} />}
          {s.skip_reason && <Row label="跳過原因" value={s.skip_reason} valueStyle={{ color: 'var(--ios-red)', fontSize: 11 }} />}
        </Section>

        {/* 橫截面信號 */}
        {(s.market_rs_rank > 0 || s.is_sector_leader) && (
          <Section title="橫截面信號">
            {s.market_rs_rank > 0 && (
              <Row label="全市場百分位排名" value={`${Math.round(s.market_rs_rank)}%`} valueStyle={{ color: s.market_rs_rank >= 90 ? '#FFD60A' : s.market_rs_rank >= 75 ? 'var(--ios-green)' : 'var(--ios-label)' }} />
            )}
            {s.sector_rs_rank > 0 && (
              <Row label="類股內百分位排名" value={`${Math.round(s.sector_rs_rank)}%`} valueStyle={{ color: s.sector_rs_rank >= 90 ? '#FFD60A' : s.sector_rs_rank >= 75 ? 'var(--ios-green)' : 'var(--ios-label)' }} />
            )}
            {s.sector_rs != null && s.sector_rs !== 0 && (
              <Row label="類股相對強弱" value={fmt(s.sector_rs, 0)} valueStyle={{ color: s.sector_rs > 0 ? 'var(--ios-red)' : 'var(--ios-green)' }} />
            )}
            {s.sector_breadth_60 > 0 && (
              <Row label="類股廣度(EMA60以上)" value={`${Math.round(s.sector_breadth_60)}%`} valueStyle={{ color: s.sector_breadth_60 >= 60 ? 'var(--ios-green)' : s.sector_breadth_60 <= 30 ? 'var(--ios-red)' : 'var(--ios-label)' }} />
            )}
            {s.sector_vol_zscore != null && s.sector_vol_zscore !== 0 && (
              <Row label="量比Z分數" value={fmt(s.sector_vol_zscore, 2)} valueStyle={{ color: s.sector_vol_zscore > 1 ? 'var(--ios-yellow)' : s.sector_vol_zscore < -1 ? 'var(--ios-label3)' : 'var(--ios-label)' }} />
            )}
            <Row label="類股旗手" value={s.is_sector_leader ? '⭐ 是' : '—'} valueStyle={{ color: s.is_sector_leader ? '#FFD60A' : 'var(--ios-label3)' }} />
            {s.sector_stock_count > 0 && <Row label="類股掃描支數" value={`${s.sector_stock_count} 支`} />}
          </Section>
        )}

        {/* 技術指標（當日快照） */}
        <Section title="技術指標（當日快照）">
          <Row label="收盤價" value={`${fmt(s.close, 1)} 元`} />
          <Row label="日漲跌" value={pct(s.day_return != null ? s.day_return * 100 : null)} valueStyle={{ color: colorNum(s.day_return) }} />
          <Row label="5日報酬" value={pct(s.return_5d != null ? s.return_5d * 100 : null)} valueStyle={{ color: colorNum(s.return_5d) }} />
          <Row label="RSI(14)" value={fmt(s.rsi14, 1)} valueStyle={{ color: s.rsi14 > 70 ? 'var(--ios-red)' : s.rsi14 < 30 ? 'var(--ios-green)' : 'var(--ios-label)' }} />
          <Row label="ADX(14)" value={fmt(s.adx14, 1)} valueStyle={{ color: s.adx14 > 25 ? 'var(--ios-blue)' : 'var(--ios-label)' }} />
          <Row label="ATR(14)" value={fmt(s.atr14, 2)} />
          <Row label="量比" value={`${fmt(s.volume_ratio, 1)}x`} valueStyle={{ color: s.volume_ratio > 2 ? 'var(--ios-yellow)' : 'var(--ios-label)' }} />
          <Row label="EMA20" value={fmt(s.ema20, 1)} />
          <Row label="EMA60" value={fmt(s.ema60, 1)} />
          <Row label="布林帶位置" value={fmt(s.bb_pct_b, 2)} />
          <Row label="KD K值" value={fmt(s.stoch_k, 1)} />
          <Row label="KD D值" value={fmt(s.stoch_d, 1)} />
          <Row label="MACD" value={fmt(s.macd, 3)} />
          <Row label="MACD柱" value={fmt(s.macd_hist, 3)} valueStyle={{ color: colorNum(s.macd_hist) }} />
          <Row label="動能分數" value={fmt(s.momentum_score, 0)} />
          <Row label="相對強度5日" value={pct(s.relative_strength_5d != null ? s.relative_strength_5d * 100 : null)} valueStyle={{ color: colorNum(s.relative_strength_5d) }} />
        </Section>

        {/* 法人籌碼 */}
        <Section title="三大法人籌碼">
          {(() => {
            const noInst = !s.foreign_buy_streak && !s.invest_trust_streak && !s.dealer_buy_streak
              && !s.foreign_net && !s.invest_trust_net && !s.dealer_net
            if (noInst) return (
              <div style={{ padding: '6px 0', fontSize: 11, color: 'var(--ios-label3)', fontStyle: 'italic' }}>
                本期無三大法人買賣超資料
              </div>
            )
            const fmtNet = (v) => v == null || v === 0 ? '—' : `${v > 0 ? '+' : ''}${fmt(v, 0)}`
            const fmtStreak = (v) => v > 0 ? `${v} 天` : '—'
            return (<>
              <Row label="外資連買天數" value={fmtStreak(s.foreign_buy_streak)} valueStyle={{ color: s.foreign_buy_streak > 0 ? 'var(--ios-red)' : 'var(--ios-label3)' }} />
              <Row label="外資買賣超" value={fmtNet(s.foreign_net)} valueStyle={{ color: colorNum(s.foreign_net) }} />
              <Row label="投信連買天數" value={fmtStreak(s.invest_trust_streak)} valueStyle={{ color: s.invest_trust_streak > 0 ? 'var(--ios-red)' : 'var(--ios-label3)' }} />
              <Row label="投信買賣超" value={fmtNet(s.invest_trust_net)} valueStyle={{ color: colorNum(s.invest_trust_net) }} />
              <Row label="自營商連買天數" value={fmtStreak(s.dealer_buy_streak)} valueStyle={{ color: s.dealer_buy_streak > 0 ? 'var(--ios-red)' : 'var(--ios-label3)' }} />
              <Row label="自營商買賣超" value={fmtNet(s.dealer_net)} valueStyle={{ color: colorNum(s.dealer_net) }} />
            </>)
          })()}
        </Section>

        {/* 融資融券 */}
        <Section title="融資融券">
          <Row label="融資5日變化" value={pct(s.margin_change_5d)} valueStyle={{ color: s.margin_change_5d < -3 ? 'var(--ios-green)' : s.margin_change_5d > 5 ? 'var(--ios-red)' : 'var(--ios-label)' }} />
          <Row label="融券/融資比" value={`${fmt(s.short_ratio, 1)}%`} />
          {s.limit_down_streak >= 1 && (
            <Row label="連續跌停" value={`${s.limit_down_streak} 天 ⚠️`} valueStyle={{ color: 'var(--ios-red)' }} />
          )}
        </Section>

        {/* 基本面 */}
        <Section title="基本面">
          <Row label="F-Score" value={`${fmt(s.f_score, 0)} / 9`} valueStyle={{ color: s.f_score >= 7 ? 'var(--ios-green)' : s.f_score <= 3 ? 'var(--ios-red)' : 'var(--ios-label)' }} />
          {s.revenue_yoy != null && s.revenue_yoy !== 0 && (
            <Row label="月營收 YoY" value={pct(s.revenue_yoy * 100)} valueStyle={{ color: s.revenue_yoy > 0 ? 'var(--ios-red)' : 'var(--ios-green)' }} />
          )}
        </Section>
      </div>
    </div>
  )
}
