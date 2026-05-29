const fmt = (v, dec = 2) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(dec))
const pct = (v) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`)
const colorNum = (v, pos = '#ef4444', neg = '#4ade80') => {
  const n = Number(v)
  if (isNaN(n) || n === 0) return '#94a3b8'
  return n > 0 ? pos : neg
}

// Taiwan stocks: TWSE for main board, TPEX for OTC
// Stock IDs starting with 4, 6, 8 (4000-4999, 6000-6999, 8000-8999) are often OTC
function tvSymbol(stockId) {
  const id = String(stockId)
  const n = parseInt(id, 10)
  // OTC (TPEX): roughly 4000-4999, 6000-6999, 8000-8999, some 5000s
  const isOTC = (n >= 4000 && n <= 4999) || (n >= 6000 && n <= 6999) || (n >= 8000 && n <= 8999)
  return `${isOTC ? 'TPEX' : 'TWSE'}:${id}`
}

function TradingViewChart({ stockId }) {
  const sym = tvSymbol(stockId)
  const src = `https://www.tradingview.com/widgetembed/?hideideas=1&symbol=${encodeURIComponent(sym)}&interval=D&theme=dark&style=1&locale=zh_TW&allow_symbol_change=1&saveimage=0&hide_top_toolbar=0&hide_legend=0`
  return (
    <div style={{ width: '100%', borderRadius: 8, overflow: 'hidden', background: '#0f172a' }}>
      <iframe
        key={stockId}
        src={src}
        style={{ width: '100%', height: 360, border: 'none', display: 'block' }}
        allowTransparency="true"
        frameBorder="0"
        scrolling="no"
        allowFullScreen
        title={`TradingView ${stockId}`}
      />
      <div style={{ fontSize: 10, color: '#334155', padding: '2px 6px', textAlign: 'right' }}>
        TradingView · 可切換時間框架
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
  const scoreColor = s.entry_score >= 1800 ? '#facc15' : s.entry_score >= 1500 ? '#fb923c' : '#e2e8f0'

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

        {/* TradingView chart */}
        <Section title={`K 線圖 · ${tvSymbol(s.stock_id)}`}>
          <TradingViewChart stockId={s.stock_id} />
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
