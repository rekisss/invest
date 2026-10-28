import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react'
import { getStockHistories } from '../utils/histCache.js'
import { animateListRows } from '../utils/animeUtils.js'
import { resampleDrawing, findSimilarPatterns, PRESET_PATTERNS } from '../utils/patternMatch.js'
import { priceColor } from '../utils/marketColors.js'

const BASE = import.meta.env.BASE_URL || '/'

const LOOKBACKS = [20, 40, 60, 120]
// stock_histories 的 v 單位是「股」;介面用「張」(1 張 = 1000 股)
const VOLUME_FILTERS = [
  { label: '不限', lots: 0 },
  { label: '≥500 張', lots: 500 },
  { label: '≥2000 張', lots: 2000 },
]

function buildNameMap(data) {
  const map = {}
  for (const scan of Object.values(data?.scans || {}))
    for (const s of [...(scan?.top_stocks || []), ...(scan?.filter_stocks || [])])
      if (s?.name && !map[String(s.stock_id)]) map[String(s.stock_id)] = s.name
  return map
}

// ── 手繪畫布 ────────────────────────────────────────────────────────────────
// 點以 0..1 正規化座標保存(y 越大越高),跟畫布實際像素大小無關,旋轉/縮放視窗不會壞。
function DrawCanvas({ points, onChange }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const drawingRef = useRef(false)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !size.w) return
    const dpr = window.devicePixelRatio || 1
    cv.width = size.w * dpr
    cv.height = size.h * dpr
    const ctx = cv.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    const css = getComputedStyle(cv)
    ctx.strokeStyle = css.getPropertyValue('--ios-sep').trim() || 'rgba(128,128,128,0.25)'
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      const y = (size.h * i) / 4
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size.w, y); ctx.stroke()
    }
    for (let i = 1; i < 6; i++) {
      const x = (size.w * i) / 6
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size.h); ctx.stroke()
    }
    if (points.length < 2) return
    const sorted = [...points].sort((a, b) => a.x - b.x)
    ctx.strokeStyle = css.getPropertyValue('--ios-blue').trim() || '#0A84FF'
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    sorted.forEach((p, i) => {
      const x = p.x * size.w
      const y = (1 - p.y) * size.h
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }, [points, size])

  const toPoint = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)),
    }
  }
  // 由左往右畫:同一個 x 區間後畫的覆蓋先畫的,所以可以局部重描修正
  const addPoint = (p, current) => {
    const eps = 0.004
    return [...current.filter(q => Math.abs(q.x - p.x) > eps), p]
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height: 220, borderRadius: 14, overflow: 'hidden', background: 'var(--ios-fill)' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', touchAction: 'none', cursor: 'crosshair', display: 'block' }}
        onPointerDown={e => {
          drawingRef.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          onChange(prev => addPoint(toPoint(e), prev))
        }}
        onPointerMove={e => {
          if (!drawingRef.current) return
          const p = toPoint(e)
          onChange(prev => addPoint(p, prev))
        }}
        onPointerUp={() => { drawingRef.current = false }}
        onPointerCancel={() => { drawingRef.current = false }}
      />
      {points.length < 2 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', color: 'var(--ios-label3)', fontSize: 13, textAlign: 'center', padding: 16 }}>
          用手指或滑鼠由左到右畫出你想找的走勢<br />或選下方的範本
        </div>
      )}
    </div>
  )
}

