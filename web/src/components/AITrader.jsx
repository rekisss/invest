import { useMemo, useState, useCallback } from 'react'
import LiveTraderPanel from './LiveTraderPanel'
import { useLivePrices, isTWSEOpen, isScanDataCurrent } from '../hooks/useLivePrices'

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
function EquityCurve({ curve, startCapital, benchmark }) {
  const path = useMemo(() => {
    if (!curve || curve.length < 2) return null
    const W = 320, H = 96, pad = 4
    const eqs = curve.map(p => p.equity)
    // 基準曲線(ret_pct)換算成同一權益尺度,一起參與 min/max
    const benchEqs = (benchmark?.curve || []).map(p => startCapital * (1 + p.ret_pct / 100))
    const min = Math.min(...eqs, ...benchEqs, startCapital), max = Math.max(...eqs, ...benchEqs, startCapital)
    const span = max - min || 1
    const x = (i, n) => pad + i * (W - 2 * pad) / (n - 1)
    const y = (v) => pad + (H - 2 * pad) * (1 - (v - min) / span)
    const line = curve.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i, curve.length).toFixed(1)} ${y(p.equity).toFixed(1)}`).join(' ')
    const area = `${line} L ${x(curve.length - 1, curve.length).toFixed(1)} ${H - pad} L ${x(0, curve.length).toFixed(1)} ${H - pad} Z`
    const benchLine = benchEqs.length >= 2
      ? benchEqs.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i, benchEqs.length).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
      : null
    const baseY = y(startCapital)
    const up = curve[curve.length - 1].equity >= startCapital
    return { W, H, line, area, benchLine, baseY, up }
  }, [curve, startCapital, benchmark])
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
      {path.benchLine && <path d={path.benchLine} fill="none" stroke="var(--ios-label3)" strokeWidth="1.1" strokeDasharray="4 3" strokeLinejoin="round" opacity="0.85" />}
      <path d={path.line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

// ── rule-lab overlay chart:主帳戶 + 變體 ret_pct 疊線 ───────────────────────
const VARIANT_COLORS = { next_open: '#FF9F0A', rs_mom: '#66D4CF', bear_filter: '#5E5CE6', trail8: '#BF5AF2', tp12: '#64D2FF', tp5: '#FFD60A', pos3: '#FF6482', random: '#8E8E93', rev_growth: '#A2845E' }
// 風險指標 chips — 讓 meta 帳戶(自我學習/群體智慧)除了報酬,也能比「顛簸程度」。
// 群體智慧的賣點就是分散 → 理論上回落/波動較低,這排數字讓使用者直接看得到。
function RiskChips({ risk }) {
  if (!risk) return null
  const items = [
    risk.max_drawdown_pct != null && ['最大回落', `-${risk.max_drawdown_pct}%`, DOWN],
    risk.volatility_pct != null && ['日波動', `${risk.volatility_pct}%`, 'var(--ios-label2)'],
    risk.return_over_mdd != null && ['報酬÷回落', `${risk.return_over_mdd}`, colorOf(risk.return_over_mdd)],
  ].filter(Boolean)
  if (!items.length) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
      {items.map(([label, val, color]) => (
        <span key={label} style={{ fontSize: 9.5, background: 'var(--ios-fill3)', borderRadius: 5, padding: '1px 6px', color: 'var(--ios-label3)' }}>
          {label} <b style={{ fontFamily: 'var(--font-mono)', color }}>{val}</b>
        </span>
      ))}
    </div>
  )
}

function VariantChart({ mainCurve, variants, adaptive, ensemble }) {
  const path = useMemo(() => {
    if (!mainCurve || mainCurve.length < 2) return null
    const W = 320, H = 84, pad = 4
    const series = [
      { id: 'main', color: 'var(--ios-blue)', vals: mainCurve.map(p => p.ret_pct), width: 1.8 },
      ...(variants || []).filter(v => Array.isArray(v.curve) && v.curve.length >= 2)
        .map(v => ({ id: v.id, color: VARIANT_COLORS[v.id] || 'var(--ios-label3)', vals: v.curve, width: 1.1 })),
      ...(adaptive?.curve?.length >= 2
        ? [{ id: 'adaptive', color: '#30D158', vals: adaptive.curve.map(p => p.ret_pct), width: 1.8 }]
        : []),
      ...(ensemble?.curve?.length >= 2
        ? [{ id: 'ensemble', color: '#FF9F0A', vals: ensemble.curve.map(p => p.ret_pct), width: 1.8 }]
        : []),
    ]
    const all = series.flatMap(s => s.vals)
    const min = Math.min(...all, 0), max = Math.max(...all, 0)
    const span = max - min || 1
    const y = (v) => pad + (H - 2 * pad) * (1 - (v - min) / span)
    const lines = series.map(s => ({
      ...s,
      d: s.vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${(pad + i * (W - 2 * pad) / (s.vals.length - 1)).toFixed(1)} ${y(v).toFixed(1)}`).join(' '),
    }))
    return { W, H, lines, zeroY: y(0) }
  }, [mainCurve, variants])
  if (!path) return null
  return (
    <svg viewBox={`0 0 ${path.W} ${path.H}`} width="100%" height="84" preserveAspectRatio="none" style={{ display: 'block', marginBottom: 8 }}>
      <line x1="0" y1={path.zeroY} x2={path.W} y2={path.zeroY} stroke="var(--ios-label4)" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.6" />
      {path.lines.map(l => (
        <path key={l.id} d={l.d} fill="none" stroke={l.color} strokeWidth={l.width} strokeLinejoin="round" opacity={l.id === 'main' ? 1 : 0.9} />
      ))}
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

function FragmentRow({ v, isMain, open, onToggle }) {
  const dot = isMain ? 'var(--ios-blue)' : (VARIANT_COLORS[v.id] || 'var(--ios-label3)')
  // 變體可點開看實際買賣明細;主帳戶明細在上方完整卡片,不重複展開
  const clickable = !isMain && ((v.trades?.length || 0) + (v.positions?.length || 0) > 0)
  const cellClick = clickable ? onToggle : undefined
  const cellCursor = clickable ? 'pointer' : 'default'
  return (
    <>
      <span onClick={cellClick} style={{ minWidth: 0, cursor: cellCursor }}>
        <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 4, background: dot, marginRight: 5, verticalAlign: 'middle' }} />
        <span style={{ fontSize: 11, fontWeight: isMain ? 800 : 600, color: isMain ? 'var(--ios-blue)' : 'var(--ios-label)' }}>{v.label}</span>
        {v.control && (
          <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--ios-label3)', border: '0.5px solid var(--ios-sep)', borderRadius: 5, padding: '0 4px', marginLeft: 4, verticalAlign: 'middle' }}>對照</span>
        )}
        {clickable && <span style={{ fontSize: 8, color: 'var(--ios-label4)', marginLeft: 4 }}>{open ? '▲' : '▼'}</span>}
        {v.note && <span style={{ display: 'block', fontSize: 9, color: 'var(--ios-label4)' }}>{v.note}</span>}
      </span>
      <span onClick={cellClick} style={{ textAlign: 'right', fontWeight: 800, fontFamily: 'var(--font-mono)', color: colorOf(v.return_pct), cursor: cellCursor }}>{pctStr(v.return_pct, 1)}</span>
      <span onClick={cellClick} style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--ios-label2)', cursor: cellCursor }}>{v.win_rate == null ? '—' : `${Math.round(v.win_rate)}%`}</span>
      <span onClick={cellClick} style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--ios-label3)', cursor: cellCursor }}>{v.max_drawdown_pct == null ? '—' : `-${v.max_drawdown_pct}%`}</span>
      <span onClick={cellClick} style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--ios-label3)', cursor: cellCursor }}>{v.num_trades ?? '—'}</span>
      {open && !isMain && (
        <div style={{ gridColumn: '1 / -1', background: 'var(--ios-fill4)', borderRadius: 10, padding: '8px 10px', marginBottom: 2 }}>
          {(v.positions?.length || 0) > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--ios-label3)', marginBottom: 3 }}>目前持倉</div>
              {v.positions.map(p => (
                <div key={p.stock_id} style={{ display: 'flex', gap: 8, fontSize: 10.5, padding: '2px 0', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--ios-blue)' }}>{p.stock_id}</span>
                  <span style={{ color: 'var(--ios-label)' }}>{p.name}</span>
                  <span style={{ color: 'var(--ios-label4)', fontSize: 9.5 }}>{p.entry_date} @{p.entry}</span>
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontWeight: 700, color: colorOf(p.pnl_pct) }}>{pctStr(p.pnl_pct, 1)}</span>
                </div>
              ))}
            </div>
          )}
          {(v.trades?.length || 0) > 0 ? (
            <div>
              <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--ios-label3)', marginBottom: 3 }}>最近交易(新→舊)</div>
              {v.trades.map((t, i) => {
                const r = REASON[t.reason] || { t: t.reason, c: 'var(--ios-label3)' }
                return (
                  <div key={i} style={{ display: 'flex', gap: 7, fontSize: 10.5, padding: '2px 0', alignItems: 'center' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--ios-blue)' }}>{t.stock_id}</span>
                    <span style={{ color: 'var(--ios-label)' }}>{t.name}</span>
                    <span style={{ fontSize: 9, color: r.c, background: `${r.c}1a`, padding: '0 4px', borderRadius: 4 }}>{r.t}</span>
                    <span style={{ color: 'var(--ios-label4)', fontSize: 9.5 }}>{t.entry_date}→{t.exit_date}</span>
                    <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontWeight: 700, color: colorOf(t.ret_pct) }}>{pctStr(t.ret_pct, 1)}</span>
                  </div>
                )
              })}
            </div>
          ) : (v.positions?.length || 0) === 0 && (
            <div style={{ fontSize: 10.5, color: 'var(--ios-label3)' }}>尚無交易紀錄。</div>
          )}
        </div>
      )}
    </>
  )
}

