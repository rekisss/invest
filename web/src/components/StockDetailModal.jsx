import { useState, useEffect } from 'react'

const fmt = (v, dec = 2) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(dec))
const pct = (v) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`)
const colorNum = (v, pos = '#ef4444', neg = '#4ade80') => {
  const n = Number(v)
  if (isNaN(n) || n === 0) return '#94a3b8'
  return n > 0 ? pos : neg
}

// Taiwan convention: red = up, green = down
function candleColor(open, close) { return close >= open ? '#ef4444' : '#22c55e' }

function isOTC(stockId) {
  const n = parseInt(String(stockId), 10)
  return (n >= 4200 && n <= 4999) || (n >= 5000 && n <= 5999) ||
         (n >= 6000 && n <= 6999) || (n >= 8000 && n <= 8999) || (n >= 9200 && n <= 9999)
}

async function fetchYahooHistory(stockId) {
  const suffix = isOTC(stockId) ? '.TWO' : '.TW'
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${stockId}${suffix}?interval=1d&range=3mo`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error('no result')
  const ts = result.timestamp || []
  const q = result.indicators?.quote?.[0] || {}
  return ts.map((t, i) => ({
    time: new Date(t * 1000).toISOString().slice(0, 10),
    open: q.open?.[i], high: q.high?.[i], low: q.low?.[i],
    close: q.close?.[i], volume: q.volume?.[i] || 0,
  })).filter(d => d.open != null && d.close != null && d.high != null && d.low != null)
}

function CandleSVG({ data }) {
  if (!data || data.length < 2) return (
    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 12, background: '#0f172a', borderRadius: 8 }}>
      暫無歷史 K 線資料
    </div>
  )

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

  return (
    <svg viewBox={`0 0 ${W} ${H + PT + 18}`} style={{ width: '100%', display: 'block', background: '#0f172a', borderRadius: 8 }}>
      {gridLevels.map(({ y, price }, j) => (
        <g key={j}>
          <line x1={PL} y1={y} x2={W - 6} y2={y} stroke="#1e293b" strokeWidth={0.5} />
          <text x={PL - 3} y={y + 3.5} fontSize={8.5} fill="#475569" textAnchor="end">
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
        return (
          <g key={i}>
            <line x1={x} y1={toY(d.high)} x2={x} y2={toY(d.low)} stroke={color} strokeWidth={0.8} />
            <rect x={x - bW / 2} y={bodyTop} width={bW} height={bodyH} fill={color} />
            <rect x={x - bW / 2} y={CH + GAP + PT + VH - volH} width={bW} height={volH} fill={color} opacity={0.45} />
          </g>
        )
      })}
      {xLabels.map(({ i, label }) => (
        <text key={i} x={toX(i)} y={H + PT + 12} fontSize={8.5} fill="#475569" textAnchor="middle">{label}</text>
      ))}
    </svg>
  )
}

function KLineChart({ stockId, priceHistory }) {
  const [data, setData] = useState(null)   // null=loading
  const [source, setSource] = useState('')

  useEffect(() => {
    let alive = true
    setData(null)
    setSource('')
    fetchYahooHistory(stockId)
      .then(rows => {
        if (!alive) return
        setData(rows)
        setSource(`Yahoo Finance · ${rows.length} 天`)
      })
      .catch(() => {
        if (!alive) return
        const fallback = Array.isArray(priceHistory) ? priceHistory : []
        setData(fallback)
        setSource(fallback.length >= 2 ? `掃描資料 · ${fallback.length} 天` : '')
      })
    return () => { alive = false }
  }, [stockId])

  const tvSym = `${isOTC(stockId) ? 'TPEX' : 'TWSE'}:${stockId}`
  const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym)}`
  const yahooUrl = `https://finance.yahoo.com/quote/${stockId}${isOTC(stockId) ? '.TWO' : '.TW'}/chart/`

  return (
    <div>
      {data === null ? (
        <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 12, background: '#0f172a', borderRadius: 8 }}>
          載入中…
        </div>
      ) : (
        <CandleSVG data={data} />
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, flexWrap: 'wrap', gap: 6 }}>
        {source && <span style={{ fontSize: 10, color: '#475569' }}>{source}</span>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href={tvUrl} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 11, color: '#60a5fa', textDecoration: 'none', padding: '3px 8px', background: '#1e293b', borderRadius: 4, border: '1px solid #334155' }}>
            TradingView ↗
          </a>
          <a href={yahooUrl} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 11, color: '#94a3b8', textDecoration: 'none', padding: '3px 8px', background: '#1e293b', borderRadius: 4, border: '1px solid #334155' }}>
            Yahoo Finance ↗
          </a>
        </div>
      </div>
    </div>
  )
}


function Row({ label, value, valueStyle }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #1e293b' }}>
      <span style={{ color: '#64748b', fontSize: 12 }}>{label}</span>
      <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600, ...valueStyle }}>{value}</span>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ background: '#1e293b', borderRadius: 8, padding: '10px 14px', marginBottom: 10 }}>
      <div style={{ color: '#60a5fa', fontSize: 11, fontWeight: 700, marginBottom: 6, letterSpacing: 1 }}>{title}</div>
      {children}
    </div>
  )
}

