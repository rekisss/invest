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

function CandleSVG({ data }) {
  const [hovered, setHovered] = useState(null)
  const touchRef = useRef(null)

  const chart = useMemo(() => {
    if (!data || data.length < 2) return null
    const bars = data.slice(-60)
    const W = 460, CH = 200, VH = 45, GAP = 6, H = CH + GAP + VH
    const PL = 42, PR = 6, PT = 8
    const maxP = Math.max(...bars.map(d => d.high))
    const minP = Math.min(...bars.map(d => d.low))
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
    return { bars, W, CH, VH, GAP, H, PL, PR, PT, maxP, minP, pRange, maxVol, n, slotW, bW, toY, toX, gridLevels, xLabels }
  }, [data])

  if (!chart) return (
    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ios-label3)', fontSize: 12, background: 'var(--ios-bg)', borderRadius: 10 }}>
      暫無歷史 K 線資料
    </div>
  )

  const { bars, W, CH, VH, GAP, H, PL, PR, PT, maxVol, slotW, bW, toY, toX, gridLevels, xLabels } = chart

  const getIdxFromClientX = (clientX, svgEl) => {
    const rect = svgEl.getBoundingClientRect()
    const svgX = (clientX - rect.left) / rect.width * W
    return Math.floor((svgX - PL) / slotW)
  }

  const setBar = (idx) => {
    if (idx >= 0 && idx < bars.length) setHovered({ idx, bar: bars[idx], x: toX(idx) })
    else setHovered(null)
  }

  const handleMouseMove = (e) => {
    setBar(getIdxFromClientX(e.clientX, e.currentTarget))
  }

  const handleTouchStart = (e) => {
    const touch = e.touches[0]
    const svg = e.currentTarget
    touchRef.current = {
      active: false,
      startX: touch.clientX,
      timer: setTimeout(() => {
        if (touchRef.current) {
          touchRef.current.active = true
          setBar(getIdxFromClientX(touchRef.current.lastX ?? touchRef.current.startX, svg))
        }
      }, 300),
      lastX: touch.clientX,
      svgEl: svg,
    }
  }

  const handleTouchMove = (e) => {
    const touch = e.touches[0]
    if (!touchRef.current) return
    touchRef.current.lastX = touch.clientX
    if (touchRef.current.active) {
      e.preventDefault()
      setBar(getIdxFromClientX(touch.clientX, touchRef.current.svgEl))
    }
  }

  const handleTouchEnd = () => {
    if (touchRef.current?.timer) clearTimeout(touchRef.current.timer)
    touchRef.current = null
    setHovered(null)
  }

  const tipW = 118, tipH = 94
  const tipX = hovered ? (hovered.x > W / 2 ? hovered.x - tipW - 6 : hovered.x + 8) : 0
  const tipY = PT + 4

  return (
    <svg
      viewBox={`0 0 ${W} ${H + PT + 18}`}
      style={{ width: '100%', display: 'block', background: 'var(--ios-bg)', borderRadius: 10, cursor: 'crosshair', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHovered(null)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {gridLevels.map(({ y, price }, j) => (
        <g key={j}>
          <line x1={PL} y1={y} x2={W - 6} y2={y} stroke="#2C2C2E" strokeWidth={0.5} />
          <text x={PL - 3} y={y + 3.5} fontSize={8.5} fill="#636366" textAnchor="end">
            {price >= 100 ? price.toFixed(0) : price.toFixed(1)}
          </text>
        </g>
      ))}
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
      {xLabels.map(({ i, label }) => (
        <text key={i} x={toX(i)} y={H + PT + 12} fontSize={8.5} fill="#636366" textAnchor="middle">{label}</text>
      ))}

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

function KLineChart({ stockId, priceHistory, priceHistoryWk, priceHistoryMo }) {
  const cnyesUrl = `https://www.cnyes.com/twstock/${stockId}`
  const wantgooUrl = `https://www.wantgoo.com/stock/${stockId}`

  const daily = Array.isArray(priceHistory) ? priceHistory : []
  const weekly = (Array.isArray(priceHistoryWk) && priceHistoryWk.length >= 2)
    ? priceHistoryWk : resampleBars(daily, 'week')
  const monthly = (Array.isArray(priceHistoryMo) && priceHistoryMo.length >= 2)
    ? priceHistoryMo : resampleBars(daily, 'month')

  const dataMap = { '1d': daily, '1wk': weekly, '1mo': monthly }

  const [chartInterval, setChartInterval] = useState(
    () => INTERVAL_LABELS.find(t => dataMap[t.id].length >= 2)?.id || '1d'
  )
  const data = dataMap[chartInterval]

  const unitLabel = { '1d': '個交易日', '1wk': '週', '1mo': '個月' }

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, alignItems: 'center' }}>
        <div className="ios-segmented" style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--ios-fill4)', borderRadius: 8 }}>
          {INTERVAL_LABELS.map(t => {
            const available = dataMap[t.id].length >= 2
            const active = chartInterval === t.id
            return (
              <button
                key={t.id}
                onClick={() => available && setChartInterval(t.id)}
                style={{
                  background: active ? 'var(--ios-bg3)' : 'transparent',
                  border: 'none',
                  color: active ? 'var(--ios-label)' : 'var(--ios-label3)',
                  borderRadius: 6, padding: '4px 14px', fontSize: 12,
                  cursor: available ? 'pointer' : 'default', fontWeight: active ? 600 : 400,
                  boxShadow: active ? '0 1px 4px rgba(0,0,0,0.3)' : 'none',
                  transition: 'all 0.15s',
                }}
              >{t.label}</button>
            )
          })}
        </div>
      </div>
      <CandleSVG data={data} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, flexWrap: 'wrap', gap: 6 }}>
        {data.length >= 2 && <span style={{ fontSize: 10, color: 'var(--ios-label3)' }}>近 {data.length} {unitLabel[chartInterval]}</span>}
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

        {/* K 線圖 */}
        <Section title="K 線圖">
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
          {s.entry_reason && <Row label="入場理由" value={s.entry_reason} valueStyle={{ color: 'var(--ios-green)', fontSize: 11 }} />}
          {s.skip_reason && <Row label="跳過原因" value={s.skip_reason} valueStyle={{ color: 'var(--ios-red)', fontSize: 11 }} />}
        </Section>

        {/* 技術指標 */}
        <Section title="技術指標">
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
        </Section>
      </div>
    </div>
  )
}
