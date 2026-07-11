import { useMemo, useState, useCallback } from 'react'
import LiveTraderPanel from './LiveTraderPanel'

const UP = 'var(--ios-red)'      // Taiwan: red = up/gain
const DOWN = 'var(--ios-green)'  // green = down/loss
const nf = (v) => v == null ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 0 })
const pctStr = (v, d = 2) => v == null || isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`
const colorOf = (v) => v == null ? 'var(--ios-label3)' : v >= 0 ? UP : DOWN
const REASON = { take_profit: { t: '停利', c: UP }, stop: { t: '停損', c: DOWN }, time: { t: '持有期滿', c: 'var(--ios-label3)' } }

// entry_reason 的英文訊號代碼 → 中文短標籤(顯示層翻譯;資料保存原始代碼)
const SIGNAL_LABELS = {
  foreign_buy_3d: '外資連買3日',
  invest_trust_buy_2d: '投信連買2日',
  dealer_buy_3d: '自營連買3日',
  kd_golden_cross: 'KD金叉',
  macd_golden_cross: 'MACD金叉',
  hist_turn_positive: 'MACD柱轉正',
  breakout_20d: '突破20日高',
  bb_squeeze_breakout: '布林壓縮突破',
  breakout_volume_confirm: '突破帶量確認',
  obv_uptrend: 'OBV上升',
  adx_trending: 'ADX趨勢',
  stronger_than_market: '強於大盤',
  volume_break: '爆量',
  rsi_strong: 'RSI強勢',
  mfi_strong: 'MFI資金流入',
  above_ichimoku_cloud: '站上一目雲',
  williams_r_recovery: '威廉指標回升',
  cci_momentum: 'CCI動能',
  ma5_above_ma10: 'MA5>MA10',
  above_ema60: '站上60日線',
  ema60_gt_ema120: '中期多頭排列',
  market_above_ma60: '大盤站上60日線',
}
// gate/篩選類代碼不是「買進理由」,展開時過濾不顯示
const GATE_SIGNALS = new Set(['liquidity_ok', 'avoid_chase', 'earnings_blocked', 'skip_trade'])

function parseSignals(entryReason) {
  if (!entryReason) return []
  return String(entryReason)
    .split(',')
    .map(s => s.trim())
    .filter(s => s && !GATE_SIGNALS.has(s))
    .map(s => SIGNAL_LABELS[s] || s)
}

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

function SignalChips({ signals }) {
  if (!signals.length) return null
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 5 }}>
      {signals.map(sig => (
        <span key={sig} style={{
          fontSize: 9.5, fontWeight: 600, color: 'var(--ios-blue)',
          background: 'rgba(10,132,255,0.1)', border: '0.5px solid rgba(10,132,255,0.22)',
          padding: '1px 6px', borderRadius: 5,
        }}>{sig}</span>
      ))}
    </div>
  )
}

// 買進段落(交易與持倉展開共用):日期/價格/股數/金額 + 排名/分數/評級 + 訊號 chips
function BuyDetail({ date, price, shares, cost, dayRank, score, grade, signals, hasDetail }) {
  if (!hasDetail) {
    return (
      <div style={{ fontSize: 10.5, color: 'var(--ios-label4)', padding: '6px 0 2px' }}>
        📄 買進明細將於下次資料更新後出現。
      </div>
    )
  }
  return (
    <div style={{ padding: '7px 9px', background: 'var(--ios-fill4)', borderRadius: 8, marginTop: 6 }}>
      <div style={{ fontSize: 10.5, color: 'var(--ios-label2)', lineHeight: 1.6 }}>
        <span style={{ fontWeight: 700 }}>📥 買進</span> {date} · @{price}{shares != null ? ` × ${nf(shares)} 股` : ''}{cost != null ? `(約 NT$${nf(cost)})` : ''}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 2 }}>
        {dayRank != null && <>當日進場訊號第 <b style={{ color: 'var(--ios-label)' }}>{dayRank}</b> 名</>}
        {score != null && <> · 分數 <b style={{ color: 'var(--ios-label)', fontFamily: 'var(--font-mono)' }}>{nf(score)}</b></>}
        {grade ? <> · 評級 <b style={{ color: grade === 'A' ? '#FFD60A' : grade === 'B' ? '#16D67E' : 'var(--ios-label)' }}>{grade}</b></> : null}
      </div>
      <SignalChips signals={signals} />
    </div>
  )
}

function exitText(t, maxHold) {
  if (t.reason === 'take_profit') return `觸及停利 +8%${t.tp_price != null ? `(${t.tp_price} 元)` : ''}`
  if (t.reason === 'stop') return `觸及停損 −12%${t.sl_price != null ? `(${t.sl_price} 元)` : ''}`
  if (t.reason === 'time') return `持有滿 ${maxHold ?? 15} 日期滿出場`
  return t.reason
}

export default function AITrader({ data }) {
  const ai = data?.aiTrader
  const [openTrade, setOpenTrade] = useState(null)
  const [openPos, setOpenPos] = useState(null)
  const toggleTrade = useCallback((i) => setOpenTrade(cur => (cur === i ? null : i)), [])
  const togglePos = useCallback((i) => setOpenPos(cur => (cur === i ? null : i)), [])

  if (!ai) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--ios-label3)', fontSize: 13, lineHeight: 1.7 }}>
        🤖 AI 操盤資料尚未產生。<br />需要掃描資料累積後,下次資料更新就會出現虛擬交易員的實際操作紀錄。
      </div>
    )
  }
  const c = ai.config
  const s = ai.stats
  const exits = s.exits
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

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <Stat label="勝率" value={s.win_rate == null ? '—' : `${s.win_rate}%`} color={colorOf(s.win_rate != null ? s.win_rate - 50 : null)} sub={`${s.num_trades} 筆已結`} />
        <Stat label="平均報酬" value={pctStr(s.avg_ret)} color={colorOf(s.avg_ret)} />
        <Stat label="最大回落" value={s.max_drawdown_pct == null ? '—' : `-${s.max_drawdown_pct}%`} color={DOWN} />
        <Stat label="操作天數" value={s.trading_days} sub={`自 ${c.start_date}`} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Stat label="出場分佈" value={exits ? `${exits.take_profit}/${exits.stop}/${exits.time}` : '—'} sub="停利/停損/期滿" />
        <Stat label="平均持有" value={s.avg_hold_days == null ? '—' : `${s.avg_hold_days} 天`} />
        <Stat label="獲利因子" value={s.profit_factor == null ? '—' : s.profit_factor} color={s.profit_factor != null ? colorOf(s.profit_factor - 1) : undefined} sub="總益÷總損" />
        <Stat label="總交易成本" value={s.total_fees == null ? '—' : `$${nf(s.total_fees)}`} sub="手續費+稅" />
      </div>

      <LiveTraderPanel ai={ai} scan={data?.scans?.[data?.dates?.[0]]} />

      <Card title="目前持倉" hint={`${ai.positions.length} 檔 · 最多 ${c.max_positions} 檔 · 點擊看明細`}>
        {ai.positions.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--ios-label3)' }}>目前空手(無符合進場訊號的標的)。</div>
        ) : ai.positions.map((p, i) => {
          const open = openPos === i
          const signals = parseSignals(p.entry_reason)
          const hasDetail = p.entry_score != null || signals.length > 0 || p.cost != null
          const unrealized = p.price != null && p.entry != null && p.shares != null
            ? Math.round((p.price - p.entry) * p.shares) : null
          const toTp = (p.tp_price != null && p.price > 0) ? (p.tp_price / p.price - 1) * 100 : null
          return (
            <div key={p.stock_id} style={{ borderTop: '0.5px solid var(--ios-sep)' }}>
              <div onClick={() => togglePos(i)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', cursor: 'pointer' }}>
                <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{p.stock_id}</span>
                <span style={{ fontSize: 12, color: 'var(--ios-label)' }}>{p.name}</span>
                <span style={{ fontSize: 10, color: 'var(--ios-label4)' }}>{nf(p.shares)}股 @{p.entry} · {p.hold_days}天</span>
                <span style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 800, fontFamily: 'var(--font-mono)', color: colorOf(p.pnl_pct) }}>{pctStr(p.pnl_pct, 1)}</span>
                <span style={{ fontSize: 9, color: 'var(--ios-label4)' }}>{open ? '▲' : '▼'}</span>
              </div>
              {open && (
                <div style={{ paddingBottom: 10 }}>
                  <BuyDetail date={p.entry_date} price={p.entry} shares={p.shares} cost={p.cost}
                    dayRank={p.day_rank} score={p.entry_score} grade={p.grade} signals={signals} hasDetail={hasDetail} />
                  <div style={{ padding: '7px 9px', background: 'var(--ios-fill4)', borderRadius: 8, marginTop: 5, fontSize: 10.5, color: 'var(--ios-label2)', lineHeight: 1.7 }}>
                    <span style={{ fontWeight: 700 }}>🎯 出場計畫</span>
                    {p.tp_price != null && <> · 停利 <b style={{ color: UP, fontFamily: 'var(--font-mono)' }}>{p.tp_price}</b>{toTp != null ? `(還差 ${pctStr(toTp, 1)})` : ''}</>}
                    {p.sl_price != null && <> · 停損 <b style={{ color: DOWN, fontFamily: 'var(--font-mono)' }}>{p.sl_price}</b></>}
                    <> · 期滿 {c.max_hold} 日</>
                    {unrealized != null && <div style={{ fontSize: 10, color: colorOf(unrealized), marginTop: 2 }}>未實現損益 NT${nf(unrealized)}(現價 {p.price})</div>}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </Card>

      <Card title="交易明細" hint={`已結 ${s.num_trades} 筆 · 點擊看買賣理由`}>
        {ai.trades.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--ios-label3)' }}>尚無已結交易。</div>
        ) : ai.trades.map((t, i) => {
          const r = REASON[t.reason] || { t: t.reason, c: 'var(--ios-label3)' }
          const open = openTrade === i
          const signals = parseSignals(t.entry_reason)
          const hasDetail = t.entry_score != null || signals.length > 0 || t.cost != null
          return (
            <div key={i} style={{ borderTop: '0.5px solid var(--ios-sep)' }}>
              <div onClick={() => toggleTrade(i)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', cursor: 'pointer' }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{t.stock_id}</span>
                <span style={{ fontSize: 11.5, color: 'var(--ios-label)' }}>{t.name}</span>
                <span style={{ fontSize: 9.5, color: r.c, background: `${r.c}1a`, padding: '1px 5px', borderRadius: 4 }}>{r.t}</span>
                <span style={{ fontSize: 9.5, color: 'var(--ios-label4)' }}>{t.entry_date}~{t.exit_date}</span>
                <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 800, fontFamily: 'var(--font-mono)', color: colorOf(t.ret_pct) }}>{pctStr(t.ret_pct, 1)}</span>
                <span style={{ fontSize: 9, color: 'var(--ios-label4)' }}>{open ? '▲' : '▼'}</span>
              </div>
              {open && (
                <div style={{ paddingBottom: 10 }}>
                  <BuyDetail date={t.entry_date} price={t.entry} shares={t.shares} cost={t.cost}
                    dayRank={t.day_rank} score={t.entry_score} grade={t.grade} signals={signals} hasDetail={hasDetail} />
                  <div style={{ padding: '7px 9px', background: 'var(--ios-fill4)', borderRadius: 8, marginTop: 5, fontSize: 10.5, color: 'var(--ios-label2)', lineHeight: 1.7 }}>
                    <span style={{ fontWeight: 700 }}>📤 賣出</span> {t.exit_date} · @{t.exit} · {exitText(t, c.max_hold)}
                    <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 2 }}>
                      持有 {t.hold_days} 個交易日
                      {t.fees != null && <> · 手續費+稅 NT${nf(t.fees)}</>}
                      {t.pnl != null && <> · 淨損益 <b style={{ color: colorOf(t.pnl), fontFamily: 'var(--font-mono)' }}>NT${nf(t.pnl)}</b></>}
                    </div>
                  </div>
                </div>
              )}
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
