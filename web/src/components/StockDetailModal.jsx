import { useState, useRef, useMemo, useEffect, useCallback } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
gsap.registerPlugin(useGSAP)

const fmt = (v, dec = 2) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(dec))
const pct = (v) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`)
const colorNum = (v, pos = 'var(--ios-red)', neg = 'var(--ios-green)') => {
  const n = Number(v)
  if (isNaN(n) || n === 0) return 'var(--ios-label3)'
  return n > 0 ? pos : neg
}

// Taiwan convention: red = up, green = down
function candleColor(open, close) { return close >= open ? '#FF3340' : '#16D67E' }

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
  // If all volumes are 0/missing, fall back to price-direction counting (unit volume)
  const hasVol = bars.some(b => (b.volume || 0) > 0)
  const result = new Array(bars.length).fill(0)
  let obv = 0
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      const vol = hasVol ? (bars[i].volume || 0) : 1
      if (bars[i].close > bars[i - 1].close) obv += vol
      else if (bars[i].close < bars[i - 1].close) obv -= vol
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

// ── K-line pattern descriptions ─────────────────────────────────────────────

const PATTERN_DESC = {
  '十字星':  { short: '多空猶豫', hint: '開收相近，趨勢可能轉折，需等下一根K棒確認方向' },
  '錘子線':  { short: '底部反轉↑', hint: '長下影線代表空方試圖壓低但多方強力拉回，底部見到為強力多頭訊號' },
  '吊頸線':  { short: '頂部警示↓', hint: '外形像錘子但出現在高位，暗示多頭力道衰竭，需謹慎' },
  '流星線':  { short: '頂部反轉↓', hint: '長上影線代表多方嘗試拉高但遭空方壓回，頂部出現為強力空頭訊號' },
  '倒錘子':  { short: '潛在反彈↑', hint: '長上影線出現在底部，代表多方開始嘗試反攻，需次日確認' },
  '多頭吞噬': { short: '強力多頭↑', hint: '大紅棒完全包住前一根黑棒，力道強，常見於底部反轉起點' },
  '空頭吞噬': { short: '強力空頭↓', hint: '大黑棒完全包住前一根紅棒，力道強，常見於頂部反轉起點' },
}

// ── K-line pattern detection ─────────────────────────────────────────────────

function detectCandlePattern(bars, i) {
  if (i < 1) return null
  const c = bars[i]
  const p = bars[i - 1]
  if (!c || !p || c.high == null || c.low == null || c.open == null) return null
  const range = c.high - c.low
  if (range < 0.001) return null
  const body    = Math.abs(c.close - c.open)
  const upper   = c.high - Math.max(c.close, c.open)
  const lower   = Math.min(c.close, c.open) - c.low
  const bullish = c.close >= c.open

  if (body / range < 0.08)                               return { name: '十字星', type: 'neutral' }
  if (lower > 2 * body && upper < body * 0.5 && bullish) return { name: '錘子線', type: 'bullish' }
  if (lower > 2 * body && upper < body * 0.5 && !bullish) return { name: '吊頸線', type: 'bearish' }
  if (upper > 2 * body && lower < body * 0.5 && !bullish) return { name: '流星線', type: 'bearish' }
  if (upper > 2 * body && lower < body * 0.5 && bullish)  return { name: '倒錘子', type: 'bullish' }
  if (p.open != null) {
    const pBull = p.close > p.open
    if (bullish && !pBull && body > Math.abs(p.close - p.open) * 0.9 && c.open < p.close && c.close > p.open)
      return { name: '多頭吞噬', type: 'bullish' }
    if (!bullish && pBull && body > Math.abs(p.close - p.open) * 0.9 && c.open > p.close && c.close < p.open)
      return { name: '空頭吞噬', type: 'bearish' }
  }
  return null
}

// ── Fibonacci retracement levels ─────────────────────────────────────────────

const FIB_LEVELS = [
  { r: 0,     label: '0%',    color: 'rgba(255,51,64,0.75)' },
  { r: 0.236, label: '23.6%', color: 'rgba(255,159,10,0.7)' },
  { r: 0.382, label: '38.2%', color: 'rgba(255,214,10,0.8)' },
  { r: 0.5,   label: '50%',   color: 'rgba(180,180,180,0.7)' },
  { r: 0.618, label: '61.8%', color: 'rgba(255,214,10,0.8)' },
  { r: 0.786, label: '78.6%', color: 'rgba(255,159,10,0.7)' },
  { r: 1,     label: '100%',  color: 'rgba(22,214,126,0.75)' },
]

// ── Sub-chart panel (MACD / RSI / KD) ───────────────────────────────────────

const CHART_W = 460
const CHART_PL = 42
const CHART_PR = 38   // wide enough for right-axis price badge (26px) + margin
const BAR_W = 5  // fixed pixels per candle for scrollable chart

function SubChartSVG({ bars, label, lines, histSeries, hBands, hoveredIdx, onHoverIdx, onLock, locked, yFixed, chartW: propChartW }) {
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

  const idxFromX = (clientX, svgEl) => {
    const rect = svgEl.getBoundingClientRect()
    const svgX = (clientX - rect.left) / rect.width * W
    const idx = Math.floor((svgX - CHART_PL) / slotW)
    return idx >= 0 && idx < n ? idx : null
  }
  const handleMove = (clientX, svgEl) => { if (onHoverIdx) onHoverIdx(idxFromX(clientX, svgEl)) }

  const handleTouchStart = (e) => {
    if (e.touches.length !== 1) { if (subTouchRef.current) clearTimeout(subTouchRef.current.lpTimer); subTouchRef.current = null; return }
    const t = e.touches[0]
    // lockedNow: see CandleSVG — lets a long-press toggle the lock mid-gesture.
    subTouchRef.current = { startX: t.clientX, startY: t.clientY, svgEl: e.currentTarget, moved: false, didLock: false, lockedNow: locked }
    if (onLock) {
      subTouchRef.current.lpTimer = setTimeout(() => {
        if (!subTouchRef.current || subTouchRef.current.moved) return
        subTouchRef.current.didLock = true
        if (subTouchRef.current.lockedNow) {
          subTouchRef.current.lockedNow = false
          onLock(null); onHoverIdx?.(null)
        } else {
          const idx = idxFromX(subTouchRef.current.startX, subTouchRef.current.svgEl)
          if (idx != null) { subTouchRef.current.lockedNow = true; onLock(idx); onHoverIdx?.(idx) }
        }
      }, 420)
    }
  }
  const handleTouchMove = (e) => {
    if (!subTouchRef.current) return
    const t = e.touches[0]
    const dx = Math.abs(t.clientX - subTouchRef.current.startX)
    const dy = Math.abs(t.clientY - subTouchRef.current.startY)
    const moveThresh = subTouchRef.current.lockedNow ? 14 : 6
    if (dx > moveThresh || dy > moveThresh) { subTouchRef.current.moved = true; clearTimeout(subTouchRef.current.lpTimer) }
    if (!subTouchRef.current.lockedNow) return // Not locked: browser scrolls natively
    if (dx > dy && dx > 5) {
      e.stopPropagation()
      handleMove(t.clientX, subTouchRef.current.svgEl)
    }
  }
  const handleTouchEnd = () => {
    const ref = subTouchRef.current
    subTouchRef.current = null
    if (ref) clearTimeout(ref.lpTimer)
    if (!ref || !ref.lockedNow) onHoverIdx?.(null)
  }

  const accentColor = lines?.[0]?.color || (histSeries ? '#FF3340' : '#8E8E93')
  const badgeW = Math.max(30, (label?.length || 0) * 6.0 + 14)

  return (
    <svg
      viewBox={`0 0 ${W} ${H + PT + 4}`}
      style={{ width: W, display: 'block', background: 'var(--ios-bg2)', borderTop: '0.5px solid var(--ios-sep)', marginTop: 2, touchAction: locked ? 'none' : 'pan-x pan-y', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
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
          <text x={W - CHART_PR + 2} y={toY(b.value) + 3.5} fontSize={7.5} fill={b.color || '#636366'} opacity={0.9} textAnchor="start">{b.label ?? b.value}</text>
        </g>
      ))}

      {/* Histogram bars */}
      {histSeries && histSeries.values.map((v, i) => {
        if (v == null) return null
        const x = toX(i), zero = toY(0), y = toY(v), h = Math.abs(y - zero)
        return <rect key={i} x={x - bW / 2} y={Math.min(y, zero)} width={bW} height={Math.max(h, 0.5)}
          fill={v >= 0 ? '#FF3340' : '#16D67E'} opacity={0.75} />
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
        const absV = Math.abs(v)
        const lbl = absV >= 1e9 ? `${v < 0 ? '-' : ''}${(absV / 1e9).toFixed(1)}B`
          : absV >= 1e6 ? `${v < 0 ? '-' : ''}${(absV / 1e6).toFixed(1)}M`
          : absV >= 1e3 ? `${v < 0 ? '-' : ''}${(absV / 1e3).toFixed(0)}K`
          : absV < 0.01 ? v.toFixed(3) : absV < 1 ? v.toFixed(2) : absV < 10 ? v.toFixed(1) : v.toFixed(0)
        return (
          <text key={t} x={CHART_PL - 3} y={y + 3.5} fontSize={8} style={{ fill: 'var(--ios-label3)' }} textAnchor="end" opacity={0.85}>{lbl}</text>
        )
      })}

      {/* Indicator label badge (top-left): colored pill with accent bar */}
      <g>
        <rect x={CHART_PL + 1} y={PT} width={badgeW} height={16} rx={4}
          fill={accentColor} fillOpacity={0.18}
          stroke={accentColor} strokeWidth={0.6} strokeOpacity={0.35} />
        <rect x={CHART_PL + 1} y={PT} width={3} height={16} rx={2}
          fill={accentColor} fillOpacity={0.95} />
        <text x={CHART_PL + 8} y={PT + 11} fontSize={9.5} fill={accentColor} fontWeight="800" letterSpacing="0.4">{label}</text>
      </g>

      {/* Floating tooltip popup on hover */}
      {hoveredIdx != null && (() => {
        const fmtV = v => {
          const a = Math.abs(v)
          if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
          if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`
          if (a < 0.01) return v.toFixed(3)
          if (a < 1)    return v.toFixed(2)
          if (a < 10)   return v.toFixed(1)
          return v.toFixed(0)
        }
        const histV = histSeries?.values[hoveredIdx]
        const lineRows = (lines || []).filter(s => s.values[hoveredIdx] != null)
        const rows = [
          ...(histV != null ? [{ label: 'Hist', value: histV, color: histV >= 0 ? '#FF3340' : '#16D67E' }] : []),
          ...lineRows.map(s => ({ label: s.label, value: s.values[hoveredIdx], color: s.color })),
        ]
        if (rows.length === 0) return null
        const ttW = 76
        const rowH = 12
        const ttH = rows.length * rowH + 10
        const cx = toX(hoveredIdx)
        const ttX = Math.min(
          Math.max(cx > W / 2 ? cx - ttW - 5 : cx + 5, CHART_PL),
          W - CHART_PR - ttW
        )
        const ttY = PT + 2
        return (
          <g>
            <rect x={ttX} y={ttY} width={ttW} height={ttH} rx={5} strokeWidth={0.5}
              style={{ fill: 'var(--ios-bg3)', stroke: 'var(--ios-sep)' }} />
            {rows.map((r, i) => (
              <g key={i}>
                <text x={ttX + 5} y={ttY + 9 + i * rowH} fontSize={8} fontWeight="500"
                  style={{ fill: 'var(--ios-label3)' }}>{r.label}</text>
                <text x={ttX + ttW - 4} y={ttY + 9 + i * rowH} fontSize={8.5} fontWeight="700"
                  fill={r.color} textAnchor="end">{fmtV(r.value)}</text>
              </g>
            ))}
          </g>
        )
      })()}

      {/* Crosshair */}
      {hoveredIdx != null && hoveredIdx >= 0 && hoveredIdx < n && (
        <line x1={toX(hoveredIdx)} y1={0} x2={toX(hoveredIdx)} y2={H + PT}
          stroke="#0A84FF" strokeWidth={0.6} strokeDasharray="2,2" opacity={0.55} />
      )}
    </svg>
  )
}

// ── Candlestick chart ────────────────────────────────────────────────────────

const CDP_LINE_DEFS = [
  { key: 'ah',  color: 'rgba(255,51,64,0.85)',  sw: 1.2 },
  { key: 'nh',  color: 'rgba(255,159,10,0.8)',  sw: 1.2 },
  { key: 'cdp', color: 'rgba(255,214,10,0.92)', sw: 1.5 },
  { key: 'nl',  color: 'rgba(22,214,126,0.8)',   sw: 1.2 },
  { key: 'al',  color: 'rgba(22,214,126,0.95)',  sw: 1.2 },
]

