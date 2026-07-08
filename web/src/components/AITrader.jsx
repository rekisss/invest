import { useMemo } from 'react'

const UP = 'var(--ios-red)'      // Taiwan: red = up/gain
const DOWN = 'var(--ios-green)'  // green = down/loss
const nf = (v) => v == null ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 0 })
const pctStr = (v, d = 2) => v == null || isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`
const colorOf = (v) => v == null ? 'var(--ios-label3)' : v >= 0 ? UP : DOWN
const REASON = { take_profit: { t: '停利', c: UP }, stop: { t: '停損', c: DOWN }, time: { t: '持有期滿', c: 'var(--ios-label3)' } }

// ── equity curve (self-contained SVG) ────────────────────────────────────────
function EquityCurve({ curve, startCapital }) {
  const path = useMemo(() => {
    if (!curve || curve.length < 2) return null
    const W = 320, H = 96, pad = 4
    const eqs = curve.map(p => p.equity)
    const min = Math.min(...eqs, startCapital), max = Math.max(...eqs, startCapital)
    const span = max - min || 1
    const x = (i) => pad + i * (W - 2 * pad) / (curve.length - 1)
    const y = (v) => pad + (H - 2 * pad) * (1 - (v - min) / span)
    const line = curve.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.equity).toFixed(1)}`).join(' ')
    const area = `${line} L ${x(curve.length - 1).toFixed(1)} ${H - pad} L ${x(0).toFixed(1)} ${H - pad} Z`
    const baseY = y(startCapital)
    const up = curve[curve.length - 1].equity >= startCapital
    return { W, H, line, area, baseY, up }
  }, [curve, startCapital])
  if (!path) return null
  const stroke = path.up ? '#FF3340' : '#16D67E'
  return (
    <svg viewBox={`0 0 ${path.W} ${path.H}`} width="100%" height="96" preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="aiEqFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" y1={path.baseY} x2={path.W} y2={path.baseY} stroke="var(--ios-label4)" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.6" />
      <path d={path.area} fill="url(#aiEqFill)" />
      <path d={path.line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function Stat({ label, value, color, sub }) {
  return (
    <div style={{ flex: 1, minWidth: 84, background: 'var(--ios-bg3)', borderRadius: 12, padding: '9px 10px', textAlign: 'center' }}>
      <div style={{ fontSize: 10.5, color: 'var(--ios-label3)', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: color || 'var(--ios-label)', fontFamily: 'var(--font-mono)' }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--ios-label4)', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}
function Card({ title, hint, children }) {
  return (
    <div style={{ background: 'var(--ios-bg2)', borderRadius: 16, padding: '14px 15px', marginBottom: 12, boxShadow: 'var(--shadow-card)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ios-label)' }}>{title}</div>
        {hint && <div style={{ fontSize: 10, color: 'var(--ios-label4)' }}>{hint}</div>}
      </div>
      {children}
    </div>
  )
}

export default function AITrader({ data }) {
  const ai = data?.aiTrader
  if (!ai) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--ios-label3)', fontSize: 13, lineHeight: 1.7 }}>
        🤖 AI 操盤資料尚未產生。<br />需要掃描資料累積後,下次資料更新就會出現虛擬交易員的實際操作紀錄。
      </div>
    )
  }
  const c = ai.config
  const s = ai.stats
  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '12px 12px 40px' }}>
      {/* headline */}
      <div style={{ background: 'var(--ios-bg2)', borderRadius: 18, padding: '16px 16px 12px', marginBottom: 12, boxShadow: 'var(--shadow-card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 15 }}>🤖</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-label)' }}>AI 系統交易員</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--ios-label4)' }}>更新 {ai.as_of}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 34, fontWeight: 900, color: colorOf(ai.return_pct), fontFamily: 'var(--font-mono)', letterSpacing: '-1px' }}>{pctStr(ai.return_pct)}</span>
          <span style={{ fontSize: 12, color: 'var(--ios-label3)' }}>總報酬率</span>
        </div>
        <EquityCurve curve={ai.equity_curve} startCapital={c.start_capital} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ios-label3)', marginTop: 6 }}>
          <span>本金 NT${nf(c.start_capital)}</span>
          <span>總資產 <b style={{ color: 'var(--ios-label)', fontFamily: 'var(--font-mono)' }}>NT${nf(ai.equity)}</b></span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ios-label4)', marginTop: 2 }}>
          <span>現金 NT${nf(ai.cash)}</span>
          <span>持股市值 NT${nf(ai.invested)}</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Stat label="勝率" value={s.win_rate == null ? '—' : `${s.win_rate}%`} color={colorOf(s.win_rate != null ? s.win_rate - 50 : null)} sub={`${s.num_trades} 筆已結`} />
        <Stat label="平均報酬" value={pctStr(s.avg_ret)} color={colorOf(s.avg_ret)} />
        <Stat label="最大回落" value={s.max_drawdown_pct == null ? '—' : `-${s.max_drawdown_pct}%`} color={DOWN} />
        <Stat label="操作天數" value={s.trading_days} sub={`自 ${c.start_date}`} />
      </div>

      <Card title="目前持倉" hint={`${ai.positions.length} 檔 · 最多 ${c.max_positions} 檔`}>
        {ai.positions.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--ios-label3)' }}>目前空手(無符合進場訊號的標的)。</div>
        ) : ai.positions.map(p => (
          <div key={p.stock_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '0.5px solid var(--ios-sep)' }}>
            <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{p.stock_id}</span>
            <span style={{ fontSize: 12, color: 'var(--ios-label)' }}>{p.name}</span>
            <span style={{ fontSize: 10, color: 'var(--ios-label4)' }}>{nf(p.shares)}股 @{p.entry} · {p.hold_days}天</span>
            <span style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 800, fontFamily: 'var(--font-mono)', color: colorOf(p.pnl_pct) }}>{pctStr(p.pnl_pct, 1)}</span>
          </div>
        ))}
      </Card>

      <Card title="近期交易紀錄" hint={`已結 ${s.num_trades} 筆`}>
        {ai.trades.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--ios-label3)' }}>尚無已結交易。</div>
        ) : ai.trades.map((t, i) => {
          const r = REASON[t.reason] || { t: t.reason, c: 'var(--ios-label3)' }
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '0.5px solid var(--ios-sep)' }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{t.stock_id}</span>
              <span style={{ fontSize: 11.5, color: 'var(--ios-label)' }}>{t.name}</span>
              <span style={{ fontSize: 9.5, color: r.c, background: `${r.c}1a`, padding: '1px 5px', borderRadius: 4 }}>{r.t}</span>
              <span style={{ fontSize: 9.5, color: 'var(--ios-label4)' }}>{t.entry_date}~{t.exit_date}</span>
              <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 800, fontFamily: 'var(--font-mono)', color: colorOf(t.ret_pct) }}>{pctStr(t.ret_pct, 1)}</span>
            </div>
          )
        })}
      </Card>

      <div style={{ fontSize: 9.5, color: 'var(--ios-label4)', lineHeight: 1.6, padding: '2px 6px' }}>
        規則:自 {c.start_date} 起以 NT${nf(c.start_capital)} 虛擬本金,每日買進掃描分數最高的進場訊號股(最多 {c.max_positions} 檔、等權),
        觸及 +{c.take_profit_pct}% 停利 / −{c.stop_loss_pct}% 停損 / 持有 {c.max_hold} 日則出場;報酬已扣交易成本(手續費+證交稅)。<br />
        這是「完全照這套策略機械操作」的虛擬紀錄,可完整重現,非投資建議、非真實下單。樣本累積越久越有參考價值。
      </div>
    </div>
  )
}