export default function StockDetailModal({ stock, notionInfo, onClose }) {
  if (!stock) return null
  const s = stock
  const n = notionInfo || null
  const scoreColor = s.entry_score >= 1000 ? '#facc15' : s.entry_score >= 700 ? '#fb923c' : '#e2e8f0'

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex' }}
      onClick={onClose}
    >
      {/* backdrop */}
      <div style={{ flex: 1, background: 'rgba(0,0,0,0.6)' }} />

      {/* panel */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(460px, 100vw)',
          height: '100vh',
          background: '#0f172a',
          overflowY: 'auto',
          padding: '16px 14px 40px',
          borderLeft: '1px solid #1e293b',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
        }}
      >
        {/* header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9' }}>
              {s.stock_id} <span style={{ fontSize: 16, color: '#94a3b8' }}>{s.name}</span>
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{s.industry_category}</div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: '1px solid #334155', color: '#94a3b8', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 14 }}
          >✕</button>
        </div>

        {/* K 線圖 */}
        <Section title="K 線圖">
          <KLineChart stockId={s.stock_id} priceHistory={s.price_history} />
        </Section>

        {/* Notion 連結 */}
        {n && (
          <Section title="Notion 同步">
            {n.type && <Row label="類型" value={n.type} valueStyle={{ color: n.type === 'TOP 20' ? '#facc15' : n.type === '候選進場' ? '#4ade80' : '#94a3b8' }} />}
            {n.regime && <Row label="市場氛圍" value={n.regime} />}
            {n.confidence != null && <Row label="信心分數" value={`${n.confidence}%`} />}
            {n.note && <Row label="觀察建議" value={n.note} valueStyle={{ color: '#93c5fd', fontSize: 11 }} />}
            {n.date && <Row label="同步日期" value={n.date} valueStyle={{ color: '#64748b' }} />}
            {n.notion_url && (
              <a
                href={n.notion_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'block', marginTop: 8, textAlign: 'center',
                  background: '#1d2b3a', border: '1px solid #334155',
                  borderRadius: 6, padding: '6px 12px',
                  color: '#60a5fa', fontSize: 12, textDecoration: 'none',
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
          {s.entry_reason && <Row label="入場理由" value={s.entry_reason} valueStyle={{ color: '#86efac', fontSize: 11 }} />}
          {s.skip_reason && <Row label="跳過原因" value={s.skip_reason} valueStyle={{ color: '#fca5a5', fontSize: 11 }} />}
        </Section>

        {/* 技術指標 */}
        <Section title="技術指標">
          <Row label="收盤價" value={`${fmt(s.close, 1)} 元`} />
          <Row label="日漲跌" value={pct(s.day_return != null ? s.day_return * 100 : null)} valueStyle={{ color: colorNum(s.day_return) }} />
          <Row label="5日報酬" value={pct(s.return_5d != null ? s.return_5d * 100 : null)} valueStyle={{ color: colorNum(s.return_5d) }} />
          <Row label="RSI(14)" value={fmt(s.rsi14, 1)} valueStyle={{ color: s.rsi14 > 70 ? '#fca5a5' : s.rsi14 < 30 ? '#86efac' : '#e2e8f0' }} />
          <Row label="ADX(14)" value={fmt(s.adx14, 1)} valueStyle={{ color: s.adx14 > 25 ? '#60a5fa' : '#e2e8f0' }} />
          <Row label="ATR(14)" value={fmt(s.atr14, 2)} />
          <Row label="量比" value={`${fmt(s.volume_ratio, 1)}x`} valueStyle={{ color: s.volume_ratio > 2 ? '#facc15' : '#e2e8f0' }} />
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
          <Row label="外資連買天數" value={`${s.foreign_buy_streak || 0} 天`} valueStyle={{ color: s.foreign_buy_streak > 0 ? '#ef4444' : s.foreign_buy_streak < 0 ? '#22c55e' : '#e2e8f0' }} />
          <Row label="外資當日買賣超" value={`${s.foreign_net > 0 ? '+' : ''}${fmt(s.foreign_net, 0)}`} valueStyle={{ color: colorNum(s.foreign_net) }} />
          <Row label="投信連買天數" value={`${s.invest_trust_streak || 0} 天`} valueStyle={{ color: s.invest_trust_streak > 0 ? '#ef4444' : '#e2e8f0' }} />
          <Row label="投信當日買賣超" value={`${s.invest_trust_net > 0 ? '+' : ''}${fmt(s.invest_trust_net, 0)}`} valueStyle={{ color: colorNum(s.invest_trust_net) }} />
          <Row label="自營商連買天數" value={`${s.dealer_buy_streak || 0} 天`} valueStyle={{ color: s.dealer_buy_streak > 0 ? '#ef4444' : '#e2e8f0' }} />
          <Row label="自營商當日買賣超" value={`${s.dealer_net > 0 ? '+' : ''}${fmt(s.dealer_net, 0)}`} valueStyle={{ color: colorNum(s.dealer_net) }} />
        </Section>

        {/* 融資融券 */}
        <Section title="融資融券">
          <Row label="融資5日變化" value={pct(s.margin_change_5d)} valueStyle={{ color: s.margin_change_5d < -3 ? '#4ade80' : s.margin_change_5d > 5 ? '#fca5a5' : '#e2e8f0' }} />
          <Row label="融券/融資比" value={`${fmt(s.short_ratio, 1)}%`} />
          {s.limit_down_streak >= 1 && (
            <Row label="連續跌停" value={`${s.limit_down_streak} 天 ⚠️`} valueStyle={{ color: '#ef4444' }} />
          )}
        </Section>

        {/* 基本面 */}
        <Section title="基本面">
          <Row label="F-Score" value={`${fmt(s.f_score, 0)} / 9`} valueStyle={{ color: s.f_score >= 7 ? '#4ade80' : s.f_score <= 3 ? '#fca5a5' : '#e2e8f0' }} />
        </Section>
      </div>
    </div>
  )
}