function exitText(t, maxHold) {
  if (t.reason === 'take_profit') return `觸及停利 +8%${t.tp_price != null ? `(${t.tp_price} 元)` : ''}`
  if (t.reason === 'stop') return `觸及停損 −12%${t.sl_price != null ? `(${t.sl_price} 元)` : ''}`
  if (t.reason === 'time') return `持有滿 ${maxHold ?? 15} 日期滿出場`
  return t.reason
}

// 每晚日報(由 daily_report workflow 寫進 repo)— 最新一份展開,歷史可點開
function ReportCard({ reports }) {
  const [openIdx, setOpenIdx] = useState(0)
  if (!Array.isArray(reports) || reports.length === 0) return null
  return (
    <Card title="📜 操盤日報" hint={`每晚 21:30 產生 · ${reports.length} 份`}>
      {reports.map((r, i) => {
        const open = openIdx === i
        return (
          <div key={r.date} style={{ borderTop: i > 0 ? '0.5px solid var(--ios-sep)' : 'none' }}>
            <div onClick={() => setOpenIdx(cur => (cur === i ? null : i))}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', cursor: 'pointer' }}>
              <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{r.date}</span>
              {i === 0 && <span style={{ fontSize: 9, color: 'var(--ios-green)', fontWeight: 700 }}>最新</span>}
              <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--ios-label4)' }}>{open ? '▲' : '▼'}</span>
            </div>
            {open && (
              <div style={{ paddingBottom: 10, display: 'grid', gap: 5 }}>
                {(r.lines || []).map((line, j) => (
                  <div key={j} style={{
                    fontSize: 11.5, lineHeight: 1.65, color: 'var(--ios-label2)',
                    background: line.startsWith('🧠') ? 'rgba(10,132,255,0.07)' : 'var(--ios-fill4)',
                    borderRadius: 8, padding: '7px 10px',
                    border: line.startsWith('🧠') ? '0.5px solid rgba(10,132,255,0.2)' : 'none',
                  }}>{line}</div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </Card>
  )
}

export default function AITrader({ data }) {
  const ai = data?.aiTrader
  const [openTrade, setOpenTrade] = useState(null)
  const [openPos, setOpenPos] = useState(null)
  // 盤中即時報價(由 LiveTraderPanel 的 WS/REST 分享上來)。持倉卡的 price
  // 是每晚 build 的收盤價,盤中會過期——有即時價時蓋過顯示並標 ⚡。
  const [liveQuotes, setLiveQuotes] = useState({})
  const [openVariant, setOpenVariant] = useState(null) // 規則實驗室展開的變體
  const toggleTrade = useCallback((i) => setOpenTrade(cur => (cur === i ? null : i)), [])
  const togglePos = useCallback((i) => setOpenPos(cur => (cur === i ? null : i)), [])
  // 後備即時層:WS(LiveTraderPanel)沒開/沒金鑰時,AI 持倉照樣跟即時價;
  // 收盤後~晚間資料建置前的空窗(isScanDataCurrent=false),p.price 還是前一
  // 交易日收盤 → 用快取的今日收盤。資料已是今日(晚間入帳後)就不用後備,
  // 避免舊快取蓋過已結算價(「慢一天」bug 的老路)。
  const posIds = useMemo(() => (ai?.positions || []).map(p => String(p.stock_id)), [ai])
  const { prices: hookPrices } = useLivePrices(posIds)
  const useHookPx = isTWSEOpen() || !isScanDataCurrent(ai?.as_of)
  const pxOf = (id) => liveQuotes[id]?.price ?? (useHookPx ? hookPrices[id]?.price : undefined)

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
        <EquityCurve curve={ai.equity_curve} startCapital={c.start_capital} benchmark={ai.benchmark} />
        {ai.benchmark?.return_pct != null && (() => {
          const diff = Math.round((ai.return_pct - ai.benchmark.return_pct) * 100) / 100
          return (
            <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 4 }}>
              灰虛線:同期{ai.benchmark.label} <b style={{ fontFamily: 'var(--font-mono)', color: colorOf(ai.benchmark.return_pct) }}>{pctStr(ai.benchmark.return_pct, 1)}</b>
              <span style={{ marginLeft: 6 }}>AI {diff >= 0 ? '領先' : '落後'} <b style={{ fontFamily: 'var(--font-mono)', color: colorOf(diff) }}>{Math.abs(diff).toFixed(1)}pp</b></span>
            </div>
          )
        })()}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ios-label3)', marginTop: 6 }}>
          <span>本金 NT${nf(c.start_capital)}</span>
          <span>總資產 <b style={{ color: 'var(--ios-label)', fontFamily: 'var(--font-mono)' }}>NT${nf(ai.equity)}</b></span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ios-label4)', marginTop: 2 }}>
          <span>現金 NT${nf(ai.cash)}</span>
          <span>持股市值 NT${nf(ai.invested)}</span>
        </div>
        {(() => {
          // 即時估值:任何持倉有即時/今日價時,重算總資產(標 ⚡)。來源:
          // WS 分享的 liveQuotes 優先,其次 useLivePrices 後備層(見上方)。
          const hasLive = ai.positions?.some(p => pxOf(String(p.stock_id)) != null)
          if (!hasLive) return null
          const liveInvested = ai.positions.reduce((a, p) => a + p.shares * (pxOf(String(p.stock_id)) ?? p.price ?? p.entry), 0)
          const liveEquity = Math.round(ai.cash + liveInvested)
          const liveRet = (liveEquity / c.start_capital - 1) * 100
          const label = isTWSEOpen() ? '盤中即時估值' : '今日收盤估值(晚間正式入帳前)'
          return (
            <div style={{ fontSize: 10.5, marginTop: 4, color: '#66D4CF', fontWeight: 700 }}>
              ⚡ {label} NT${nf(liveEquity)}(<span style={{ color: colorOf(liveRet) }}>{pctStr(liveRet, 2)}</span>)
            </div>
          )
        })()}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <Stat label="勝率" value={s.win_rate == null ? '—' : `${s.win_rate}%`} color={colorOf(s.win_rate != null ? s.win_rate - 50 : null)}
          sub={s.num_trades < 30 ? `樣本累積中 ${s.num_trades}/30 筆` : `${s.num_trades} 筆已結`} />
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

      <LiveTraderPanel ai={ai} scan={data?.scans?.[data?.dates?.[0]]} onQuotes={setLiveQuotes} />

      <ReportCard reports={data?.aiReports} />

      {ai.plan && (
        <Card title="📋 明日作戰計畫" hint={`依 ${ai.plan.as_of} 掃描推導`}>
          {ai.plan.buys?.length > 0 ? (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', marginBottom: 4 }}>
                開盤補進(空槽 {ai.plan.free_slots} 檔{ai.plan.est_budget_each ? ` · 每檔預算約 NT$${nf(ai.plan.est_budget_each)}` : ''})
              </div>
              {ai.plan.buys.map(b => (
                <div key={b.stock_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '0.5px solid var(--ios-sep)' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{b.stock_id}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--ios-label)' }}>{b.name}</span>
                  <span style={{ fontSize: 9.5, color: 'var(--ios-label4)' }}>第 {b.rank} 順位</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--ios-label2)', fontFamily: 'var(--font-mono)' }}>
                    分 {b.entry_score}{b.grade ? ` · ${b.grade}` : ''}{b.close != null ? ` · 收 ${b.close}` : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--ios-label3)', marginBottom: 6 }}>
              {ai.plan.free_slots === 0 ? '滿倉中,明日開盤不補新單。' : `有 ${ai.plan.free_slots} 個空槽,但最新掃描沒有(未持有的)進場訊號 → 明日不進新單,續抱等訊號。`}
            </div>
          )}
          {ai.plan.exits?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', margin: '6px 0 4px' }}>武裝中的出場單</div>
              {ai.plan.exits.map(e => (
                <div key={e.stock_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '0.5px solid var(--ios-sep)', fontSize: 10.5 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{e.stock_id}</span>
                  <span style={{ fontSize: 11, color: 'var(--ios-label)' }}>{e.name}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--ios-label2)', fontFamily: 'var(--font-mono)' }}>
                    {e.tp_price != null && <>停利 <b style={{ color: UP }}>{e.tp_price}</b></>}
                    {e.sl_price != null && <> · 停損 <b style={{ color: DOWN }}>{e.sl_price}</b></>}
                    <> · 期滿剩 {e.days_left} 日</>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card title="目前持倉" hint={`${ai.positions.length} 檔 · 最多 ${c.max_positions} 檔 · 點擊看明細`}>
        {ai.positions.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--ios-label3)' }}>目前空手(無符合進場訊號的標的)。</div>
        ) : ai.positions.map((p, i) => {
          const open = openPos === i
          const signals = parseSignals(p.entry_reason)
          const hasDetail = p.entry_score != null || signals.length > 0 || p.cost != null
          // 有即時/今日價(WS 或後備層)就用它估值並標 ⚡;
          // 否則用每晚 build 的收盤價(p.price)——修正「持倉價位盤中過期」
          const livePx = pxOf(String(p.stock_id))
          const px = livePx ?? p.price
          const pnlPct = (px != null && p.entry > 0) ? (px / p.entry - 1) * 100 : p.pnl_pct
          const unrealized = px != null && p.entry != null && p.shares != null
            ? Math.round((px - p.entry) * p.shares) : null
          const toTp = (p.tp_price != null && px > 0) ? (p.tp_price / px - 1) * 100 : null
          return (
            <div key={p.stock_id} style={{ borderTop: '0.5px solid var(--ios-sep)' }}>
              <div onClick={() => togglePos(i)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', cursor: 'pointer' }}>
                <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{p.stock_id}</span>
                <span style={{ fontSize: 12, color: 'var(--ios-label)' }}>{p.name}</span>
                <span style={{ fontSize: 10, color: 'var(--ios-label4)' }}>{nf(p.shares)}股 @{p.entry} · {p.hold_days}天</span>
                {livePx != null && <span style={{ fontSize: 9, color: '#66D4CF', fontWeight: 700 }}>⚡{livePx}</span>}
                <span style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 800, fontFamily: 'var(--font-mono)', color: colorOf(pnlPct) }}>{pctStr(pnlPct, 1)}</span>
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
                    {unrealized != null && <div style={{ fontSize: 10, color: colorOf(unrealized), marginTop: 2 }}>未實現損益 NT${nf(unrealized)}(現價 {px}{livePx != null ? ' ⚡即時' : ''})</div>}
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

      {Array.isArray(ai.variants) && ai.variants.length > 0 && (
        <Card title="🧪 規則實驗室" hint="同資料、同起點,只換規則的平行帳戶">
          {ai.adaptive && (
            <div style={{ background: 'rgba(48,209,88,0.08)', border: '0.5px solid rgba(48,209,88,0.3)', borderRadius: 10, padding: '8px 11px', marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, fontWeight: 800, color: '#30D158', display: 'flex', alignItems: 'center', gap: 6 }}>
                🎓 自我學習帳戶
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', color: colorOf(ai.adaptive.return_pct) }}>{pctStr(ai.adaptive.return_pct, 1)}</span>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--ios-label2)', lineHeight: 1.7, marginTop: 3 }}>
                目前跟隨:<b>{ai.adaptive.follow_label}</b> · 已切換 {ai.adaptive.num_switches} 次
                {ai.adaptive.learning_active
                  ? ' · 學習中(每日評估近10日實績,領先>1pp才換,換倉扣0.7%)'
                  : ` · 樣本累積中(已結 ${ai.adaptive.samples?.closed_trades ?? 0}/${ai.adaptive.samples?.required ?? 10} 筆,足夠後開始自動換規則)`}
              </div>
              {ai.adaptive.switches?.length > 0 && (
                <div style={{ fontSize: 9.5, color: 'var(--ios-label3)', marginTop: 4, lineHeight: 1.6 }}>
                  {ai.adaptive.switches.slice(-3).map((s, i) => (
                    <div key={i}>{s.date}:{s.from} → <b>{s.to}</b>(近10日 {pctStr(s.from_trail_pct, 1)} vs {pctStr(s.to_trail_pct, 1)})</div>
                  ))}
                </div>
              )}
              <RiskChips risk={ai.adaptive.risk} />
            </div>
          )}
          {ai.ensemble && (
            <div style={{ background: 'rgba(255,159,10,0.08)', border: '0.5px solid rgba(255,159,10,0.3)', borderRadius: 10, padding: '8px 11px', marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, fontWeight: 800, color: '#FF9F0A', display: 'flex', alignItems: 'center', gap: 6 }}>
                🧠 群體智慧帳戶
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', color: colorOf(ai.ensemble.return_pct) }}>{pctStr(ai.ensemble.return_pct, 1)}</span>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--ios-label2)', lineHeight: 1.7, marginTop: 3 }}>
                參考<b>全體交易員</b>、按近期績效分散配權(每週調整,保留分散地板)
                {ai.ensemble.learning_active
                  ? ` · 已調權 ${ai.ensemble.num_rebalances} 次`
                  : ` · 樣本累積中(已結 ${ai.ensemble.samples?.closed_trades ?? 0}/${ai.ensemble.samples?.required ?? 10} 筆)`}
              </div>
              {ai.ensemble.weights?.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
                  {ai.ensemble.weights.slice(0, 6).map((w) => (
                    <span key={w.id} style={{ fontSize: 9.5, background: 'var(--ios-fill3)', borderRadius: 5, padding: '1px 6px', color: 'var(--ios-label2)' }}>
                      <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: w.id === 'main' ? 'var(--ios-blue)' : (VARIANT_COLORS[w.id] || 'var(--ios-label3)'), marginRight: 4, verticalAlign: 'middle' }} />
                      {w.label} <b style={{ fontFamily: 'var(--font-mono)' }}>{w.weight_pct}%</b>
                    </span>
                  ))}
                </div>
              )}
              <RiskChips risk={ai.ensemble.risk} />
              <div style={{ fontSize: 9, color: 'var(--ios-label4)', marginTop: 4, lineHeight: 1.5 }}>
                與「自我學習帳戶」互補:那個押單一贏家,這個分散押全體 — 可直接比哪種學習方式好(含回落/波動)
              </div>
            </div>
          )}
          <VariantChart mainCurve={ai.equity_curve} variants={ai.variants} adaptive={ai.adaptive} ensemble={ai.ensemble} />
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) auto auto auto auto', gap: '6px 10px', fontSize: 11, alignItems: 'center' }}>
            <span style={{ fontSize: 9.5, color: 'var(--ios-label4)' }}>規則</span>
            <span style={{ fontSize: 9.5, color: 'var(--ios-label4)', textAlign: 'right' }}>報酬</span>
            <span style={{ fontSize: 9.5, color: 'var(--ios-label4)', textAlign: 'right' }}>勝率</span>
            <span style={{ fontSize: 9.5, color: 'var(--ios-label4)', textAlign: 'right' }}>回落</span>
            <span style={{ fontSize: 9.5, color: 'var(--ios-label4)', textAlign: 'right' }}>筆數</span>
            {[{ id: 'main', label: '主帳戶(現行)', note: '停利8%/停損12%', return_pct: ai.return_pct, win_rate: s.win_rate, max_drawdown_pct: s.max_drawdown_pct, num_trades: s.num_trades },
              ...[...ai.variants].sort((a, b) => (b.return_pct ?? -999) - (a.return_pct ?? -999))]
              .map(v => (
                <FragmentRow key={v.id} v={v} isMain={v.id === 'main'}
                  open={openVariant === v.id}
                  onToggle={() => setOpenVariant(cur => (cur === v.id ? null : v.id))} />
              ))}
          </div>
          <div style={{ fontSize: 9.5, color: 'var(--ios-label4)', lineHeight: 1.6, marginTop: 8 }}>
            「次日開盤買進」是唯一真人跟單拿得到的成交價(掃描收盤後才完成)。樣本仍少,規則排名會隨時間變動,先看方向、別急著下結論。
          </div>
        </Card>
      )}

      <div style={{ fontSize: 9.5, color: 'var(--ios-label4)', lineHeight: 1.6, padding: '2px 6px' }}>
        規則:自 {c.start_date} 起以 NT${nf(c.start_capital)} 虛擬本金,每日買進掃描分數最高的進場訊號股(最多 {c.max_positions} 檔、等權),
        觸及 +{c.take_profit_pct}% 停利 / −{c.stop_loss_pct}% 停損 / 持有 {c.max_hold} 日則出場;報酬已扣交易成本(手續費+證交稅)。<br />
        這是「完全照這套策略機械操作」的虛擬紀錄,可完整重現,非投資建議、非真實下單。樣本累積越久越有參考價值。
      </div>
    </div>
  )
}