function CandleSVG({ data, maLines, bbBands, cdpSeries, showFib, showPatterns, onHoverIdx, hoveredIdx: extHoverIdx, onLock, locked, label, chartW: propChartW, compareId, compareHistories, historyDates, logScale = false, measureMode = false }) {
  const [hovered, setHovered] = useState(null)
  const touchRef = useRef(null)
  // Measure tool: A = anchor bar, B = current bar. Active only when measureMode is on.
  const [measA, setMeasA] = useState(null)
  const [measB, setMeasB] = useState(null)
  const measDragRef = useRef(false)
  useEffect(() => { if (!measureMode) { setMeasA(null); setMeasB(null) } }, [measureMode])

  const chart = useMemo(() => {
    if (!data || data.length < 2) return null
    const bars = data
    const n = bars.length
    const W = propChartW || Math.max(CHART_W, n * BAR_W + CHART_PL + CHART_PR)
    const CH = 200, H = CH
    const PL = CHART_PL, PR = CHART_PR, PT = 8
    const maxP = Math.max(...bars.map(d => d.high ?? d.close ?? 0), ...(bbBands?.upper?.filter(Boolean) || []), ...(cdpSeries?.filter(Boolean).map(lv => lv.ah) || []))
    const minP = Math.min(...bars.map(d => d.low  ?? d.close ?? 0), ...(bbBands?.lower?.filter(Boolean) || []), ...(cdpSeries?.filter(Boolean).map(lv => lv.al) || []))
    const pRange = (isNaN(maxP) || isNaN(minP) || maxP === minP) ? 1 : maxP - minP
    const slotW = (W - PL - PR) / n
    const bW = Math.max(slotW * 0.65, 1.5)
    // Logarithmic price axis: equal % moves take equal vertical space (pro long-term view).
    // Falls back to linear if any non-positive price would break log().
    const useLog = logScale && !isNaN(minP) && !isNaN(maxP) && minP > 0 && maxP > 0
    const lMin = useLog ? Math.log(minP) : 0
    const lRange = useLog ? (Math.log(maxP) - lMin) || 1 : 1
    const toY = useLog
      ? p => p > 0 ? PT + (1 - (Math.log(p) - lMin) / lRange) * CH : PT + CH
      : p => PT + (1 - (p - (isNaN(minP) ? 0 : minP)) / pRange) * CH
    const toX = i => PL + (i + 0.5) * slotW
    const gridLevels = isNaN(minP) ? [] : [0, 1/3, 2/3, 1].map(t => ({
      price: useLog ? Math.exp(lMin + t * lRange) : minP + t * pRange,
      y: PT + (1 - t) * CH,
    }))
    const xStep = Math.max(1, Math.floor(n / 5))
    const xLabels = bars.map((d, i) => ({ i, label: d.time ? d.time.slice(5) : '' })).filter((_, i) => i % xStep === 0 || i === n - 1)
    return { bars, W, CH, H, PL, PR, PT, n, slotW, bW, toY, toX, gridLevels, xLabels }
  }, [data, bbBands, cdpSeries, propChartW, logScale])

  if (!chart) return (
    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ios-label3)', fontSize: 12, background: 'var(--ios-bg)', borderRadius: 10 }}>
      暫無歷史 K 線資料
    </div>
  )

  const { bars, W, CH, H, PL, PR, PT, n, slotW, bW, toY, toX, gridLevels, xLabels } = chart

  // Feature 1: Build compare percentage-change series aligned to bars by date
  const comparePolyline = useMemo(() => {
    if (!compareId || !compareHistories?.[compareId] || !historyDates || !bars.length) return null
    const cData = compareHistories[compareId]
    // Build a date→close map for the compare stock
    const closeMap = {}
    historyDates.forEach((d, i) => { if (cData.c?.[i] != null) closeMap[d] = cData.c[i] })
    if (Object.keys(closeMap).length === 0) return null

    // Find bar dates (bars have .time field)
    const barDates = bars.map(b => b.time)
    const firstDate = barDates[0]
    const baseClose = closeMap[firstDate]
    if (!baseClose) return null

    // Build pct-change values aligned to bars
    const mainFirst = bars[0].close
    const mainLast  = bars[bars.length - 1].close
    const mainPctRange = Math.abs(mainLast - mainFirst) / mainFirst || 0.05

    // pct-change polyline — use same vertical space as price chart
    const points = []
    for (let i = 0; i < bars.length; i++) {
      const d = barDates[i]
      const c = closeMap[d]
      if (c == null) continue
      const pct = (c - baseClose) / baseClose
      // Map pct to y: center at mid of chart, scale to ±CH/2
      // We scale so that the compare stock's range fits in the chart visually
      const x = toX(i)
      // pct is mapped to pixel: 0% → midY, scale by mainPctRange
      const midY = PT + CH / 2
      const scaleY = (CH * 0.45) / Math.max(mainPctRange, 0.02)
      const y = midY - pct * scaleY
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    }
    if (points.length < 2) return null
    return points.join(' ')
  }, [compareId, compareHistories, historyDates, bars, toX])

  const getIdx = (clientX, svgEl) => {
    const rect = svgEl.getBoundingClientRect()
    const svgX = (clientX - rect.left) / rect.width * (W + rightExt)
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

  const clampIdx = (clientX, svgEl) => Math.max(0, Math.min(bars.length - 1, getIdx(clientX, svgEl)))

  const handleMouseDown = (e) => {
    if (!measureMode) return
    const i = clampIdx(e.clientX, e.currentTarget)
    measDragRef.current = true
    setMeasA(i); setMeasB(i)
  }
  const handleMouseMove = (e) => {
    if (measureMode) { if (measDragRef.current) setMeasB(clampIdx(e.clientX, e.currentTarget)); return }
    setBar(getIdx(e.clientX, e.currentTarget), e.currentTarget)
  }
  const handleMouseUp = () => { measDragRef.current = false }
  const handleMouseLeave = () => { measDragRef.current = false; if (!measureMode) { setHovered(null); onHoverIdx?.(null) } }

  const handleTouchStart = (e) => {
    if (measureMode) {
      if (e.touches.length !== 1) return
      const i = clampIdx(e.touches[0].clientX, e.currentTarget)
      measDragRef.current = true
      setMeasA(i); setMeasB(i)
      return
    }
    if (e.touches.length !== 1) { if (touchRef.current) clearTimeout(touchRef.current.lpTimer); touchRef.current = null; return }
    const t = e.touches[0]
    const svgEl = e.currentTarget
    // lockedNow mirrors the lock state *within this gesture* so a long-press that
    // toggles the lock takes effect immediately (the `locked` prop is stale until
    // the next React render).
    touchRef.current = { startX: t.clientX, startY: t.clientY, svgEl, active: false, moved: false, didLock: false, lockedNow: locked }
    if (onLock) {
      touchRef.current.lpTimer = setTimeout(() => {
        if (!touchRef.current || touchRef.current.moved) return
        touchRef.current.didLock = true
        if (touchRef.current.lockedNow) {
          touchRef.current.lockedNow = false
          onLock(null); setHovered(null); onHoverIdx?.(null)
        } else {
          const idx = getIdx(touchRef.current.startX, touchRef.current.svgEl)
          if (idx >= 0 && idx < bars.length) { touchRef.current.lockedNow = true; onLock(idx); setBar(idx, touchRef.current.svgEl) }
        }
      }, 420)
    }
  }
  const handleTouchMove = (e) => {
    if (measureMode) {
      if (!measDragRef.current || e.touches.length !== 1) return
      e.stopPropagation()
      setMeasB(clampIdx(e.touches[0].clientX, e.currentTarget))
      return
    }
    if (!touchRef.current) return
    const t = e.touches[0]
    const dx = Math.abs(t.clientX - touchRef.current.startX)
    const dy = Math.abs(t.clientY - touchRef.current.startY)
    // While locked, tolerate finger jitter (14px) so a held finger reliably
    // long-presses to UNLOCK; a clear drag still cancels the timer to move the crosshair.
    const moveThresh = touchRef.current.lockedNow ? 14 : 6
    if (dx > moveThresh || dy > moveThresh) { touchRef.current.moved = true; clearTimeout(touchRef.current.lpTimer) }
    if (!touchRef.current.lockedNow) return // Not locked: touchAction pan-x pan-y lets browser scroll natively
    // Locked: crosshair follows finger, prevent scroll
    if (dx > dy && dx > 5) {
      e.stopPropagation()
      touchRef.current.active = true
      setBar(getIdx(t.clientX, touchRef.current.svgEl))
    } else if (dy > 8 && !touchRef.current.active) {
      setHovered(null); onHoverIdx?.(null)
    }
  }
  const handleTouchEnd = () => {
    if (measureMode) { measDragRef.current = false; return }
    const ref = touchRef.current
    touchRef.current = null
    if (ref) clearTimeout(ref.lpTimer)
    // Clear the crosshair unless this gesture left the chart locked (pinned).
    if (!ref || !ref.lockedNow) { setHovered(null); onHoverIdx?.(null) }
  }

  // Effective hover: prefer this chart's own pointer; otherwise mirror the
  // shared crosshair index coming from a linked sub-chart (bidirectional sync).
  const effHover = hovered || (
    extHoverIdx != null && extHoverIdx >= 0 && extHoverIdx < bars.length
      ? { idx: extHoverIdx, bar: bars[extHoverIdx], x: toX(extHoverIdx) }
      : null
  )

  const tipW = 118, tipH = 94
  const tipX = effHover ? (effHover.x > W / 2 ? effHover.x - tipW - 6 : effHover.x + 8) : 0
  const tipY = PT + 4

  // Build polyline segments for MA/BB/CDP
  const bbSegs = bbBands ? {
    upper: toPolySegs(bbBands.upper, toX, toY),
    mid:   toPolySegs(bbBands.mid,   toX, toY),
    lower: toPolySegs(bbBands.lower, toX, toY),
  } : null

  const cdpSegs = cdpSeries ? CDP_LINE_DEFS.map(def => ({
    ...def,
    segs: toPolySegs(cdpSeries.map(lv => lv?.[def.key] ?? null), toX, toY),
  })) : null

  // Fibonacci retracement (auto high/low of visible bars)
  const fibBands = showFib ? (() => {
    const highs = bars.map(b => b.high ?? b.close ?? 0)
    const lows  = bars.map(b => b.low  ?? b.close ?? 0)
    const fibH = Math.max(...highs), fibL = Math.min(...lows)
    const fibR = fibH - fibL || 1
    return FIB_LEVELS.map(({ r, label, color }) => ({ price: fibH - r * fibR, label, color }))
  })() : null

  // K-line patterns for each bar
  const patterns = showPatterns ? bars.map((_, i) => detectCandlePattern(bars, i)) : null

  // Right-axis extension: just enough for the 42px badge (ends at W+8) plus 6px breathing room
  const hasRightLabels = cdpSeries || (maLines && maLines.length > 0)
  const rightExt = hasRightLabels ? 14 : 0

  return (
    <svg
      viewBox={`0 0 ${W + rightExt} ${H + PT + 18}`}
      style={{ width: W + rightExt, display: 'block', background: 'var(--ios-bg)', borderRadius: '10px 10px 0 0', cursor: measureMode ? 'col-resize' : 'crosshair', touchAction: (locked || measureMode) ? 'none' : 'pan-x pan-y', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Grid */}
      {gridLevels.map(({ y, price }, j) => (
        <g key={j}>
          <line x1={PL} y1={y} x2={W - 6} y2={y} stroke="rgba(128,128,128,0.18)" strokeWidth={0.5} />
          <text x={PL - 3} y={y + 3.5} fontSize={8.5} style={{ fill: 'var(--ios-label3)' }} textAnchor="end">
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

      {/* CDP — connected polylines */}
      {cdpSegs && cdpSegs.map(({ key, color, sw, segs }) =>
        segs.map((pts, si) => (
          <polyline key={`cdp-${key}-${si}`} points={pts} fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
        ))
      )}

      {/* Fibonacci retracement levels */}
      {fibBands && fibBands.map(({ price, label, color }) => {
        const y = toY(price)
        if (y < PT || y > CH + PT) return null
        return (
          <g key={label}>
            <line x1={PL} y1={y} x2={W - PR} y2={y} stroke={color} strokeWidth={0.7} strokeDasharray="5,3" />
            <text x={PL + 4} y={y - 2} fontSize={7} fill={color} opacity={0.9}>{label}</text>
            <text x={W - PR - 4} y={y - 2} fontSize={7} fill={color} opacity={0.9} textAnchor="end">
              {price >= 100 ? price.toFixed(1) : price.toFixed(2)}
            </text>
          </g>
        )
      })}

      {/* Candles */}
      {bars.map((d, i) => {
        const x = toX(i), color = candleColor(d.open ?? d.close, d.close)
        const bodyTop = toY(Math.max(d.open ?? d.close, d.close))
        const bodyBot = toY(Math.min(d.open ?? d.close, d.close))
        const bodyH = Math.max(bodyBot - bodyTop, 1)
        const isHovered = hovered?.idx === i
        return (
          <g key={i} opacity={hovered && !isHovered ? 0.45 : 1}>
            <line x1={x} y1={toY(d.high ?? d.close)} x2={x} y2={toY(d.low ?? d.close)} stroke={color} strokeWidth={isHovered ? 1.4 : 0.8} />
            <rect x={x - bW / 2} y={bodyTop} width={bW} height={bodyH} fill={color} stroke={isHovered ? '#fff' : 'none'} strokeWidth={0.5} />
          </g>
        )
      })}

      {/* MA overlays */}
      {(maLines || []).map((ma, mi) =>
        toPolySegs(ma.values, toX, toY).map((pts, sj) => (
          <polyline key={`ma${mi}-${sj}`} points={pts} fill="none" stroke={ma.color} strokeWidth={1.2} opacity={0.85} />
        ))
      )}

      {/* Feature 1: Compare stock percentage-change overlay */}
      {comparePolyline && (
        <g>
          {/* Legend */}
          <rect x={PL + 4} y={PT + 18} width={60} height={14} rx={3} fill="rgba(0,0,0,0.45)" />
          <circle cx={PL + 10} cy={PT + 25} r={3} fill="#FF9F0A" />
          <text x={PL + 16} y={PT + 29} fontSize={8} fill="#FF9F0A" fontWeight="700">{compareId} %△</text>
          {/* Zero line (0% change reference) */}
          <line x1={PL} y1={PT + CH / 2} x2={W - PR} y2={PT + CH / 2}
            stroke="#FF9F0A" strokeWidth={0.4} strokeDasharray="3,4" opacity={0.35} />
          {/* The polyline */}
          <polyline points={comparePolyline} fill="none" stroke="#FF9F0A" strokeWidth={1.5} opacity={0.8} strokeLinejoin="round" />
        </g>
      )}

      {/* X-axis labels */}
      {xLabels.map(({ i, label }) => (
        <text key={i} x={toX(i)} y={H + PT + 12} fontSize={8.5} style={{ fill: 'var(--ios-label3)' }} textAnchor="middle">{label}</text>
      ))}

      {/* CDP right-axis price labels — de-collided so they never overlap */}
      {cdpSeries && bars.length > 0 && (() => {
        const lastLv = cdpSeries[bars.length - 1]
        if (!lastLv) return null
        const CDP_AXIS = [
          { v: lastLv.ah,  c: 'rgba(255,51,64,0.95)',  s: 'AH' },
          { v: lastLv.nh,  c: 'rgba(255,159,10,0.95)', s: 'NH' },
          { v: lastLv.cdp, c: 'rgba(255,214,10,0.95)', s: 'CDP' },
          { v: lastLv.nl,  c: 'rgba(22,214,126,0.9)',   s: 'NL' },
          { v: lastLv.al,  c: 'rgba(22,214,126,1)',      s: 'AL' },
        ]
        // Filter to visible range and compute positions
        const visible = CDP_AXIS.map(({ v, c, s }) => {
          const y = toY(v); if (y < PT || y > CH + PT) return null
          return { v, c, s, y, adjY: y }
        }).filter(Boolean)
        // De-collision: forward pass (push down), backward pass (pull up)
        const BADGE_H = 11, MIN_GAP = 2
        for (let i = 1; i < visible.length; i++) {
          const minY = visible[i - 1].adjY + BADGE_H + MIN_GAP
          if (visible[i].adjY < minY) visible[i].adjY = minY
        }
        for (let i = visible.length - 2; i >= 0; i--) {
          const maxY = visible[i + 1].adjY - BADGE_H - MIN_GAP
          if (visible[i].adjY > maxY) visible[i].adjY = Math.min(visible[i].adjY, maxY)
        }
        return visible.map(({ v, c, s, y, adjY }) => {
          const priceStr = v >= 100 ? v.toFixed(1) : v.toFixed(2)
          const displaced = Math.abs(adjY - y) > 1.5
          return (
            <g key={s}>
              <line x1={W - PR} y1={y} x2={W - PR + 4} y2={y} stroke={c} strokeWidth={1.2} />
              {displaced && <line x1={W - PR + 4} y1={y} x2={W - PR + 5} y2={adjY} stroke={c} strokeWidth={0.5} strokeDasharray="2,1.5" opacity={0.55} />}
              <rect x={W - PR + 4} y={adjY - 8} width={42} height={16} fill={c} rx={3} opacity={0.9} />
              <text x={W - PR + 25} y={adjY + 4.5} fontSize={9.5} fill="#1C1C1E" fontWeight="800" textAnchor="middle">{priceStr}</text>
            </g>
          )
        })
      })()}

      {/* MA right-axis price labels — de-collided */}
      {(() => {
        const BADGE_H = 11, MIN_GAP = 2
        const maVisible = (maLines || []).map(ma => {
          const lastVal = ma.values[bars.length - 1]
          if (lastVal == null) return null
          const y = toY(lastVal)
          if (y < PT || y > CH + PT) return null
          return { ma, y, adjY: y }
        }).filter(Boolean)
        for (let i = 1; i < maVisible.length; i++) {
          const minY = maVisible[i - 1].adjY + BADGE_H + MIN_GAP
          if (maVisible[i].adjY < minY) maVisible[i].adjY = minY
        }
        for (let i = maVisible.length - 2; i >= 0; i--) {
          const maxY = maVisible[i + 1].adjY - BADGE_H - MIN_GAP
          if (maVisible[i].adjY > maxY) maVisible[i].adjY = Math.min(maVisible[i].adjY, maxY)
        }
        return maVisible.map(({ ma, y, adjY }) => {
          const priceStr = ma.values[bars.length - 1] >= 100 ? ma.values[bars.length - 1].toFixed(0) : ma.values[bars.length - 1].toFixed(1)
          const displaced = Math.abs(adjY - y) > 1.5
          return (
            <g key={ma.label}>
              <line x1={W - PR} y1={y} x2={W - PR + 4} y2={y} stroke={ma.color} strokeWidth={1.0} />
              {displaced && <line x1={W - PR + 4} y1={y} x2={W - PR + 5} y2={adjY} stroke={ma.color} strokeWidth={0.5} strokeDasharray="2,1.5" opacity={0.55} />}
              <rect x={W - PR + 4} y={adjY - 8} width={42} height={16} fill={ma.color} rx={3} opacity={0.9} />
              <text x={W - PR + 25} y={adjY + 4.5} fontSize={9.5} fill="#1C1C1E" fontWeight="800" textAnchor="middle">{priceStr}</text>
            </g>
          )
        })
      })()}

      {/* Persistent chart label (top-left) — shows hovered date when crosshair active */}
      <text x={PL + 3} y={PT + 8} fontSize={9} style={{ fill: 'var(--ios-label3)' }} fontWeight="700" letterSpacing="0.3">
        {label || 'K線'}{effHover?.bar?.time ? `  ${effHover.bar.time.slice(5)}` : ''}
      </text>

      {/* Tooltip */}
      {effHover && (() => {
        const b = effHover.bar
        const closeColor = candleColor(b.open, b.close)
        const slimOnly = b.open == null  // slim stock — only close is available
        const fmtP = v => v != null ? v.toFixed(v >= 100 ? 1 : 2) : '—'
        const vol = b.volume != null
          ? (b.volume >= 1000000 ? `${(b.volume / 1000000).toFixed(1)}M` : `${(b.volume / 1000).toFixed(0)}K`)
          : '—'
        // CDP levels and K-line pattern for hovered bar
        const cdpLv = cdpSeries?.[effHover.idx] ?? null
        const patInfo = patterns?.[effHover.idx] ?? null
        const hasPD = patInfo && PATTERN_DESC[patInfo.name]
        const patOffset = (patInfo && !slimOnly) ? (hasPD ? 26 : 16) : 0
        const baseH = slimOnly ? 42 : tipH
        const fullH = baseH + patOffset + (cdpLv ? 72 : 0)
        const CDP_TIP = cdpLv ? [
          { label: 'AH',  v: cdpLv.ah,  c: 'rgba(255,51,64,0.95)' },
          { label: 'NH',  v: cdpLv.nh,  c: 'rgba(255,159,10,0.95)' },
          { label: 'CDP', v: cdpLv.cdp, c: 'rgba(255,214,10,0.95)' },
          { label: 'NL',  v: cdpLv.nl,  c: 'rgba(22,214,126,0.9)' },
          { label: 'AL',  v: cdpLv.al,  c: 'rgba(22,214,126,1)' },
        ] : []
        return (
          <g>
            <line x1={effHover.x} y1={PT} x2={effHover.x} y2={H + PT} stroke="#0A84FF" strokeWidth={0.6} strokeDasharray="3,3" opacity={0.7} />
            <line x1={PL} y1={toY(b.close)} x2={W - PR} y2={toY(b.close)} stroke="#0A84FF" strokeWidth={0.4} strokeDasharray="2,3" opacity={0.5} />
            <rect x={0} y={toY(b.close) - 7} width={PL - 2} height={13} rx={2} style={{ fill: 'var(--ios-bg3)' }} />
            <text x={PL - 5} y={toY(b.close) + 4} fontSize={8} fill={closeColor} textAnchor="end" fontWeight="bold">
              {fmtP(b.close)}
            </text>
            <rect x={tipX} y={tipY} width={tipW} height={fullH} rx={7} strokeWidth={0.8} style={{ fill: 'var(--ios-bg3)', stroke: 'var(--ios-sep)' }} />
            <text x={tipX + 8} y={tipY + 13} fontSize={9} fontWeight="600" letterSpacing="0.3" style={{ fill: 'var(--ios-label3)' }}>{b.time || ''}</text>
            <line x1={tipX + 5} y1={tipY + 17} x2={tipX + tipW - 5} y2={tipY + 17} strokeWidth={0.5} style={{ stroke: 'var(--ios-sep)' }} />
            {slimOnly ? (
              <>
                <text x={tipX + 8} y={tipY + 32} fontSize={8} style={{ fill: 'var(--ios-label3)' }}>收</text>
                <text x={tipX + tipW - 6} y={tipY + 32} fontSize={9} fill={closeColor} fontWeight="700" textAnchor="end">{fmtP(b.close)}</text>
              </>
            ) : <>
              <text x={tipX + 8} y={tipY + 30} fontSize={8} style={{ fill: 'var(--ios-label3)' }}>開</text>
              <text x={tipX + tipW - 6} y={tipY + 30} fontSize={9} fontWeight="600" textAnchor="end" style={{ fill: 'var(--ios-label)' }}>{fmtP(b.open)}</text>
              <text x={tipX + 8} y={tipY + 43} fontSize={8} style={{ fill: 'var(--ios-label3)' }}>高</text>
              <text x={tipX + tipW - 6} y={tipY + 43} fontSize={9} fill="#FF3340" fontWeight="600" textAnchor="end">{fmtP(b.high)}</text>
              <text x={tipX + 8} y={tipY + 56} fontSize={8} style={{ fill: 'var(--ios-label3)' }}>低</text>
              <text x={tipX + tipW - 6} y={tipY + 56} fontSize={9} fill="#16D67E" fontWeight="600" textAnchor="end">{fmtP(b.low)}</text>
              <text x={tipX + 8} y={tipY + 69} fontSize={8} style={{ fill: 'var(--ios-label3)' }}>收</text>
              <text x={tipX + tipW - 6} y={tipY + 69} fontSize={9} fill={closeColor} fontWeight="700" textAnchor="end">{fmtP(b.close)}</text>
              <text x={tipX + 8} y={tipY + 82} fontSize={8} style={{ fill: 'var(--ios-label3)' }}>量</text>
              <text x={tipX + tipW - 6} y={tipY + 82} fontSize={9} fontWeight="600" textAnchor="end" style={{ fill: 'var(--ios-label2)' }}>{vol}</text>
            </>}
            {patInfo && !slimOnly && (() => {
              const pd = PATTERN_DESC[patInfo.name]
              const patColor = patInfo.type === 'bullish' ? '#16D67E' : patInfo.type === 'bearish' ? '#FF3340' : '#8E8E93'
              return (
                <>
                  <line x1={tipX+5} y1={tipY+tipH} x2={tipX+tipW-5} y2={tipY+tipH} strokeWidth={0.5} style={{ stroke: 'var(--ios-sep)' }} />
                  <text x={tipX+8} y={tipY+tipH+11} fontSize={8} fontWeight="600" style={{ fill: 'var(--ios-label3)' }}>型態</text>
                  <text x={tipX+tipW-6} y={tipY+tipH+11} fontSize={9} fill={patColor} fontWeight="700" textAnchor="end">{patInfo.name}</text>
                  {pd && <text x={tipX+8} y={tipY+tipH+22} fontSize={7.5} fill={patColor} opacity={0.75}>{pd.short}</text>}
                </>
              )
            })()}
            {cdpLv && <>
              <line x1={tipX+5} y1={tipY+baseH+patOffset+2} x2={tipX+tipW-5} y2={tipY+baseH+patOffset+2} strokeWidth={0.5} style={{ stroke: 'var(--ios-sep)' }} />
              {CDP_TIP.map(({ label, v, c }, ri) => (
                <g key={label}>
                  <rect x={tipX+7} y={tipY+baseH+patOffset+6+ri*13} width={16} height={10} fill={`${c}25`} rx={2} />
                  <text x={tipX+15} y={tipY+baseH+patOffset+14+ri*13} fontSize={7.5} fill={c} fontWeight="700" textAnchor="middle">{label}</text>
                  <text x={tipX+tipW-6} y={tipY+baseH+patOffset+14+ri*13} fontSize={9} fill={c} fontWeight="600" textAnchor="end">{fmtP(v)}</text>
                </g>
              ))}
            </>}
          </g>
        )
      })()}

      {/* Measure tool overlay: drag two points to read Δprice / Δ% / bar count */}
      {measureMode && measA != null && measB != null && bars[measA] && bars[measB] && (() => {
        const iA = measA, iB = measB
        const pA = bars[iA].close, pB = bars[iB].close
        if (pA == null || pB == null) return null
        const xA = toX(iA), xB = toX(iB)
        const yA = toY(pA), yB = toY(pB)
        const xLeft = Math.min(xA, xB), xRight = Math.max(xA, xB)
        const diff = pB - pA
        const pct = pA !== 0 ? (diff / pA) * 100 : 0
        const nBars = Math.abs(iB - iA)
        const up = diff >= 0
        const col = up ? '#FF3340' : '#16D67E'
        const fmtP = v => v.toFixed(Math.abs(v) >= 100 ? 1 : 2)
        // Range high/low within the selected window for a richer readout
        const wLo = Math.min(iA, iB), wHi = Math.max(iA, iB)
        let hiP = -Infinity, loP = Infinity
        for (let i = wLo; i <= wHi; i++) {
          const h = bars[i].high ?? bars[i].close, l = bars[i].low ?? bars[i].close
          if (h != null && h > hiP) hiP = h
          if (l != null && l < loP) loP = l
        }
        const ampPct = loP > 0 ? ((hiP - loP) / loP) * 100 : 0
        const boxW = 92, boxH = 50
        let bx = (xLeft + xRight) / 2 - boxW / 2
        bx = Math.max(PL + 2, Math.min(bx, W - PR - boxW - 2))
        const by = PT + 4
        return (
          <g>
            <rect x={xLeft} y={PT} width={Math.max(xRight - xLeft, 1)} height={CH} fill={col} opacity={0.10} />
            <line x1={xLeft} y1={PT} x2={xLeft} y2={PT + CH} stroke={col} strokeWidth={0.7} strokeDasharray="3,2" opacity={0.6} />
            <line x1={xRight} y1={PT} x2={xRight} y2={PT + CH} stroke={col} strokeWidth={0.7} strokeDasharray="3,2" opacity={0.6} />
            <line x1={xA} y1={yA} x2={xB} y2={yB} stroke={col} strokeWidth={1.3} />
            <circle cx={xA} cy={yA} r={2.6} fill={col} />
            <circle cx={xB} cy={yB} r={2.6} fill={col} />
            <rect x={bx} y={by} width={boxW} height={boxH} rx={6} style={{ fill: 'var(--ios-bg3)', stroke: col }} strokeWidth={0.8} opacity={0.97} />
            <text x={bx + boxW / 2} y={by + 14} fontSize={11} fill={col} fontWeight="800" textAnchor="middle">
              {up ? '▲' : '▼'} {up ? '+' : ''}{pct.toFixed(2)}%
            </text>
            <text x={bx + 7} y={by + 27} fontSize={8} style={{ fill: 'var(--ios-label3)' }}>價差</text>
            <text x={bx + boxW - 7} y={by + 27} fontSize={8.5} fill={col} fontWeight="600" textAnchor="end">{up ? '+' : ''}{fmtP(diff)}</text>
            <text x={bx + 7} y={by + 38} fontSize={8} style={{ fill: 'var(--ios-label3)' }}>K棒</text>
            <text x={bx + boxW - 7} y={by + 38} fontSize={8.5} style={{ fill: 'var(--ios-label)' }} fontWeight="600" textAnchor="end">{nBars} 根</text>
            <text x={bx + 7} y={by + 47} fontSize={8} style={{ fill: 'var(--ios-label3)' }}>振幅</text>
            <text x={bx + boxW - 7} y={by + 47} fontSize={8.5} style={{ fill: 'var(--ios-label2)' }} fontWeight="600" textAnchor="end">{ampPct.toFixed(2)}%</text>
          </g>
        )
      })()}
    </svg>
  )
}

// ── Volume sub-chart ─────────────────────────────────────────────────────────

function VolumeSubChart({ bars, hoveredIdx, onHoverIdx, onLock, locked, chartW: propChartW }) {
  const subTouchRef = useRef(null)
  const H = 58, PT = 4
  const n = bars.length
  const W = propChartW || Math.max(CHART_W, n * BAR_W + CHART_PL + CHART_PR)
  const slotW = (W - CHART_PL - CHART_PR) / n
  const toX = i => CHART_PL + (i + 0.5) * slotW
  const bW = Math.max(slotW * 0.6, 1)
  const maxVol = Math.max(...bars.map(d => d.volume ?? 0), 1)
  const vol20avg = bars.map((_, i) => {
    if (i < 5) return 0
    const w = bars.slice(Math.max(0, i - 20), i).map(b => b.volume ?? 0)
    return w.reduce((a, b) => a + b, 0) / (w.length || 1)
  })
  const idxFromX = (clientX, svgEl) => {
    const rect = svgEl.getBoundingClientRect()
    const svgX = (clientX - rect.left) / rect.width * W
    const idx = Math.floor((svgX - CHART_PL) / slotW)
    return idx >= 0 && idx < n ? idx : null
  }
  const handleMove = (clientX, svgEl) => { if (onHoverIdx) onHoverIdx(idxFromX(clientX, svgEl)) }
  const handleTouchStart = (e) => {
    if (e.touches.length !== 1) { if (subTouchRef.current) clearTimeout(subTouchRef.current.lpTimer); subTouchRef.current = null; return }
    const t = e.touches[0]
    // lockedNow: see CandleSVG — lets a long-press toggle the lock mid-gesture.
    subTouchRef.current = { startX: t.clientX, startY: t.clientY, svgEl: e.currentTarget, moved: false, didLock: false, lockedNow: locked }
    if (onLock) {
      subTouchRef.current.lpTimer = setTimeout(() => {
        if (!subTouchRef.current || subTouchRef.current.moved) return
        subTouchRef.current.didLock = true
        if (subTouchRef.current.lockedNow) { subTouchRef.current.lockedNow = false; onLock(null); onHoverIdx?.(null) }
        else {
          const idx = idxFromX(subTouchRef.current.startX, subTouchRef.current.svgEl)
          if (idx != null) { subTouchRef.current.lockedNow = true; onLock(idx); onHoverIdx?.(idx) }
        }
      }, 420)
    }
  }
  const handleTouchMove = (e) => {
    if (!subTouchRef.current) return
    const t = e.touches[0]
    const dx = Math.abs(t.clientX - subTouchRef.current.startX)
    const dy = Math.abs(t.clientY - subTouchRef.current.startY)
    const moveThresh = subTouchRef.current.lockedNow ? 14 : 6
    if (dx > moveThresh || dy > moveThresh) { subTouchRef.current.moved = true; clearTimeout(subTouchRef.current.lpTimer) }
    if (!subTouchRef.current.lockedNow) return // Not locked: browser scrolls natively
    if (dx > dy && dx > 5) { e.stopPropagation(); handleMove(t.clientX, subTouchRef.current.svgEl) }
  }
  const handleTouchEnd = () => {
    const ref = subTouchRef.current
    subTouchRef.current = null
    if (ref) clearTimeout(ref.lpTimer)
    if (!ref || !ref.lockedNow) onHoverIdx?.(null)
  }
  const maxVolStr = maxVol >= 1e6 ? `${(maxVol / 1e6).toFixed(1)}M` : maxVol >= 1e3 ? `${(maxVol / 1e3).toFixed(0)}K` : maxVol.toFixed(0)
  return (
    <svg
      viewBox={`0 0 ${W} ${H + 4}`}
      style={{ width: W, display: 'block', background: 'var(--ios-bg2)', borderTop: '0.5px solid var(--ios-sep)', marginTop: 2, touchAction: locked ? 'none' : 'pan-x pan-y', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
      onMouseMove={e => handleMove(e.clientX, e.currentTarget)}
      onMouseLeave={() => onHoverIdx?.(null)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <g>
        <rect x={CHART_PL + 1} y={PT} width={28} height={16} rx={4} fill="rgba(255,159,10,0.18)" stroke="rgba(255,159,10,0.35)" strokeWidth={0.6} />
        <rect x={CHART_PL + 1} y={PT} width={3} height={16} rx={2} fill="rgba(255,159,10,0.95)" />
        <text x={CHART_PL + 8} y={PT + 11} fontSize={9.5} fill="#FF9F0A" fontWeight="800" letterSpacing="0.4">VOL</text>
      </g>
      <text x={CHART_PL - 3} y={PT + 8} fontSize={8} style={{ fill: 'var(--ios-label3)' }} textAnchor="end" opacity={0.85}>{maxVolStr}</text>
      {bars.map((d, i) => {
        const x = toX(i)
        const color = candleColor(d.open ?? d.close, d.close)
        const volH = Math.max(((d.volume ?? 0) / maxVol) * (H - PT - 2), 0.5)
        const isVolSpike = vol20avg[i] > 0 && (d.volume ?? 0) > vol20avg[i] * 2
        const isHov = hoveredIdx === i
        const barY = H - volH
        return (
          <g key={i} opacity={hoveredIdx != null && !isHov ? 0.55 : 1}>
            <rect x={x - bW / 2} y={barY} width={bW} height={volH}
              fill={isVolSpike ? '#FFD60A' : color}
              opacity={isHov ? 0.9 : isVolSpike ? 0.8 : 0.5} />
            {isVolSpike && (
              <>
                <line x1={x} y1={barY - 11} x2={x} y2={barY - 5} stroke="#FF9F0A" strokeWidth={1.5} opacity={0.9} />
                <polygon points={`${x},${barY - 5} ${x - 5},${barY - 10} ${x + 5},${barY - 10}`} fill="#FF9F0A" opacity={0.95} />
              </>
            )}
          </g>
        )
      })}
      {/* 5-day average volume line */}
      <polyline
        points={bars.map((_, i) => {
          if (i < 5) return null
          const x = toX(i)
          const avgV = vol20avg[i]
          const y = avgV > 0 ? (H - PT - 2) - (avgV / maxVol) * (H - PT - 2) + PT : H - 2
          return `${x},${y}`
        }).filter(Boolean).join(' ')}
        fill="none"
        stroke="#FF9F0A"
        strokeWidth={1}
        opacity={0.7}
      />
      {hoveredIdx != null && hoveredIdx >= 0 && hoveredIdx < n && (
        <line x1={toX(hoveredIdx)} y1={PT} x2={toX(hoveredIdx)} y2={H} stroke="#0A84FF" strokeWidth={0.6} strokeDasharray="2,2" opacity={0.55} />
      )}
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

  const Chip = ({ label, borderColor, children }) => (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      background: `${borderColor}18`, border: `0.5px solid ${borderColor}45`,
      borderRadius: 7, padding: '2px 6px', flexShrink: 0, whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: 9, color: '#636366', fontWeight: 600, letterSpacing: 0.2 }}>{label}</span>
      {children}
    </span>
  )
  const V = ({ v, c }) => <b style={{ fontSize: 10.5, color: c, fontWeight: 700 }}>{v}</b>

  const hasAny = (active.rsi && rsi != null) || (active.macd && macdL != null) ||
    (active.kd && k != null) || (active.adx && adx != null) || (active.wr && wr != null) ||
    (active.cci && cci != null) || (active.mfi && mfi != null)
  if (!hasAny) return null

  return (
    <div style={{
      display: 'flex', gap: 4, padding: '4px 0 3px',
      overflowX: 'auto', WebkitOverflowScrolling: 'touch',
      alignItems: 'center', borderBottom: '0.5px solid var(--ios-sep)',
      marginBottom: 1, scrollbarWidth: 'none', msOverflowStyle: 'none',
    }}>
      <span style={{ fontSize: 9, color: '#48484A', minWidth: 34, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
        {hoveredIdx != null ? (bar.time ? bar.time.slice(5) : '') : '最新'}
      </span>

      {active.rsi && rsi != null && (() => {
        const c = rsi > 70 ? '#FF3340' : rsi < 30 ? '#16D67E' : '#BF5AF2'
        return <Chip label="RSI" borderColor={c}><V v={vn(rsi)} c={c} /></Chip>
      })()}

      {active.macd && macdL != null && (
        <Chip label="MACD" borderColor="#0A84FF">
          <V v={vn(macdL, 2)} c="#0A84FF" />
          {macdH != null && <span style={{ fontSize: 9.5, color: macdH >= 0 ? '#FF3340' : '#16D67E', fontWeight: 700, marginLeft: 1 }}>{macdH >= 0 ? '▲' : '▼'}{Math.abs(macdH) < 0.01 ? macdH.toFixed(3) : vn(macdH, 2)}</span>}
        </Chip>
      )}

      {active.kd && k != null && (
        <Chip label="KD" borderColor="#FF9F0A">
          <span style={{ fontSize: 9, color: '#636366' }}>K</span><V v={vn(k)} c="#FF9F0A" />
          <span style={{ fontSize: 9, color: '#636366' }}>D</span><V v={vn(d)} c="#0A84FF" />
        </Chip>
      )}

      {active.adx && adx != null && (() => {
        const c = adx > 25 ? '#FF3340' : '#FF6B35'
        return (
          <Chip label="ADX" borderColor={c}>
            <V v={vn(adx)} c={c} />
            {pdi != null && <><span style={{ fontSize: 9, color: '#16D67E', fontWeight: 700 }}>+{vn(pdi, 0)}</span><span style={{ fontSize: 9, color: '#FF6B35', fontWeight: 700 }}>-{vn(ndi, 0)}</span></>}
          </Chip>
        )
      })()}

      {active.wr && wr != null && (() => {
        const c = wr > -20 ? '#FF3340' : wr < -80 ? '#16D67E' : '#FF6B35'
        return <Chip label="W%R" borderColor={c}><V v={vn(wr)} c={c} /></Chip>
      })()}

      {active.cci && cci != null && (() => {
        const c = cci > 100 ? '#FF3340' : cci < -100 ? '#16D67E' : '#5E5CE6'
        return <Chip label="CCI" borderColor={c}><V v={vn(cci, 0)} c={c} /></Chip>
      })()}

      {active.mfi && mfi != null && (() => {
        const c = mfi > 80 ? '#FF3340' : mfi < 20 ? '#16D67E' : '#FFD60A'
        return <Chip label="MFI" borderColor={c}><V v={vn(mfi)} c={c} /></Chip>
      })()}
    </div>
  )
}

// ── KLineChart: orchestrates candlestick + all sub-charts ────────────────────

const MA_LINES_DEF = [
  { label: 'MA5',   color: '#5AC8FA', fn: c => smaCalc(c, 5),  },
  { label: 'MA10',  color: '#FF9F0A', fn: c => smaCalc(c, 10), },
  { label: 'EMA20', color: '#BF5AF2', fn: c => emaCalc(c, 20), },
  { label: 'MA60',  color: '#FFD60A', fn: c => emaCalc(c, 60), },
]

const STRATEGY_PRESETS = [
  { id: 'all',        label: '全部', color: '#8E8E93', desc: '同時顯示全部 10 項指標，一覽無遺',
    state: { ma: true,  bb: true,  macd: true,  rsi: true,  kd: true,  obv: true,  adx: true,  wr: true,  cci: true,  mfi: true  } },
  { id: 'momentum',   label: '動能', color: '#FF9F0A', desc: 'MACD 翻紅 + RSI 站上 50 才進場，追強勢續攻',
    state: { ma: true,  bb: false, macd: true,  rsi: true,  kd: false, obv: false, adx: false, wr: false, cci: false, mfi: false } },
  { id: 'oscillator', label: '震盪', color: '#16D67E', desc: 'KD 低檔金叉 + W%R/CCI 超賣回升，抓區間反彈',
    state: { ma: false, bb: true,  macd: false, rsi: false, kd: true,  obv: false, adx: false, wr: true,  cci: true,  mfi: false } },
  { id: 'trend',      label: '趨勢', color: '#0A84FF', desc: 'ADX>25 且 +DI>-DI 站上均線，順勢波段',
    state: { ma: true,  bb: true,  macd: false, rsi: false, kd: false, obv: false, adx: true,  wr: false, cci: false, mfi: false } },
  { id: 'chips',      label: '籌碼', color: '#64D2FF', desc: 'OBV 突破均量 + MFI 資金流入，跟量能',
    state: { ma: true,  bb: false, macd: false, rsi: false, kd: false, obv: true,  adx: false, wr: false, cci: false, mfi: true  } },
]

const TOGGLE_DEFS = [
  { key: 'ma',   label: 'MA',   color: '#5AC8FA', title: '移動平均線 (MA5/10/20/60)：追蹤趨勢方向，多頭排列=看漲' },
  { key: 'bb',   label: 'BB',   color: '#0A84FF', title: '布林通道 (BB)：上軌壓力/下軌支撐，突破上軌=強勢，跌破下軌=弱勢' },
  { key: 'cdp',  label: 'CDP',  color: '#FFD60A', title: '逆勢操作 (CDP)：AH/NH 為當日壓力，NL/AL 為當日支撐' },
  { key: 'fib',  label: 'Fib',  color: '#FF9F0A', title: '費波那契回撤：0%高點/100%低點，38.2%/61.8%是常見支撐壓力' },
  { key: 'pat',  label: '型態', color: '#BF5AF2', title: 'K 線型態：錘子/吞噬/十字星等反轉型態，滑動時顯示（開啟後見下方說明）' },
  { key: 'macd', label: 'MACD', color: '#FF9F0A', title: 'MACD(12,26,9)：柱子翻紅=多頭動能增強，金叉(藍穿紅上)=買進訊號' },
  { key: 'rsi',  label: 'RSI',  color: '#BF5AF2', title: 'RSI(14)：>70 超買警示，<30 超賣反彈機會，50 以上偏多' },
  { key: 'kd',   label: 'KD',   color: '#16D67E', title: 'KD(9)：低檔金叉(K穿D上)買進訊號，高檔死叉賣出訊號' },
  { key: 'obv',  label: 'OBV',  color: '#64D2FF', title: 'OBV 能量潮：OBV 隨價上升=量價配合，OBV 背離=潛在反轉' },
  { key: 'adx',  label: 'ADX',  color: '#FF3340', title: 'ADX/DMI(14)：ADX>25 趨勢強，+DI>-DI 多頭趨勢，反之空頭' },
  { key: 'wr',   label: 'W%R',  color: '#FF6B35', title: 'Williams %R(14)：>-20 超買，<-80 超賣，由超賣回升=買進機會' },
  { key: 'cci',  label: 'CCI',  color: '#5E5CE6', title: 'CCI(20)：>+100 超買，<-100 超賣，穿越±100 往往是趨勢啟動點' },
  { key: 'mfi',  label: 'MFI',  color: '#FFD60A', title: 'MFI(14) 資金流量指標：>80 超買，<20 超賣，結合量能判斷主力動向' },
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
    { id: 'oscillator', label: '震盪', color: '#16D67E',
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
  const containerRef = useRef(null)
  useGSAP(() => {
    if (!containerRef.current) return
    gsap.from('.winrate-bar-fill', {
      scaleX: 0, transformOrigin: 'left center', duration: 0.5,
      stagger: 0.07, ease: 'power2.out', delay: 0.1,
    })
  }, { scope: containerRef, dependencies: [horizon, bt?.best] })
  if (!bt) return null
  return (
    <div ref={containerRef} style={{ marginTop: 10, background: 'var(--ios-bg2)', borderRadius: 12, padding: '10px 12px', boxShadow: 'var(--shadow-card)' }}>
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
              <div className="winrate-bar-fill" style={{ width: `${enough ? r.winRate * 100 : 0}%`, height: '100%', background: r.color, opacity: isBest ? 1 : 0.55, borderRadius: 3, transition: 'width 0.3s' }} />
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

const PARAM_DEFAULTS = { rsiPeriod: 14, kdN: 9, kdM: 3, macdFast: 12, macdSlow: 26, macdSig: 9, bbPeriod: 20, bbMult: 2.0 }

function KLineChart({ stockId, priceHistory, priceHistoryWk, priceHistoryMo, loading, compareId, compareHistories, historyDates }) {
  const cnyesUrl = `https://www.cnyes.com/twstock/${stockId}`
  const wantgooUrl = `https://www.wantgoo.com/stock/${stockId}`

  const daily   = Array.isArray(priceHistory) ? priceHistory : []
  const weekly  = (Array.isArray(priceHistoryWk) && priceHistoryWk.length >= 2) ? priceHistoryWk : resampleBars(daily, 'week')
  const monthly = (Array.isArray(priceHistoryMo) && priceHistoryMo.length >= 2) ? priceHistoryMo : resampleBars(daily, 'month')
  const dataMap = { '1d': daily, '1wk': weekly, '1mo': monthly }

  const [chartInterval, setChartInterval] = useState(
    () => INTERVAL_LABELS.find(t => dataMap[t.id].length >= 2)?.id || '1d'
  )
  const [active, setActive] = useState({ ma: true, bb: false, cdp: false, fib: false, pat: false, macd: true, rsi: true, kd: false, obv: false, adx: false, wr: false, cci: false, mfi: false })
  const [preset, setPreset] = useState('momentum')
  const [hoveredIdx, setHoveredIdx] = useState(null)
  const [lockedIdx, setLockedIdx] = useState(null)
  const [logScale, setLogScale] = useState(false)
  const [measureMode, setMeasureMode] = useState(false)
  const [barCount, setBarCount] = useState(250)
  const [params, setParams] = useState(() => {
    try { return { ...PARAM_DEFAULTS, ...JSON.parse(localStorage.getItem('indicatorParams') || '{}') } }
    catch { return PARAM_DEFAULTS }
  })
  const updateParam = (key, raw) => {
    const val = parseFloat(raw)
    if (isNaN(val) || val <= 0) return
    setParams(prev => {
      const next = { ...prev, [key]: key === 'bbMult' ? val : Math.round(val) }
      try { localStorage.setItem('indicatorParams', JSON.stringify(next)) } catch {}
      return next
    })
  }
  const [showParams, setShowParams] = useState(false)

  // Long-press locks the crosshair: after the finger lifts, the crosshair +
  // detail stay pinned to that bar. Live drag (hoveredIdx) overrides it; tapping
  // an empty spot clears the lock.
  const displayIdx = hoveredIdx != null ? hoveredIdx : lockedIdx
  const handleLock = useCallback((idx) => setLockedIdx(idx), [])
  const scrollRef = useRef(null)
  const pinchRef = useRef(null)
  const barCountRef = useRef(250)
  const maxBarsRef = useRef(0)

  // Auto-reset barCount when interval changes so warm-up bars are available
  useEffect(() => {
    const defaults = { '1wk': 60, '1mo': 24 }
    setBarCount(defaults[chartInterval] || 250)
    setLockedIdx(null)
    setMeasureMode(false)
  }, [chartInterval])

  const toggle = key => { setActive(prev => ({ ...prev, [key]: !prev[key] })); setPreset(null) }
  const applyPreset = p => { setActive(p.state); setPreset(p.id) }

  const _allBars = dataMap[chartInterval] || []
  const bars = useMemo(() => _allBars.slice(-barCount), [_allBars, barCount])
  const totalBarsAvail = _allBars.length

  const totalChartW = Math.max(CHART_W, bars.length * BAR_W + CHART_PL + CHART_PR)

  useEffect(() => { barCountRef.current = barCount }, [barCount])
  useEffect(() => { maxBarsRef.current = totalBarsAvail }, [totalBarsAvail])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Immediate + RAF to cover both sync and async DOM paint timings
    el.scrollLeft = el.scrollWidth
    const raf = requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth })
    return () => cancelAnimationFrame(raf)
  }, [bars.length, chartInterval, barCount])

  // Pinch-to-zoom: adjust barCount with 2-finger pinch
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onStart = (e) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX
        const dy = e.touches[0].clientY - e.touches[1].clientY
        pinchRef.current = { dist: Math.hypot(dx, dy), count: barCountRef.current }
      } else {
        pinchRef.current = null
      }
    }
    const onMove = (e) => {
      if (e.touches.length !== 2 || !pinchRef.current) return
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const scale = pinchRef.current.dist / Math.hypot(dx, dy)
      const max = maxBarsRef.current || 9999
      setBarCount(Math.round(Math.min(max, Math.max(20, pinchRef.current.count * scale))))
    }
    const onEnd = () => { pinchRef.current = null }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
    }
  }, [])

  const indicators = useMemo(() => {
    if (bars.length < 2) return null

    // For weekly/monthly: compute oscillators on the full daily series, then remap each
    // period bar to the last daily value within that period. This eliminates the warm-up gap
    // (MACD needs 35+ bars; daily gives thousands).
    if (chartInterval !== '1d' && daily.length >= 2 && bars[0]?.time) {
      // Two-pointer: for each period bar, find the last daily bar within [bar.time, nextBar.time).
      // Works regardless of what date pre-built weekly/monthly bars use as their time key.
      const remap = arr => {
        let di = 0
        const result = new Array(bars.length).fill(null)
        for (let bi = 0; bi < bars.length; bi++) {
          const nextTime = bi + 1 < bars.length ? bars[bi + 1].time : '9999-12-31'
          let lastDi = -1
          while (di < daily.length && daily[di].time < nextTime) {
            if (daily[di].time >= bars[bi].time) lastDi = di
            di++
          }
          result[bi] = lastDi >= 0 ? arr[lastDi] : null
        }
        return result
      }

      // Compute oscillators on full daily data (warm-up is free)
      const dc = daily.map(d => d.close)
      const dBB   = bollingerCalc(dc, 20, 2)
      const dMACD = macdCalc(dc)
      const dRSI  = rsiCalc(dc)
      const dKD   = kdCalc(daily)
      const dOBV  = obvCalc(daily)
      const dADX  = adxCalc(daily)
      const dWR   = williamsRCalc(daily)
      const dCCI  = cciCalc(daily)
      const dMFI  = mfiCalc(daily)

      // MA/EMA on resampled closes — use full available resampled history as warmup
      const allRC = _allBars.map(d => d.close)
      const maOff = _allBars.length - bars.length
      const slMA  = arr => arr.slice(maOff)

      const remOBV = remap(dOBV)

      return {
        maLines: MA_LINES_DEF.map(m => ({ ...m, values: slMA(m.fn(allRC)) })),
        bbBands: {
          upper: remap(dBB.map(v => v?.upper ?? null)),
          mid:   remap(dBB.map(v => v?.mid   ?? null)),
          lower: remap(dBB.map(v => v?.lower ?? null)),
        },
        macd: { macdLine: remap(dMACD.macdLine), signalLine: remap(dMACD.signalLine), hist: remap(dMACD.hist) },
        rsi:  remap(dRSI),
        kd:   { kArr: remap(dKD.kArr), dArr: remap(dKD.dArr) },
        obv:  { values: remOBV, ma: smaCalc(remOBV, 20) },
        adx:  { adxLine: remap(dADX.adxLine), plusDI: remap(dADX.plusDI), minusDI: remap(dADX.minusDI) },
        wr:   remap(dWR),
        cci:  remap(dCCI),
        mfi:  remap(dMFI),
        cdpSeries: bars.map((_, i) => {
          const p = i === 0 ? null : bars[i - 1]
          if (!p || p.high == null || p.low == null || p.close == null) return null
          const c = (p.high + p.low + p.close * 2) / 4
          const r = p.high - p.low
          return { ah: c + r, nh: 2 * c - p.low, cdp: c, nl: 2 * c - p.high, al: c - r }
        }),
      }
    }

    // Daily view: use ALL available bars as warm-up so indicators converge from bar 0.
    const warmBars = _allBars
    const off = warmBars.length - bars.length
    const closes = warmBars.map(d => d.close)
    const sl = arr => arr.slice(off)

    const bb = bollingerCalc(closes, params.bbPeriod, params.bbMult)
    const { macdLine, signalLine, hist } = macdCalc(closes, params.macdFast, params.macdSlow, params.macdSig)
    const kdResult = kdCalc(warmBars, params.kdN, params.kdM)
    const obvWarm = obvCalc(warmBars)
    const adxResult = adxCalc(warmBars)
    const bbSl = sl(bb)

    return {
      maLines: MA_LINES_DEF.map(m => ({ ...m, values: sl(m.fn(closes)) })),
      bbBands: {
        upper: bbSl.map(v => v?.upper ?? null),
        mid:   bbSl.map(v => v?.mid   ?? null),
        lower: bbSl.map(v => v?.lower ?? null),
      },
      macd: { macdLine: sl(macdLine), signalLine: sl(signalLine), hist: sl(hist) },
      rsi:  sl(rsiCalc(closes, params.rsiPeriod)),
      kd:   { kArr: sl(kdResult.kArr), dArr: sl(kdResult.dArr) },
      obv:  (() => { const v = sl(obvWarm); return { values: v, ma: smaCalc(v, 20) } })(),
      adx:  { adxLine: sl(adxResult.adxLine), plusDI: sl(adxResult.plusDI), minusDI: sl(adxResult.minusDI) },
      wr:   sl(williamsRCalc(warmBars)),
      cci:  sl(cciCalc(warmBars)),
      mfi:  sl(mfiCalc(warmBars)),
      cdpSeries: bars.map((_, i) => {
        const p = i === 0 ? (off > 0 ? warmBars[off - 1] : null) : bars[i - 1]
        if (!p || p.high == null || p.low == null || p.close == null) return null
        const c = (p.high + p.low + p.close * 2) / 4
        const r = p.high - p.low
        return { ah: c + r, nh: 2 * c - p.low, cdp: c, nl: 2 * c - p.high, al: c - r }
      }),
    }
  }, [bars, _allBars, chartInterval, daily, params])

  const unitLabel = { '1d': '個交易日', '1wk': '週', '1mo': '個月' }

  return (
    <div>
      {/* Indicator param settings */}
      <div style={{ marginBottom: 6 }}>
        <button onClick={() => setShowParams(v => !v)} style={{
          fontSize: 10, color: showParams ? 'var(--ios-blue)' : 'var(--ios-label3)',
          background: showParams ? 'rgba(10,132,255,0.1)' : 'var(--ios-fill4)',
          border: 'none', borderRadius: 6, padding: '3px 9px', cursor: 'pointer',
          fontWeight: showParams ? 700 : 400, transition: 'all 0.15s',
        }}>⚙ 指標係數</button>
        {showParams && (
          <div style={{ marginTop: 6, padding: '10px 12px', background: 'var(--ios-bg2)', borderRadius: 10, border: '0.5px solid var(--ios-sep)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px 16px' }}>
              {[
                ['RSI 週期', 'rsiPeriod', params.rsiPeriod],
                ['KD 週期 (N)', 'kdN', params.kdN],
                ['KD 平滑 (M)', 'kdM', params.kdM],
                ['MACD 快線', 'macdFast', params.macdFast],
                ['MACD 慢線', 'macdSlow', params.macdSlow],
                ['MACD 信號', 'macdSig', params.macdSig],
                ['BB 週期', 'bbPeriod', params.bbPeriod],
                ['BB 倍數', 'bbMult', params.bbMult],
              ].map(([lbl, key, val]) => (
                <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 9, color: 'var(--ios-label3)', fontWeight: 600 }}>{lbl}</span>
                  <input type="number" defaultValue={val} min={1} step={key === 'bbMult' ? 0.1 : 1}
                    onBlur={e => updateParam(key, e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && updateParam(key, e.target.value)}
                    style={{ width: '100%', padding: '4px 6px', fontSize: 12, borderRadius: 6, border: '0.5px solid var(--ios-sep)', background: 'var(--ios-fill4)', color: 'var(--ios-label)', outline: 'none', boxSizing: 'border-box' }} />
                </label>
              ))}
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button onClick={() => { setParams(PARAM_DEFAULTS); try { localStorage.setItem('indicatorParams', JSON.stringify(PARAM_DEFAULTS)) } catch {} }} style={{ fontSize: 10, color: 'var(--ios-label3)', background: 'var(--ios-fill4)', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>重設預設值</button>
            </div>
          </div>
        )}
      </div>

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
      <div style={{ display: 'flex', gap: 5, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
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
            const isActive = barCount === n
            const avail = n === 9999 ? totalBarsAvail >= 2 : totalBarsAvail >= n
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
        {/* Zoom +/- buttons */}
        <div style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--ios-fill4)', borderRadius: 8 }}>
          {[{ label: '－', dir: 1 }, { label: '＋', dir: -1 }].map(({ label, dir }) => (
            <button key={label} onClick={() => {
              const step = Math.max(10, Math.round(barCount * 0.25))
              const max = totalBarsAvail || 9999
              setBarCount(c => Math.min(max, Math.max(20, c + dir * step)))
            }} title={dir > 0 ? '縮小（顯示更多K線）' : '放大（顯示更少K線）'} style={{
              background: 'transparent', border: 'none', color: 'var(--ios-label2)',
              borderRadius: 6, padding: '4px 10px', fontSize: 14, cursor: 'pointer',
              fontWeight: 600, lineHeight: 1,
            }}>{label}</button>
          ))}
        </div>
        {/* Log scale + Measure tool */}
        <div style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--ios-fill4)', borderRadius: 8 }}>
          <button onClick={() => setLogScale(v => !v)} title="對數座標：等比例%漲跌占相同高度，適合長期報酬比較" style={{
            background: logScale ? 'var(--ios-bg3)' : 'transparent', border: 'none',
            color: logScale ? 'var(--ios-blue)' : 'var(--ios-label3)',
            borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontWeight: logScale ? 700 : 400,
            boxShadow: logScale ? '0 1px 4px rgba(0,0,0,0.3)' : 'none', transition: 'all 0.15s',
          }}>對數</button>
          <button onClick={() => { setMeasureMode(v => !v); setLockedIdx(null) }} title="量測工具：在圖上拖曳兩點，顯示漲跌幅%、價差、K棒數" style={{
            background: measureMode ? 'var(--ios-bg3)' : 'transparent', border: 'none',
            color: measureMode ? '#FF9F0A' : 'var(--ios-label3)',
            borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontWeight: measureMode ? 700 : 400,
            boxShadow: measureMode ? '0 1px 4px rgba(0,0,0,0.3)' : 'none', transition: 'all 0.15s',
          }}>量測</button>
        </div>
      </div>

      {/* Indicator toggles — two grouped rows */}
      <div style={{ display: 'flex', gap: 3, marginBottom: 6, alignItems: 'center', overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
        <span style={{ fontSize: 8.5, color: '#48484A', fontWeight: 600, flexShrink: 0, marginRight: 1, letterSpacing: 0.3 }}>疊加</span>
        {TOGGLE_DEFS.slice(0, 5).map(({ key, label, color, title }) => (
          <button key={key} onClick={() => toggle(key)} title={title} style={{
            background: active[key] ? `${color}22` : 'var(--ios-fill4)',
            color: active[key] ? color : 'var(--ios-label3)',
            border: `0.5px solid ${active[key] ? color + '80' : 'transparent'}`,
            borderRadius: 6, padding: '3px 9px', fontSize: 11, cursor: 'pointer', fontWeight: active[key] ? 700 : 500,
            transition: 'all 0.15s', flexShrink: 0,
          }}>{label}</button>
        ))}
        <div style={{ width: 1, height: 14, background: 'var(--ios-sep)', flexShrink: 0, margin: '0 3px' }} />
        <span style={{ fontSize: 8.5, color: '#48484A', fontWeight: 600, flexShrink: 0, marginRight: 1, letterSpacing: 0.3 }}>副圖</span>
        {TOGGLE_DEFS.slice(5).map(({ key, label, color, title }) => (
          <button key={key} onClick={() => toggle(key)} title={title} style={{
            background: active[key] ? `${color}22` : 'var(--ios-fill4)',
            color: active[key] ? color : 'var(--ios-label3)',
            border: `0.5px solid ${active[key] ? color + '80' : 'transparent'}`,
            borderRadius: 6, padding: '3px 9px', fontSize: 11, cursor: 'pointer', fontWeight: active[key] ? 700 : 500,
            transition: 'all 0.15s', flexShrink: 0,
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
          {active.cdp && <span style={{ fontSize: 10, fontWeight: 600, display: 'flex', gap: 6 }}>
            <span style={{ color: 'rgba(255,51,64,0.9)' }}>AH</span>
            <span style={{ color: 'rgba(255,159,10,0.9)' }}>NH</span>
            <span style={{ color: 'rgba(255,214,10,0.95)' }}>CDP</span>
            <span style={{ color: 'rgba(22,214,126,0.9)' }}>NL</span>
            <span style={{ color: 'rgba(22,214,126,1)' }}>AL</span>
          </span>}
        </div>
      )}

      {/* Lock status hint */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4, minHeight: 14 }}>
        {measureMode ? (
          <span style={{ fontSize: 9.5, color: '#FF9F0A', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            📏 量測模式 · 在圖上拖曳兩點看漲跌幅 · 再按「量測」結束
          </span>
        ) : lockedIdx != null ? (
          <span style={{ fontSize: 9.5, color: '#FFD60A', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            🔒 已鎖定 {bars[lockedIdx]?.time ? bars[lockedIdx].time.slice(5) : ''} · 再長按圖表解除鎖定
          </span>
        ) : (
          <span style={{ fontSize: 9, color: 'var(--ios-label4)', opacity: 0.7 }}>長按圖表可鎖定十字線 · 雙指縮放 · 左右滑看更早</span>
        )}
      </div>

      {/* Scrollable chart area — locked = freeze scroll so crosshair is the only interaction */}
      <div ref={scrollRef} style={{ overflowX: (lockedIdx != null || measureMode) ? 'hidden' : 'auto', WebkitOverflowScrolling: 'touch', borderRadius: 10, marginBottom: 2 }}>
        {/* Main candlestick chart */}
        {bars.length >= 2 ? (
          <CandleSVG
            data={bars}
            maLines={active.ma && indicators ? indicators.maLines : []}
            bbBands={active.bb && indicators ? indicators.bbBands : null}
            cdpSeries={active.cdp && indicators ? indicators.cdpSeries : null}
            showFib={active.fib}
            showPatterns={active.pat}
            onHoverIdx={setHoveredIdx}
            hoveredIdx={displayIdx}
            onLock={handleLock}
            locked={lockedIdx != null}
            logScale={logScale}
            measureMode={measureMode}
            label={`K線 · ${INTERVAL_LABELS.find(t => t.id === chartInterval)?.label || ''}`}
            chartW={totalChartW}
            compareId={compareId}
            compareHistories={compareHistories}
            historyDates={historyDates}
          />
        ) : (
          <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ios-label3)', fontSize: 12, background: 'var(--ios-bg)', borderRadius: 10, flexDirection: 'column', gap: 8 }}>
            {loading ? (
              <>
                <div style={{ width: 22, height: 22, border: '2.5px solid var(--ios-fill2)', borderTopColor: 'var(--ios-blue)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                <span>載入 K 線中…</span>
                <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
              </>
            ) : '暫無歷史 K 線資料'}
          </div>
        )}

        {/* Volume sub-chart */}
        {bars.length >= 2 && (
          <VolumeSubChart
            bars={bars}
            hoveredIdx={displayIdx}
            onHoverIdx={setHoveredIdx}
            onLock={handleLock}
            locked={lockedIdx != null}
            chartW={totalChartW}
          />
        )}

        {/* MACD sub-chart */}
        {active.macd && indicators && bars.length >= 26 && (
          <SubChartSVG
            bars={bars}
            label={`MACD(${params.macdFast},${params.macdSlow},${params.macdSig})`}
            histSeries={{ values: indicators.macd.hist }}
            lines={[
              { color: '#0A84FF', label: 'MACD', values: indicators.macd.macdLine, width: 1 },
              { color: '#FF3340', label: 'Signal', values: indicators.macd.signalLine, width: 1 },
            ]}
            hBands={[{ value: 0, color: '#48484A', label: '' }]}
            hoveredIdx={displayIdx}
            onHoverIdx={setHoveredIdx}
            onLock={handleLock}
            locked={lockedIdx != null}
            chartW={totalChartW}
          />
        )}

        {/* RSI sub-chart */}
        {active.rsi && indicators && bars.length >= 15 && (
          <SubChartSVG
            bars={bars}
            label={`RSI(${params.rsiPeriod})`}
            lines={[{ color: '#BF5AF2', label: 'RSI', values: indicators.rsi, width: 1.2 }]}
            hBands={[
              { value: 70, color: '#FF3340', label: '70' },
              { value: 50, color: '#48484A', label: '50' },
              { value: 30, color: '#16D67E', label: '30' },
            ]}
            hoveredIdx={displayIdx}
            onHoverIdx={setHoveredIdx}
            onLock={handleLock}
            locked={lockedIdx != null}
            yFixed={[0, 100]}
            chartW={totalChartW}
          />
        )}

        {/* KD sub-chart */}
        {active.kd && indicators && bars.length >= 9 && (
          <SubChartSVG
            bars={bars}
            label={`KD(${params.kdN},${params.kdM})`}
            lines={[
              { color: '#FF9F0A', label: 'K', values: indicators.kd.kArr, width: 1 },
              { color: '#0A84FF', label: 'D', values: indicators.kd.dArr, width: 1 },
            ]}
            hBands={[
              { value: 80, color: '#FF3340', label: '80' },
              { value: 20, color: '#16D67E', label: '20' },
            ]}
            hoveredIdx={displayIdx}
            onHoverIdx={setHoveredIdx}
            onLock={handleLock}
            locked={lockedIdx != null}
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
            hoveredIdx={displayIdx}
            onHoverIdx={setHoveredIdx}
            onLock={handleLock}
            locked={lockedIdx != null}
            chartW={totalChartW}
          />
        )}

        {/* ADX / DMI sub-chart */}
        {active.adx && indicators && bars.length >= 28 && (
          <SubChartSVG
            bars={bars}
            label="ADX(14) / DMI"
            lines={[
              { color: '#FF3340', label: 'ADX',  values: indicators.adx.adxLine,  width: 1.5 },
              { color: '#16D67E', label: '+DI',  values: indicators.adx.plusDI,   width: 1,   opacity: 0.85 },
              { color: '#FF6B35', label: '-DI',  values: indicators.adx.minusDI,  width: 1,   opacity: 0.85 },
            ]}
            hBands={[{ value: 25, color: '#FFD60A', label: '25' }]}
            hoveredIdx={displayIdx}
            onHoverIdx={setHoveredIdx}
            onLock={handleLock}
            locked={lockedIdx != null}
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
              { value: -20, color: '#FF3340', label: '-20' },
              { value: -50, color: '#48484A', label: '-50' },
              { value: -80, color: '#16D67E', label: '-80' },
            ]}
            hoveredIdx={displayIdx}
            onHoverIdx={setHoveredIdx}
            onLock={handleLock}
            locked={lockedIdx != null}
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
              { value: 100,  color: '#FF3340', label: '+100' },
              { value: 0,    color: '#48484A', label: '0' },
              { value: -100, color: '#16D67E', label: '-100' },
            ]}
            hoveredIdx={displayIdx}
            onHoverIdx={setHoveredIdx}
            onLock={handleLock}
            locked={lockedIdx != null}
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
              { value: 80, color: '#FF3340', label: '80' },
              { value: 50, color: '#48484A', label: '50' },
              { value: 20, color: '#16D67E', label: '20' },
            ]}
            hoveredIdx={displayIdx}
            onHoverIdx={setHoveredIdx}
            onLock={handleLock}
            locked={lockedIdx != null}
            yFixed={[0, 100]}
            chartW={totalChartW}
          />
        )}
      </div>

      {/* K-line pattern legend — appears when pattern mode is on */}
      {active.pat && (
        <div style={{ margin: '8px 0 4px', padding: '10px 12px', background: 'var(--ios-bg2)', borderRadius: 10, border: '0.5px solid var(--ios-sep)' }}>
          <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 7, fontWeight: 600, letterSpacing: 0.3 }}>K 線型態說明（滑動時浮現）</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 10px' }}>
            {Object.entries(PATTERN_DESC).map(([name, { short, hint }]) => {
              const type = name === '十字星' ? 'neutral' : (name.includes('多頭') || name.includes('錘子') || name.includes('倒錘')) ? 'bullish' : 'bearish'
              const color = type === 'bullish' ? '#16D67E' : type === 'bearish' ? '#FF3340' : '#8E8E93'
              return (
                <div key={name} title={hint} style={{ display: 'flex', flexDirection: 'column', gap: 1, cursor: 'help' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color }}>{name}</span>
                    <span style={{ fontSize: 9, color, opacity: 0.8 }}>({short})</span>
                  </div>
                  <span style={{ fontSize: 9, color: 'var(--ios-label3)', lineHeight: 1.35 }}>{hint}</span>
                </div>
              )
            })}
          </div>
          <div style={{ marginTop: 6, fontSize: 9, color: 'var(--ios-label3)', opacity: 0.7 }}>
            💡 型態僅為輔助參考，需配合量能與趨勢確認，不宜單獨作為進出場依據
          </div>
        </div>
      )}

      {/* Dynamic indicator value strip — updates with crosshair */}
      {bars.length >= 2 && indicators && (
        <ChartValueStrip bars={bars} indicators={indicators} active={active} hoveredIdx={displayIdx} />
      )}

      {/* Strategy win-rate backtest */}
      <StrategyBacktestPanel
        bars={daily}
        activeId={preset}
        onPick={(id) => { const p = STRATEGY_PRESETS.find(x => x.id === id); if (p) applyPreset(p) }}
      />

      {/* Footer */}
      {chartInterval !== '1d' && !priceHistoryWk && daily.length >= 2 && (
        <div style={{ fontSize: 9.5, color: 'var(--ios-label3)', margin: '4px 0', padding: '5px 8px', background: 'rgba(255,159,10,0.08)', borderRadius: 6, border: '0.5px solid rgba(255,159,10,0.2)' }}>
          ⚠️ {chartInterval === '1wk' ? '週線' : '月線'}由每日掃描紀錄重採樣，非連續交易日資料，指標值供趨勢參考（非精確量化）
        </div>
      )}
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

export default function StockDetailModal({ stock, stocks, initialIndex = 0, notionInfo, onClose, allScans, compareHistories, historyDates }) {
  // Feature 4: multi-stock navigation
  const stockList = stocks?.length ? stocks : (stock ? [stock] : [])
  const [idx, setIdx] = useState(initialIndex ?? 0)
  // Sync idx when parent changes initialIndex (new stock selected from outside)
  useEffect(() => { setIdx(initialIndex ?? 0) }, [initialIndex])
  const s_nav = stockList[idx] ?? stockList[0] ?? stock

  // Compute technical indicators from price_history for non-top-50 stocks.
  // Top-50 stocks already have pre-computed values from Python scan; slim stocks don't.
  // This fills all the "—" rows using the OHLCV bars we now carry for every scanned stock.
  const ph = s_nav?.price_history
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

  const [swipeX, setSwipeX]   = useState(0)
  const [closing, setClosing] = useState(false)
  const swipeRef = useRef(null)
  const scoreRef = useRef(null)
  const panelRef = useRef(null)
  // Feature 1: K-line comparison
  const [compareStockId, setCompareStockId] = useState('')
  const [compareInput, setCompareInput]     = useState('')
  const [showCompareInput, setShowCompareInput] = useState(false)
  // Feature 7: sector peers collapse state
  const [peersExpanded, setPeersExpanded] = useState(false)
  useEffect(() => { setSwipeX(0); setClosing(false); setCompareStockId(''); setCompareInput(''); setShowCompareInput(false); setPeersExpanded(false) }, [s_nav?.stock_id])

  // Feature 18: track recently viewed
  useEffect(() => {
    if (!s_nav?.stock_id) return
    const stored = JSON.parse(localStorage.getItem('recentlyViewed') || '[]')
    const filtered = stored.filter(x => x.id !== s_nav.stock_id)
    const updated = [{ id: s_nav.stock_id, name: s_nav.name || '' }, ...filtered].slice(0, 5)
    localStorage.setItem('recentlyViewed', JSON.stringify(updated))
  }, [s_nav?.stock_id])

  useGSAP(() => {
    if (!scoreRef.current || !s_nav?.entry_score) return
    const obj = { val: 0 }
    gsap.to(obj, {
      val: s_nav.entry_score,
      duration: 0.85,
      ease: 'power3.out',
      delay: 0.38,
      onUpdate() { if (scoreRef.current) scoreRef.current.textContent = Math.round(obj.val) },
    })
  }, { dependencies: [s_nav?.stock_id] })

  // Feature 4: navigation helpers
  const goToPrev = () => {
    if (idx <= 0) return
    setIdx(i => i - 1)
    setClosing(false)
    if (panelRef.current) panelRef.current.scrollTo(0, 0)
  }
  const goToNext = () => {
    if (idx >= stockList.length - 1) return
    setIdx(i => i + 1)
    setClosing(false)
    if (panelRef.current) panelRef.current.scrollTo(0, 0)
  }

  const doClose = () => { setClosing(true); setTimeout(onClose, 260) }

  // Feature 6: keyboard shortcuts
  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape') { doClose() }
      else if (e.key === 'ArrowLeft' && stockList.length > 1 && idx > 0) { goToPrev() }
      else if (e.key === 'ArrowRight' && stockList.length > 1 && idx < stockList.length - 1) { goToNext() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  })

  if (!s_nav && !stock) return null
  const s = s_nav
  const n = notionInfo || null
  const scoreColor = s.entry_score >= 1000 ? 'var(--ios-yellow)' : s.entry_score >= 700 ? 'var(--ios-orange)' : 'var(--ios-label)'

  const handleDragStart = e => {
    swipeRef.current = { x0: e.touches[0].clientX, t0: Date.now() }
  }
  const handleDragMove = e => {
    if (!swipeRef.current) return
    const dx = e.touches[0].clientX - swipeRef.current.x0
    if (dx > 0) { e.preventDefault(); setSwipeX(Math.round(dx)) }
  }
  const handleDragEnd = () => {
    if (!swipeRef.current) return
    const vel = swipeX / Math.max(Date.now() - swipeRef.current.t0, 1)
    if (swipeX > 80 || vel > 0.4) doClose(); else setSwipeX(0)
    swipeRef.current = null
  }

  const sendToStudio = () => {
    localStorage.setItem('gemini_prefill_stock', String(s.stock_id))
    window.dispatchEvent(new CustomEvent('navigate-to-studio'))
    doClose()
  }

  return (
    <>
    <style>{`
      @keyframes sheetIn  { from { transform:translateX(100%); opacity:0 } to { transform:translateX(0); opacity:1 } }
      @keyframes sheetOut { from { transform:translateX(0);    opacity:1 } to { transform:translateX(100%); opacity:0 } }
    `}</style>
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex' }}
      onClick={doClose}
    >
      {/* Backdrop */}
      <div style={{
        flex: 1,
        background: `rgba(0,0,0,${(0.55 * Math.max(0, 1 - swipeX / 280)).toFixed(3)})`,
        transition: swipeX === 0 ? 'background 0.26s' : 'none',
      }} />

      {/* Panel */}
      <div
        ref={panelRef}
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(460px, 100vw)',
          height: '100%',
          maxHeight: '100%',
          background: 'var(--ios-bg)',
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: 'max(4px, env(safe-area-inset-top)) 14px 0',
          borderLeft: '0.5px solid var(--ios-sep)',
          borderRadius: '16px 0 0 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          boxShadow: '-8px 0 32px rgba(0,0,0,0.5)',
          WebkitOverflowScrolling: 'touch',
          transform: `translateX(${swipeX}px)`,
          transition: swipeX === 0 && !swipeRef.current ? 'transform 0.32s cubic-bezier(0.22,1,0.36,1)' : 'none',
          animation: closing ? 'sheetOut 0.26s ease-in both' : 'sheetIn 0.32s cubic-bezier(0.22,1,0.36,1) both',
          willChange: 'transform',
        }}
      >
        {/* iOS drag handle */}
        <div
          style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 8px', cursor: 'grab', flexShrink: 0, touchAction: 'none' }}
          onTouchStart={handleDragStart}
          onTouchMove={handleDragMove}
          onTouchEnd={handleDragEnd}
        >
          <div style={{ width: 36, height: 4, background: 'var(--ios-fill2)', borderRadius: 2, opacity: 0.7 }} />
        </div>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, position: 'sticky', top: 0, zIndex: 10, background: 'var(--ios-bg)', paddingTop: 6, paddingBottom: 6, marginTop: -6, boxShadow: '0 1px 0 var(--ios-sep)' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ios-label)', letterSpacing: '-0.3px' }}>
              {s.stock_id} <span style={{ fontSize: 16, color: 'var(--ios-label2)', fontWeight: 400 }}>{s.name}</span>
            </div>
            {s.industry_category && (
              <span style={{
                display: 'inline-block', marginTop: 5,
                fontSize: 11, fontWeight: 600, color: 'var(--ios-blue)',
                background: 'rgba(10,132,255,0.12)', borderRadius: 7,
                padding: '2px 9px',
              }}>📂 {s.industry_category}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexShrink: 0 }}>
            {/* Feature 4: prev/next navigation arrows */}
            {stockList.length > 1 && (<>
              <button
                onClick={goToPrev}
                disabled={idx === 0}
                title="上一支"
                style={{
                  background: 'var(--ios-fill3)', border: 'none', color: 'var(--ios-label2)',
                  borderRadius: 9999, width: 28, height: 28, cursor: idx === 0 ? 'default' : 'pointer',
                  fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  opacity: idx === 0 ? 0.35 : 1,
                }}
              >‹</button>
              <span style={{ fontSize: 11, color: 'var(--ios-label3)', fontVariantNumeric: 'tabular-nums', minWidth: 32, textAlign: 'center' }}>
                {idx + 1} / {stockList.length}
              </span>
              <button
                onClick={goToNext}
                disabled={idx === stockList.length - 1}
                title="下一支"
                style={{
                  background: 'var(--ios-fill3)', border: 'none', color: 'var(--ios-label2)',
                  borderRadius: 9999, width: 28, height: 28, cursor: idx === stockList.length - 1 ? 'default' : 'pointer',
                  fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  opacity: idx === stockList.length - 1 ? 0.35 : 1,
                }}
              >›</button>
            </>)}
            {/* Feature 1: Compare button */}
            <button
              onClick={() => setShowCompareInput(v => !v)}
              title="K線比較"
              style={{
                background: compareStockId ? 'rgba(255,159,10,0.2)' : 'var(--ios-fill3)',
                border: compareStockId ? '1px solid #FF9F0A' : 'none',
                color: compareStockId ? '#FF9F0A' : 'var(--ios-label2)',
                borderRadius: 9999, padding: '0 10px', height: 28,
                cursor: 'pointer', fontSize: 11, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              }}
            >比較{compareStockId ? ` ${compareStockId}` : ''}</button>
            <button
              onClick={sendToStudio}
              title="在 AI 圓桌研究室分析此股"
              style={{
                background: 'var(--ios-fill3)', border: 'none',
                color: 'var(--ios-label2)', borderRadius: 9999, width: 28, height: 28,
                cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >🎯</button>
            <button
              onClick={doClose}
              style={{
                background: 'var(--ios-fill3)', border: 'none',
                color: 'var(--ios-label2)', borderRadius: 9999, width: 28, height: 28,
                cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >✕</button>
          </div>
        </div>

        {/* 基本資料快覽 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16, padding: '12px 14px', background: 'var(--ios-bg2)', borderRadius: 14, border: '0.5px solid var(--ios-sep)' }}>
          {/* Price row */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 26, fontWeight: 700, color: 'var(--ios-label)', letterSpacing: '-0.5px' }}>{fmt(s.close, 1)}</span>
              {s.day_return != null && (
                <span style={{ fontSize: 15, fontWeight: 600, color: colorNum(s.day_return) }}>
                  {s.day_return >= 0 ? '+' : ''}{(s.day_return * 100).toFixed(2)}%
                </span>
              )}
            </div>
            {s.return_5d != null && (
              <span style={{ fontSize: 11, color: colorNum(s.return_5d), fontWeight: 600, padding: '2px 7px', borderRadius: 6, background: s.return_5d >= 0 ? 'rgba(255,51,64,0.1)' : 'rgba(22,214,126,0.1)' }}>
                5日 {s.return_5d >= 0 ? '+' : ''}{(s.return_5d * 100).toFixed(1)}%
              </span>
            )}
            {s.regime_label && s.regime_label !== '未知' && (() => {
              const c = s.regime_label === '牛市' ? '#16D67E' : s.regime_label === '熊市' ? '#FF3340' : '#FF9F0A'
              return <span style={{ fontSize: 10, fontWeight: 700, color: c, background: `${c}18`, padding: '2px 8px', borderRadius: 9999, border: `0.5px solid ${c}40`, marginLeft: 'auto' }}>{s.regime_label}</span>
            })()}
          </div>

          {/* Stats grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            {[
              { label: '量比', value: `${fmt(s.volume_ratio, 1)}x`, color: s.volume_ratio > 2 ? 'var(--ios-yellow)' : s.volume_ratio > 1.2 ? 'var(--ios-label)' : 'var(--ios-label3)' },
              { label: 'RSI', value: fmt(s.rsi14 ?? ci.rsi14, 0), color: (s.rsi14 ?? ci.rsi14) > 70 ? 'var(--ios-red)' : (s.rsi14 ?? ci.rsi14) < 30 ? 'var(--ios-green)' : 'var(--ios-label)' },
              { label: '市場RS', value: s.market_rs_rank != null ? `${Math.round(s.market_rs_rank)}%` : '—', color: (s.market_rs_rank || 0) >= 80 ? '#FFD60A' : (s.market_rs_rank || 0) >= 60 ? 'var(--ios-green)' : 'var(--ios-label3)' },
              { label: 'ADX', value: fmt(s.adx14 ?? ci.adx14, 0), color: (s.adx14 ?? ci.adx14) > 25 ? 'var(--ios-blue)' : 'var(--ios-label3)' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ background: 'var(--ios-bg)', borderRadius: 8, padding: '6px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: 9, color: 'var(--ios-label4)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color }}>{value ?? '—'}</div>
              </div>
            ))}
          </div>

          {/* Institutional + fundamental chips */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {(s.foreign_buy_streak || 0) > 0 && (
              <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: 'rgba(255,51,64,0.12)', color: 'var(--ios-red)', fontWeight: 600 }}>外資連買 {s.foreign_buy_streak}天</span>
            )}
            {(s.invest_trust_streak || 0) > 0 && (
              <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: 'rgba(255,159,10,0.12)', color: 'var(--ios-orange)', fontWeight: 600 }}>投信連買 {s.invest_trust_streak}天</span>
            )}
            {(s.dealer_buy_streak || 0) > 0 && (
              <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: 'rgba(10,132,255,0.1)', color: 'var(--ios-blue)', fontWeight: 600 }}>自營連買 {s.dealer_buy_streak}天</span>
            )}
            {s.f_score != null && (
              <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: s.f_score >= 7 ? 'rgba(22,214,126,0.12)' : 'var(--ios-fill4)', color: s.f_score >= 7 ? 'var(--ios-green)' : 'var(--ios-label3)', fontWeight: 600 }}>F分 {s.f_score}/9</span>
            )}
            {s.revenue_yoy != null && (
              <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: s.revenue_yoy > 0 ? 'rgba(255,51,64,0.12)' : 'rgba(22,214,126,0.12)', color: s.revenue_yoy > 0 ? 'var(--ios-red)' : 'var(--ios-green)', fontWeight: 600 }}>
                營收YoY {s.revenue_yoy > 0 ? '+' : ''}{(s.revenue_yoy * 100).toFixed(1)}%
              </span>
            )}
            {s.is_sector_leader && (
              <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: 'rgba(255,214,10,0.15)', color: '#FFD60A', fontWeight: 700 }}>🏆 旗手股</span>
            )}
          </div>
        </div>

        {/* Feature 7: Sector peer comparison */}
        {(() => {
          if (!s.industry_category) return null
          const latestScanDate = allScans ? Object.keys(allScans).sort().reverse()[0] : null
          const peers = latestScanDate
            ? (allScans[latestScanDate]?.top_stocks || [])
                .filter(p => p.industry_category === s.industry_category && String(p.stock_id) !== String(s.stock_id))
                .sort((a, b) => b.entry_score - a.entry_score)
                .slice(0, 5)
            : []
          if (!peers.length) return null
          return (
            <div style={{ marginBottom: 12, borderRadius: 12, border: '0.5px solid var(--ios-sep)', overflow: 'hidden' }}>
              <button
                onClick={() => setPeersExpanded(v => !v)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 14px', background: 'var(--ios-bg2)', border: 'none', cursor: 'pointer',
                  color: 'var(--ios-label)', fontSize: 13, fontWeight: 600, textAlign: 'left',
                }}
              >
                <span>📊 類股 {s.industry_category} 同業（{peers.length}）</span>
                <span style={{ fontSize: 11, color: 'var(--ios-label3)', marginLeft: 8 }}>{peersExpanded ? '▲' : '▼'}</span>
              </button>
              {peersExpanded && (
                <div style={{ background: 'var(--ios-bg)' }}>
                  {peers.map((p, i) => {
                    const scoreHex = p.entry_score >= 1000 ? '#FFD60A' : p.entry_score >= 700 ? '#FF9F0A' : '#8E8E93'
                    return (
                      <div
                        key={p.stock_id}
                        onClick={() => document.dispatchEvent(new CustomEvent('openStockDetail', { detail: p }))}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
                          cursor: 'pointer',
                          borderTop: i > 0 ? '0.5px solid var(--ios-sep)' : 'none',
                          background: p.entry_signal ? 'rgba(22,214,126,0.05)' : 'transparent',
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-blue)', fontFamily: 'monospace' }}>{p.stock_id}</span>
                          {p.name && <span style={{ fontSize: 11, color: 'var(--ios-label2)', marginLeft: 6 }}>{p.name}</span>}
                        </div>
                        {p.market_rs_rank != null && (
                          <span style={{ fontSize: 10, color: 'var(--ios-label3)' }}>RS {Math.round(p.market_rs_rank)}%</span>
                        )}
                        <span style={{ fontSize: 11, fontWeight: 700, color: scoreHex, background: `${scoreHex}28`, borderRadius: 6, padding: '2px 7px', border: `0.5px solid ${scoreHex}60` }}>
                          {Math.round(p.entry_score)}
                        </span>
                        {p.entry_signal && (
                          <span style={{ fontSize: 9, color: '#16D67E', fontWeight: 700, background: 'rgba(22,214,126,0.12)', borderRadius: 4, padding: '1px 5px' }}>進場</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })()}

        {/* Feature 1: Compare stock input panel */}
        {showCompareInput && (() => {
          const q = compareInput.trim().toUpperCase()
          // Build a quick name lookup from allScans latest date
          const latestScan = allScans ? Object.values(allScans).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0] : null
          const nameMap = {}
          ;[...(latestScan?.top_stocks || []), ...(latestScan?.filter_stocks || [])].forEach(x => { nameMap[String(x.stock_id)] = x.name || '' })
          // Candidates: all ids in compareHistories that match the query
          const candidates = compareHistories
            ? Object.keys(compareHistories)
                .filter(id => !q || id.includes(q) || (nameMap[id] || '').includes(compareInput.trim()))
                .filter(id => id !== String(s.stock_id))
                .slice(0, 8)
            : []
          const confirmId = id => { if (id && compareHistories?.[id]) { setCompareStockId(id); setCompareInput(id); setShowCompareInput(false) } }
          return (
            <div style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--ios-bg2)', borderRadius: 10, border: '0.5px solid var(--ios-sep)' }}>
              <div style={{ fontSize: 10, color: 'var(--ios-label4)', marginBottom: 6 }}>選擇比較股票（K 線百分比疊加）</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  autoFocus
                  value={compareInput}
                  onChange={e => setCompareInput(e.target.value.toUpperCase())}
                  onKeyDown={e => { if (e.key === 'Enter') confirmId(compareInput.trim()) }}
                  placeholder="輸入代號，如 0050"
                  style={{ flex: 1, padding: '7px 10px', fontSize: 13, borderRadius: 8, background: 'var(--ios-fill3)', border: '0.5px solid var(--ios-sep)', color: 'var(--ios-label)', outline: 'none' }}
                />
                <button onClick={() => confirmId(compareInput.trim())} style={{ padding: '7px 14px', fontSize: 12, fontWeight: 700, background: 'var(--ios-blue)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>確認</button>
                {compareStockId && (
                  <button onClick={() => { setCompareStockId(''); setCompareInput(''); setShowCompareInput(false) }} style={{ padding: '7px 10px', fontSize: 12, background: 'var(--ios-fill3)', color: 'var(--ios-red)', border: 'none', borderRadius: 8, cursor: 'pointer' }}>清除</button>
                )}
              </div>
              {/* Autocomplete suggestions */}
              {candidates.length > 0 && (
                <div style={{ marginTop: 6, borderRadius: 8, border: '0.5px solid var(--ios-sep)', overflow: 'hidden', maxHeight: 200, overflowY: 'auto' }}>
                  {candidates.map((id, i) => (
                    <div key={id} onClick={() => confirmId(id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer', background: compareStockId === id ? 'rgba(10,132,255,0.1)' : i % 2 === 0 ? 'var(--ios-bg2)' : 'var(--ios-bg)', borderBottom: i < candidates.length - 1 ? '0.5px solid var(--ios-sep)' : 'none' }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-blue)', fontFamily: 'monospace', minWidth: 40 }}>{id}</span>
                      <span style={{ fontSize: 12, color: 'var(--ios-label)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameMap[id] || ''}</span>
                      {compareStockId === id && <span style={{ fontSize: 10, color: 'var(--ios-blue)', fontWeight: 700 }}>✓ 已選</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
        {/* Compare summary badge — shown when compare is active */}
        {compareStockId && !showCompareInput && (() => {
          const ph = s.price_history
          const cData = compareHistories?.[compareStockId]
          if (!ph || !cData || !historyDates) return null
          // Compute last 30-day pct change for both
          const pct30 = (arr) => {
            if (!arr || arr.length < 2) return null
            const last = arr[arr.length - 1]
            const ref = arr[Math.max(0, arr.length - 30)]
            return ((last - ref) / ref * 100)
          }
          const mainCloses = ph.map(b => b.close)
          const cmpCloses = historyDates.map((_, i) => cData.c?.[i]).filter(v => v != null)
          const mainPct = pct30(mainCloses)
          const cmpPct = pct30(cmpCloses)
          return (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, padding: '7px 12px', background: 'var(--ios-bg2)', borderRadius: 10, border: '0.5px solid var(--ios-sep)', alignItems: 'center', fontSize: 11 }}>
              <span style={{ color: 'var(--ios-label3)' }}>近30日：</span>
              <span style={{ fontWeight: 700, fontFamily: 'monospace', color: mainPct >= 0 ? 'var(--ios-red)' : 'var(--ios-green)' }}>{s.stock_id} {mainPct != null ? `${mainPct >= 0 ? '+' : ''}${mainPct.toFixed(1)}%` : '—'}</span>
              <span style={{ color: 'var(--ios-label4)' }}>vs</span>
              <span style={{ fontWeight: 700, fontFamily: 'monospace', color: '#FF9F0A' }}>{compareStockId} {cmpPct != null ? `${cmpPct >= 0 ? '+' : ''}${cmpPct.toFixed(1)}%` : '—'}</span>
              <button onClick={() => setShowCompareInput(true)} style={{ marginLeft: 'auto', fontSize: 10, background: 'none', border: 'none', color: 'var(--ios-blue)', cursor: 'pointer', padding: 0 }}>換股</button>
            </div>
          )
        })()}

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
                        <circle cx={x} cy={y} r={h.signal ? 4 : 2.5} fill={h.signal ? '#16D67E' : 'var(--ios-blue)'} />
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
          <KLineChart key={s.stock_id} stockId={s.stock_id} priceHistory={s.price_history} priceHistoryWk={s.price_history_wk} priceHistoryMo={s.price_history_mo} loading={!!s.price_history_loading} compareId={compareStockId || null} compareHistories={compareHistories} historyDates={historyDates} />
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '0.5px solid var(--ios-sep)' }}>
            <span style={{ color: 'var(--ios-label2)', fontSize: 13 }}>入場分數</span>
            <span ref={scoreRef} style={{ color: scoreColor, fontSize: 16, fontWeight: 600 }}>0</span>
          </div>
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
            <div style={{ margin: '6px 0 2px', padding: '6px 10px', background: 'rgba(255,51,64,0.10)', border: '0.5px solid var(--ios-red)', borderRadius: 8, fontSize: 11, color: 'var(--ios-red)' }}>
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
              <Row label="AH 強力壓力" value={fmt(ah, 2)} valueStyle={{ color: 'rgba(255,51,64,0.9)', fontWeight: 700 }} />
              <Row label="NH 一般壓力" value={fmt(nh, 2)} valueStyle={{ color: close != null && close >= nh ? 'var(--ios-red)' : 'var(--ios-label3)' }} />
              <Row label="CDP 中樞" value={fmt(cdp, 2)} valueStyle={{ color: 'var(--ios-yellow)', fontWeight: 600 }} />
              <Row label="NL 一般支撐" value={fmt(nl, 2)} valueStyle={{ color: close != null && close <= nl ? 'var(--ios-green)' : 'var(--ios-label3)' }} />
              <Row label="AL 強力支撐" value={fmt(al, 2)} valueStyle={{ color: 'rgba(22,214,126,0.9)', fontWeight: 700 }} />
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
                    <span key={sig.key} style={{ fontSize: 11, padding: '3px 8px', background: 'rgba(22,214,126,0.12)', color: 'var(--ios-green)', border: '0.5px solid rgba(22,214,126,0.4)', borderRadius: 6, fontWeight: 600, letterSpacing: 0.2 }}>
                      ✓ {sig.label}
                    </span>
                  ))}
                </div>
              )}
              {activeR.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {activeR.map(sig => (
                    <span key={sig.key} style={{ fontSize: 11, padding: '3px 8px', background: 'rgba(255,51,64,0.12)', color: 'var(--ios-red)', border: '0.5px solid rgba(255,51,64,0.4)', borderRadius: 6, fontWeight: 600, letterSpacing: 0.2 }}>
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
                法人資料每日盤後 16:00–18:00 由 TWSE 公布，20:15 自動彙整更新
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
          <div style={{ margin: '4px 0 10px', padding: '8px 12px', background: 'rgba(255,51,64,0.08)', border: '0.5px solid var(--ios-red)', borderRadius: 10, fontSize: 11, color: 'var(--ios-red)' }}>
            ⚠️ 資料品質警示：此股票部分指標資料不完整，評分參考性較低
          </div>
        )}
        {/* 訊號歷史 — detailed scan timeline */}
        {allScans && (() => {
          const history = Object.entries(allScans)
            .map(([date, sc]) => {
              const inTop = sc.top_stocks?.find(t => String(t.stock_id) === String(s.stock_id))
              const inFilter = sc.filter_stocks?.find(t => String(t.stock_id) === String(s.stock_id))
              const row = inTop || inFilter
              if (!row) return null
              return {
                date,
                score: row.entry_score ?? null,
                signal: !!row.entry_signal,
                grade: row.grade || null,
                macdCross: !!row.macd_golden_cross,
                rsi: row.rsi14 ?? null,
                close: row.close ?? null,
              }
            })
            .filter(Boolean)
            .sort((a, b) => a.date.localeCompare(b.date))
          if (history.length === 0) return null
          return (
            <Section title={`📋 訊號歷史（${history.length} 筆掃描記錄）`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {history.map((h, i) => {
                  const scoreColor = h.signal ? '#16D67E' : (h.score ?? 0) >= 700 ? 'var(--ios-orange)' : 'var(--ios-label3)'
                  const gc = { A: '#FFD60A', B: '#16D67E', C: '#FF9F0A', D: '#64748B', X: '#FF3340' }
                  return (
                    <div key={h.date} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '8px 0',
                      borderBottom: i < history.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
                    }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: h.signal ? '#16D67E' : 'var(--ios-fill2)', flexShrink: 0 }} />
                      <span style={{ fontSize: 11, color: 'var(--ios-label3)', fontFamily: 'monospace', minWidth: 52 }}>{h.date.slice(5)}</span>
                      {h.score != null && (
                        <span style={{ fontSize: 11, fontWeight: 700, color: scoreColor, minWidth: 44 }}>
                          {Math.round(h.score)}分
                        </span>
                      )}
                      {h.grade && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: gc[h.grade] || 'var(--ios-label3)' }}>[{h.grade}]</span>
                      )}
                      {h.signal && (
                        <span style={{ fontSize: 9, color: '#16D67E', fontWeight: 700, background: 'rgba(22,214,126,0.12)', borderRadius: 4, padding: '1px 5px' }}>進場</span>
                      )}
                      {h.macdCross && (
                        <span style={{ fontSize: 9, color: 'var(--ios-blue)', background: 'rgba(10,132,255,0.1)', borderRadius: 4, padding: '1px 5px' }}>MACD金叉</span>
                      )}
                      {h.close != null && (
                        <span style={{ fontSize: 10, color: 'var(--ios-label4)', marginLeft: 'auto' }}>{h.close.toFixed(1)}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </Section>
          )
        })()}

        {/* Bottom spacer — fixed 200px so content always scrolls fully clear of any UI chrome */}
        <div style={{ height: 200, flexShrink: 0 }} />
      </div>
    </div>
    </>
  )
}