// 結果列的小圖:把股票實際收盤(實線)與你畫的範本(虛線)疊在一起,一眼看出像不像
function OverlaySpark({ closes, template, w = 96, h = 36 }) {
  const norm = (arr) => {
    const lo = Math.min(...arr)
    const hi = Math.max(...arr)
    const span = hi - lo || 1
    return arr.map((v, i) => `${((i / (arr.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(' ')
  }
  const up = closes[closes.length - 1] >= closes[0]
  return (
    <svg width={w} height={h} style={{ flexShrink: 0 }}>
      <polyline points={norm(template)} fill="none" stroke="var(--ios-label3)" strokeWidth="1.2" strokeDasharray="3 3" />
      <polyline points={norm(closes)} fill="none" stroke={priceColor(up ? 1 : -1)} strokeWidth="1.6" />
    </svg>
  )
}

function Chip({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 12px', borderRadius: 'var(--radius-pill, 999px)', fontSize: 13, fontWeight: 600,
        border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
        background: active ? 'var(--ios-blue)' : 'var(--ios-fill)',
        color: active ? '#fff' : 'var(--ios-label)',
      }}
    >
      {children}
    </button>
  )
}

export default function PatternSearch({ data }) {
  const [points, setPoints] = useState([])
  const [preset, setPreset] = useState(null)
  const [lookback, setLookback] = useState(60)
  const [volIdx, setVolIdx] = useState(1)
  const [hist, setHist] = useState(null)
  const [histError, setHistError] = useState(false)
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const listRef = useRef(null)

  const nameMap = useMemo(() => buildNameMap(data), [data])

  useEffect(() => {
    let alive = true
    getStockHistories(BASE).then(h => {
      if (!alive) return
      if (h?.stocks && Object.keys(h.stocks).length) setHist(h)
      else setHistError(true)
    })
    return () => { alive = false }
  }, [])

  const template = useMemo(() => resampleDrawing(points), [points])
  const stockCount = hist?.stocks ? Object.keys(hist.stocks).length : 0
  const latestDate = hist?.dates?.[hist.dates.length - 1]

  const runSearch = useCallback(() => {
    if (!template || !hist?.stocks) return
    setSearching(true)
    // 讓「搜尋中」先畫出來;1500 檔 × 3 視窗 × 40 點在手機上也只要幾十 ms
    setTimeout(() => {
      const res = findSimilarPatterns(template, hist.stocks, {
        lookback, topN: 30, minAvgVolume: VOLUME_FILTERS[volIdx].lots * 1000,
      })
      setResults(res)
      setSearching(false)
    }, 16)
  }, [template, hist, lookback, volIdx])

  // 範本或條件變動後自動重搜(畫的當下不搜,放開才有完整曲線 → 用 debounce)
  useEffect(() => {
    if (!template || !hist) return
    const t = setTimeout(runSearch, 350)
    return () => clearTimeout(t)
  }, [template, hist, lookback, volIdx, runSearch])

  useLayoutEffect(() => {
    if (!results?.length || !listRef.current) return
    // 先以指令式設定初始狀態,避免首幀閃爍
    for (const el of listRef.current.querySelectorAll('[data-row]')) el.style.opacity = '0'
    animateListRows(listRef.current)
  }, [results])

  const applyPreset = (p) => {
    setPreset(p.key)
    setPoints(p.points.map(([x, y]) => ({ x, y })))
  }

  const open = (r) => {
    document.dispatchEvent(new CustomEvent('openStockDetail', { detail: { stock_id: r.stock_id, name: nameMap[r.stock_id] || '' } }))
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <div style={{ padding: '0 16px 32px', maxWidth: 720, margin: '0 auto' }}>
        <div className="ios-card" style={{ padding: 14, marginBottom: 14 }}>
          <DrawCanvas points={points} onChange={(fn) => { setPreset(null); setPoints(fn) }} />

          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 12, paddingBottom: 2 }}>
            {PRESET_PATTERNS.map(p => (
              <Chip key={p.key} active={preset === p.key} onClick={() => applyPreset(p)}>{p.label}</Chip>
            ))}
            <Chip active={false} onClick={() => { setPoints([]); setPreset(null); setResults(null) }}>清除</Chip>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12, alignItems: 'center', fontSize: 13, color: 'var(--ios-label2)' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span>比對最近</span>
              {LOOKBACKS.map(n => <Chip key={n} active={lookback === n} onClick={() => setLookback(n)}>{n} 日</Chip>)}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span>日均量</span>
              {VOLUME_FILTERS.map((f, i) => <Chip key={f.label} active={volIdx === i} onClick={() => setVolIdx(i)}>{f.label}</Chip>)}
            </div>
          </div>

          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ios-label3)', lineHeight: 1.5 }}>
            {histError
              ? '⚠ 讀不到 K 線資料(stock_histories.json),暫時無法搜尋'
              : hist
                ? `資料:${stockCount} 檔,最新 K 棒 ${latestDate || '—'}。只比「形狀」,不看漲跌幅大小;視窗長度會自動 ±20% 容錯。`
                : '載入 K 線資料中…(約 8MB,第一次較久)'}
          </div>
        </div>

        {searching && <div style={{ textAlign: 'center', color: 'var(--ios-label3)', fontSize: 13, padding: 12 }}>搜尋中…</div>}

        {results && !searching && (
          results.length === 0
            ? <div style={{ textAlign: 'center', color: 'var(--ios-label3)', fontSize: 13, padding: 24 }}>沒有符合條件的股票,試著放寬日均量條件</div>
            : (
              <div ref={listRef} className="ios-card">
                {results.map((r, idx) => (
                  <div
                    key={r.stock_id}
                    data-row
                    onClick={() => open(r)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer',
                      borderBottom: idx < results.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
                    }}
                  >
                    <div style={{ width: 22, fontSize: 12, color: 'var(--ios-label3)', fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ios-label)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {r.stock_id} {nameMap[r.stock_id] || ''}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--ios-label3)', marginTop: 2 }}>
                        近 {r.window} 日 <span style={{ color: priceColor(r.changePct) }}>{r.changePct >= 0 ? '+' : ''}{r.changePct.toFixed(1)}%</span>
                        {' · '}收 {r.closes[r.closes.length - 1]}
                      </div>
                    </div>
                    {template && <OverlaySpark closes={r.closes} template={template} />}
                    <div style={{ width: 52, textAlign: 'right' }}>
                      <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: r.score >= 0.9 ? 'var(--ios-green)' : r.score >= 0.75 ? 'var(--ios-label)' : 'var(--ios-label3)' }}>
                        {Math.round(Math.max(0, r.score) * 100)}%
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--ios-label3)' }}>相似度</div>
                    </div>
                  </div>
                ))}
              </div>
            )
        )}

        {results?.length > 0 && !searching && (
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ios-label3)', lineHeight: 1.5 }}>
            虛線=你畫的型態,實線=該股實際走勢。型態相似不代表後續走勢會相同,僅供篩選參考,請搭配基本面與風險控管。
          </div>
        )}
      </div>
    </div>
  )
}
