import { useState, useRef, useMemo, useEffect } from 'react'

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

function obvCalc(bars) {
  const result = new Array(bars.length).fill(0)
  let obv = 0
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      if (bars[i].close > bars[i - 1].close) obv += bars[i].volume
      else if (bars[i].close < bars[i - 1].close) obv -= bars[i].volume
    }
    result[i] = obv
  }
  return result
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

function adxCalc(bars, n = 14) {
  const len = bars.length
  const plusDI  = new Array(len).fill(null)
  const minusDI = new Array(len).fill(null)
  const adxLine = new Array(len).fill(null)
  if (len < n + 1) return { plusDI, minusDI, adxLine }
  const trArr = [], pdmArr = [], ndmArr = []
  for (let i = 1; i < len; i++) {
    const hd = bars[i].high - bars[i - 1].high
    const ld = bars[i - 1].low - bars[i].low
    trArr[i]  = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close))
    pdmArr[i] = (hd > ld && hd > 0) ? hd : 0
    ndmArr[i] = (ld > hd && ld > 0) ? ld : 0
  }
  let sTR = 0, sPDM = 0, sNDM = 0
  for (let i = 1; i <= n; i++) { sTR += trArr[i] || 0; sPDM += pdmArr[i] || 0; sNDM += ndmArr[i] || 0 }
  let dxSum = 0, dxCnt = 0
  for (let i = n; i < len; i++) {
    if (i > n) { sTR = sTR - sTR / n + (trArr[i] || 0); sPDM = sPDM - sPDM / n + (pdmArr[i] || 0); sNDM = sNDM - sNDM / n + (ndmArr[i] || 0) }
    const pdi = sTR > 0 ? 100 * sPDM / sTR : 0
    const ndi = sTR > 0 ? 100 * sNDM / sTR : 0
    plusDI[i] = pdi; minusDI[i] = ndi
    const dx = (pdi + ndi) > 0 ? 100 * Math.abs(pdi - ndi) / (pdi + ndi) : 0
    dxSum += dx; dxCnt++
    if (dxCnt === n) { adxLine[i] = dxSum / n }
    else if (dxCnt > n) { adxLine[i] = (adxLine[i - 1] * (n - 1) + dx) / n }
  }
  return { plusDI, minusDI, adxLine }
}

function williamsRCalc(bars, n = 14) {
  return bars.map((_, i) => {
    if (i < n - 1) return null
    const slice = bars.slice(i - n + 1, i + 1)
    const hh = Math.max(...slice.map(b => b.high))
    const ll = Math.min(...slice.map(b => b.low))
    return hh === ll ? -50 : (hh - bars[i].close) / (hh - ll) * -100
  })
}

function cciCalc(bars, n = 20) {
  const tp = bars.map(b => (b.high + b.low + b.close) / 3)
  return bars.map((_, i) => {
    if (i < n - 1) return null
    const slice = tp.slice(i - n + 1, i + 1)
    const mean = slice.reduce((a, b) => a + b, 0) / n
    const md = slice.reduce((a, b) => a + Math.abs(b - mean), 0) / n
    return md === 0 ? 0 : (tp[i] - mean) / (0.015 * md)
  })
}

function mfiCalc(bars, n = 14) {
  const tp = bars.map(b => (b.high + b.low + b.close) / 3)
  const result = new Array(bars.length).fill(null)
  for (let i = n; i < bars.length; i++) {
    let posFlow = 0, negFlow = 0
    for (let j = i - n + 1; j <= i; j++) {
      const rmf = tp[j] * (bars[j].volume || 0)
      if (tp[j] > tp[j - 1]) posFlow += rmf
      else if (tp[j] < tp[j - 1]) negFlow += rmf
    }
    result[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow)
  }
  return result
}

// CDP (逆勢操作系統): uses previous bar's H/L/C
function cdpCalc(bars) {
  if (!bars || bars.length < 2) return null
  const prev = bars[bars.length - 2]
  if (prev.high == null || prev.low == null || prev.close == null) return null
  const cdp = (prev.high + prev.low + prev.close * 2) / 4
  const range = prev.high - prev.low
  const r2 = v => Math.round(v * 100) / 100
  return { cdp: r2(cdp), ah: r2(cdp + range), nh: r2(2 * cdp - prev.low), nl: r2(2 * cdp - prev.high), al: r2(cdp - range) }
}

// ATR (平均真實波幅) using Wilder smoothing
function atrCalc(bars, n = 14) {
  if (!bars || bars.length < n + 1 || bars[1]?.high == null) return null
  let atr = 0
  for (let i = 1; i <= n; i++) {
    const b = bars[i], p = bars[i - 1]
    atr += Math.max(b.high - b.low, Math.abs(b.high - (p.close ?? b.high)), Math.abs(b.low - (p.close ?? b.low)))
  }
  atr /= n
  for (let i = n + 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1]
    if (b.high == null) continue
    const tr = Math.max(b.high - b.low, Math.abs(b.high - (p.close ?? b.high)), Math.abs(b.low - (p.close ?? b.low)))
    atr = (atr * (n - 1) + tr) / n
  }
  return Math.round(atr * 100) / 100
}

// 乖離率 (BIAS) = (close - SMA) / SMA * 100
function biasCalc(closes, period = 20) {
  const ma = smaCalc(closes, period)
  const last = closes[closes.length - 1]
  for (let i = ma.length - 1; i >= 0; i--) {
    if (ma[i] != null && ma[i] > 0) return Math.round((last - ma[i]) / ma[i] * 10000) / 100
  }
  return null
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
const BAR_W = 5  // fixed pixels per candle for scrollable chart

function SubChartSVG({ bars, label, lines, histSeries, hBands, hoveredIdx, onHoverIdx, yFixed, chartW: propChartW }) {
  const subTouchRef = useRef(null)
  const H = 72, PT = 6
  const n = bars.length
  const W = propChartW || Math.max(CHART_W, n * BAR_W + CHART_PL + CHART_PR)
  const slotW = (W - CHART_PL - CHART_PR) / n
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
    const svgX = (clientX - rect.left) / rect.width * W
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
      viewBox={`0 0 ${W} ${H + PT + 4}`}
      style={{ width: W, display: 'block', background: 'rgba(20,20,22,0.85)', borderTop: '0.5px solid #2C2C2E', marginTop: 2, touchAction: 'pan-y' }}
      onMouseMove={e => handleMove(e.clientX, e.currentTarget)}
      onMouseLeave={() => onHoverIdx?.(null)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Zero line or reference lines */}
      {(hBands || []).map((b, i) => (
        <g key={i}>
          <line x1={CHART_PL} y1={toY(b.value)} x2={W - CHART_PR} y2={toY(b.value)}
            stroke={b.color || '#48484A'} strokeWidth={0.5} strokeDasharray="4,3" opacity={0.65} />
          <text x={W - CHART_PR + 3} y={toY(b.value) + 3.5} fontSize={7} fill={b.color || '#48484A'} opacity={0.85}>{b.label ?? b.value}</text>
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

function CandleSVG({ data, maLines, bbBands, cdpLevels, onHoverIdx, chartW: propChartW }) {
  const [hovered, setHovered] = useState(null)
  const touchRef = useRef(null)

  const chart = useMemo(() => {
    if (!data || data.length < 2) return null
    const bars = data
    const n = bars.length
    const W = propChartW || Math.max(CHART_W, n * BAR_W + CHART_PL + CHART_PR)
    const CH = 200, VH = 45, GAP = 6, H = CH + GAP + VH
    const PL = CHART_PL, PR = CHART_PR, PT = 8
    const cdpVals = cdpLevels ? [cdpLevels.ah, cdpLevels.nh, cdpLevels.cdp, cdpLevels.nl, cdpLevels.al].filter(Boolean) : []
    const maxP = Math.max(...bars.map(d => d.high ?? d.close ?? 0), ...(bbBands?.upper?.filter(Boolean) || []), ...cdpVals)
    const minP = Math.min(...bars.map(d => d.low  ?? d.close ?? 0), ...(bbBands?.lower?.filter(Boolean) || []), ...cdpVals)
    const pRange = (isNaN(maxP) || isNaN(minP) || maxP === minP) ? 1 : maxP - minP
    const maxVol = Math.max(...bars.map(d => d.volume ?? 0), 1)
    const slotW = (W - PL - PR) / n
    const bW = Math.max(slotW * 0.65, 1.5)
    const toY = p => PT + (1 - (p - (isNaN(minP) ? 0 : minP)) / pRange) * CH
    const toX = i => PL + (i + 0.5) * slotW
    const gridLevels = isNaN(minP) ? [] : [0, 1/3, 2/3, 1].map(t => ({
      price: minP + t * pRange, y: PT + (1 - t) * CH,
    }))
    const xStep = Math.max(1, Math.floor(n / 5))
    const xLabels = bars.map((d, i) => ({ i, label: d.time ? d.time.slice(5) : '' })).filter((_, i) => i % xStep === 0 || i === n - 1)
    return { bars, W, CH, VH, GAP, H, PL, PR, PT, maxVol, n, slotW, bW, toY, toX, gridLevels, xLabels }
  }, [data, bbBands, cdpLevels, propChartW])

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
      style={{ width: W, display: 'block', background: 'var(--ios-bg)', borderRadius: '10px 10px 0 0', cursor: 'crosshair', touchAction: 'pan-y', userSelect: 'none', WebkitUserSelect: 'none' }}
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

      {/* CDP 逆勢操作系統 horizontal levels */}
      {cdpLevels && [
        { key: 'ah',  price: cdpLevels.ah,  color: 'rgba(255,69,58,0.8)',   dash: '5,3', label: 'AH' },
        { key: 'nh',  price: cdpLevels.nh,  color: 'rgba(255,159,10,0.7)',  dash: '4,3', label: 'NH' },
        { key: 'cdp', price: cdpLevels.cdp, color: 'rgba(255,214,10,0.75)', dash: '6,2', label: 'CDP' },
        { key: 'nl',  price: cdpLevels.nl,  color: 'rgba(48,209,88,0.7)',   dash: '4,3', label: 'NL' },
        { key: 'al',  price: cdpLevels.al,  color: 'rgba(48,209,88,0.85)',  dash: '5,3', label: 'AL' },
      ].map(({ key, price, color, dash, label }) => {
        const y = toY(price)
        return (
          <g key={key}>
            <line x1={PL} y1={y} x2={W - PR} y2={y} stroke={color} strokeWidth={0.9} strokeDasharray={dash} />
            <text x={PL + 3} y={y - 2} fontSize={7} fill={color}>{label} {price}</text>
          </g>
        )
      })}

      {/* Candles + volume */}
      {bars.map((d, i) => {
        const x = toX(i), color = candleColor(d.open ?? d.close, d.close)
        const bodyTop = toY(Math.max(d.open ?? d.close, d.close))
        const bodyBot = toY(Math.min(d.open ?? d.close, d.close))
        const bodyH = Math.max(bodyBot - bodyTop, 1)
        const volH = ((d.volume ?? 0) / maxVol) * VH
        const isHovered = hovered?.idx === i
        return (
          <g key={i} opacity={hovered && !isHovered ? 0.45 : 1}>
            <line x1={x} y1={toY(d.high ?? d.close)} x2={x} y2={toY(d.low ?? d.close)} stroke={color} strokeWidth={isHovered ? 1.4 : 0.8} />
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
        const slimOnly = b.open == null  // slim stock — only close is available
        const fmtP = v => v != null ? v.toFixed(v >= 100 ? 1 : 2) : '—'
        const vol = b.volume != null
          ? (b.volume >= 1000000 ? `${(b.volume / 1000000).toFixed(1)}M` : `${(b.volume / 1000).toFixed(0)}K`)
          : '—'
        return (
          <g>
            <line x1={hovered.x} y1={PT} x2={hovered.x} y2={H + PT} stroke="#0A84FF" strokeWidth={0.6} strokeDasharray="3,3" opacity={0.7} />
            <line x1={PL} y1={toY(b.close)} x2={W - PR} y2={toY(b.close)} stroke="#0A84FF" strokeWidth={0.4} strokeDasharray="2,3" opacity={0.5} />
            <rect x={0} y={toY(b.close) - 7} width={PL - 2} height={13} fill="#1C1C1E" rx={2} />
            <text x={PL - 5} y={toY(b.close) + 4} fontSize={8} fill={closeColor} textAnchor="end" fontWeight="bold">
              {fmtP(b.close)}
            </text>
            <rect x={tipX} y={tipY} width={tipW} height={slimOnly ? 42 : tipH} fill="#1C1C1E" rx={6} stroke="#3A3A3C" strokeWidth={0.8} />
            <text x={tipX + 7} y={tipY + 13} fontSize={9} fill="#8E8E93" fontWeight="bold">{b.time || ''}</text>
            <line x1={tipX + 4} y1={tipY + 17} x2={tipX + tipW - 4} y2={tipY + 17} stroke="#2C2C2E" strokeWidth={0.5} />
            {slimOnly ? (
              <text x={tipX + 7} y={tipY + 32} fontSize={8.5} fill="#636366">收 <tspan fill={closeColor} fontWeight="bold">{fmtP(b.close)}</tspan></text>
            ) : <>
              <text x={tipX + 7} y={tipY + 30} fontSize={8.5} fill="#636366">開 <tspan fill="#EBEBF5">{fmtP(b.open)}</tspan></text>
              <text x={tipX + 7} y={tipY + 43} fontSize={8.5} fill="#636366">高 <tspan fill="#FF453A">{fmtP(b.high)}</tspan></text>
              <text x={tipX + 7} y={tipY + 56} fontSize={8.5} fill="#636366">低 <tspan fill="#30D158">{fmtP(b.low)}</tspan></text>
              <text x={tipX + 7} y={tipY + 69} fontSize={8.5} fill="#636366">收 <tspan fill={closeColor} fontWeight="bold">{fmtP(b.close)}</tspan></text>
              <text x={tipX + 7} y={tipY + 82} fontSize={8.5} fill="#636366">量 <tspan fill="#8E8E93">{vol}</tspan></text>
            </>}
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
  if (!dailyBars[0]?.time) return []  // slim close-only bars — no dates to resample on
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

  const rsi   = indicators.rsi[i]
  const macdL = indicators.macd.macdLine[i]
  const macdH = indicators.macd.hist[i]
  const k     = indicators.kd.kArr[i]
  const d     = indicators.kd.dArr[i]
  const adx   = indicators.adx?.adxLine[i]
  const pdi   = indicators.adx?.plusDI[i]
  const ndi   = indicators.adx?.minusDI[i]
  const wr    = indicators.wr?.[i]
  const cci   = indicators.cci?.[i]
  const mfi   = indicators.mfi?.[i]
  const vn = (val, dec = 1) => val != null ? Number(val).toFixed(dec) : '—'

  return (
    <div style={{
      display: 'flex', gap: 10, padding: '5px 2px 5px', fontSize: 10.5,
      flexWrap: 'wrap', alignItems: 'center', borderBottom: '0.5px solid var(--ios-sep)',
      marginBottom: 1, minHeight: 26,
    }}>
      <span style={{ color: 'var(--ios-label3)', fontSize: 10, minWidth: 44, flexShrink: 0 }}>
        {hoveredIdx != null ? (bar.time ? bar.time.slice(5) : '') : '最新'}
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
      {active.adx && adx != null && (
        <span style={{ color: 'var(--ios-label3)' }}>
          ADX <b style={{ color: adx > 25 ? '#FF453A' : '#FF453A88' }}>{vn(adx)}</b>
          {pdi != null && <> +DI<b style={{ color: '#30D158' }}>{vn(pdi)}</b></>}
          {ndi != null && <> -DI<b style={{ color: '#FF6B35' }}>{vn(ndi)}</b></>}
        </span>
      )}
      {active.wr && wr != null && (
        <span style={{ color: 'var(--ios-label3)' }}>
          W%R <b style={{ color: wr > -20 ? '#FF453A' : wr < -80 ? '#30D158' : '#FF6B35' }}>{vn(wr)}</b>
        </span>
      )}
      {active.cci && cci != null && (
        <span style={{ color: 'var(--ios-label3)' }}>
          CCI <b style={{ color: cci > 100 ? '#FF453A' : cci < -100 ? '#30D158' : '#5E5CE6' }}>{vn(cci, 0)}</b>
        </span>
      )}
      {active.mfi && mfi != null && (
        <span style={{ color: 'var(--ios-label3)' }}>
          MFI <b style={{ color: mfi > 80 ? '#FF453A' : mfi < 20 ? '#30D158' : '#FFD60A' }}>{vn(mfi)}</b>
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

const STRATEGY_PRESETS = [
  { id: 'all',        label: '全部', color: '#FFFFFF', desc: '同時顯示全部 10 項指標，一覽無遺',
    state: { ma: true,  bb: true,  macd: true,  rsi: true,  kd: true,  obv: true,  adx: true,  wr: true,  cci: true,  mfi: true  } },
  { id: 'momentum',   label: '動能', color: '#FF9F0A', desc: 'MACD 翻紅 + RSI 站上 50 才進場，追強勢續攻',
    state: { ma: true,  bb: false, macd: true,  rsi: true,  kd: false, obv: false, adx: false, wr: false, cci: false, mfi: false } },
  { id: 'oscillator', label: '震盪', color: '#30D158', desc: 'KD 低檔金叉 + W%R/CCI 超賣回升，抓區間反彈',
    state: { ma: false, bb: true,  macd: false, rsi: false, kd: true,  obv: false, adx: false, wr: true,  cci: true,  mfi: false } },
  { id: 'trend',      label: '趨勢', color: '#0A84FF', desc: 'ADX>25 且 +DI>-DI 站上均線，順勢波段',
    state: { ma: true,  bb: true,  macd: false, rsi: false, kd: false, obv: false, adx: true,  wr: false, cci: false, mfi: false } },
  { id: 'chips',      label: '籌碼', color: '#64D2FF', desc: 'OBV 突破均量 + MFI 資金流入，跟量能',
    state: { ma: true,  bb: false, macd: false, rsi: false, kd: false, obv: true,  adx: false, wr: false, cci: false, mfi: true  } },
]

const TOGGLE_DEFS = [
  { key: 'ma',   label: 'MA',   color: '#5AC8FA' },
  { key: 'bb',   label: 'BB',   color: '#0A84FF' },
  { key: 'macd', label: 'MACD', color: '#FF9F0A' },
  { key: 'rsi',  label: 'RSI',  color: '#BF5AF2' },
  { key: 'kd',   label: 'KD',   color: '#30D158' },
  { key: 'obv',  label: 'OBV',  color: '#64D2FF' },
  { key: 'adx',  label: 'ADX',  color: '#FF453A' },
  { key: 'wr',   label: 'W%R',  color: '#FF6B35' },
  { key: 'cci',  label: 'CCI',  color: '#5E5CE6' },
  { key: 'mfi',  label: 'MFI',  color: '#FFD60A' },
]

// ── Strategy win-rate backtest (per-stock, on its own price history) ─────────
function computeStrategyBacktest(bars, horizon) {
  if (!bars || bars.length < 40) return null
  const closes = bars.map(b => b.close)
  const macd = macdCalc(closes)
  const rsi  = rsiCalc(closes)
  const kd   = kdCalc(bars)
  const adx  = adxCalc(bars)
  const obv  = obvCalc(bars)
  const obvMa = smaCalc(obv, 20)
  const ma5  = smaCalc(closes, 5)
  const ma20 = smaCalc(closes, 20)

  const fwd = i => {
    const j = i + horizon
    if (j >= bars.length || closes[i] <= 0) return null
    return (closes[j] - closes[i]) / closes[i]
  }
  const trendOn = i =>
    adx.adxLine[i] != null && adx.adxLine[i] > 25 &&
    adx.plusDI[i] > adx.minusDI[i] && ma20[i] != null && closes[i] > ma20[i]

  const strategies = [
    { id: 'momentum', label: '動能', color: '#FF9F0A',
      fire: i => i > 0 && macd.hist[i] != null && macd.hist[i - 1] != null &&
        macd.hist[i] > 0 && macd.hist[i - 1] <= 0 && rsi[i] != null && rsi[i] > 50 },
    { id: 'oscillator', label: '震盪', color: '#30D158',
      fire: i => i > 0 && kd.kArr[i] != null && kd.kArr[i - 1] != null &&
        kd.kArr[i] > kd.dArr[i] && kd.kArr[i - 1] <= kd.dArr[i - 1] && kd.kArr[i] < 35 },
    { id: 'trend', label: '趨勢', color: '#0A84FF',
      fire: i => i > 0 && trendOn(i) && !trendOn(i - 1) },
    { id: 'chips', label: '籌碼', color: '#64D2FF',
      fire: i => i > 0 && obvMa[i] != null && obvMa[i - 1] != null &&
        obv[i] > obvMa[i] && obv[i - 1] <= obvMa[i - 1] && ma5[i] != null && closes[i] > ma5[i] },
  ]

  const rows = strategies.map(s => {
    let signals = 0, wins = 0, sumRet = 0
    for (let i = 0; i < bars.length; i++) {
      if (!s.fire(i)) continue
      const r = fwd(i)
      if (r == null) continue
      signals++
      if (r > 0) wins++
      sumRet += r
    }
    return {
      id: s.id, label: s.label, color: s.color, signals,
      winRate: signals > 0 ? wins / signals : null,
      avgRet:  signals > 0 ? sumRet / signals : null,
    }
  })
  const ranked = rows.filter(r => r.signals >= 3 && r.winRate != null)
    .sort((a, b) => b.winRate - a.winRate || b.avgRet - a.avgRet)
  return { rows, best: ranked.length ? ranked[0].id : null }
}

function StrategyBacktestPanel({ bars, onPick, activeId }) {
  const [horizon, setHorizon] = useState(5)
  const bt = useMemo(() => computeStrategyBacktest(bars, horizon), [bars, horizon])
  if (!bt) return null
  return (
    <div style={{ marginTop: 10, background: 'var(--ios-bg2)', borderRadius: 12, padding: '10px 12px', boxShadow: 'var(--shadow-card)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ color: 'var(--ios-blue)', fontSize: 11, fontWeight: 700, letterSpacing: 0.6 }}>📊 策略勝率回測</span>
        <div style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--ios-fill4)', borderRadius: 7 }}>
          {[5, 10, 20].map(h => (
            <button key={h} onClick={() => setHorizon(h)} style={{
              background: horizon === h ? 'var(--ios-bg3)' : 'transparent', border: 'none',
              color: horizon === h ? 'var(--ios-label)' : 'var(--ios-label3)', borderRadius: 5,
              padding: '2px 9px', fontSize: 10, cursor: 'pointer', fontWeight: horizon === h ? 700 : 400,
            }}>{h}日</button>
          ))}
        </div>
      </div>
      {bt.rows.map(r => {
        const enough = r.signals >= 3
        const isBest = r.id === bt.best
        return (
          <div key={r.id} onClick={() => onPick?.(r.id)} style={{ cursor: 'pointer', padding: '6px 0', borderBottom: '0.5px solid var(--ios-sep)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: activeId === r.id ? r.color : 'var(--ios-label)' }}>
                {isBest && '🏆 '}{r.label}
                <span style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 400, marginLeft: 6 }}>{r.signals} 次訊號</span>
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: !enough ? 'var(--ios-label3)' : r.winRate >= 0.5 ? 'var(--ios-red)' : 'var(--ios-green)' }}>
                {enough ? `勝率 ${(r.winRate * 100).toFixed(0)}%` : '樣本不足'}
                {enough && r.avgRet != null && (
                  <span style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 400, marginLeft: 6 }}>
                    均 {r.avgRet > 0 ? '+' : ''}{(r.avgRet * 100).toFixed(1)}%
                  </span>
                )}
              </span>
            </div>
            <div style={{ height: 5, background: 'var(--ios-fill4)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${enough ? r.winRate * 100 : 0}%`, height: '100%', background: r.color, opacity: isBest ? 1 : 0.55, borderRadius: 3, transition: 'width 0.3s' }} />
            </div>
          </div>
        )
      })}
      <div style={{ fontSize: 9.5, color: 'var(--ios-label3)', marginTop: 7, lineHeight: 1.5 }}>
        以本股近 {bars.length} 根 K 棒回測：各策略訊號出現後、持有 {horizon} 日的上漲比例（勝率）與平均報酬。🏆 為目前最高勝率，點一下可直接套用該策略指標。樣本 &lt;3 次僅供參考。
      </div>
    </div>
  )
}

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
  const [active, setActive] = useState({ ma: true, bb: false, macd: true, rsi: true, kd: false, obv: false, adx: false, wr: false, cci: false, mfi: false })
  const [preset, setPreset] = useState('momentum')
  const [hoveredIdx, setHoveredIdx] = useState(null)
  const [barCount, setBarCount] = useState(250)
  const scrollRef = useRef(null)

  const toggle = key => { setActive(prev => ({ ...prev, [key]: !prev[key] })); setPreset(null) }
  const applyPreset = p => { setActive(p.state); setPreset(p.id) }

  const bars = (dataMap[chartInterval] || []).slice(-barCount)

  const totalChartW = Math.max(CHART_W, bars.length * BAR_W + CHART_PL + CHART_PR)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
    }
  }, [bars.length, chartInterval, barCount])

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
      obv: (() => { const v = obvCalc(bars); return { values: v, ma: smaCalc(v, 20) } })(),
      adx: adxCalc(bars),
      wr: williamsRCalc(bars),
      cci: cciCalc(bars),
      mfi: mfiCalc(bars),
    }
  }, [bars])

  const unitLabel = { '1d': '個交易日', '1wk': '週', '1mo': '個月' }

  return (
    <div>
      {/* Strategy preset row */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: 'var(--ios-label3)', marginRight: 2, flexShrink: 0 }}>策略</span>
        {STRATEGY_PRESETS.map(p => (
          <button key={p.id} onClick={() => applyPreset(p)} style={{
            background: preset === p.id ? `${p.color}20` : 'var(--ios-fill4)',
            color: preset === p.id ? p.color : 'var(--ios-label3)',
            border: `0.5px solid ${preset === p.id ? p.color : 'transparent'}`,
            borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
            fontWeight: preset === p.id ? 700 : 400, transition: 'all 0.15s',
          }}>{p.label}</button>
        ))}
      </div>
      {preset && (() => {
        const p = STRATEGY_PRESETS.find(x => x.id === preset)
        return p ? (
          <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 7, paddingLeft: 2, lineHeight: 1.4 }}>
            <b style={{ color: p.color }}>{p.label}策略</b>：{p.desc}
          </div>
        ) : null
      })()}

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
        {/* Bar count selector */}
        <div style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--ios-fill4)', borderRadius: 8 }}>
          {[
            { n: 60,  label: '60' },
            { n: 120, label: '120' },
            { n: 250, label: '250' },
            { n: 9999, label: '全' },
          ].map(({ n, label }) => {
            const total = (dataMap[chartInterval] || []).length
            const isActive = barCount === n
            const avail = n === 9999 ? total >= 2 : total >= n
            return (
              <button key={n} onClick={() => avail && setBarCount(n)} title={`顯示最近 ${n === 9999 ? '全部' : n} 根 K 線`} style={{
                background: isActive ? 'var(--ios-bg3)' : 'transparent',
                border: 'none', color: isActive ? 'var(--ios-label)' : avail ? 'var(--ios-label3)' : 'var(--ios-fill2)',
                borderRadius: 6, padding: '4px 10px', fontSize: 11,
                cursor: avail ? 'pointer' : 'default', fontWeight: isActive ? 600 : 400,
                boxShadow: isActive ? '0 1px 4px rgba(0,0,0,0.3)' : 'none', transition: 'all 0.15s',
              }}>{label}</button>
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

      {/* Scrollable chart area — all SVG charts share one horizontal scroll container */}
      <div ref={scrollRef} style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', borderRadius: 10, marginBottom: 2 }}>
        {/* Main candlestick chart */}
        {bars.length >= 2 ? (
          <CandleSVG
            data={bars}
            maLines={active.ma && indicators ? indicators.maLines : []}
            bbBands={active.bb && indicators ? indicators.bbBands : null}
            cdpLevels={ci.cdp}
            onHoverIdx={setHoveredIdx}
            chartW={totalChartW}
          />
        ) : (
          <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ios-label3)', fontSize: 12, background: 'var(--ios-bg)', borderRadius: 10 }}>
            暫無歷史 K 線資料
          </div>
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
            chartW={totalChartW}
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
            chartW={totalChartW}
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
            chartW={totalChartW}
          />
        )}

        {/* OBV sub-chart */}
        {active.obv && indicators && bars.length >= 5 && (
          <SubChartSVG
            bars={bars}
            label="OBV"
            lines={[
              { color: '#64D2FF', label: 'OBV', values: indicators.obv.values, width: 1 },
              { color: '#FF9F0A', label: 'MA20', values: indicators.obv.ma, width: 1, opacity: 0.7 },
            ]}
            hBands={[{ value: 0, color: '#48484A', label: '' }]}
            hoveredIdx={hoveredIdx}
            onHoverIdx={setHoveredIdx}
            chartW={totalChartW}
          />
        )}

        {/* ADX / DMI sub-chart */}
        {active.adx && indicators && bars.length >= 28 && (
          <SubChartSVG
            bars={bars}
            label="ADX(14) / DMI"
            lines={[
              { color: '#FF453A', label: 'ADX',  values: indicators.adx.adxLine,  width: 1.5 },
              { color: '#30D158', label: '+DI',  values: indicators.adx.plusDI,   width: 1,   opacity: 0.85 },
              { color: '#FF6B35', label: '-DI',  values: indicators.adx.minusDI,  width: 1,   opacity: 0.85 },
            ]}
            hBands={[{ value: 25, color: '#FFD60A', label: '25' }]}
            hoveredIdx={hoveredIdx}
            onHoverIdx={setHoveredIdx}
            yFixed={[0, 60]}
            chartW={totalChartW}
          />
        )}

        {/* Williams %R sub-chart */}
        {active.wr && indicators && bars.length >= 14 && (
          <SubChartSVG
            bars={bars}
            label="Williams %R(14)"
            lines={[{ color: '#FF6B35', label: 'W%R', values: indicators.wr, width: 1.2 }]}
            hBands={[
              { value: -20, color: '#FF453A', label: '-20' },
              { value: -50, color: '#48484A', label: '-50' },
              { value: -80, color: '#30D158', label: '-80' },
            ]}
            hoveredIdx={hoveredIdx}
            onHoverIdx={setHoveredIdx}
            yFixed={[-100, 0]}
            chartW={totalChartW}
          />
        )}

        {/* CCI sub-chart */}
        {active.cci && indicators && bars.length >= 21 && (
          <SubChartSVG
            bars={bars}
            label="CCI(20)"
            lines={[{ color: '#5E5CE6', label: 'CCI', values: indicators.cci, width: 1.2 }]}
            hBands={[
              { value: 100,  color: '#FF453A', label: '+100' },
              { value: 0,    color: '#48484A', label: '0' },
              { value: -100, color: '#30D158', label: '-100' },
            ]}
            hoveredIdx={hoveredIdx}
            onHoverIdx={setHoveredIdx}
            chartW={totalChartW}
          />
        )}

        {/* MFI sub-chart */}
        {active.mfi && indicators && bars.length >= 15 && (
          <SubChartSVG
            bars={bars}
            label="MFI(14) 資金流"
            lines={[{ color: '#FFD60A', label: 'MFI', values: indicators.mfi, width: 1.2 }]}
            hBands={[
              { value: 80, color: '#FF453A', label: '80' },
              { value: 50, color: '#48484A', label: '50' },
              { value: 20, color: '#30D158', label: '20' },
            ]}
            hoveredIdx={hoveredIdx}
            onHoverIdx={setHoveredIdx}
            yFixed={[0, 100]}
            chartW={totalChartW}
          />
        )}
      </div>

      {/* Dynamic indicator value strip — updates with crosshair */}
      {bars.length >= 2 && indicators && (
        <ChartValueStrip bars={bars} indicators={indicators} active={active} hoveredIdx={hoveredIdx} />
      )}

      {/* Strategy win-rate backtest */}
      <StrategyBacktestPanel
        bars={daily}
        activeId={preset}
        onPick={(id) => { const p = STRATEGY_PRESETS.find(x => x.id === id); if (p) applyPreset(p) }}
      />

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

// ── Rule-based multi-analyst engine (zero API) ───────────────────────────────

function _techAnalysis(s, ci) {
  const out = []
  const close = s.close
  const ema60 = s.ema60 ?? ci?.ema60
  const ema20 = s.ema20 ?? ci?.ema20
  const ema120 = s.ema120 ?? ci?.ema120
  if (close && ema60 && ema120) {
    if (close > ema60 && ema60 > ema120)
      out.push({ t: 'bull', v: `多頭排列（收盤${close}>EMA60>${ema120?.toFixed(1)}），趨勢明確` })
    else if (close < ema20)
      out.push({ t: 'bear', v: `跌破EMA20（${ema20?.toFixed(1)}），短線轉弱` })
    else if (close < ema60)
      out.push({ t: 'warn', v: `EMA60（${ema60?.toFixed(1)}）壓制中，回補才能轉強` })
  }
  const macdH = s.macd_hist ?? ci?.macd_hist
  const macd = s.macd ?? ci?.macd
  const macdSig = s.macd_signal ?? ci?.macd_signal
  if (macdH != null) {
    if (macdH > 0 && macd > macdSig) out.push({ t: 'bull', v: `MACD柱正值且擴張（${macdH.toFixed(2)}），動能加速` })
    else if (macdH > 0) out.push({ t: 'neutral', v: `MACD柱轉正（${macdH.toFixed(2)}），初步翻多` })
    else out.push({ t: 'bear', v: `MACD柱負值（${macdH.toFixed(2)}），多頭動能不足` })
  }
  const k = s.stoch_k ?? ci?.stoch_k; const d = s.stoch_d ?? ci?.stoch_d
  if (k != null && d != null) {
    if (k > d && k > 50 && k < 80) out.push({ t: 'bull', v: `KD金叉未超買（K=${k.toFixed(0)}/D=${d.toFixed(0)}），進場窗口` })
    else if (k > 80) out.push({ t: 'warn', v: `KD超買（K=${k.toFixed(0)}），短線追高風險` })
    else if (k < 20) out.push({ t: 'neutral', v: `KD超賣（K=${k.toFixed(0)}），留意反彈機會` })
  }
  const adx = s.adx14 ?? ci?.adx14
  if (adx != null) {
    if (adx > 30) out.push({ t: 'bull', v: `ADX ${adx.toFixed(0)} 強趨勢，順勢操作優先` })
    else if (adx < 18) out.push({ t: 'neutral', v: `ADX ${adx.toFixed(0)} 無趨勢，盤整中` })
  }
  const bbBw = s.bb_bandwidth ?? ci?.bb_bandwidth
  const bbPct = s.bb_pct_b ?? ci?.bb_pct_b
  if (bbBw != null && bbBw < 0.04) out.push({ t: 'neutral', v: `布林帶極度收縮（帶寬${(bbBw*100).toFixed(1)}%），方向突破在即` })
  else if (bbPct != null && bbPct > 0.95) out.push({ t: 'warn', v: '觸碰布林上軌，短線壓力位' })
  else if (bbPct != null && bbPct < 0.05) out.push({ t: 'neutral', v: '觸碰布林下軌，支撐反彈機會' })
  if (ci?.cdp && close) {
    const { ah, nh, nl, al, cdp } = ci.cdp
    if (close > ah) out.push({ t: 'bull', v: `突破CDP強力壓力 ${ah}，強勢格局` })
    else if (close >= nh) out.push({ t: 'bull', v: `站上CDP一般壓力 ${nh}，多方有力` })
    else if (close <= al) out.push({ t: 'bear', v: `跌破CDP強力支撐 ${al}，弱勢` })
    else if (close <= nl) out.push({ t: 'warn', v: `CDP支撐 ${nl} 附近，觀察能否守住` })
    else out.push({ t: 'neutral', v: `CDP中樞 ${cdp} 為今日分水嶺，觀察站上方向` })
  }
  if (!out.length) out.push({ t: 'neutral', v: '技術資料尚不完整' })
  return out.slice(0, 4)
}

function _momAnalysis(s) {
  const out = []
  const vr = s.volume_ratio
  if (vr != null) {
    if (vr > 3) out.push({ t: 'warn', v: `爆量 ${vr.toFixed(1)}x，確認方向再進場（高量可能是出貨）` })
    else if (vr > 1.5) out.push({ t: 'bull', v: `放量 ${vr.toFixed(1)}x，量能配合，訊號可信度提升` })
    else if (vr < 0.5) out.push({ t: 'neutral', v: `縮量（${vr.toFixed(1)}x），市場觀望，方向待定` })
  }
  const rs5 = s.relative_strength_5d
  if (rs5 != null) {
    const pct = (rs5 * 100).toFixed(1)
    if (rs5 > 0.03) out.push({ t: 'bull', v: `5日相對大盤強度 +${pct}%，選股效果優良` })
    else if (rs5 < -0.03) out.push({ t: 'bear', v: `5日相對大盤 ${pct}%，相對弱勢` })
  }
  const fs = s.foreign_buy_streak; const ts = s.invest_trust_streak; const ds = s.dealer_buy_streak
  if (fs > 3) out.push({ t: 'bull', v: `外資連買 ${fs} 日，法人護盤力度強` })
  else if (fs < -3) out.push({ t: 'bear', v: `外資連賣 ${Math.abs(fs)} 日，法人撤退` })
  if (ts > 2) out.push({ t: 'bull', v: `投信連買 ${ts} 日，機構認可該標的` })
  if (ds > 3) out.push({ t: 'bull', v: `自營商連買 ${ds} 日，短線護盤` })
  const mc = s.margin_change_5d
  if (mc != null) {
    if (mc < -3) out.push({ t: 'bull', v: `融資5日縮 ${Math.abs(mc).toFixed(1)}%，籌碼轉乾淨（外資買+融資縮=強訊號）` })
    else if (mc > 5) out.push({ t: 'warn', v: `融資5日暴增 +${mc.toFixed(1)}%，散戶追漲，後續風險提高` })
  }
  const fScore = s.f_score
  if (fScore != null && fScore >= 0) {
    if (fScore >= 7) out.push({ t: 'bull', v: `Piotroski F-Score ${fScore}/9，財務體質強健` })
    else if (fScore <= 3) out.push({ t: 'bear', v: `Piotroski F-Score ${fScore}/9，基本面疲弱` })
  }
  if (!out.length) out.push({ t: 'neutral', v: '動能資料不足（本標的可能為非掃描範圍）' })
  return out.slice(0, 4)
}

function _riskAnalysis(s, ci) {
  const out = []
  const close = s.close
  const atr = s.atr14 ?? ci?.atr14
  if (s.limit_down_streak > 0) out.push({ t: 'bear', v: `⛔ 有跌停紀錄，極高風險，建議迴避` })
  if (atr && close) {
    const sl = (close - 2 * atr).toFixed(2)
    const pct = (2 * atr / close * 100).toFixed(1)
    out.push({ t: 'neutral', v: `建議停損：${sl}（收盤−2ATR），最大虧損約 ${pct}%` })
  }
  const rsi = s.rsi14 ?? ci?.rsi14
  if (rsi != null && rsi > 70) out.push({ t: 'warn', v: `RSI ${rsi.toFixed(0)} 超買，此位追多勝率下降` })
  const ret5 = s.return_5d
  if (ret5 != null && ret5 * 100 > 8) out.push({ t: 'warn', v: `5日已漲 ${(ret5*100).toFixed(1)}%，短線追高需注意高點套牢` })
  const bearFlags = [
    ['macd_death_cross', 'MACD死叉'], ['close_below_ema20', '跌破EMA20'],
    ['close_below_swing_low', '跌破波段低'], ['long_upper_shadow', '長上影線'], ['open_high_close_low', '開高走低'],
  ]
  const active = bearFlags.filter(([k]) => s[k]).map(([, l]) => l)
  if (active.length >= 2) out.push({ t: 'bear', v: `負面訊號 ${active.length} 項：${active.join('、')}` })
  else if (active.length === 1) out.push({ t: 'warn', v: `注意：${active[0]}` })
  if (s.entry_signal) out.push({ t: 'bull', v: `系統進場訊號成立（9項硬性條件全通過），可追蹤` })
  if (s.entry_score > 1000) out.push({ t: 'bull', v: `綜合評分 ${s.entry_score.toFixed(0)}，訊號強度優良` })
  else if (s.entry_score != null && s.entry_score < 400) out.push({ t: 'warn', v: `綜合評分 ${s.entry_score.toFixed(0)}，強度偏低，等待更好時機` })
  if (!out.length) out.push({ t: 'neutral', v: '無明顯風險訊號，依常規停損紀律操作' })
  return out.slice(0, 4)
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

export default function StockDetailModal({ stock, notionInfo, onClose, allScans }) {
  // Compute technical indicators from price_history for non-top-50 stocks.
  // Top-50 stocks already have pre-computed values from Python scan; slim stocks don't.
  // This fills all the "—" rows using the OHLCV bars we now carry for every scanned stock.
  const ph = stock?.price_history
  const ci = useMemo(() => {
    if (!ph || ph.length < 26) return {}
    const closes = ph.map(b => b.close)
    const lastOf = arr => { for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] != null && isFinite(arr[i])) return arr[i] } return null }
    const hasHL = ph[0]?.high != null && ph[0]?.low != null
    const hasVol = ph[0]?.volume != null

    const ema20arr  = emaCalc(closes, 20)
    const ema60arr  = emaCalc(closes, 60)
    const ema120arr = emaCalc(closes, 120)
    const { macdLine, signalLine, hist } = macdCalc(closes)
    const bbs = bollingerCalc(closes, 20, 2)
    let bb_pct_b = null, bb_bandwidth = null
    for (let i = bbs.length - 1; i >= 0; i--) {
      const b = bbs[i]
      if (!b) continue
      const bw = b.upper - b.lower
      if (bw > 0) { bb_pct_b = (closes[i] - b.lower) / bw; bb_bandwidth = bw / b.mid }
      break
    }

    let stoch_k = null, stoch_d = null, williams_r = null, cci20 = null, mfi14 = null
    let cdp = null, atr14 = null, adx14 = null
    const rsi14 = lastOf(rsiCalc(closes))
    const bias20 = biasCalc(closes, 20)
    const bias60 = biasCalc(closes, 60)
    if (hasHL) {
      const kd = kdCalc(ph); stoch_k = lastOf(kd.kArr); stoch_d = lastOf(kd.dArr)
      williams_r = lastOf(williamsRCalc(ph))
      cci20 = lastOf(cciCalc(ph))
      if (hasVol) mfi14 = lastOf(mfiCalc(ph))
      cdp = cdpCalc(ph)
      atr14 = atrCalc(ph, 14)
      adx14 = lastOf(adxCalc(ph).adxLine)
    }

    return {
      ema20: lastOf(ema20arr), ema60: lastOf(ema60arr), ema120: lastOf(ema120arr),
      macd: lastOf(macdLine), macd_signal: lastOf(signalLine), macd_hist: lastOf(hist),
      bb_pct_b, bb_bandwidth, stoch_k, stoch_d, williams_r, cci20, mfi14,
      rsi14, adx14, atr14, bias20, bias60, cdp,
    }
  }, [ph])

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

        {/* Feature 4: Score trend across dates */}
        {allScans && (() => {
          const history = Object.entries(allScans)
            .filter(([, sc]) => sc.top_stocks?.some(t => String(t.stock_id) === String(s.stock_id)))
            .map(([date, sc]) => {
              const t = sc.top_stocks.find(t => String(t.stock_id) === String(s.stock_id))
              return { date, score: t?.entry_score || 0, signal: !!t?.entry_signal }
            })
            .sort((a, b) => a.date.localeCompare(b.date))
          if (history.length < 2) return null
          const maxScore = Math.max(...history.map(h => h.score), 1)
          const w = 260, h2 = 44
          const pts = history.map((h, i) => {
            const x = (i / (history.length - 1)) * w
            const y = h2 - (h.score / maxScore) * (h2 - 6) - 3
            return `${x.toFixed(1)},${y.toFixed(1)}`
          }).join(' ')
          return (
            <Section title={`📊 評分歷程（近 ${history.length} 個交易日）`}>
              <div style={{ padding: '4px 0 8px' }}>
                <svg width="100%" viewBox={`0 0 ${w} ${h2}`} style={{ display: 'block', overflow: 'visible' }}>
                  <polyline points={pts} fill="none" stroke="var(--ios-blue)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
                  {history.map((h, i) => {
                    const x = (i / (history.length - 1)) * w
                    const y = h2 - (h.score / maxScore) * (h2 - 6) - 3
                    return (
                      <g key={h.date}>
                        <circle cx={x} cy={y} r={h.signal ? 4 : 2.5} fill={h.signal ? '#30D158' : 'var(--ios-blue)'} />
                        {i === history.length - 1 && (
                          <text x={x} y={y - 7} textAnchor="middle" fontSize="9" fill="var(--ios-label2)">{h.score}</text>
                        )}
                      </g>
                    )
                  })}
                </svg>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ios-label4)', marginTop: 2 }}>
                  <span>{history[0].date.slice(5)}</span>
                  <span style={{ color: 'var(--ios-label3)' }}>● 進場訊號</span>
                  <span>{history[history.length - 1].date.slice(5)}</span>
                </div>
              </div>
            </Section>
          )
        })()}

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
          {s.score_pct > 0 && (
            <Row label="市場百分位" value={`前 ${Math.max(1, (100 - s.score_pct).toFixed(0))}%`} valueStyle={{ color: s.score_pct >= 95 ? '#FFD60A' : s.score_pct >= 85 ? 'var(--ios-green)' : 'var(--ios-label)' }} />
          )}
          <Row label="條件達成數" value={`${s.condition_count} 個`} />
          <Row label="入場訊號" value={s.entry_signal ? '✅ 是' : '❌ 否'} />
          {s.grade && (() => {
            const gc = { A: '#FFD60A', B: 'var(--ios-green)', C: 'var(--ios-orange)', D: 'var(--ios-label3)', X: 'var(--ios-red)' }
            return <Row label="評級" value={s.grade} valueStyle={{ color: gc[s.grade] || 'var(--ios-label3)', fontSize: 18, fontWeight: 800 }} />
          })()}
          {s.regime_label && s.regime_label !== '未知' && (
            <Row label="市場體制" value={s.regime_label} valueStyle={{ color: s.regime_label === '牛市' ? 'var(--ios-green)' : s.regime_label === '熊市' ? 'var(--ios-red)' : 'var(--ios-yellow)' }} />
          )}
          {s.expected_hold_days > 0 && (
            <Row label="預期持股天數" value={`${s.expected_hold_days} 天`} valueStyle={{ color: 'var(--ios-blue)' }} />
          )}
          {s.estimated_sl_days > 0 && (
            <Row label="預估停損觸發" value={`${s.estimated_sl_days} 天內`} valueStyle={{ color: 'var(--ios-label3)' }} />
          )}
          {s.momentum_decay_signal && (
            <div style={{ margin: '6px 0 2px', padding: '6px 10px', background: 'rgba(255,159,10,0.12)', border: '0.5px solid var(--ios-orange)', borderRadius: 8, fontSize: 11, color: 'var(--ios-orange)' }}>
              ⚠️ 動能衰退訊號：此股動能已轉弱，注意追高風險
            </div>
          )}
          {s.entry_reason && <Row label="入場理由" value={s.entry_reason} valueStyle={{ color: 'var(--ios-green)', fontSize: 11 }} />}
          {s.skip_reason && <Row label="跳過原因" value={s.skip_reason} valueStyle={{ color: 'var(--ios-red)', fontSize: 11 }} />}
          {s.base_exit_signal && (
            <div style={{ margin: '6px 0 2px', padding: '6px 10px', background: 'rgba(255,69,58,0.10)', border: '0.5px solid var(--ios-red)', borderRadius: 8, fontSize: 11, color: 'var(--ios-red)' }}>
              🚪 出場訊號觸發{s.base_exit_reason ? `：${s.base_exit_reason}` : ''}
            </div>
          )}
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
          {(() => { const v = s.rsi14 ?? ci.rsi14; return <Row label="RSI(14)" value={fmt(v, 1)} valueStyle={{ color: v > 70 ? 'var(--ios-red)' : v < 30 ? 'var(--ios-green)' : 'var(--ios-label)' }} /> })()}
          {(() => { const v = s.adx14 ?? ci.adx14; return <Row label="ADX(14)" value={fmt(v, 1)} valueStyle={{ color: v > 25 ? 'var(--ios-blue)' : 'var(--ios-label)' }} /> })()}
          {(() => { const v = s.atr14 ?? ci.atr14; return <Row label="ATR(14)" value={fmt(v, 2)} /> })()}
          <Row label="量比" value={`${fmt(s.volume_ratio, 1)}x`} valueStyle={{ color: s.volume_ratio > 2 ? 'var(--ios-yellow)' : 'var(--ios-label)' }} />
          {s.volume_ma20 > 0 && (() => {
            const lots = Math.round(s.volume_ma20 / 1000)
            return <Row label="20日均量" value={lots >= 10000 ? `${(lots / 1000).toFixed(0)}K張` : `${lots.toLocaleString()}張`} valueStyle={{ color: 'var(--ios-label2)' }} />
          })()}
          {s.sma5 > 0 && <Row label="SMA5" value={`${fmt(s.sma5, 1)} 元`} valueStyle={{ color: s.close > s.sma5 ? 'var(--ios-red)' : 'var(--ios-green)' }} />}
          {s.sma10 > 0 && <Row label="SMA10" value={`${fmt(s.sma10, 1)} 元`} valueStyle={{ color: s.close > s.sma10 ? 'var(--ios-red)' : 'var(--ios-green)' }} />}
          <Row label="EMA20" value={fmt(s.ema20 ?? ci.ema20, 1)} />
          <Row label="EMA60" value={fmt(s.ema60 ?? ci.ema60, 1)} />
          {(() => { const v = s.bb_pct_b ?? ci.bb_pct_b; return <Row label="布林帶位置" value={fmt(v, 2)} /> })()}
          {(() => { const k = s.stoch_k ?? ci.stoch_k; return <Row label="KD K值" value={fmt(k, 1)} /> })()}
          {(() => { const d = s.stoch_d ?? ci.stoch_d; return <Row label="KD D值" value={fmt(d, 1)} /> })()}
          {(() => { const v = s.macd ?? ci.macd; return <Row label="MACD" value={fmt(v, 3)} /> })()}
          {(() => { const v = s.macd_signal ?? ci.macd_signal; return <Row label="MACD訊號" value={fmt(v, 3)} valueStyle={{ color: colorNum(v) }} /> })()}
          {(() => { const v = s.macd_hist ?? ci.macd_hist; return <Row label="MACD柱" value={fmt(v, 3)} valueStyle={{ color: colorNum(v) }} /> })()}
          <Row label="EMA120" value={fmt(s.ema120 ?? ci.ema120, 1)} />
          {(() => { const v = s.bb_bandwidth ?? ci.bb_bandwidth; return <Row label="BB帶寬" value={fmt(v, 2)} valueStyle={{ color: v != null && v < 0.05 ? 'var(--ios-yellow)' : 'var(--ios-label)' }} /> })()}
          {(() => { const v = s.williams_r ?? ci.williams_r; return <Row label="Williams %R" value={fmt(v, 1)} valueStyle={{ color: v < -80 ? 'var(--ios-green)' : v > -20 ? 'var(--ios-red)' : 'var(--ios-label)' }} /> })()}
          {(() => { const v = s.cci20 ?? ci.cci20; return <Row label="CCI(20)" value={fmt(v, 1)} valueStyle={{ color: v > 100 ? 'var(--ios-red)' : v < -100 ? 'var(--ios-green)' : 'var(--ios-label)' }} /> })()}
          {(() => { const v = s.mfi14 ?? ci.mfi14; return <Row label="MFI(14)" value={fmt(v, 1)} valueStyle={{ color: v > 80 ? 'var(--ios-red)' : v < 20 ? 'var(--ios-green)' : 'var(--ios-label)' }} /> })()}
          <Row label="動能分數" value={fmt(s.momentum_score, 0)} />
          <Row label="相對強度5日" value={pct(s.relative_strength_5d != null ? s.relative_strength_5d * 100 : null)} valueStyle={{ color: colorNum(s.relative_strength_5d) }} />
          {ci.bias20 != null && <Row label="乖離率 MA20" value={`${fmt(ci.bias20, 2)}%`} valueStyle={{ color: ci.bias20 > 8 ? 'var(--ios-red)' : ci.bias20 < -8 ? 'var(--ios-green)' : 'var(--ios-label)' }} />}
          {ci.bias60 != null && <Row label="乖離率 MA60" value={`${fmt(ci.bias60, 2)}%`} valueStyle={{ color: ci.bias60 > 15 ? 'var(--ios-red)' : ci.bias60 < -15 ? 'var(--ios-green)' : 'var(--ios-label)' }} />}
        </Section>

        {/* CDP 逆勢操作系統 */}
        {ci.cdp && (() => {
          const { cdp, ah, nh, nl, al } = ci.cdp
          const close = s.close
          return (
            <Section title="CDP 逆勢操作系統">
              <Row label="AH 強力壓力" value={fmt(ah, 2)} valueStyle={{ color: 'rgba(255,69,58,0.9)', fontWeight: 700 }} />
              <Row label="NH 一般壓力" value={fmt(nh, 2)} valueStyle={{ color: close != null && close >= nh ? 'var(--ios-red)' : 'var(--ios-label3)' }} />
              <Row label="CDP 中樞" value={fmt(cdp, 2)} valueStyle={{ color: 'var(--ios-yellow)', fontWeight: 600 }} />
              <Row label="NL 一般支撐" value={fmt(nl, 2)} valueStyle={{ color: close != null && close <= nl ? 'var(--ios-green)' : 'var(--ios-label3)' }} />
              <Row label="AL 強力支撐" value={fmt(al, 2)} valueStyle={{ color: 'rgba(48,209,88,0.9)', fontWeight: 700 }} />
            </Section>
          )
        })()}

        {/* 多角度分析（零 API 規則引擎）*/}
        {(() => {
          const tech = _techAnalysis(s, ci)
          const mom  = _momAnalysis(s)
          const risk = _riskAnalysis(s, ci)
          const typeColor = t => t === 'bull' ? 'var(--ios-green)' : t === 'bear' ? 'var(--ios-red)' : t === 'warn' ? 'var(--ios-yellow)' : 'var(--ios-label3)'
          const typeIcon  = t => t === 'bull' ? '▲' : t === 'bear' ? '▼' : t === 'warn' ? '⚠' : '●'
          const AgentCard = ({ title, icon, signals }) => (
            <div style={{ background: 'var(--ios-bg)', borderRadius: 10, padding: '10px 12px', marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--ios-blue)', fontWeight: 700, marginBottom: 7, letterSpacing: 0.4 }}>{icon} {title}</div>
              {signals.map((sig, i) => (
                <div key={i} style={{ display: 'flex', gap: 7, marginBottom: 5, alignItems: 'flex-start' }}>
                  <span style={{ color: typeColor(sig.t), fontSize: 10, marginTop: 2.5, flexShrink: 0, fontWeight: 700 }}>{typeIcon(sig.t)}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--ios-label)', lineHeight: 1.5 }}>{sig.v}</span>
                </div>
              ))}
            </div>
          )
          return (
            <Section title="分析師觀點（不消耗 API）">
              <AgentCard title="技術分析師" icon="📐" signals={tech} />
              <AgentCard title="動能研究員" icon="⚡" signals={mom} />
              <AgentCard title="風險管理師" icon="🛡️" signals={risk} />
            </Section>
          )
        })()}

        {/* 技術訊號旗標 */}
        {(() => {
          const bullish = [
            { key: 'macd_golden_cross',    label: 'MACD金叉' },
            { key: 'hist_turn_positive',   label: 'MACD柱轉正' },
            { key: 'kd_golden_cross',      label: 'KD金叉' },
            { key: 'above_ema60',          label: '站上EMA60' },
            { key: 'ema60_gt_ema120',      label: 'EMA60>120' },
            { key: 'rsi_strong',           label: 'RSI強勢' },
            { key: 'adx_trending',         label: 'ADX趨勢' },
            { key: 'volume_break',         label: '放量' },
            { key: 'breakout_20d',         label: '突破20日高' },
            { key: 'stronger_than_market', label: '強於大盤' },
            { key: 'obv_uptrend',          label: 'OBV上升' },
            { key: 'above_ichimoku_cloud', label: '站上雲' },
            { key: 'bb_squeeze_breakout',  label: 'BB壓縮突破' },
            { key: 'breakout_volume_confirm', label: '量確認突破' },
            { key: 'williams_r_recovery',  label: 'WR回升' },
            { key: 'cci_momentum',         label: 'CCI動能' },
            { key: 'mfi_strong',           label: 'MFI強勢' },
            { key: 'foreign_buy_3d',       label: '外資3日買' },
            { key: 'invest_trust_buy_2d',  label: '投信2日買' },
            { key: 'dealer_buy_3d',        label: '自營3日買' },
            { key: 'ma5_above_ma10',       label: 'MA5>MA10' },
          ]
          const bearish = [
            { key: 'macd_death_cross',        label: 'MACD死叉' },
            { key: 'close_below_ema20',       label: '跌破EMA20' },
            { key: 'close_below_swing_low',   label: '跌破波段低' },
            { key: 'long_upper_shadow',       label: '長上影線' },
            { key: 'open_high_close_low',     label: '開高走低' },
          ]
          const activeB = bullish.filter(sig => s[sig.key])
          const activeR = bearish.filter(sig => s[sig.key])
          if (!activeB.length && !activeR.length) return null
          return (
            <Section title="技術訊號">
              {activeB.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: activeR.length ? 10 : 0 }}>
                  {activeB.map(sig => (
                    <span key={sig.key} style={{ fontSize: 11, padding: '3px 8px', background: 'rgba(48,209,88,0.12)', color: 'var(--ios-green)', border: '0.5px solid rgba(48,209,88,0.4)', borderRadius: 6, fontWeight: 600, letterSpacing: 0.2 }}>
                      ✓ {sig.label}
                    </span>
                  ))}
                </div>
              )}
              {activeR.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {activeR.map(sig => (
                    <span key={sig.key} style={{ fontSize: 11, padding: '3px 8px', background: 'rgba(255,69,58,0.12)', color: 'var(--ios-red)', border: '0.5px solid rgba(255,69,58,0.4)', borderRadius: 6, fontWeight: 600, letterSpacing: 0.2 }}>
                      ✗ {sig.label}
                    </span>
                  ))}
                </div>
              )}
            </Section>
          )
        })()}

        {/* 進場就位度 */}
        {((s.gap_to_20d_high_pct != null && s.gap_to_20d_high_pct !== 0) || s.breakout_proximity_score > 0 || (s.obv_strength != null && s.obv_strength !== 0) || s.ma5_above_ma10 != null) && (
          <Section title="進場就位度">
            {s.gap_to_20d_high_pct != null && s.gap_to_20d_high_pct !== 0 && (
              <Row label="距20日高點" value={`${s.gap_to_20d_high_pct > 0 ? '+' : ''}${fmt(s.gap_to_20d_high_pct, 1)}%`} valueStyle={{ color: s.gap_to_20d_high_pct <= 2 ? 'var(--ios-yellow)' : s.gap_to_20d_high_pct > 10 ? 'var(--ios-label3)' : 'var(--ios-label)' }} />
            )}
            {s.breakout_proximity_score > 0 && (
              <Row label="突破就位分" value={`${fmt(s.breakout_proximity_score, 0)} / 10`} valueStyle={{ color: s.breakout_proximity_score >= 7 ? '#FFD60A' : s.breakout_proximity_score >= 4 ? 'var(--ios-label)' : 'var(--ios-label3)' }} />
            )}
            {s.bb_level_signal != null && s.bb_level_signal !== 0 && (
              <Row label="布林帶位置分" value={`${s.bb_level_signal > 0 ? '+' : ''}${fmt(s.bb_level_signal, 0)}`} valueStyle={{ color: s.bb_level_signal > 0 ? 'var(--ios-green)' : 'var(--ios-red)' }} />
            )}
            {s.kd_level_score != null && s.kd_level_score !== 0 && (
              <Row label="KD梯度分" value={`${s.kd_level_score > 0 ? '+' : ''}${fmt(s.kd_level_score, 0)}`} valueStyle={{ color: s.kd_level_score > 0 ? 'var(--ios-green)' : 'var(--ios-red)' }} />
            )}
            {s.ma5_above_ma10 != null && (
              <Row label="MA5 > MA10" value={s.ma5_above_ma10 ? '✅ 是' : '❌ 否'} valueStyle={{ color: s.ma5_above_ma10 ? 'var(--ios-green)' : 'var(--ios-label3)' }} />
            )}
            {s.obv_strength != null && s.obv_strength !== 0 && (
              <Row label="OBV強度" value={fmt(s.obv_strength, 2)} valueStyle={{ color: s.obv_strength > 0.5 ? 'var(--ios-green)' : s.obv_strength < -0.5 ? 'var(--ios-red)' : 'var(--ios-label)' }} />
            )}
            {s.close_20d_high > 0 && (
              <Row label="20日高點壓力" value={`${fmt(s.close_20d_high, 1)} 元`} valueStyle={{ color: 'var(--ios-label2)' }} />
            )}
            {s.close_10d_low > 0 && (
              <Row label="10日低點支撐" value={`${fmt(s.close_10d_low, 1)} 元`} valueStyle={{ color: 'var(--ios-label2)' }} />
            )}
            {s.lr_slope_20 != null && s.lr_slope_20 !== 0 && (
              <Row label="短期趨勢斜率(20日)" value={fmt(s.lr_slope_20, 3)} valueStyle={{ color: s.lr_slope_20 > 0 ? 'var(--ios-green)' : 'var(--ios-red)' }} />
            )}
            {s.lr_slope_60 != null && s.lr_slope_60 !== 0 && (
              <Row label="中期趨勢斜率(60日)" value={fmt(s.lr_slope_60, 3)} valueStyle={{ color: s.lr_slope_60 > 0 ? 'var(--ios-green)' : 'var(--ios-red)' }} />
            )}
          </Section>
        )}

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
            const AccelTag = ({ show }) => show
              ? <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--ios-orange)', fontWeight: 700, background: 'rgba(255,159,10,0.12)', borderRadius: 4, padding: '1px 5px' }}>加速↑</span>
              : null
            return (<>
              <Row label="外資連買天數" value={<>{fmtStreak(s.foreign_buy_streak)}<AccelTag show={s.foreign_buy_accel} /></>} valueStyle={{ color: s.foreign_buy_streak > 0 ? 'var(--ios-red)' : 'var(--ios-label3)' }} />
              <Row label="外資買賣超" value={fmtNet(s.foreign_net)} valueStyle={{ color: colorNum(s.foreign_net) }} />
              <Row label="投信連買天數" value={<>{fmtStreak(s.invest_trust_streak)}<AccelTag show={s.invest_trust_accel} /></>} valueStyle={{ color: s.invest_trust_streak > 0 ? 'var(--ios-red)' : 'var(--ios-label3)' }} />
              <Row label="投信買賣超" value={fmtNet(s.invest_trust_net)} valueStyle={{ color: colorNum(s.invest_trust_net) }} />
              <Row label="自營商連買天數" value={fmtStreak(s.dealer_buy_streak)} valueStyle={{ color: s.dealer_buy_streak > 0 ? 'var(--ios-red)' : 'var(--ios-label3)' }} />
              <Row label="自營商買賣超" value={fmtNet(s.dealer_net)} valueStyle={{ color: colorNum(s.dealer_net) }} />
              {s.foreign_holding_pct > 0 && (
                <Row label="外資持股%" value={`${fmt(s.foreign_holding_pct, 1)}%`} valueStyle={{ color: s.foreign_holding_pct >= 30 ? 'var(--ios-red)' : 'var(--ios-label)' }} />
              )}
              {s.foreign_holding_chg5d != null && s.foreign_holding_chg5d !== 0 && (
                <Row label="外資持股5日變化" value={`${s.foreign_holding_chg5d > 0 ? '+' : ''}${fmt(s.foreign_holding_chg5d, 2)}%`} valueStyle={{ color: s.foreign_holding_chg5d > 1 ? 'var(--ios-red)' : s.foreign_holding_chg5d < -1 ? 'var(--ios-green)' : 'var(--ios-label)' }} />
              )}
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
          {s.revenue_mom != null && s.revenue_mom !== 0 && (
            <Row label="月營收 MoM" value={pct(s.revenue_mom * 100)} valueStyle={{ color: s.revenue_mom > 0 ? 'var(--ios-red)' : 'var(--ios-green)' }} />
          )}
          {s.revenue_3m_yoy != null && s.revenue_3m_yoy !== 0 && (
            <Row label="近3月累計 YoY" value={pct(s.revenue_3m_yoy * 100)} valueStyle={{ color: s.revenue_3m_yoy > 0.1 ? 'var(--ios-red)' : s.revenue_3m_yoy < 0 ? 'var(--ios-green)' : 'var(--ios-label)' }} />
          )}
          {s.has_buyback && (
            <Row label="庫藏股回購" value="✅ 進行中" valueStyle={{ color: 'var(--ios-orange)' }} />
          )}
          {s.insider_net_30d != null && s.insider_net_30d !== 0 && (
            <Row label="內部人30日淨買" value={`${s.insider_net_30d > 0 ? '+' : ''}${fmt(s.insider_net_30d, 0)} 張`} valueStyle={{ color: s.insider_net_30d > 0 ? 'var(--ios-red)' : 'var(--ios-green)' }} />
          )}
        </Section>
        {!s.data_quality_ok && s.data_quality_ok != null && (
          <div style={{ margin: '4px 0 10px', padding: '8px 12px', background: 'rgba(255,69,58,0.08)', border: '0.5px solid var(--ios-red)', borderRadius: 10, fontSize: 11, color: 'var(--ios-red)' }}>
            ⚠️ 資料品質警示：此股票部分指標資料不完整，評分參考性較低
          </div>
        )}
      </div>
    </div>
  )
}
