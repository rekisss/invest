import { useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react'
import StockDetailModal from './StockDetailModal'
import { useLivePrices } from '../hooks/useLivePrices'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { animate, stagger, spring } from 'animejs'
gsap.registerPlugin(useGSAP)

const PAGE_SIZE = 50

const FILTER_PRESETS = [
  { label: '外資主攻', filters: ['foreign_buy_3d', 'invest_trust_buy_2d'], color: '#16D67E' },
  { label: '三法人齊攻', filters: ['foreign_buy_3d', 'invest_trust_buy_2d', 'dealer_buy_3d'], color: '#FF6B35' },
  { label: '突破帶量', filters: ['breakout_20d', 'volume_break', 'adx_trending'], color: '#FF9F0A' },
  { label: '基本面強', filters: ['f_score_high', 'margin_shrinking'], color: '#5AC8FA' },
  { label: '技術共振', filters: ['macd_golden_cross', 'kd_golden_cross', 'rsi_strong'], color: '#BF5AF2' },
]

const SORT_OPTIONS = [
  { value: 'entry_score',           label: '分數' },
  { value: 'market_rs_rank',        label: '市場RS' },
  { value: 'sector_rs_rank',        label: '類股RS' },
  { value: 'rsi14',                 label: 'RSI' },
  { value: 'adx14',                 label: 'ADX' },
  { value: 'volume_ratio',          label: '量比' },
  { value: 'foreign_buy_streak',    label: '外資連買' },
  { value: 'f_score',               label: 'F評分' },
  { value: 'revenue_yoy',           label: '營收成長' },
  { value: 'gap_to_20d_high_pct_asc', label: '近突破' },
  { value: 'close',                 label: '收盤價' },
]

const SIGNAL_FILTERS = [
  { key: 'macd_golden_cross',    label: 'MACD金叉' },
  { key: 'kd_golden_cross',      label: 'KD金叉' },
  { key: 'foreign_buy_3d',       label: '外資連買' },
  { key: 'invest_trust_buy_2d',  label: '投信買超' },
  { key: 'above_ichimoku_cloud', label: '站上雲' },
  { key: 'bb_squeeze_breakout',  label: 'BB突破' },
  { key: 'breakout_20d',         label: '突破20高' },
  { key: 'volume_break',         label: '放量突破' },
  { key: 'adx_trending',         label: 'ADX趨勢' },
  { key: 'rsi_strong',           label: 'RSI強勢' },
  { key: 'f_score_high',         label: 'F-Score 7+' },
  { key: 'margin_shrinking',     label: '融資縮減' },
  { key: 'volume_surge_3x',      label: '爆量3x+' },
  { key: 'dealer_buy_3d',        label: '自營連買' },
  { key: 'is_sector_leader',     label: '旗手股' },
]

const REASON_LABEL = {
  macd_golden_cross: 'MACD金叉', kd_golden_cross: 'KD金叉', hist_turn_positive: 'MACD翻正',
  above_ema60: 'EMA60上', ema60_gt_ema120: '均線多頭', volume_break: '放量突破',
  rsi_strong: 'RSI強', adx_trending: 'ADX趨勢', breakout_20d: '突破20高',
  foreign_buy_3d: '外資連買', invest_trust_buy_2d: '投信買', dealer_buy_3d: '自營買',
  obv_uptrend: 'OBV↑', bb_squeeze_breakout: 'BB突破', above_ichimoku_cloud: '雲上',
  cci_momentum: 'CCI強', mfi_strong: 'MFI強', williams_r_recovery: 'W%R回升',
  stronger_than_market: 'RS強', market_above_ma60: '大盤MA60上',
  breakout_volume_confirm: '突破量確認',
}

const GRADE_STYLE = {
  A: { color: '#FFD60A', bg: 'rgba(255,214,10,0.15)',  border: 'rgba(255,214,10,0.35)' },
  B: { color: '#16D67E', bg: 'rgba(22,214,126,0.13)',   border: 'rgba(22,214,126,0.32)' },
  C: { color: '#FF9F0A', bg: 'rgba(255,159,10,0.13)',  border: 'rgba(255,159,10,0.32)' },
  D: { color: '#94A3B8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.22)' },
  X: { color: '#FF3340', bg: 'rgba(255,51,64,0.13)',   border: 'rgba(255,51,64,0.32)' },
}

const GRADE_FILTERS = ['A', 'B', 'C', 'D']

const TREND_TYPES = [
  { key: 'uptrend',     label: '📈 多頭排列', match: s => !!(s.above_ema60 && s.ema60_gt_ema120 && s.ma5_above_ma10) },
  { key: 'breakout',    label: '🚀 突破格局', match: s => !!(s.breakout_20d || s.bb_squeeze_breakout || s.breakout_volume_confirm) },
  { key: 'strong_rs',   label: '💪 相對強勢', match: s => (s.market_rs_rank || 0) >= 75 },
  { key: 'institution', label: '🏦 法人護盤', match: s => (s.foreign_buy_streak || 0) >= 3 || (s.invest_trust_streak || 0) >= 3 },
  { key: 'leader',      label: '🏆 類股旗手', match: s => !!s.is_sector_leader },
  { key: 'reversal',    label: '🔄 底部反彈', match: s => !!(s.kd_golden_cross || s.macd_golden_cross) && (s.rsi14 || 100) < 55 },
]

function GradeBadge({ grade }) {
  if (!grade) return null
  const g = GRADE_STYLE[grade] || GRADE_STYLE.D
  return (
    <span style={{
      fontSize: 11, fontWeight: 800, color: g.color,
      background: g.bg, border: `1px solid ${g.border}`,
      borderRadius: 6, padding: '1px 6px', flexShrink: 0, letterSpacing: 0.3,
    }}>{grade}</span>
  )
}

const BASE = import.meta.env.BASE_URL

/* ── CustomWatchlistTab — ⭐ tab with manual stock tracking ──────── */
function CustomTrackCard({ stockId, liveQuote, scanStock, onRemove, onSelect }) {
  const price = liveQuote?.price
  const pct   = liveQuote?.pct
  const [pressed, setPressed] = useState(false)
  const displayName = scanStock?.name || ''
  const pColor = pct == null ? 'var(--ios-label3)' : pct >= 0 ? 'var(--ios-red)' : 'var(--ios-green)'
  return (
    <div
      onMouseDown={() => setPressed(true)} onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)} onTouchStart={() => setPressed(true)} onTouchEnd={() => setPressed(false)}
      onClick={() => scanStock && onSelect && onSelect(scanStock)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: 'var(--ios-bg2)', borderRadius: 14, padding: '10px 13px',
        border: '0.5px solid var(--ios-sep)',
        transform: pressed ? 'scale(0.975)' : 'scale(1)', transition: 'transform 0.15s',
        cursor: scanStock ? 'pointer' : 'default',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-label)' }}>{stockId}</span>
          {displayName && <span style={{ fontSize: 12, color: 'var(--ios-label3)' }}>{displayName}</span>}
          {scanStock && <span style={{ fontSize: 9, color: 'var(--ios-blue)', background: 'rgba(10,132,255,0.12)', borderRadius: 4, padding: '1px 5px', marginLeft: 2 }}>在掃描</span>}
        </div>
        {!liveQuote && (
          <div style={{ fontSize: 10, color: 'var(--ios-label4)', marginTop: 2 }}>盤中才顯示即時價</div>
        )}
      </div>
      {liveQuote && (
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: pColor, fontFamily: 'var(--font-mono)' }}>
            {price >= 100 ? price.toFixed(0) : price?.toFixed(2)}
          </div>
          {pct != null && (
            <div style={{ fontSize: 11, fontWeight: 600, color: pColor }}>
              {pct >= 0 ? '+' : ''}{(pct * 100).toFixed(2)}%
            </div>
          )}
        </div>
      )}
      <button
        onClick={e => { e.stopPropagation(); onRemove(stockId) }}
        style={{
          flexShrink: 0, background: 'none', border: 'none',
          color: 'var(--ios-label4)', fontSize: 16, padding: '2px 4px', cursor: 'pointer',
        }}
      >✕</button>
    </div>
  )
}

function CustomWatchlistTab({
  watchlistStocks, customTrack, allScanStocks, liveData,
  onAdd, onRemove, onSelect,
  notionMap, watchlist, toggleWatchlist, persistentMap, scoreDeltaMap, globalMaxScore, rankOffset,
}) {
  const [input, setInput] = useState('')
  const [shake, setShake] = useState(false)

  const scanMap = useMemo(() => {
    const m = {}
    for (const s of allScanStocks) m[String(s.stock_id)] = s
    return m
  }, [allScanStocks])

  const handleAdd = () => {
    const id = input.trim().replace(/\D/g, '')
    if (!id) { setShake(true); setTimeout(() => setShake(false), 400); return }
    onAdd(id)
    setInput('')
  }

  const customIds = [...customTrack].filter(Boolean)

  return (
    <div>
      {/* ── Custom track input bar ── */}
      <div style={{ padding: '10px 14px 6px', display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="輸入股票代號（如 1409）"
          style={{
            flex: 1, background: 'var(--ios-bg3)', border: `0.5px solid ${shake ? 'var(--ios-red)' : 'var(--ios-sep)'}`,
            borderRadius: 10, padding: '8px 12px', fontSize: 14, color: 'var(--ios-label)',
            outline: 'none', transition: 'border-color 0.2s',
          }}
        />
        <button
          onClick={handleAdd}
          style={{
            flexShrink: 0, background: 'var(--ios-blue)', color: '#fff', border: 'none',
            borderRadius: 10, padding: '8px 14px', fontSize: 14, fontWeight: 700, cursor: 'pointer',
          }}
        >追蹤</button>
      </div>

      {/* ── Custom tracked (not from scan watchlist) ── */}
      {customIds.length > 0 && (
        <div style={{ padding: '2px 14px 10px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', marginBottom: 6 }}>自訂追蹤</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {customIds.map(id => (
              <CustomTrackCard
                key={id}
                stockId={id}
                liveQuote={liveData[id]}
                scanStock={scanMap[id] || null}
                onRemove={onRemove}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Scan-based watchlist ── */}
      {watchlistStocks.length > 0 ? (
        <div>
          {customIds.length > 0 && (
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', padding: '0 14px 6px', borderTop: '0.5px solid var(--ios-sep)', paddingTop: 10 }}>
              自選股（掃描出現）
            </div>
          )}
          <WatchlistView
            stocks={watchlistStocks}
            globalMaxScore={globalMaxScore}
            onSelect={onSelect}
            notionMap={notionMap}
            watchlist={watchlist}
            toggleWatchlist={toggleWatchlist}
            persistentMap={persistentMap}
            scoreDeltaMap={scoreDeltaMap}
            sectorMode={false}
            rankOffset={rankOffset}
            liveData={liveData}
          />
        </div>
      ) : customIds.length === 0 ? (
        <div style={{ padding: '48px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>☆</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ios-label)', marginBottom: 6 }}>尚無自選股</div>
          <div style={{ fontSize: 13, color: 'var(--ios-label3)' }}>點選股票列右側的 ☆ 加入，或上方輸入代號追蹤</div>
        </div>
      ) : null}
    </div>
  )
}

/* ── Utility micro-components ────────────────────────────────────── */

function CopyListButton({ stocks }) {
  const [copied, setCopied] = useState(false)
  if (!stocks || stocks.length === 0) return null
  const copy = () => {
    const text = stocks.map(s => s.stock_id).join(',')
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button onClick={copy} style={{
      background: copied ? 'rgba(22,214,126,0.15)' : 'var(--ios-bg3)',
      color: copied ? 'var(--ios-green)' : 'var(--ios-label3)',
      border: 'none', borderRadius: 10, padding: '8px 10px',
      fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
      transition: 'all 0.2s',
    }} title="複製進場股號清單">
      {copied ? '✓ 已複製' : '📋'}
    </button>
  )
}

function StatCard({ label, value, sub, color }) {
  const accents = {
    'var(--ios-green)':  { from: 'rgba(22,214,126,0.16)',  border: 'rgba(22,214,126,0.55)' },
    'var(--ios-red)':    { from: 'rgba(255,51,64,0.14)',  border: 'rgba(255,51,64,0.55)' },
    'var(--ios-blue)':   { from: 'rgba(10,132,255,0.14)', border: 'rgba(10,132,255,0.50)' },
    'var(--ios-yellow)': { from: 'rgba(255,214,10,0.13)', border: 'rgba(255,214,10,0.50)' },
  }
  const a = accents[color] || { from: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.09)' }
  return (
    <div style={{
      flex: 1, minWidth: 0,
      background: `linear-gradient(155deg, ${a.from} 0%, var(--ios-bg2) 62%)`,
      borderRadius: 16, padding: '14px 16px 12px',
      boxShadow: 'var(--shadow-card)',
      borderTop: `1.5px solid ${a.border}`,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.8px', color: color || 'var(--ios-label)', fontFamily: 'var(--font-mono)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

function SignalBadge({ entry_signal }) {
  if (!entry_signal) return <span style={{ color: 'var(--ios-label3)', fontSize: 13 }}>—</span>
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 20, height: 20, background: 'var(--ios-green)', borderRadius: '50%',
      color: '#fff', fontSize: 11, fontWeight: 700,
    }}>✓</span>
  )
}

function StreakBadge({ value }) {
  if (!value || value <= 0) return <span style={{ color: 'var(--ios-label3)', fontSize: 13 }}>—</span>
  const color = value >= 3 ? 'var(--ios-green)' : 'var(--ios-yellow)'
  return (
    <span style={{
      display: 'inline-block',
      background: value >= 3 ? 'rgba(22,214,126,0.15)' : 'rgba(255,214,10,0.15)',
      color, borderRadius: 6, padding: '1px 6px', fontSize: 12, fontWeight: 600,
    }}>{value}天</span>
  )
}

function ScoreCell({ score, entry_signal }) {
  const color = entry_signal ? 'var(--ios-green)' : score > 800 ? 'var(--ios-yellow)' : score > 400 ? 'var(--ios-label)' : 'var(--ios-label3)'
  return (
    <span style={{ color, fontWeight: entry_signal ? 700 : 500, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
      {score.toLocaleString()}
    </span>
  )
}

// ── Per-element animated score bar (each bar watches itself, fires when visible) ──
function AnimatedScoreBar({ normScore, scoreColor }) {
  const barRef = useRef(null)
  useGSAP(() => {
    const el = barRef.current
    if (!el) return
    const tw = gsap.from(el, { scaleX: 0, transformOrigin: 'left center', duration: 0.55, ease: 'power3.out', paused: true })
    const io = new IntersectionObserver(es => {
      if (es[0].isIntersecting) { tw.play(); io.disconnect() }
    }, { threshold: 0.3, rootMargin: '0px 0px -10px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, { dependencies: [normScore] })
  return (
    <div ref={barRef} style={{
      height: '100%', width: `${normScore}%`,
      background: `linear-gradient(90deg,${scoreColor}60,${scoreColor})`,
      borderRadius: 9999,
    }} />
  )
}

function WatchlistView({ stocks, onSelect, notionMap = {}, globalMaxScore, watchlist = new Set(), toggleWatchlist, persistentMap = {}, scoreDeltaMap = {}, sectorMode = false, rankOffset = 0, liveData = {} }) {

  if (!stocks || stocks.length === 0) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>📭</div>
        <div style={{ color: 'var(--ios-label2)', fontSize: 15 }}>無資料</div>
      </div>
    )
  }

  const maxScore = globalMaxScore || Math.max(...stocks.map(s => s.entry_score || 0), 1)

  return (
    <div style={{ margin: '0 12px 16px' }}>
      <div className="glass-panel" style={{ overflow: 'hidden' }}>
        {stocks.map((s, idx) => {
          const normScore = Math.min(Math.round((s.entry_score || 0) / maxScore * 100), 99)
          const isEntry = s.entry_signal
          const rsi = s.rsi14 || 0
          const adx = s.adx14 || 0
          const vol = s.volume_ratio || 0
          const foreignStreak = s.foreign_buy_streak || 0
          const investStreak = s.invest_trust_streak || 0
          const grade = s.grade || ''
          const isSectorLeader = !!s.is_sector_leader
          const marketRsRank = s.market_rs_rank || 0
          const scorePct = s.score_pct || 0
          const entryReason = s.entry_reason || ''
          const rs5d = s.relative_strength_5d || 0
          const marginChg = s.margin_change_5d || 0
          const shortRatio = s.short_ratio || 0
          const hasMarginWarning = marginChg > 5 || shortRatio > 15
          const fScore = s.f_score || 0
          const dealerStreak = s.dealer_buy_streak || 0
          const skipReason = s.skip_reason || ''
          const expectedHoldDays = s.expected_hold_days || 0
          const baseExitSignal = s.base_exit_signal || false
          const baseExitReason = s.base_exit_reason || ''
          const gapTo20dHigh = s.gap_to_20d_high_pct ?? null
          const nearBreakout = gapTo20dHigh !== null && gapTo20dHigh >= 0 && gapTo20dHigh < 2
          const volumeBreak = s.volume_break || false
          const conditionCount = s.condition_count || 0
          const bbPctB = s.bb_pct_b ?? null
          const momentumScore = s.momentum_score || 0
          const revenueYoyVal = s.revenue_yoy || 0
          const revenueMom = s.revenue_mom || 0
          const scoreDelta = scoreDeltaMap[String(s.stock_id)]
          const scoreColor = isEntry ? '#16D67E' : normScore >= 70 ? '#0A84FF' : '#94A3B8'
          const rsiColor = rsi > 65 ? '#16D67E' : rsi < 40 ? '#FF3340' : '#94A3B8'
          const adxColor = adx > 25 ? '#5AC8FA' : '#94A3B8'
          const volColor = vol > 1.8 ? '#FF9F0A' : vol > 1.3 ? '#94A3B8' : '#475569'

          return (
            <div
              key={s.stock_id}
              className={`glass-row${isEntry ? ' glass-row--entry' : ''}`}
              onClick={() => onSelect && onSelect(s)}
              style={{
                padding: '10px 14px',
                borderBottom: idx < stocks.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
                cursor: 'pointer',
                animation: `rowIn 0.35s ${Math.min(idx * 30, 300)}ms cubic-bezier(0.22,1,0.36,1) both`,
              }}
            >
              {/* Row 1: ID + Name + Signal tag */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: sectorMode ? 'var(--ios-blue)' : 'var(--ios-label4)', fontFamily: 'var(--font-mono)', minWidth: 18, fontWeight: sectorMode ? 700 : 400 }}>
                  {String(rankOffset + idx + 1).padStart(2, '0')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-blue)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                  {s.stock_id}
                </span>
                <span style={{ fontSize: 13, color: 'var(--ios-label)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.name}
                    {notionMap[s.stock_id] && <span style={{ fontSize: 9, color: 'var(--ios-blue)', fontWeight: 700, marginLeft: 4 }}>N</span>}
                  </span>
                  {s.industry_category && <span style={{ fontSize: 9, color: 'var(--ios-label4)' }}>{s.industry_category}</span>}
                </span>
                <GradeBadge grade={grade} />
                {scorePct >= 90 && (
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#FFD60A', background: 'rgba(255,214,10,0.12)', borderRadius: 5, padding: '1px 5px', flexShrink: 0, letterSpacing: 0.2 }}>
                    前{Math.max(1, Math.round(100 - scorePct))}%
                  </span>
                )}
                {isEntry
                  ? <span style={{ fontSize: 10, fontWeight: 700, color: '#16D67E', background: 'rgba(22,214,126,0.14)', border: '1px solid rgba(34,197,94,0.28)', borderRadius: 9999, padding: '2px 8px', flexShrink: 0 }}>進場</span>
                  : <span style={{ fontSize: 10, fontWeight: 600, color: '#0A84FF', background: 'rgba(10,132,255,0.12)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 9999, padding: '2px 8px', flexShrink: 0 }}>觀察</span>
                }
                {baseExitSignal && (
                  <span title={baseExitReason || '出場訊號'} style={{ fontSize: 10, fontWeight: 700, color: '#FF3340', background: 'rgba(255,51,64,0.12)', border: '1px solid rgba(255,51,64,0.38)', borderRadius: 9999, padding: '2px 7px', flexShrink: 0 }}>⚡出場</span>
                )}
                {hasMarginWarning && (
                  <span
                    title={marginChg > 5 ? `融資5日暴增 +${marginChg.toFixed(1)}%` : `融券比率 ${shortRatio.toFixed(1)}%`}
                    style={{ fontSize: 10, fontWeight: 700, color: '#FF9F0A', background: 'rgba(255,159,10,0.12)', border: '1px solid rgba(255,159,10,0.3)', borderRadius: 9999, padding: '2px 6px', flexShrink: 0 }}
                  >⚠</span>
                )}
                {fScore >= 7 && (
                  <span title={`Piotroski F-Score ${fScore}/9 — 基本面優質`} style={{
                    fontSize: 9, fontWeight: 800, color: '#5AC8FA',
                    background: 'rgba(90,200,250,0.12)', border: '1px solid rgba(90,200,250,0.3)',
                    borderRadius: 5, padding: '1px 5px', flexShrink: 0,
                  }}>F{fScore}</span>
                )}
                <button
                  onClick={e => { e.stopPropagation(); toggleWatchlist && toggleWatchlist(s.stock_id) }}
                  style={{
                    background: 'none', border: 'none', padding: '0 2px',
                    cursor: 'pointer', flexShrink: 0, lineHeight: 1,
                    color: watchlist.has(s.stock_id) ? '#FFD60A' : 'var(--ios-label4)',
                    fontSize: 15, transition: 'color 0.15s',
                  }}
                  title={watchlist.has(s.stock_id) ? '移出自選股' : '加入自選股'}
                >
                  {watchlist.has(s.stock_id) ? '★' : '☆'}
                </button>
              </div>

              {/* Row 2: Score bar + score + sparkline + price */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ flex: 1, height: 4, background: 'var(--ios-fill2)', borderRadius: 9999, overflow: 'hidden' }}>
                  <AnimatedScoreBar normScore={normScore} scoreColor={scoreColor} />
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: scoreColor, fontFamily: 'var(--font-mono)', minWidth: 24, textAlign: 'right' }}>{normScore}</span>
                {scoreDelta != null && Math.abs(scoreDelta) >= 30 && (
                  <span title={`分數較前日${scoreDelta > 0 ? '上升' : '下滑'} ${Math.abs(Math.round(scoreDelta))}`} style={{
                    fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
                    color: scoreDelta > 0 ? '#FF3340' : '#16D67E',
                    flexShrink: 0, whiteSpace: 'nowrap',
                  }}>
                    {scoreDelta > 0 ? '▲' : '▼'}{Math.abs(Math.round(scoreDelta))}
                  </span>
                )}
                <div style={{ flexShrink: 0 }}>
                  <Sparkline data={s.price_history} stockId={s.stock_id} />
                  <BBPositionBar bbPctB={s.bb_pct_b} width={56} />
                </div>
                {(s.close != null || liveData[s.stock_id]) && (
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    {liveData[s.stock_id] ? (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}>
                          <span style={{ fontSize: 8, color: '#16D67E', fontWeight: 900, lineHeight: 1 }}>◉</span>
                          <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: (liveData[s.stock_id].pct || 0) >= 0 ? '#FF3340' : '#16D67E', fontWeight: 700 }}>
                            {liveData[s.stock_id].price >= 100 ? liveData[s.stock_id].price.toFixed(0) : liveData[s.stock_id].price.toFixed(2)}
                          </span>
                        </div>
                        {liveData[s.stock_id].pct != null && (
                          <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 700, color: liveData[s.stock_id].pct >= 0 ? '#FF3340' : '#16D67E' }}>
                            {liveData[s.stock_id].pct >= 0 ? '+' : ''}{(liveData[s.stock_id].pct * 100).toFixed(2)}%
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: 12, color: 'var(--ios-label3)', fontFamily: 'var(--font-mono)' }}>
                          {s.close > 100 ? s.close.toFixed(0) : s.close.toFixed(1)}
                        </div>
                        {s.day_return != null && s.day_return !== 0 && (
                          <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 700, color: s.day_return > 0 ? '#FF3340' : '#16D67E' }}>
                            {s.day_return > 0 ? '+' : ''}{(s.day_return * 100).toFixed(1)}%
                          </div>
                        )}
                        {s.return_5d != null && Math.abs(s.return_5d) >= 0.05 && (
                          <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: s.return_5d > 0 ? '#FF9F0A' : '#16D67E', opacity: 0.8 }} title="5日報酬">
                            5d{s.return_5d > 0 ? '+' : ''}{(s.return_5d * 100).toFixed(0)}%
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Row 3: Real indicator numbers */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'nowrap', overflow: 'hidden' }}>
                {sectorMode && s.sector_rs_rank > 0 && (
                  <span style={{ fontSize: 11, color: '#0A84FF', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', fontWeight: 700 }}>
                    類股RS <strong>{Math.round(s.sector_rs_rank)}%</strong>
                  </span>
                )}
                <span style={{ fontSize: 11, color: rsiColor, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                  RSI <strong>{rsi.toFixed(0)}</strong>
                </span>
                <span style={{ fontSize: 11, color: adxColor, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                  ADX <strong>{adx.toFixed(0)}</strong>
                </span>
                {conditionCount > 0 && (
                  <span title={`${conditionCount} 個技術條件達成`} style={{ fontSize: 11, color: conditionCount >= 9 ? '#16D67E' : conditionCount >= 6 ? '#0A84FF' : '#94A3B8', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    ✓<strong>{conditionCount}</strong>
                  </span>
                )}
                {vol > 0 && (
                  vol >= 3 ? (
                    <span title="爆量（量比≥3x）" style={{ fontSize: 11, color: '#FF6B35', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', fontWeight: 700 }}>
                      爆量<strong>{vol.toFixed(1)}x</strong>
                    </span>
                  ) : vol >= 2 && volumeBreak ? (
                    <span title="放量突破（量比≥2x且突破）" style={{ fontSize: 11, color: '#FF9F0A', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', fontWeight: 700 }}>
                      突量<strong>{vol.toFixed(1)}x</strong>
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: volColor, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                      量 <strong>{vol.toFixed(1)}x</strong>
                    </span>
                  )
                )}
                {foreignStreak > 0 && (
                  <span style={{ fontSize: 11, color: '#16D67E', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    外+<strong>{foreignStreak}</strong>天{s.foreign_buy_accel ? <span style={{ fontSize: 9, color: 'var(--ios-orange)', fontWeight: 700 }}>↑</span> : null}
                  </span>
                )}
                {investStreak > 0 && (
                  <span style={{ fontSize: 11, color: '#BF5AF2', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    投+<strong>{investStreak}</strong>天{s.invest_trust_accel ? <span style={{ fontSize: 9, color: 'var(--ios-orange)', fontWeight: 700 }}>↑</span> : null}
                  </span>
                )}
                {dealerStreak > 0 && (
                  <span style={{ fontSize: 11, color: '#0A84FF', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    自+<strong>{dealerStreak}</strong>天
                  </span>
                )}
                {marketRsRank > 0 && (
                  <span style={{ fontSize: 11, color: marketRsRank >= 90 ? '#FFD60A' : '#64748B', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    RS<strong>{Math.round(marketRsRank)}</strong>
                  </span>
                )}
                {isSectorLeader && (
                  <span style={{ fontSize: 11, color: '#FFD60A', whiteSpace: 'nowrap' }}>⭐旗手</span>
                )}
                {(persistentMap[s.stock_id]?.days || 0) >= 2 && (() => {
                  const pm = persistentMap[s.stock_id]
                  const trendArrow = pm.trend > 50 ? ' ↑' : pm.trend < -50 ? ' ↓' : ''
                  const trendColor = pm.trend > 50 ? '#16D67E' : pm.trend < -50 ? '#FF9F0A' : 'var(--ios-green)'
                  return (
                    <span style={{ fontSize: 11, fontWeight: 600, color: trendColor, background: 'rgba(22,214,126,0.13)', borderRadius: 5, padding: '1px 5px', whiteSpace: 'nowrap', flexShrink: 0 }} title={`近14天入榜${pm.days}次，分數趨勢${pm.trend > 0 ? '上升' : '下滑'}${trendArrow}`}>
                      📅{pm.days}次{trendArrow}
                    </span>
                  )
                })()}
                {rs5d > 0.01 && (
                  <span style={{ fontSize: 11, color: rs5d > 0.05 ? '#16D67E' : '#94A3B8', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    RS <strong>+{(rs5d * 100).toFixed(1)}%</strong>
                  </span>
                )}
                {Math.abs(marginChg) >= 1 && (
                  <span style={{ fontSize: 11, color: marginChg < -1 ? '#16D67E' : '#FF3340', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    融{marginChg > 0 ? '↑' : '↓'}{Math.abs(marginChg).toFixed(1)}%
                  </span>
                )}
                {revenueYoyVal >= 0.05 && (
                  <span style={{ fontSize: 11, color: '#FF3340', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }} title="月營收年增率">
                    營收+{(revenueYoyVal * 100).toFixed(0)}%
                    {revenueMom >= 0.05 && <span style={{ fontSize: 9, color: '#5AC8FA', marginLeft: 2 }}>MoM+{(revenueMom * 100).toFixed(0)}%</span>}
                  </span>
                )}
                {revenueYoyVal <= -0.10 && (
                  <span style={{ fontSize: 11, color: '#16D67E', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }} title="月營收年增率">
                    營收{(revenueYoyVal * 100).toFixed(0)}%
                  </span>
                )}
                {momentumScore >= 50 && (
                  <span title={`動能分數 ${momentumScore}`} style={{ fontSize: 11, color: momentumScore >= 80 ? '#FFD60A' : '#BF5AF2', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', fontWeight: 700 }}>
                    MOM<strong>{Math.round(momentumScore)}</strong>
                  </span>
                )}
                {isEntry && expectedHoldDays > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--ios-blue)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }} title="預期持股天數">
                    持{expectedHoldDays}天
                  </span>
                )}
                {nearBreakout && (
                  <span title={`距20日高點僅 ${gapTo20dHigh.toFixed(1)}%，接近突破`} style={{ fontSize: 11, color: '#FF9F0A', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', fontWeight: 700 }}>
                    近突破{gapTo20dHigh.toFixed(1)}%
                  </span>
                )}
              </div>
              {/* Row 4: entry reason chips + skip/exit warnings */}
              {(entryReason || skipReason || baseExitSignal) && (
                <div style={{ marginTop: 4, lineHeight: 1.5 }}>
                  {entryReason && (() => {
                    const keys = entryReason.split(/[,;]/).map(s => s.trim()).filter(Boolean)
                    const labels = keys.map(k => REASON_LABEL[k] || null).filter(Boolean).slice(0, 6)
                    if (labels.length === 0) return null
                    return (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 2 }}>
                        {labels.map(l => (
                          <span key={l} style={{ fontSize: 9, color: 'var(--ios-label3)', background: 'var(--ios-fill)', border: '0.5px solid var(--ios-sep)', borderRadius: 4, padding: '1px 5px', flexShrink: 0 }}>{l}</span>
                        ))}
                      </div>
                    )
                  })()}
                  {skipReason && (
                    <div style={{ fontSize: 10, color: 'var(--ios-red)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      ⚠ {skipReason}
                    </div>
                  )}
                  {baseExitSignal && baseExitReason && (
                    <div style={{ fontSize: 10, color: '#FF3340', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                      🚨 {baseExitReason}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Feature 1: Sparkline ────────────────────────────────────────── */
function Sparkline({ data, stockId, width = 56, height = 20, days = 60 }) {
  if (!data || data.length < 2) return null
  const slice = data.slice(-days)
  const closes = slice.map(p => p.close).filter(v => v != null)
  if (closes.length < 2) return null
  const min = Math.min(...closes), max = Math.max(...closes)
  const range = max - min || 1
  const n = closes.length
  const pts = closes.map((c, i) => {
    const x = (i / (n - 1)) * width
    const y = height - ((c - min) / range) * (height - 3) - 1.5
    return [x.toFixed(1), y.toFixed(1)]
  })
  const isUp = closes[n - 1] >= closes[0]
  const color = isUp ? '#FF3340' : '#16D67E'
  const linePoints = pts.map(([x, y]) => `${x},${y}`).join(' ')
  const areaPoints = `0,${height} ${linePoints} ${width},${height}`
  const gradId = `spk-${stockId || 'x'}`
  const [lastX, lastY] = pts[pts.length - 1]
  return (
    <svg width={width} height={height} style={{ flexShrink: 0, opacity: 0.9 }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28"/>
          <stop offset="100%" stopColor={color} stopOpacity="0.02"/>
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#${gradId})`}/>
      <polyline points={linePoints} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="2" fill={color} />
    </svg>
  )
}

/* ── BB Position Bar ─────────────────────────────────────────────── */
function BBPositionBar({ bbPctB, width = 56 }) {
  if (bbPctB == null) return null
  // bb_pct_b: 0=lower band, 0.5=mid, 1=upper band, >1=above upper (breakout)
  const clamped = Math.max(-0.2, Math.min(1.5, bbPctB))
  const pct = Math.min(((clamped + 0.2) / 1.7) * 100, 100)
  let color
  if (bbPctB > 1.1) color = '#16D67E'
  else if (bbPctB > 0.8) color = '#34C759'
  else if (bbPctB > 0.5) color = '#0A84FF'
  else if (bbPctB > 0.2) color = '#FF9F0A'
  else color = '#FF3340'
  const label = bbPctB > 1.1 ? '突破上軌' : bbPctB > 0.8 ? '強勢上半' : bbPctB > 0.5 ? '中上' : bbPctB > 0.2 ? '中下' : '近下軌'
  const fillRef = useRef(null)
  useGSAP(() => {
    if (fillRef.current) gsap.from(fillRef.current, { scaleX: 0, transformOrigin: 'left center', duration: 0.55, ease: 'power2.out' })
  }, { dependencies: [pct] })
  return (
    <div title={`BB%B ${bbPctB.toFixed(2)} — ${label}`} style={{ width, height: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 9999, overflow: 'hidden', marginTop: 2 }}>
      <div ref={fillRef} style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 9999 }}/>
    </div>
  )
}

/* ── Feature 3: Sector Heatmap ───────────────────────────────────── */
function SectorHeatmap({ stocks, onSectorClick, activeSector }) {
  const [heatTab, setHeatTab] = useState('strong')
  const tileGridRef = useRef(null)

  // Animate tiles in with stagger when tab switches
  useEffect(() => {
    if (!tileGridRef.current) return
    const tiles = tileGridRef.current.querySelectorAll('.sector-tile')
    if (!tiles.length) return
    animate(tiles, {
      opacity: [0, 1],
      scale: [0.82, 1],
      delay: stagger(30, { from: 'first', start: 0 }),
      ease: spring({ stiffness: 360, damping: 28, mass: 0.7 }),
    })
  }, [heatTab])

  const allSectors = useMemo(() => {
    const map = {}
    for (const s of stocks) {
      const sec = s.industry_category || '其他'
      if (!map[sec]) map[sec] = {
        count: 0, entries: 0, totalScore: 0,
        totalMarketRs: 0, totalBreadth60: 0, breadth60Count: 0,
      }
      map[sec].count++
      if (s.entry_signal) map[sec].entries++
      map[sec].totalScore += s.entry_score || 0
      // Use market_rs_rank (cross-sector percentile) for aggregation — avoids each sector
      // always having a max near 100 that sector_rs_rank (intra-sector) would produce.
      map[sec].totalMarketRs += s.market_rs_rank || 0
      if (s.sector_breadth_60 > 0) {
        map[sec].totalBreadth60 += s.sector_breadth_60
        map[sec].breadth60Count++
      }
    }
    return Object.entries(map)
      .map(([name, d]) => ({
        name, count: d.count, entries: d.entries,
        avgScore: d.count > 0 ? d.totalScore / d.count : 0,
        avgMarketRs: d.count > 0 ? d.totalMarketRs / d.count : 0,
        breadth60: d.breadth60Count > 0 ? d.totalBreadth60 / d.breadth60Count : 0,
      }))
      .slice(0, 30)
  }, [stocks])

  const strongSectors = useMemo(() =>
    allSectors.filter(s => s.avgMarketRs >= 50).sort((a, b) => b.avgMarketRs - a.avgMarketRs),
    [allSectors]
  )
  const weakSectors = useMemo(() =>
    allSectors.filter(s => s.avgMarketRs < 50).sort((a, b) => a.avgMarketRs - b.avgMarketRs),
    [allSectors]
  )

  if (allSectors.length === 0) return null

  const sectors = heatTab === 'strong' ? strongSectors : weakSectors
  const maxEntries = Math.max(...sectors.map(s => s.entries), 1)

  return (
    <div style={{ padding: '12px 16px 8px' }}>
      {/* Header + tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.7, textTransform: 'uppercase', flex: 1 }}>
          🌡 族群輪動熱圖
          {activeSector && (
            <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--ios-blue)', fontWeight: 600 }}>
              · 已篩：{activeSector}
            </span>
          )}
        </div>
        {/* Segmented tab control — sliding indicator */}
        <div style={{
          display: 'flex', background: 'var(--ios-fill3)', borderRadius: 10,
          padding: 2, gap: 0, position: 'relative', flexShrink: 0,
        }}>
          {[
            { key: 'strong', label: '強勢', activeColor: '#FF9F0A', activeBg: 'rgba(255,159,10,0.22)', activeBorder: 'rgba(255,159,10,0.5)' },
            { key: 'weak',   label: '弱勢', activeColor: '#5AC8FA', activeBg: 'rgba(90,200,250,0.16)', activeBorder: 'rgba(90,200,250,0.4)' },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setHeatTab(t.key)}
              style={{
                fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 8, border: 'none',
                cursor: 'pointer',
                transition: 'background 0.22s, color 0.22s, box-shadow 0.22s',
                background: heatTab === t.key ? t.activeBg : 'transparent',
                color: heatTab === t.key ? t.activeColor : 'var(--ios-label3)',
                boxShadow: heatTab === t.key ? `0 0 0 1px ${t.activeBorder}, 0 2px 6px rgba(0,0,0,0.12)` : 'none',
              }}
            >{t.label}</button>
          ))}
        </div>
      </div>

      {/* Tile grid */}
      <div ref={tileGridRef} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {sectors.map(sec => {
          const isSelected = activeSector === sec.name
          const hasEntry = sec.entries > 0
          // Width scale: larger tiles for sectors with more entries (mini treemap)
          const tileScale = Math.max(1, sec.entries / Math.max(maxEntries, 1))
          const minW = heatTab === 'strong' ? Math.round(80 + tileScale * 30) : 80

          let bg, textColor, borderColor
          if (isSelected) {
            bg = 'rgba(10,132,255,0.18)'; textColor = '#0A84FF'; borderColor = 'rgba(10,132,255,0.6)'
          } else if (heatTab === 'strong') {
            const t = sec.avgMarketRs / 100
            bg = `rgba(255,${Math.round(120 - t * 70)},10,${0.10 + t * 0.22})`
            textColor = t > 0.75 ? '#FF3340' : t > 0.5 ? '#FF9F0A' : '#FFD60A'
            borderColor = `rgba(255,${Math.round(120 - t * 70)},10,${0.25 + t * 0.35})`
          } else {
            const t = 1 - sec.avgMarketRs / 50
            bg = `rgba(90,${Math.round(150 + t * 55)},250,${0.06 + t * 0.12})`
            textColor = t > 0.6 ? '#5AC8FA' : 'var(--ios-label3)'
            borderColor = `rgba(90,200,250,${0.10 + t * 0.20})`
          }

          return (
            <div key={sec.name} className="sector-tile" onClick={() => onSectorClick && onSectorClick(sec.name)} style={{
              padding: heatTab === 'strong' ? '8px 12px' : '6px 10px',
              borderRadius: 10,
              background: bg, border: `0.5px solid ${borderColor}`,
              display: 'flex', flexDirection: 'column', gap: 2,
              minWidth: minW,
              cursor: onSectorClick ? 'pointer' : 'default',
              transform: isSelected ? 'scale(1.04)' : 'none',
              transition: 'transform 0.18s, box-shadow 0.18s',
              boxShadow: isSelected ? `0 0 0 2px ${borderColor}` : 'none',
            }}>
              <div style={{ fontSize: heatTab === 'strong' ? 12 : 11, fontWeight: 600, color: textColor, lineHeight: 1.3, letterSpacing: '-0.1px' }}>
                {sec.name.length > 7 ? sec.name.slice(0, 7) + '…' : sec.name}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {sec.avgMarketRs > 0 && (
                  <span style={{ fontSize: 9, color: textColor, fontFamily: 'var(--font-mono)', fontWeight: 700 }}>RS{Math.round(sec.avgMarketRs)}</span>
                )}
                {sec.breadth60 > 0 && (
                  <span style={{ fontSize: 9, color: 'var(--ios-label4)', fontFamily: 'var(--font-mono)' }}>{Math.round(sec.breadth60)}%</span>
                )}
                {hasEntry && (
                  <span style={{ fontSize: 9, color: heatTab === 'strong' ? '#FF9F0A' : '#5AC8FA', fontWeight: 700 }}>↑{sec.entries}</span>
                )}
              </div>
            </div>
          )
        })}
        {sectors.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--ios-label4)', padding: '12px 0' }}>無資料</div>
        )}
      </div>
      <div style={{ fontSize: 9, color: 'var(--ios-label4)', marginTop: 8 }}>RS=市場RS均值（跨類股百分位）· %=60日MA上方比例 · ↑=入榜支數 · 點擊族群篩選</div>
    </div>
  )
}

function calcDropStreak(priceHistory) {
  if (!priceHistory || priceHistory.length < 2) return 0
  let streak = 0
  for (let i = priceHistory.length - 1; i > 0; i--) {
    if (priceHistory[i].close < priceHistory[i - 1].close) streak++
    else break
  }
  return streak
}

function AlertTable({ title, accentColor, stocks, columns, onSelect }) {
  if (!stocks || stocks.length === 0) return null
  return (
    <div style={{ margin: '0 16px 20px' }}>
      <div style={{
        fontSize: 13, fontWeight: 600, color: accentColor,
        padding: '0 4px 8px', display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {title}
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ios-label2)', background: 'var(--ios-bg3)', borderRadius: 10, padding: '1px 7px' }}>
          {stocks.length}
        </span>
      </div>
      <div className="glass-panel" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="ios-table" style={{ minWidth: 400 }}>
            <thead>
              <tr style={{ background: `${accentColor}10` }}>
                {columns.map(c => (
                  <th key={c.key} style={{ color: accentColor, opacity: 0.8 }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stocks.map((s, i) => (
                <tr key={s.stock_id || i}
                  onClick={() => onSelect && onSelect(s)}
                  style={{ cursor: onSelect ? 'pointer' : 'default' }}
                >
                  {columns.map(c => <td key={c.key}>{c.render(s, i)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function ConsecutiveDropSection({ stocks, onSelect }) {
  const droppers = (stocks || [])
    .map(s => ({ ...s, _drop: calcDropStreak(s.price_history) }))
    .filter(s => s._drop >= 2)
    .sort((a, b) => b._drop - a._drop)

  const cols = [
    { key: 'stock_id', label: '股號', render: s => <span style={{ color: 'var(--ios-orange)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{s.stock_id}</span> },
    { key: 'name',     label: '名稱', render: s => <span style={{ fontSize: 13 }}>{s.name}</span> },
    { key: 'close',    label: '收盤', render: s => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{s.close?.toFixed(2)}</span> },
    { key: 'drop',     label: '連跌', render: s => (
      <span style={{
        background: s._drop >= 6 ? '#431407' : s._drop >= 4 ? '#9a3412' : 'rgba(255,159,10,0.2)',
        color: s._drop >= 4 ? '#fff' : 'var(--ios-orange)',
        borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12,
      }}>↓{s._drop}天</span>
    )},
    { key: 'pct', label: '漲跌%', render: s => {
      const ph = s.price_history || []
      const last = ph[ph.length - 1], prev = ph[ph.length - 2]
      const pct = last && prev && prev.close ? ((last.close - prev.close) / prev.close * 100).toFixed(2) : null
      return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--ios-orange)' }}>{pct != null ? `${pct}%` : '—'}</span>
    }},
    { key: 'industry', label: '產業', render: s => <span style={{ color: 'var(--ios-label2)', fontSize: 12 }}>{s.industry_category || '—'}</span> },
  ]

  return <AlertTable title="📉 連跌警示" accentColor="var(--ios-orange)" stocks={droppers} columns={cols} onSelect={onSelect} />
}

function SignalChangeSection({ newEntry, dropped, onSelect }) {
  if (!newEntry.length && !dropped.length) return null
  return (
    <div style={{ margin: '0 16px 16px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.7, textTransform: 'uppercase', padding: '0 4px 8px' }}>
        📡 今日訊號變化（vs 前一日，限前N名）
      </div>
      <div className="glass-panel" style={{ overflow: 'hidden', padding: '10px 14px' }}>
        {newEntry.length > 0 && (
          <div style={{ marginBottom: dropped.length ? 10 : 0 }}>
            <div style={{ fontSize: 10, color: 'var(--ios-green)', fontWeight: 700, marginBottom: 5 }}>
              ↑ 新進場訊號 {newEntry.length} 支
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {newEntry.map(s => (
                <button key={s.stock_id} onClick={() => onSelect && onSelect(s)} style={{
                  background: 'rgba(22,214,126,0.12)', border: '0.5px solid rgba(22,214,126,0.35)',
                  borderRadius: 8, padding: '3px 8px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#16D67E', fontFamily: 'var(--font-mono)' }}>{s.stock_id}</span>
                  <span style={{ fontSize: 11, color: 'var(--ios-label2)' }}>{s.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--ios-label3)', fontFamily: 'var(--font-mono)' }}>{Math.round(s.entry_score)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {dropped.length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, marginBottom: 5 }}>
              ↓ 退出入場訊號 {dropped.length} 支
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {dropped.map(s => (
                <span key={s.stock_id} style={{
                  background: 'rgba(148,163,184,0.08)', border: '0.5px solid rgba(148,163,184,0.2)',
                  borderRadius: 8, padding: '3px 8px', fontSize: 11, color: 'var(--ios-label3)',
                }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.stock_id}</span> {s.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ScoreMoversSection({ stocks, scoreDeltaMap, onSelect }) {
  const { gainers, losers } = useMemo(() => {
    if (!scoreDeltaMap || Object.keys(scoreDeltaMap).length === 0) return { gainers: [], losers: [] }
    const withDelta = stocks
      .map(s => ({ ...s, _delta: scoreDeltaMap[String(s.stock_id)] ?? null }))
      .filter(s => s._delta !== null && Math.abs(s._delta) >= 80)
    const gainers = withDelta.filter(s => s._delta > 0).sort((a, b) => b._delta - a._delta).slice(0, 5)
    const losers  = withDelta.filter(s => s._delta < 0).sort((a, b) => a._delta - b._delta).slice(0, 5)
    return { gainers, losers }
  }, [stocks, scoreDeltaMap])

  if (gainers.length === 0 && losers.length === 0) return null

  const Pill = ({ s, isGain, onClick }) => (
    <button onClick={onClick} style={{
      background: isGain ? 'rgba(255,51,64,0.10)' : 'rgba(22,214,126,0.10)',
      border: `0.5px solid ${isGain ? 'rgba(255,51,64,0.3)' : 'rgba(22,214,126,0.3)'}`,
      borderRadius: 8, padding: '4px 9px', cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ios-blue)', fontFamily: 'var(--font-mono)' }}>{s.stock_id}</span>
      <span style={{ fontSize: 11, color: 'var(--ios-label2)' }}>{s.name}</span>
      <span style={{ fontSize: 11, fontWeight: 700, color: isGain ? '#FF3340' : '#16D67E', fontFamily: 'var(--font-mono)' }}>
        {isGain ? '▲' : '▼'}{Math.abs(Math.round(s._delta))}
      </span>
    </button>
  )

  return (
    <div style={{ margin: '0 16px 16px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.7, textTransform: 'uppercase', padding: '0 4px 8px' }}>
        📊 分數大幅變動（較前日）
      </div>
      <div className="glass-panel" style={{ overflow: 'hidden', padding: '10px 14px' }}>
        {gainers.length > 0 && (
          <div style={{ marginBottom: losers.length ? 10 : 0 }}>
            <div style={{ fontSize: 10, color: '#FF3340', fontWeight: 700, marginBottom: 5 }}>▲ 大漲（+80分以上）</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {gainers.map(s => <Pill key={s.stock_id} s={s} isGain onClick={() => onSelect?.(s)} />)}
            </div>
          </div>
        )}
        {losers.length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: '#16D67E', fontWeight: 700, marginBottom: 5 }}>▼ 大跌（−80分以上）</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {losers.map(s => <Pill key={s.stock_id} s={s} isGain={false} onClick={() => onSelect?.(s)} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function NearBreakoutSection({ stocks, onSelect }) {
  const candidates = useMemo(() => {
    return (stocks || [])
      .filter(s => {
        const g = s.gap_to_20d_high_pct
        // within 2% below 20-day high; exclude already broken out (negative gap) and already in entry
        return g != null && g >= 0 && g <= 2 && !s.entry_signal
      })
      .sort((a, b) => a.gap_to_20d_high_pct - b.gap_to_20d_high_pct)
      .slice(0, 10)
  }, [stocks])

  if (candidates.length === 0) return null

  const cols = [
    { key: 'stock_id', label: '股號', render: s => <span style={{ color: '#FF9F0A', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{s.stock_id}</span> },
    { key: 'name',     label: '名稱', render: s => <span style={{ fontSize: 13 }}>{s.name}</span> },
    { key: 'close',    label: '收盤', render: s => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{s.close?.toFixed(s.close >= 100 ? 0 : 1)}</span> },
    { key: 'gap',      label: '距高點', render: s => (
      <span style={{
        background: s.gap_to_20d_high_pct < 0.5 ? 'rgba(255,214,10,0.2)' : 'rgba(255,159,10,0.14)',
        color: s.gap_to_20d_high_pct < 0.5 ? '#FFD60A' : '#FF9F0A',
        borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12,
      }}>{s.gap_to_20d_high_pct.toFixed(1)}%</span>
    )},
    { key: 'score',    label: '分數', render: s => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ios-label2)' }}>{Math.round(s.entry_score)}</span> },
    { key: 'rsi',      label: 'RSI', render: s => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: (s.rsi14 || 0) > 60 ? '#16D67E' : 'var(--ios-label3)' }}>{s.rsi14?.toFixed(0)}</span> },
  ]
  return <AlertTable title="📐 近突破雷達（距20日高點 ≤2%，尚未入場）" accentColor="#FF9F0A" stocks={candidates} columns={cols} onSelect={onSelect} />
}

function VolumeSurgeSection({ stocks, onSelect }) {
  const candidates = useMemo(() => {
    return (stocks || [])
      .filter(s => {
        const vol = s.volume_ratio || 0
        return vol >= 2.5 && !s.entry_signal && (s.rsi14 || 0) > 35 && (s.rsi14 || 0) < 80
      })
      .sort((a, b) => (b.volume_ratio || 0) - (a.volume_ratio || 0))
      .slice(0, 10)
  }, [stocks])

  if (candidates.length === 0) return null

  const cols = [
    { key: 'stock_id', label: '股號', render: s => <span style={{ color: '#FF6B35', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{s.stock_id}</span> },
    { key: 'name',     label: '名稱', render: s => <span style={{ fontSize: 13 }}>{s.name}</span> },
    { key: 'close',    label: '收盤', render: s => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{s.close?.toFixed(s.close >= 100 ? 0 : 1)}</span> },
    { key: 'vol',      label: '量比', render: s => (
      <span style={{
        background: (s.volume_ratio || 0) >= 5 ? 'rgba(255,51,64,0.2)' : 'rgba(255,107,53,0.14)',
        color: (s.volume_ratio || 0) >= 5 ? '#FF3340' : '#FF6B35',
        borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12,
      }}>{(s.volume_ratio || 0).toFixed(1)}x</span>
    )},
    { key: 'rsi', label: 'RSI', render: s => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: (s.rsi14 || 0) > 60 ? '#16D67E' : 'var(--ios-label3)' }}>{s.rsi14?.toFixed(0)}</span> },
    { key: 'score', label: '分數', render: s => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ios-label2)' }}>{Math.round(s.entry_score)}</span> },
  ]
  return <AlertTable title="🔥 放量異動（量比≥2.5x，尚未入場）" accentColor="#FF6B35" stocks={candidates} columns={cols} onSelect={onSelect} />
}

function LimitDownSection({ items, onSelect }) {
  const cols = [
    { key: 'stock_id', label: '股號', render: s => <span style={{ color: 'var(--ios-red)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{s.stock_id}</span> },
    { key: 'name',     label: '名稱', render: s => <span style={{ fontSize: 13 }}>{s.name}</span> },
    { key: 'close',    label: '收盤', render: s => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{s.close?.toFixed(2)}</span> },
    { key: 'streak',   label: '連跌天', render: s => (
      <span style={{
        background: s.limit_down_streak >= 5 ? '#7f1d1d' : 'rgba(255,51,64,0.18)',
        color: s.limit_down_streak >= 5 ? '#fff' : 'var(--ios-red)',
        borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12,
      }}>↓{s.limit_down_streak}天</span>
    )},
    { key: 'industry', label: '產業', render: s => <span style={{ color: 'var(--ios-label2)', fontSize: 12 }}>{s.industry_category || '—'}</span> },
  ]
  return <AlertTable title="🔴 連續跌停警示（≥3天）" accentColor="var(--ios-red)" stocks={items} columns={cols} onSelect={onSelect} />
}

function PersistentSection({ items, onSelect }) {
  const cols = [
    { key: 'stock_id',    label: '股號',  render: s => <span style={{ color: 'var(--ios-blue)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{s.stock_id}</span> },
    { key: 'name',        label: '名稱',  render: s => <span style={{ fontSize: 13 }}>{s.name}</span> },
    { key: 'days_in_top', label: '天數',  render: s => (
      <span style={{ color: s.days_in_top >= 5 ? 'var(--ios-green)' : s.days_in_top >= 3 ? 'var(--ios-yellow)' : 'var(--ios-label)', fontWeight: 700, fontSize: 13 }}>{s.days_in_top}天</span>
    )},
    { key: 'score',       label: '最新分', render: s => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{s.latest_score?.toLocaleString()}</span> },
    { key: 'trend',       label: '分數趨勢', render: s => (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: s.score_trend > 0 ? 'var(--ios-green)' : s.score_trend < 0 ? 'var(--ios-red)' : 'var(--ios-label2)' }}>
        {s.score_trend > 0 ? '+' : ''}{Math.round(s.score_trend)}
      </span>
    )},
  ]
  return <AlertTable title="📅 跨日持續強勢（近14天 TOP 50）" accentColor="var(--ios-blue)" stocks={items} columns={cols} onSelect={onSelect} />
}

/* ── Outcome Stats Panel ─────────────────────────────────────────── */
function OutcomeStatsPanel({ outcomeStats }) {
  if (!outcomeStats) return null
  const grades = ['A', 'B', 'C', 'D']
  const hasData = grades.some(g => (outcomeStats[g]?.total || 0) >= 10)
  if (!hasData) return null

  return (
    <div style={{
      margin: '10px 16px 0',
      background: 'var(--ios-bg2)',
      borderRadius: 16, padding: '14px 16px',
      boxShadow: 'var(--shadow-card)',
      border: '0.5px solid var(--ios-sep)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        📊 系統勝率驗證（5日後實際表現）
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {grades.map(g => {
          const st = outcomeStats[g] || {}
          const wr = st.win_rate
          const enough = (st.total || 0) >= 10
          const gStyle = GRADE_STYLE[g] || GRADE_STYLE.D
          const wr_color = !enough ? 'var(--ios-label3)' : wr >= 55 ? 'var(--ios-green)' : wr >= 45 ? 'var(--ios-yellow)' : 'var(--ios-red)'
          return (
            <div key={g} style={{
              flex: 1, background: 'var(--ios-fill4)',
              borderRadius: 12, padding: '10px 8px', textAlign: 'center',
              border: `0.5px solid ${gStyle.border}`,
            }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: gStyle.color, marginBottom: 5 }}>{g}</div>
              <div style={{ fontSize: 19, fontWeight: 700, color: wr_color, fontFamily: 'var(--font-mono)', lineHeight: 1 }}>
                {enough ? `${wr}%` : '—'}
              </div>
              {enough && st.avg_return_pct != null && (
                <div style={{ fontSize: 10, color: st.avg_return_pct >= 0 ? 'var(--ios-green)' : 'var(--ios-red)', marginTop: 3 }}>
                  均{st.avg_return_pct >= 0 ? '+' : ''}{st.avg_return_pct}%
                </div>
              )}
              <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 2 }}>
                {enough ? `${st.total}筆` : '資料不足'}
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 8, textAlign: 'right' }}>
        基於歷史掃描交叉驗算（入場後第5個交易日收盤）· 統計起算：2026-06-23
      </div>
    </div>
  )
}

/* ── Strategy Accuracy Panel: score-rank buckets vs baseline ──────── */
function StrategyAccuracyPanel({ accuracy }) {
  if (!accuracy) return null
  const horizons = accuracy.horizons || [1, 5, 10]
  // Require a meaningful sample at the 5-day horizon for the top bucket
  if (!(accuracy.top10?.d5?.total >= 20)) return null

  const rows = [
    { key: 'top10', label: '高分前10%', color: 'var(--ios-blue)' },
    { key: 'top25', label: '高分前25%', color: 'var(--ios-teal)' },
    { key: 'baseline', label: '全市場均值', color: 'var(--ios-label3)' },
  ]
  const fmtPct = v => (v == null ? '—' : `${v}%`)
  const cell = (v) => {
    if (v?.win_rate == null) return { wr: '—', ret: null, color: 'var(--ios-label3)' }
    const c = v.win_rate >= 55 ? 'var(--ios-green)' : v.win_rate >= 45 ? 'var(--ios-yellow)' : 'var(--ios-red)'
    return { wr: `${v.win_rate}%`, ret: v.avg_return_pct, color: c }
  }

  return (
    <div style={{
      margin: '10px 16px 0',
      background: 'var(--ios-bg2)',
      borderRadius: 16, padding: '14px 16px',
      boxShadow: 'var(--shadow-card)',
      border: '0.5px solid var(--ios-sep)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        🎯 評分預測力驗證（高分股 vs 全市場）
      </div>
      {/* header row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr repeat(3, 1fr)', gap: 6, fontSize: 10, color: 'var(--ios-label3)', marginBottom: 6 }}>
        <div />
        {horizons.map(h => <div key={h} style={{ textAlign: 'center', fontWeight: 700 }}>{h}日後</div>)}
      </div>
      {rows.map(r => (
        <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '1.2fr repeat(3, 1fr)', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: r.color }}>{r.label}</div>
          {horizons.map(h => {
            const c = cell(accuracy[r.key]?.[`d${h}`])
            return (
              <div key={h} style={{ background: 'var(--ios-fill4)', borderRadius: 9, padding: '6px 4px', textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: c.color, fontFamily: 'var(--font-mono)', lineHeight: 1 }}>{c.wr}</div>
                {c.ret != null && (
                  <div style={{ fontSize: 9, color: c.ret >= 0 ? 'var(--ios-green)' : 'var(--ios-red)', marginTop: 2 }}>
                    {c.ret >= 0 ? '+' : ''}{c.ret}%
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 6, lineHeight: 1.5 }}>
        勝率＝N日後收盤上漲比例；下方為平均報酬。若高分股勝率與報酬持續高於全市場均值，代表評分有預測力。統計起算：2026-06-23（新基準），資料累積中。
      </div>
    </div>
  )
}

/* ── Daily Action Panel ──────────────────────────────────────────── */
function DataQualityPanel({ dq }) {
  const [open, setOpen] = useState(false)
  if (!dq) return null
  const fresh = dq.is_fresh
  const statusColor = fresh ? 'var(--ios-green)' : 'var(--ios-orange)'
  const statusBg = fresh ? 'rgba(22,214,126,0.10)' : 'rgba(255,159,10,0.10)'
  const statusBorder = fresh ? 'rgba(22,214,126,0.28)' : 'rgba(255,159,10,0.3)'
  const checks = [
    {
      label: '資料新鮮度',
      ok: fresh,
      detail: fresh
        ? `最新資料 ${dq.latest_data_date}（T+${dq.days_behind ?? 0}，正常延遲）`
        : `資料落後 ${dq.days_behind} 個交易日（${dq.latest_data_date}）`,
    },
    {
      label: '股票數量',
      ok: (dq.total_stocks || 0) >= 1000,
      detail: `掃描 ${(dq.total_stocks || 0).toLocaleString()} 支`,
    },
    {
      label: '欄位完整性',
      ok: dq.fields_ok !== false,
      detail: dq.top_valid_ratio != null
        ? `指標欄位有效率 ${dq.top_valid_ratio}%`
        : '無 TOP 股票資料',
    },
    {
      label: '法人資料',
      ok: dq.institutional_ok !== false,
      detail: dq.institutional_ok === false
        ? `三大法人尚未公布（${dq.institutional_ratio ?? 0}% 有資料）· 盤後 TWSE 公布後自動補入`
        : dq.institutional_ratio != null
          ? (() => {
              const src = dq.institutional_source === 'twse_t86' ? '掃描 + TWSE 補抓' : '掃描原生資料'
              const pct = dq.institutional_ratio
              const note = pct < 80 ? `（${pct}%，部分股票無法人揭露）` : `（${pct}%）`
              return src + note
            })()
          : '無法人資料',
    },
    {
      label: '建置時間',
      ok: true,
      detail: dq.build_time
        ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(dq.build_time)) + ' CST'
        : '未知',
    },
  ]
  const allOk = checks.every(c => c.ok !== false)

  return (
    <div style={{ margin: '10px 16px 0' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', background: statusBg, border: `0.5px solid ${statusBorder}`,
          borderRadius: 12, padding: '9px 14px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: statusColor }}>
          {allOk ? '✓' : '⚠'} 資料驗證
        </span>
        <span style={{ fontSize: 12, color: statusColor, flex: 1, textAlign: 'left' }}>
          {fresh ? `正常 · 最新 ${dq.latest_data_date}` : `延遲 T+${dq.days_behind} · ${dq.latest_data_date}`}
        </span>
        <span style={{ fontSize: 12, color: 'var(--ios-label3)', fontFamily: 'var(--font-mono)' }}>
          {(dq.total_stocks || 0).toLocaleString()} 支
        </span>
        <span style={{ fontSize: 11, color: 'var(--ios-label3)' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          marginTop: 4, background: 'var(--ios-bg2)', borderRadius: 12,
          border: '0.5px solid var(--ios-sep)', overflow: 'hidden',
        }}>
          {checks.map((c, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 14px',
              borderBottom: i < checks.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
            }}>
              <span style={{ fontSize: 13, color: c.ok !== false ? 'var(--ios-green)' : 'var(--ios-orange)', flexShrink: 0 }}>
                {c.ok !== false ? '✓' : '⚠'}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-label)', minWidth: 72 }}>{c.label}</span>
              <span style={{ fontSize: 12, color: 'var(--ios-label2)', flex: 1 }}>{c.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DailyActionPanel({ scan, prevScan, persistent }) {
  if (!scan) return null
  const stocks = scan.top_stocks || []

  const prevIds = new Set((prevScan?.top_stocks || []).map(s => s.stock_id))
  const newAGrade = stocks.filter(s => s.grade === 'A' && !prevIds.has(s.stock_id)).slice(0, 5)
  const multiDay = (persistent || []).filter(p => p.days_in_top >= 3).slice(0, 5)
  const decayWarnings = stocks.filter(s => s.momentum_decay_signal && s.entry_signal).slice(0, 3)

  if (newAGrade.length === 0 && multiDay.length === 0 && decayWarnings.length === 0) return null

  return (
    <div style={{
      margin: '10px 16px 0',
      background: 'linear-gradient(135deg, rgba(10,132,255,0.08) 0%, var(--ios-bg2) 65%)',
      borderRadius: 16, padding: '14px 16px',
      boxShadow: 'var(--shadow-card)',
      borderLeft: '3px solid var(--ios-blue)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-blue)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        🎯 今日行動重點
      </div>

      {newAGrade.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-yellow)', marginBottom: 4 }}>✦ 新進 A 級候選</div>
          {newAGrade.map(s => (
            <div key={s.stock_id} style={{ fontSize: 13, color: 'var(--ios-label)', marginLeft: 12, lineHeight: 2 }}>
              <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{s.stock_id}</b>
              {' '}{s.name}
              {s.expected_hold_days > 0 && (
                <span style={{ color: 'var(--ios-label3)', fontSize: 11 }}> · 預估持股 {s.expected_hold_days} 天</span>
              )}
              {s.entry_reason && (
                <span style={{ color: 'var(--ios-label3)', fontSize: 11 }}> · {s.entry_reason.split(';')[0]}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {multiDay.length > 0 && (
        <div style={{ marginBottom: decayWarnings.length > 0 ? 8 : 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-green)', marginBottom: 4 }}>↗ 持續強勢（{multiDay.length} 支連續入榜）</div>
          {multiDay.map(s => (
            <div key={s.stock_id} style={{ fontSize: 13, color: 'var(--ios-label)', marginLeft: 12, lineHeight: 2 }}>
              <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{s.stock_id}</b>
              {' '}{s.name}
              <span style={{ color: 'var(--ios-green)', fontWeight: 600 }}> {s.days_in_top}天</span>
              {s.score_trend > 0 && <span style={{ color: 'var(--ios-green)', fontSize: 11 }}> ↑分數持續上升</span>}
              {s.score_trend < -50 && <span style={{ color: 'var(--ios-yellow)', fontSize: 11 }}> ↓分數滑落，留意出場</span>}
            </div>
          ))}
        </div>
      )}

      {decayWarnings.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-red)', marginBottom: 4 }}>⚠ 動能衰退留意</div>
          {decayWarnings.map(s => (
            <div key={s.stock_id} style={{ fontSize: 13, color: 'var(--ios-label3)', marginLeft: 12, lineHeight: 2 }}>
              {s.stock_id} {s.name} — 5日動能高於2日均值，趨勢可能減速
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Today vs Previous Day comparison ───────────────────────────── */
function DateComparisonPanel({ scan, prevScan }) {
  const todayStocks = scan?.top_stocks || []
  const prevStocks  = prevScan?.top_stocks || []
  if (!prevStocks.length || !todayStocks.length) return null

  const todayEntry  = todayStocks.filter(s => s.entry_signal).length
  const prevEntry   = prevStocks.filter(s => s.entry_signal).length
  const todayAB     = todayStocks.filter(s => s.grade === 'A' || s.grade === 'B').length
  const prevAB      = prevStocks.filter(s => s.grade === 'A' || s.grade === 'B').length
  const todayAvg    = Math.round(todayStocks.reduce((a, s) => a + (s.entry_score || 0), 0) / (todayStocks.length || 1))
  const prevAvg     = Math.round(prevStocks.reduce((a, s) => a + (s.entry_score || 0), 0) / (prevStocks.length || 1))

  const topSector = (arr) => {
    const m = {}
    for (const s of arr) if (s.entry_signal) m[s.industry_category || '其他'] = (m[s.industry_category || '其他'] || 0) + 1
    return Object.entries(m).sort((a, b) => b[1] - a[1])[0] || null
  }
  const todaySec = topSector(todayStocks)
  const prevSec  = topSector(prevStocks)

  const rows = [
    { label: '進場訊號', today: todayEntry, prev: prevEntry, suffix: '支' },
    { label: 'A/B 級',   today: todayAB,    prev: prevAB,    suffix: '支' },
    { label: '均分',     today: todayAvg,   prev: prevAvg,   suffix: '' },
  ]

  const overallDelta = (todayEntry - prevEntry) + (todayAB - prevAB)
  const headerColor = overallDelta > 0 ? '#16D67E' : overallDelta < 0 ? '#FF3340' : 'var(--ios-label3)'

  return (
    <div style={{ margin: '10px 16px 0', background: 'var(--ios-bg2)', borderRadius: 16, padding: '12px 14px', boxShadow: 'var(--shadow-card)', border: '0.5px solid var(--ios-sep)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: headerColor, letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 8 }}>
        🔀 今日 vs 前日
      </div>
      {rows.map((r, i) => {
        const delta = r.today - r.prev
        const dColor = delta > 0 ? '#16D67E' : delta < 0 ? '#FF3340' : 'var(--ios-label3)'
        return (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '0.5px solid var(--ios-sep)' }}>
            <span style={{ fontSize: 12, color: 'var(--ios-label2)', flex: 1 }}>{r.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-label)', fontFamily: 'var(--font-mono)' }}>
              {r.today.toLocaleString()}{r.suffix}
            </span>
            {delta !== 0 && (
              <span style={{ fontSize: 11, fontWeight: 700, color: dColor, fontFamily: 'var(--font-mono)', minWidth: 36, textAlign: 'right', flexShrink: 0 }}>
                {delta > 0 ? '▲' : '▼'}{Math.abs(delta).toLocaleString()}
              </span>
            )}
            {delta === 0 && <span style={{ fontSize: 11, color: 'var(--ios-label4)', minWidth: 36, textAlign: 'right', flexShrink: 0 }}>—</span>}
          </div>
        )
      })}
      {todaySec && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 5 }}>
          <span style={{ fontSize: 12, color: 'var(--ios-label2)', flex: 1 }}>主導族群</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-blue)' }}>
            {todaySec[0]} <span style={{ color: 'var(--ios-label3)', fontWeight: 400 }}>{todaySec[1]}支</span>
          </span>
          {prevSec && prevSec[0] !== todaySec[0] && (
            <span style={{ fontSize: 10, color: 'var(--ios-label4)' }}>← {prevSec[0]}</span>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Market Breadth Bar ──────────────────────────────────────────── */
function MarketBreadthBar({ stocks }) {
  const stats = useMemo(() => {
    const n = stocks.length || 1
    const ema60    = stocks.filter(s => s.above_ema60).length
    const trending = stocks.filter(s => s.adx_trending).length
    const rsiStr   = stocks.filter(s => s.rsi_strong).length
    const foreign  = stocks.filter(s => (s.foreign_buy_streak || 0) >= 1).length
    return [
      { label: 'EMA60上', value: ema60,    pct: ema60 / n * 100,    color: '#16D67E' },
      { label: 'ADX趨勢', value: trending, pct: trending / n * 100, color: '#5AC8FA' },
      { label: 'RSI強勢', value: rsiStr,   pct: rsiStr / n * 100,   color: '#FF9F0A' },
      { label: '外資買',  value: foreign,  pct: foreign / n * 100,  color: '#BF5AF2' },
    ]
  }, [stocks])

  if (!stocks.length) return null
  const allZero = stats.every(s => s.value === 0)
  if (allZero) return null

  return (
    <div style={{ margin: '10px 16px 0', background: 'var(--ios-bg2)', borderRadius: 16, padding: '12px 14px', boxShadow: 'var(--shadow-card)', border: '0.5px solid var(--ios-sep)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        📡 市場廣度（前 {stocks.length} 名）
      </div>
      {stats.map(s => (
        <div key={s.label} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontSize: 11, color: 'var(--ios-label2)' }}>{s.label}</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: s.color, fontWeight: 700 }}>
              {s.value} 支 ({s.pct.toFixed(0)}%)
            </span>
          </div>
          <div style={{ height: 4, background: 'var(--ios-fill2)', borderRadius: 9999, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${s.pct}%`, background: s.color, borderRadius: 9999, transition: 'width 0.7s cubic-bezier(0.34,1.56,0.64,1)' }} />
          </div>
        </div>
      ))}
      <div style={{ fontSize: 9, color: 'var(--ios-label4)', marginTop: 4 }}>EMA60上＝站穩60日均線；ADX趨勢＝ADX&gt;25強趨勢；RSI強勢＝RSI&gt;55；外資買＝外資連買中</div>
    </div>
  )
}

/* ── Institutional money-flow leaderboard ────────────────────────── */
function InstitutionalLeaderboard({ stocks, onSelect }) {
  const ranked = useMemo(() => {
    return (stocks || [])
      .map(s => {
        const f = Math.max(0, s.foreign_buy_streak || 0)
        const t = Math.max(0, s.invest_trust_streak || 0)
        const d = Math.max(0, s.dealer_buy_streak || 0)
        // Taiwan convention: 投信 (trust) tends to lead short-term momentum,
        // 外資 (foreign) confirms trend, 自營 (dealer) is noisiest.
        let flow = f * 1.0 + t * 1.4 + d * 0.6
        if (s.foreign_buy_accel) flow += 2
        if (s.invest_trust_accel) flow += 2.5
        return { ...s, _flow: flow, _f: f, _t: t, _d: d }
      })
      .filter(s => s._flow > 0)
      .sort((a, b) => b._flow - a._flow)
      .slice(0, 8)
  }, [stocks])
  if (ranked.length === 0) return null

  const Chip = ({ n, label, color, accel }) => n <= 0 ? null : (
    <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}1A`, borderRadius: 5, padding: '1px 5px', whiteSpace: 'nowrap' }}>
      {label}{n}{accel ? '↑' : ''}
    </span>
  )

  return (
    <div style={{ margin: '10px 16px 0', background: 'var(--ios-bg2)', borderRadius: 16, padding: '14px 16px', boxShadow: 'var(--shadow-card)', border: '0.5px solid var(--ios-sep)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        🏦 法人籌碼集中排行（連買強度）
      </div>
      {ranked.map((s, i) => (
        <div key={s.stock_id} onClick={() => onSelect?.(s)} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0',
          borderBottom: i < ranked.length - 1 ? '0.5px solid var(--ios-sep)' : 'none', cursor: 'pointer',
        }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: i < 3 ? 'var(--ios-yellow)' : 'var(--ios-label3)', width: 16, textAlign: 'center', flexShrink: 0 }}>{i + 1}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ios-label)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.stock_id} <span style={{ color: 'var(--ios-label2)', fontWeight: 400 }}>{s.name}</span>
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
              <Chip n={s._f} label="外" color="var(--ios-red)" accel={s.foreign_buy_accel} />
              <Chip n={s._t} label="投" color="var(--ios-orange)" accel={s.invest_trust_accel} />
              <Chip n={s._d} label="自" color="var(--ios-blue)" />
            </div>
          </div>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-teal)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{s._flow.toFixed(1)}</span>
        </div>
      ))}
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 8, lineHeight: 1.5 }}>
        強度＝外資連買×1.0＋投信×1.4＋自營×0.6，加速另計。數字越高代表法人買盤越集中、越持續。
      </div>
    </div>
  )
}

/* ── Sector rotation tracker (cross-date) ────────────────────────── */
function SectorRotationTracker({ scans, dates }) {
  const data = useMemo(() => {
    const recent = (dates || []).slice(0, 5)           // desc: [today, ..., 4d ago]
    if (recent.length < 2) return null
    // count per sector per date among that date's top stocks
    const perDate = recent.map(d => {
      const counts = {}
      for (const s of (scans?.[d]?.top_stocks || [])) {
        const sec = s.industry_category || '其他'
        counts[sec] = (counts[sec] || 0) + 1
      }
      return counts
    })
    const today = perDate[0], prev = perDate[1]
    const allSecs = new Set()
    perDate.forEach(c => Object.keys(c).forEach(k => allSecs.add(k)))
    const rows = [...allSecs].map(sec => {
      const series = perDate.map(c => c[sec] || 0).reverse()  // ascending in time
      return { sec, today: today[sec] || 0, delta: (today[sec] || 0) - (prev[sec] || 0), series }
    })
    .filter(r => r.today > 0)
    .sort((a, b) => b.today - a.today || b.delta - a.delta)
    .slice(0, 8)
    const maxCount = Math.max(...rows.map(r => Math.max(...r.series)), 1)
    return { rows, maxCount, span: recent.length }
  }, [scans, dates])
  if (!data) return null

  return (
    <div style={{ margin: '10px 16px 0', background: 'var(--ios-bg2)', borderRadius: 16, padding: '14px 16px', boxShadow: 'var(--shadow-card)', border: '0.5px solid var(--ios-sep)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        🔄 產業輪動追蹤（近 {data.span} 個交易日入榜家數）
      </div>
      {data.rows.map((r, i) => {
        const arrow = r.delta > 0 ? '▲' : r.delta < 0 ? '▼' : '—'
        const aColor = r.delta > 0 ? 'var(--ios-green)' : r.delta < 0 ? 'var(--ios-red)' : 'var(--ios-label3)'
        return (
          <div key={r.sec} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: i < data.rows.length - 1 ? '0.5px solid var(--ios-sep)' : 'none' }}>
            <span style={{ fontSize: 12, color: 'var(--ios-label2)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.sec}</span>
            {/* mini bar trend */}
            <span style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 18, flexShrink: 0 }}>
              {r.series.map((v, j) => (
                <span key={j} style={{
                  width: 4, height: `${Math.max(2, (v / data.maxCount) * 18)}px`,
                  background: j === r.series.length - 1 ? 'var(--ios-teal)' : 'var(--ios-fill3)', borderRadius: 1,
                }} />
              ))}
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-label)', fontFamily: 'var(--font-mono)', width: 22, textAlign: 'right', flexShrink: 0 }}>{r.today}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: aColor, width: 30, textAlign: 'right', flexShrink: 0 }}>
              {arrow}{r.delta !== 0 ? Math.abs(r.delta) : ''}
            </span>
          </div>
        )
      })}
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 8, lineHeight: 1.5 }}>
        家數＝該產業有幾支進入當日強勢榜。▲ 表示比前一日增加（資金流入升溫），▼ 表示退燒。
      </div>
    </div>
  )
}

/* ── Simple strategy backtest simulator (interactive) ────────────── */
function BacktestSimulator({ accuracy }) {
  const [bucket, setBucket] = useState('top10')
  const [horizon, setHorizon] = useState(5)
  if (!accuracy) return null
  const horizons = accuracy.horizons || [1, 5, 10]
  if (!(accuracy.top10?.d5?.total >= 20)) return null

  const buckets = [
    { key: 'top10', label: '高分前10%' },
    { key: 'top25', label: '高分前25%' },
    { key: 'baseline', label: '全市場' },
  ]
  const cur = accuracy[bucket]?.[`d${horizon}`] || {}
  const base = accuracy.baseline?.[`d${horizon}`] || {}
  const avg = cur.avg_return_pct
  const wr = cur.win_rate
  const total = cur.total || 0
  const edge = (avg != null && base.avg_return_pct != null) ? avg - base.avg_return_pct : null
  // illustrative compounding over 20 independent trades
  const compounded = avg != null ? ((Math.pow(1 + avg / 100, 20) - 1) * 100) : null

  const btn = (active) => ({
    flex: 1, padding: '6px 4px', fontSize: 11, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
    border: '0.5px solid ' + (active ? 'var(--ios-blue)' : 'transparent'),
    background: active ? 'rgba(10,132,255,0.15)' : 'var(--ios-fill4)',
    color: active ? 'var(--ios-blue)' : 'var(--ios-label3)', transition: 'all 0.15s',
  })

  return (
    <div style={{ margin: '10px 16px 0', background: 'var(--ios-bg2)', borderRadius: 16, padding: '14px 16px', boxShadow: 'var(--shadow-card)', border: '0.5px solid var(--ios-sep)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
        🧪 策略回測試算
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {buckets.map(b => (
          <button key={b.key} style={btn(bucket === b.key)} onClick={() => setBucket(b.key)}>{b.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {horizons.map(h => (
          <button key={h} style={btn(horizon === h)} onClick={() => setHorizon(h)}>持有{h}日</button>
        ))}
      </div>
      {total < 10 ? (
        <div style={{ fontSize: 12, color: 'var(--ios-label3)', textAlign: 'center', padding: '8px 0' }}>此組合樣本不足</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, background: 'var(--ios-fill4)', borderRadius: 10, padding: '10px 6px', textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 4 }}>平均報酬</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: avg >= 0 ? 'var(--ios-green)' : 'var(--ios-red)', lineHeight: 1 }}>
                {avg >= 0 ? '+' : ''}{avg}%
              </div>
            </div>
            <div style={{ flex: 1, background: 'var(--ios-fill4)', borderRadius: 10, padding: '10px 6px', textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 4 }}>勝率</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: wr >= 55 ? 'var(--ios-green)' : wr >= 45 ? 'var(--ios-yellow)' : 'var(--ios-red)', lineHeight: 1 }}>{wr}%</div>
            </div>
            <div style={{ flex: 1, background: 'var(--ios-fill4)', borderRadius: 10, padding: '10px 6px', textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 4 }}>超額報酬</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: edge == null ? 'var(--ios-label3)' : edge >= 0 ? 'var(--ios-green)' : 'var(--ios-red)', lineHeight: 1 }}>
                {edge == null ? '—' : `${edge >= 0 ? '+' : ''}${edge.toFixed(2)}%`}
              </div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ios-label2)', marginTop: 10, lineHeight: 1.6 }}>
            每次買進<b style={{ color: 'var(--ios-label)' }}>{buckets.find(b => b.key === bucket).label}</b>並持有 <b style={{ color: 'var(--ios-label)' }}>{horizon}</b> 個交易日，
            單筆平均 <b style={{ color: avg >= 0 ? 'var(--ios-green)' : 'var(--ios-red)' }}>{avg >= 0 ? '+' : ''}{avg}%</b>
            {compounded != null && <>；若連續操作 20 次（複利示意）約 <b style={{ color: compounded >= 0 ? 'var(--ios-green)' : 'var(--ios-red)' }}>{compounded >= 0 ? '+' : ''}{compounded.toFixed(0)}%</b></>}。
            <span style={{ color: 'var(--ios-label3)' }}>　樣本 {total} 筆，未計手續費／滑價，僅供參考。</span>
          </div>
        </>
      )}
    </div>
  )
}

/* ── Quick Stats Bar ─────────────────────────────────────────────── */
function QuickStatsBar({ stocks, onActivateFilter, onSort }) {
  const stats = useMemo(() => {
    let foreignBuy3 = 0, trustBuy2 = 0, fHigh = 0, exitSignals = 0, nearBreak = 0, volumeSurge = 0
    for (const s of stocks) {
      if (s.foreign_buy_streak >= 3) foreignBuy3++
      if (s.invest_trust_streak >= 2) trustBuy2++
      if ((s.f_score || 0) >= 7) fHigh++
      if (s.base_exit_signal) exitSignals++
      const g = s.gap_to_20d_high_pct
      if (g != null && g >= 0 && g < 2) nearBreak++
      if ((s.volume_ratio || 0) >= 3) volumeSurge++
    }
    return { foreignBuy3, trustBuy2, fHigh, exitSignals, nearBreak, volumeSurge }
  }, [stocks])

  const items = [
    { label: '外買3天+', value: stats.foreignBuy3, filter: 'foreign_buy_3d', color: '#16D67E' },
    { label: '投信2天+', value: stats.trustBuy2, filter: 'invest_trust_buy_2d', color: '#BF5AF2' },
    { label: 'F≥7', value: stats.fHigh, filter: 'f_score_high', color: '#5AC8FA' },
    { label: '近突破', value: stats.nearBreak, filter: null, sort: 'gap_to_20d_high_pct_asc', color: '#FF9F0A' },
    { label: '爆量3x+', value: stats.volumeSurge, filter: 'volume_surge_3x', color: '#FF6B35' },
    ...(stats.exitSignals > 0 ? [{ label: '出場警示', value: stats.exitSignals, filter: null, color: '#FF3340' }] : []),
  ].filter(item => item.value > 0)

  if (items.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, flexShrink: 0 }}>今日</span>
      {items.map(item => {
        const isClickable = !!(item.filter || item.sort)
        return (
          <button key={item.label} onClick={() => {
            if (item.filter) onActivateFilter(item.filter)
            else if (item.sort && onSort) onSort(item.sort)
          }} style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 9999,
            background: `${item.color}1A`, color: item.color,
            border: `0.5px solid ${item.color}44`,
            cursor: isClickable ? 'pointer' : 'default', flexShrink: 0,
            transition: 'opacity 0.15s',
          }} title={item.filter ? `篩選：${item.label}` : item.sort ? `排序：${item.label}` : undefined}>
            {item.label} {item.value}
          </button>
        )
      })}
    </div>
  )
}

/* ── Main Component ──────────────────────────────────────────────── */
export default function Dashboard({ data, error }) {
  const sortedDates = useMemo(
    () => [...(data?.dates || [])].sort((a, b) => b.localeCompare(a)),
    [data?.dates]
  )
  const [selectedDate, setSelectedDate] = useState(() => {
    if (!data?.dates?.length) return null
    const sorted = [...data.dates].sort((a, b) => b.localeCompare(a))
    const todayTW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
    return sorted.includes(todayTW) ? todayTW : (sorted[0] || null)
  })
  const [selectedStock, setSelectedStock] = useState(null)
  const [viewTab, setViewTab] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortField, setSortField] = useState('entry_score')
  const [sortDir, setSortDir] = useState('desc')
  const [page, setPage] = useState(0)
  const notionMap = data?.notionMap || {}

  const [watchlist, setWatchlist] = useState(() => {
    try {
      const saved = localStorage.getItem('stock_watchlist')
      return new Set(saved ? JSON.parse(saved) : [])
    } catch { return new Set() }
  })
  const toggleWatchlist = (stock_id) => {
    setWatchlist(prev => {
      const next = new Set(prev)
      if (next.has(stock_id)) next.delete(stock_id)
      else next.add(stock_id)
      try { localStorage.setItem('stock_watchlist', JSON.stringify([...next])) } catch {}
      return next
    })
  }

  // Custom tracked stocks — any ID the user pins manually, persisted across scans
  const [customTrack, setCustomTrack] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('custom_track') || '[]')) }
    catch { return new Set() }
  })
  const addCustomTrack = (id) => {
    const sid = String(id).trim()
    if (!sid) return
    setCustomTrack(prev => {
      const next = new Set(prev)
      next.add(sid)
      try { localStorage.setItem('custom_track', JSON.stringify([...next])) } catch {}
      return next
    })
  }
  const removeCustomTrack = (id) => {
    setCustomTrack(prev => {
      const next = new Set(prev)
      next.delete(String(id))
      try { localStorage.setItem('custom_track', JSON.stringify([...next])) } catch {}
      return next
    })
  }
  // Smooth snap-collapse: the secondary controls glide closed once you scroll past a
  // threshold and glide back open near the top. A single CSS transition does the easing
  // (no per-frame height writes → no layout thrash), and a ResizeObserver keeps the
  // natural height accurate as filters/tabs change the content.
  const headerInnerRef = useRef(null)     // animated height container
  const headerContentRef = useRef(null)   // natural-height content wrapper (measured)
  const [headerH, setHeaderH] = useState(null)
  const [headerCollapsed, setHeaderCollapsed] = useState(false)
  const listScrollRef = useRef(null)   // ref to the scrollable list div
  const headerTouchRef = useRef(null)  // tracks touch forwarding from header → list

  // Track the collapsible content's natural height; keep it live with ResizeObserver.
  // Also sync the wrapper's pixel height when near the top so auto-resize works.
  useLayoutEffect(() => {
    const el = headerContentRef.current
    if (!el) return
    const measure = () => {
      const h = el.offsetHeight
      setHeaderH(h)
      const inner = headerInnerRef.current
      const list  = listScrollRef.current
      if (inner && list && list.scrollTop <= 10) {
        inner.style.height = `${h}px`
        inner.style.opacity = '1'
        inner.style.transform = 'translateY(0)'
        inner.style.pointerEvents = 'auto'
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Lazy-load OHLCV price histories for ALL scanned stocks. Powers both the list
  // sparklines and the detail modal's candles / KD / ADX / OBV indicators + backtest.
  // New format: { dates: [...], stocks: { id: { o, h, l, c, v } } } aligned to dates.
  // Falls back gracefully to the legacy close-only format ({ stocks: { id: [closes] } }).
  const [slimHistories, setSlimHistories] = useState(null)
  const [historyDates, setHistoryDates] = useState(null)
  const [scanHistories, setScanHistories] = useState(null)
  useEffect(() => {
    fetch(`${BASE}stock_histories.json`, { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : null)
      .then(h => {
        if (h?.stocks) setSlimHistories(h.stocks)
        if (Array.isArray(h?.dates)) setHistoryDates(h.dates)
        if (h?.scan_stocks) setScanHistories(h.scan_stocks)
      })
      .catch(() => {})
  }, [])

  const handleListScroll = (e) => {
    const scrollTop = e.currentTarget.scrollTop
    const el = headerInnerRef.current
    if (!el || headerH == null) return

    const prog = Math.max(0, Math.min(1, scrollTop / headerH))

    if (scrollTop <= 2) {
      // At the very top: spring back open
      el.style.transition = 'height 0.42s cubic-bezier(0.22,1,0.36,1), opacity 0.3s ease, transform 0.42s cubic-bezier(0.22,1,0.36,1)'
      el.style.height = `${headerH}px`
      el.style.opacity = '1'
      el.style.transform = 'translateY(0)'
      el.style.pointerEvents = 'auto'
    } else {
      // Progressive collapse tied to scroll position (no CSS transition — we control each frame)
      el.style.transition = 'none'
      el.style.height = `${Math.max(0, headerH * (1 - prog))}px`
      el.style.opacity = String(Math.max(0, 1 - prog * 1.5))
      el.style.transform = `translateY(${-8 * prog}px)`
      el.style.pointerEvents = prog >= 0.95 ? 'none' : 'auto'
    }

    setHeaderCollapsed(prog >= 1)
  }
  const [activeSignals, setActiveSignals] = useState(new Set())
  const toggleSignal = (key) => {
    setActiveSignals(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const [activeGrades, setActiveGrades] = useState(new Set())
  const toggleGrade = (g) => {
    setActiveGrades(prev => {
      const next = new Set(prev)
      if (next.has(g)) next.delete(g)
      else next.add(g)
      return next
    })
  }
  const [activeSector, setActiveSector] = useState(null)
  const [activeTrendType, setActiveTrendType] = useState(null)

  // ── 即時報價 — must be called before any conditional return ─────────────
  // Compute entry stock IDs from the latest scan date (or empty when no data).
  // Always include customTrack IDs so manually-pinned stocks always have live prices.
  const liveStockIds = useMemo(() => {
    const ids = new Set([...customTrack])
    if (data?.scans && data?.dates?.length) {
      const latestDate = [...data.dates].sort((a, b) => b.localeCompare(a))[0]
      const latestScan = data.scans[latestDate] || {}
      for (const s of (latestScan.top_stocks || [])) {
        if (s.entry_signal) ids.add(String(s.stock_id))
      }
    }
    return [...ids]
  }, [data, customTrack])
  const { prices: liveData } = useLivePrices(liveStockIds)

  if (error || !data || !data.dates || data.dates.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 4 }}>📭</div>
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ios-label)' }}>尚無掃描資料</div>
        <div style={{ fontSize: 14, color: 'var(--ios-label2)', maxWidth: 260, lineHeight: 1.5 }}>等待 GitHub Actions 完成掃描後自動更新</div>
        {error && <div style={{ fontSize: 12, color: 'var(--ios-red)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>錯誤：{error}</div>}
      </div>
    )
  }

  const scan = data.scans[selectedDate] || {}
  const stocks = scan.top_stocks || []
  const persistent = scan.persistent || []
  const limitDownAlerts = scan.limit_down_alerts || []

  // Merge filter_stocks (ALL scanned, slim) with top_stocks (top N, rich).
  // For stocks that appear in both, prefer the rich top_stocks version.
  // Also attach slim price_history from lazy-loaded stock_histories.json.
  const allScanStocks = useMemo(() => {
    const slim = scan.filter_stocks
    const base = (() => {
      if (!slim || slim.length === 0) return stocks
      const richMap = {}
      for (const s of stocks) richMap[s.stock_id] = s
      return slim.map(s => richMap[s.stock_id] || s)
    })()
    if (!slimHistories && !scanHistories) return base
    return base.map(s => {
      if (s.price_history) return s  // already has rich history (top_stocks)
      const rec = slimHistories?.[s.stock_id]
      if (!rec) {
        // scan_stocks: compact [date, o, h, l, c, v] tuples — extended history for
        // non-klineMap stocks so weekly/monthly charts have enough bars for MACD warmup
        const scanRec = scanHistories?.[s.stock_id]
        if (Array.isArray(scanRec) && scanRec.length >= 2) {
          return {
            ...s,
            price_history: scanRec.map(b => ({
              time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5],
            })),
          }
        }
        return s
      }
      // Legacy close-only format: array of closes
      if (Array.isArray(rec)) {
        if (rec.length < 2) return s
        return { ...s, price_history: rec.map(c => ({ close: c })) }
      }
      // OHLCV format aligned to historyDates
      if (!historyDates || !rec.c) return s
      const bars = []
      for (let i = 0; i < historyDates.length; i++) {
        if (rec.c[i] == null) continue
        bars.push({
          time: historyDates[i],
          open: rec.o?.[i], high: rec.h?.[i], low: rec.l?.[i],
          close: rec.c[i], volume: rec.v?.[i],
        })
      }
      if (bars.length < 2) return s
      return { ...s, price_history: bars }
    })
  }, [scan.filter_stocks, stocks, slimHistories, historyDates, scanHistories])

  const entryStocks = allScanStocks.filter(s => s.entry_signal)
  const globalMaxScore = Math.max(...stocks.map(s => s.entry_score || 0), 1)
  const pred = data.prediction || null
  const aiText = scan.ai_picks_text || ''
  const aggLatest = data?.aggregateLatest
  const calendarRisk = scan.calendar_risk || (aggLatest?.date === selectedDate ? aggLatest.calendar_risk : '') || ''
  const marginStats = scan.margin_stats || {}
  const outcomeStats = data.outcomeStats || null
  const prevDateIdx = sortedDates.indexOf(selectedDate)
  const prevScan = prevDateIdx >= 0 && prevDateIdx + 1 < sortedDates.length
    ? (data.scans[sortedDates[prevDateIdx + 1]] || null)
    : null

  const watchlistStocks = useMemo(() => allScanStocks.filter(s => watchlist.has(s.stock_id)), [allScanStocks, watchlist])

  // Score delta map: stock_id → (today_score - prev_score), only when prevScan has the same stock
  const scoreDeltaMap = useMemo(() => {
    if (!prevScan?.top_stocks) return {}
    const prevScores = {}
    for (const s of prevScan.top_stocks) prevScores[String(s.stock_id)] = s.entry_score || 0
    const map = {}
    for (const s of stocks) {
      const prev = prevScores[String(s.stock_id)]
      if (prev !== undefined) map[String(s.stock_id)] = (s.entry_score || 0) - prev
    }
    return map
  }, [stocks, prevScan])

  // Signal change: stocks that newly entered or dropped out of entry_signal vs previous date.
  // Scope is limited to today's top_stocks list — we can't detect changes outside that cutoff.
  // "dropped" only counts stocks still visible today (but lost signal), not those that fell off the list.
  const signalChanges = useMemo(() => {
    if (!prevScan?.top_stocks) return { newEntry: [], dropped: [] }
    const prevEntryIds = new Set(prevScan.top_stocks.filter(s => s.entry_signal).map(s => String(s.stock_id)))
    const todayStockIds = new Set(stocks.map(s => String(s.stock_id)))
    const todayEntryIds = new Set(entryStocks.map(s => String(s.stock_id)))
    const newEntry = entryStocks.filter(s => !prevEntryIds.has(String(s.stock_id)))
    const dropped = (prevScan.top_stocks || []).filter(s =>
      s.entry_signal &&
      todayStockIds.has(String(s.stock_id)) &&
      !todayEntryIds.has(String(s.stock_id))
    )
    return { newEntry, dropped }
  }, [entryStocks, prevScan, stocks])

  const persistentMap = useMemo(() => {
    const m = {}
    ;(persistent || []).forEach(p => { m[p.stock_id] = { days: p.days_in_top, trend: p.score_trend ?? 0 } })
    return m
  }, [persistent])

  const availableSectors = useMemo(() => {
    const counts = {}
    for (const s of allScanStocks) {
      const sec = s.industry_category || '其他'
      counts[sec] = (counts[sec] || 0) + 1
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([sec, count]) => ({ sec, count }))
  }, [allScanStocks])

  const gradeDistribution = useMemo(() => {
    const counts = { A: 0, B: 0, C: 0, D: 0, X: 0 }
    for (const s of allScanStocks) { if (s.grade && counts[s.grade] !== undefined) counts[s.grade]++ }
    return counts
  }, [allScanStocks])

  const [showAllFiltered, setShowAllFiltered] = useState(false)

  // Reset page and show-all whenever filters or tab/date change
  useEffect(() => { setPage(0); setShowAllFiltered(false) }, [viewTab, searchQuery, sortField, sortDir, selectedDate, activeSignals, activeGrades, activeSector, activeTrendType])

  const hasActiveFilter = activeSignals.size > 0 || activeGrades.size > 0 || !!activeSector || !!activeTrendType || !!searchQuery.trim()
  const baseStocks = viewTab === 'entry' ? entryStocks
    : viewTab === 'limitdown' ? limitDownAlerts
    : viewTab === 'watchlist' ? watchlistStocks
    : viewTab === 'heatmap' ? []
    : hasActiveFilter ? allScanStocks   // full universe when filtering
    : stocks                            // top N (rich) when browsing unfiltered

  const filteredAndSorted = useMemo(() => {
    let list = baseStocks
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      list = list.filter(s =>
        String(s.stock_id).includes(q) ||
        (s.name || '').toLowerCase().includes(q)
      )
    }
    if (activeSignals.size > 0 && viewTab !== 'limitdown') {
      list = list.filter(s => [...activeSignals].every(key => !!s[key]))
    }
    if (activeGrades.size > 0 && viewTab !== 'limitdown') {
      list = list.filter(s => activeGrades.has(s.grade || 'D'))
    }
    if (activeSector && viewTab !== 'limitdown') {
      list = list.filter(s => (s.industry_category || '其他') === activeSector)
    }
    if (activeTrendType && viewTab !== 'limitdown') {
      const tt = TREND_TYPES.find(t => t.key === activeTrendType)
      if (tt) list = list.filter(tt.match)
    }
    return [...list].sort((a, b) => {
      // Special case: gap_to_20d_high_pct_asc sorts ascending by gap (smallest gap = nearest breakout)
      if (sortField === 'gap_to_20d_high_pct_asc') {
        const va = a.gap_to_20d_high_pct ?? Infinity
        const vb = b.gap_to_20d_high_pct ?? Infinity
        // only consider stocks within striking distance (gap 0–15%)
        const aValid = va >= 0 && va <= 15
        const bValid = vb >= 0 && vb <= 15
        if (aValid && !bValid) return -1
        if (!aValid && bValid) return 1
        return va - vb
      }
      const va = a[sortField] ?? -Infinity
      const vb = b[sortField] ?? -Infinity
      return sortDir === 'desc' ? vb - va : va - vb
    })
  }, [baseStocks, searchQuery, sortField, sortDir, activeSignals, activeGrades, activeSector, activeTrendType])

  // When a grade/signal/sector/preset filter is active in the 'all' tab, cap to top 20
  // so the user sees "top 20 from full universe" — avoids scrolling through hundreds.
  // Search is intentionally excluded from the cap (user is looking for a specific stock).
  const FILTER_CAP = 20
  const filterCapActive = (activeSignals.size > 0 || activeGrades.size > 0 || !!activeSector || !!activeTrendType) &&
    !searchQuery.trim() && viewTab === 'all' && !showAllFiltered && filteredAndSorted.length > FILTER_CAP
  const displayList = filterCapActive ? filteredAndSorted.slice(0, FILTER_CAP) : filteredAndSorted

  const totalPages = Math.ceil(displayList.length / PAGE_SIZE)
  const pagedStocks = displayList.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const viewOptions = [
    { id: 'all',       label: `全部` },
    { id: 'entry',     label: `進場${entryStocks.length > 0 ? ` ·${entryStocks.length}` : ''}` },
    { id: 'watchlist', label: `⭐${watchlist.size > 0 ? ` ·${watchlist.size}` : ''}` },
    { id: 'limitdown', label: `🔴 跌停` },
    { id: 'heatmap',   label: `🌡 族群` },
  ]

  // View tab drag-to-switch (same UX as bottom tab bar)
  const viewSegRef = useRef(null)
  const viewTabDragRef = useRef({ active: false, x0: 0, y0: 0, moved: false })
  const onViewTabTouchStart = (e) => {
    const t = e.touches[0]
    viewTabDragRef.current = { active: true, x0: t.clientX, y0: t.clientY, moved: false }
  }
  const onViewTabTouchMove = (e) => {
    const d = viewTabDragRef.current
    if (!d.active) return
    const t = e.touches[0]
    const dx = t.clientX - d.x0
    const dy = t.clientY - d.y0
    if (!d.moved) {
      if (Math.abs(dx) < 8) return
      if (Math.abs(dx) < Math.abs(dy)) { d.active = false; return }
      d.moved = true
    }
    if (!viewSegRef.current) return
    const btns = Array.from(viewSegRef.current.querySelectorAll('.ios-seg-btn'))
    const x = t.clientX
    for (let i = 0; i < btns.length; i++) {
      const rect = btns[i].getBoundingClientRect()
      if (x >= rect.left && x <= rect.right) {
        const newId = viewOptions[i]?.id
        if (newId && newId !== viewTab) setViewTab(newId)
        break
      }
    }
  }
  const onViewTabTouchEnd = () => {
    viewTabDragRef.current = { active: false, x0: 0, y0: 0, moved: false }
  }

  // Forward vertical swipes that START in the header down to the scrollable list.
  // iOS only triggers native scroll when touch begins inside the overflow element.
  const handleHeaderTouchStart = (e) => {
    headerTouchRef.current = { y0: e.touches[0].clientY, lastY: e.touches[0].clientY, forwarding: false }
  }
  const handleHeaderTouchMove = (e) => {
    const s = headerTouchRef.current
    if (!s) return
    const y = e.touches[0].clientY
    if (!s.forwarding) {
      if (Math.abs(s.y0 - y) < 5) return
      s.forwarding = true
    }
    const dy = s.lastY - y  // positive → finger moved up → scrollTop increases
    s.lastY = y
    const list = listScrollRef.current
    if (list) list.scrollTop += dy
  }
  const handleHeaderTouchEnd = () => { headerTouchRef.current = null }

  // Intercept horizontal right-swipe: when page > 0 go prev-page; when modal open,
  // prevent the App-level tab switch (the modal's own drag handler closes it).
  const dashSwipeRef = useRef(null)
  const handleDashTouchStart = (e) => {
    dashSwipeRef.current = { x0: e.touches[0].clientX, y0: e.touches[0].clientY, locked: false }
  }
  const handleDashTouchMove = (e) => {
    const s = dashSwipeRef.current
    if (!s || s.locked) return
    const dx = e.touches[0].clientX - s.x0
    const dy = e.touches[0].clientY - s.y0
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
    if (Math.abs(dx) > Math.abs(dy) && dx > 0 && (selectedStock !== null || page > 0)) {
      s.locked = true
      e.stopPropagation() // prevent App from switching tabs
      e.preventDefault()  // prevent page scroll
    } else {
      dashSwipeRef.current = null // vertical or leftward — let App handle
    }
  }
  const handleDashTouchEnd = (e) => {
    const s = dashSwipeRef.current
    dashSwipeRef.current = null
    if (!s?.locked) return
    // Only advance pagination here; modal closing is handled by the modal's own drag handle
    if (selectedStock === null && page > 0) {
      const dx = (e.changedTouches?.[0]?.clientX ?? s.x0) - s.x0
      if (dx > 60) setPage(p => p - 1)
    }
  }

  return (
    <div
      onTouchStart={handleDashTouchStart}
      onTouchMove={handleDashTouchMove}
      onTouchEnd={handleDashTouchEnd}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >

      {/* ── Controls Header ──────────────────────────────────────── */}
      <div
        onTouchStart={handleHeaderTouchStart}
        onTouchMove={handleHeaderTouchMove}
        onTouchEnd={handleHeaderTouchEnd}
        style={{
          padding: '8px 16px 12px',
          background: 'linear-gradient(180deg, var(--ios-bg2) 0%, var(--ios-bg) 100%)',
          flexShrink: 0,
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
        }}>
        {/* Date selector + download row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <select
            value={selectedDate || ''}
            onChange={e => setSelectedDate(e.target.value)}
            style={{
              flex: 1, background: 'var(--ios-bg3)', border: 'none', color: 'var(--ios-label)',
              borderRadius: 10, padding: '8px 12px', fontSize: 14, cursor: 'pointer',
              WebkitAppearance: 'none', appearance: 'none',
            }}
          >
            {sortedDates.map(d => {
              const s = data.scans[d]
              const partial = s?.is_partial ? ' ⚠' : ''
              return <option key={d} value={d}>{d}（{s?.total_scanned ?? 0} 支）{partial}</option>
            })}
          </select>
          <a
            href={`${BASE}downloads/scan_${selectedDate}_top50.csv`} download
            style={{
              background: 'var(--ios-bg3)', color: 'var(--ios-label2)', borderRadius: 10,
              padding: '8px 12px', fontSize: 13, textDecoration: 'none', whiteSpace: 'nowrap',
            }}
          >↓ TOP50</a>
          <a
            href={`${BASE}downloads/scan_${selectedDate}_all.csv`} download
            style={{
              background: 'rgba(10,132,255,0.12)', color: 'var(--ios-blue)', borderRadius: 10,
              padding: '8px 12px', fontSize: 13, textDecoration: 'none', whiteSpace: 'nowrap', fontWeight: 600,
            }}
          >↓ 全部</a>
          <CopyListButton stocks={entryStocks} />
        </div>

        {/* Collapsible secondary controls — progressively collapses as user scrolls down */}
        <div
          ref={headerInnerRef}
          style={{
            overflow: 'hidden',
            willChange: 'height, opacity, transform',
          }}
        >
        <div ref={headerContentRef}>
        {/* Scan execution date hint + data quality badge */}
        {(data.last_scan_exec_date || data.generated_at || data.dataQuality) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingRight: 2, marginBottom: 4, flexWrap: 'wrap' }}>
            {data.dataQuality && (() => {
              const dq = data.dataQuality
              const fresh = dq.is_fresh
              return (
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 9999,
                  background: fresh ? 'rgba(22,214,126,0.12)' : 'rgba(255,159,10,0.12)',
                  color: fresh ? 'var(--ios-green)' : 'var(--ios-orange)',
                  border: `0.5px solid ${fresh ? 'rgba(22,214,126,0.3)' : 'rgba(255,159,10,0.35)'}`,
                  flexShrink: 0,
                }}>
                  {fresh ? '✓ 資料正常' : `⚠ 資料T+${dq.days_behind}`}
                </span>
              )
            })()}
            <div style={{ fontSize: 11, color: 'var(--ios-label3)', flex: 1, textAlign: 'right' }}>
              {data.last_scan_exec_date && `掃描 ${data.last_scan_exec_date}`}
              {(() => {
                const dd = scan.data_date
                if (dd && dd !== selectedDate) return ` · 資料日 ${dd.slice(5)}`
                return null
              })()}
              {data.generated_at && ` · 建置 ${new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(data.generated_at))} CST`}
            </div>
          </div>
        )}

        {/* Market context micro-bar from prediction data */}
        {pred?.market_data && (() => {
          const md = pred.market_data
          const fn = md.futures_net
          const nc = md.night_change
          const rsi = md.taiex_rsi
          const disp = md.disposition_count
          const chips = []
          if (fn != null) chips.push({
            label: `期貨 ${fn > 0 ? '+' : ''}${Math.round(fn / 1000)}k口`,
            color: fn >= 0 ? '#FF3340' : '#16D67E',
          })
          if (nc != null) chips.push({
            label: `夜盤 ${nc > 0 ? '+' : ''}${Math.round(nc)}pt`,
            color: nc >= 0 ? '#FF3340' : '#16D67E',
          })
          if (rsi != null) chips.push({
            label: `大盤RSI ${rsi.toFixed(0)}`,
            color: rsi > 70 ? '#FF3340' : rsi > 60 ? '#FF9F0A' : rsi < 40 ? '#16D67E' : '#94A3B8',
          })
          if (disp != null && disp > 0) chips.push({
            label: `處置 ${disp}支`,
            color: disp >= 50 ? '#FF3340' : '#FF9F0A',
          })
          if (chips.length === 0) return null
          return (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 4 }}>
              {chips.map(chip => (
                <span key={chip.label} style={{
                  fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 9999,
                  background: `${chip.color}15`, color: chip.color,
                  border: `0.5px solid ${chip.color}40`, flexShrink: 0,
                }}>{chip.label}</span>
              ))}
            </div>
          )
        })()}

        {/* Grade distribution summary */}
        {allScanStocks.length > 0 && (() => {
          const hasAnyFilter = activeGrades.size > 0 || activeSignals.size > 0 || activeSector || activeTrendType || searchQuery.trim()
          const clearAll = () => { setActiveGrades(new Set()); setActiveSignals(new Set()); setActiveSector(null); setActiveTrendType(null); setSearchQuery('') }
          return (
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, flexShrink: 0 }}>分佈</span>
              {Object.entries(gradeDistribution).filter(([, n]) => n > 0).map(([g, n]) => {
                const gs = GRADE_STYLE[g] || GRADE_STYLE.D
                const isActive = activeGrades.has(g)
                return (
                  <button key={g} onClick={() => g !== 'X' && toggleGrade(g)} style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 9999,
                    background: isActive ? gs.bg : 'var(--ios-bg3)',
                    color: gs.color, border: `0.5px solid ${isActive ? gs.border : 'var(--ios-sep)'}`,
                    cursor: g !== 'X' ? 'pointer' : 'default', flexShrink: 0,
                    transition: 'all 0.15s',
                  }}>{g} {n}</button>
                )
              })}
              {hasAnyFilter && (
                <button onClick={clearAll} style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999,
                  border: '0.5px solid rgba(255,51,64,0.35)', background: 'rgba(255,51,64,0.10)',
                  color: 'var(--ios-red)', cursor: 'pointer', flexShrink: 0,
                }}>✕ 清除</button>
              )}
              {hasAnyFilter && (
                <span style={{ fontSize: 10, color: 'var(--ios-label3)', marginLeft: 2 }}>篩選 {filteredAndSorted.length}</span>
              )}
            </div>
          )
        })()}

        {/* Quick stats bar */}
        {allScanStocks.length > 0 && (
          <QuickStatsBar stocks={allScanStocks} onActivateFilter={key => {
            setActiveSignals(prev => {
              const next = new Set(prev)
              if (next.has(key)) next.delete(key)
              else next.add(key)
              return next
            })
          }} onSort={field => { setSortField(field); setSortDir('asc'); setPage(0) }} />
        )}

        {/* Search + Sort row */}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <input
            type="search"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="🔍 搜尋股號/名稱…"
            style={{
              flex: 1, background: 'var(--ios-bg3)', border: 'none', color: 'var(--ios-label)',
              borderRadius: 10, padding: '7px 12px', fontSize: 16, outline: 'none',
              WebkitAppearance: 'none',
            }}
          />
          <select
            value={sortField}
            onChange={e => setSortField(e.target.value)}
            style={{
              background: 'var(--ios-bg3)', border: 'none', color: 'var(--ios-label2)',
              borderRadius: 10, padding: '7px 10px', fontSize: 12, cursor: 'pointer',
              WebkitAppearance: 'none', appearance: 'none', flexShrink: 0,
            }}
          >
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button
            onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
            style={{
              background: 'var(--ios-bg3)', border: 'none', color: 'var(--ios-label2)',
              borderRadius: 10, padding: '7px 10px', fontSize: 13, cursor: 'pointer', flexShrink: 0,
            }}
          >{sortDir === 'desc' ? '↓' : '↑'}</button>
        </div>

        {/* Segmented view selector — supports drag-to-switch like bottom tab bar */}
        <div
          ref={viewSegRef}
          style={{ marginTop: 8 }}
          onTouchStart={onViewTabTouchStart}
          onTouchMove={onViewTabTouchMove}
          onTouchEnd={onViewTabTouchEnd}
        >
          <div className="ios-segmented">
            {viewOptions.map(v => (
              <button
                key={v.id}
                className={`ios-seg-btn${viewTab === v.id ? ' active' : ''}`}
                onClick={() => setViewTab(v.id)}
                style={{ fontSize: 12 }}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>

        {/* Grade filter chips */}
        {viewTab !== 'limitdown' && (
          <div style={{ marginTop: 8, display: 'flex', gap: 5, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, flexShrink: 0 }}>評級</span>
            {GRADE_FILTERS.map(g => {
              const isActive = activeGrades.has(g)
              const gs = GRADE_STYLE[g]
              return (
                <button key={g} onClick={() => toggleGrade(g)} style={{
                  flexShrink: 0, fontSize: 11, fontWeight: 800,
                  padding: '3px 9px', borderRadius: 9999, cursor: 'pointer',
                  border: `1px solid ${isActive ? gs.border : 'var(--ios-sep)'}`,
                  background: isActive ? gs.bg : 'var(--ios-bg3)',
                  color: isActive ? gs.color : 'var(--ios-label3)',
                  transition: 'all 0.15s',
                }}>{g}</button>
              )
            })}
            {activeGrades.size > 0 && (
              <button onClick={() => setActiveGrades(new Set())} style={{
                flexShrink: 0, fontSize: 10, padding: '3px 8px', borderRadius: 9999,
                border: '1px solid rgba(255,51,64,0.3)', background: 'rgba(255,51,64,0.08)',
                color: 'var(--ios-red)', cursor: 'pointer', fontWeight: 600,
              }}>✕</button>
            )}
          </div>
        )}

        {/* Signal filter chips */}
        {viewTab !== 'limitdown' && (
          <div style={{ marginTop: 6, display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none' }}>
            {SIGNAL_FILTERS.map(f => {
              const isActive = activeSignals.has(f.key)
              return (
                <button
                  key={f.key}
                  onClick={() => toggleSignal(f.key)}
                  style={{
                    flexShrink: 0, fontSize: 11, fontWeight: 600,
                    padding: '4px 10px', borderRadius: 9999, cursor: 'pointer',
                    border: isActive ? '1px solid var(--ios-green)' : '1px solid var(--ios-sep)',
                    background: isActive ? 'rgba(22,214,126,0.15)' : 'var(--ios-bg3)',
                    color: isActive ? 'var(--ios-green)' : 'var(--ios-label3)',
                    transition: 'all 0.15s',
                  }}
                >
                  {isActive ? '✓ ' : ''}{f.label}
                </button>
              )
            })}
            {activeSignals.size > 0 && (
              <button
                onClick={() => setActiveSignals(new Set())}
                style={{
                  flexShrink: 0, fontSize: 11, padding: '4px 10px', borderRadius: 9999,
                  border: '1px solid rgba(255,51,64,0.3)', background: 'rgba(255,51,64,0.08)',
                  color: 'var(--ios-red)', cursor: 'pointer', fontWeight: 600,
                }}
              >✕ 清除</button>
            )}
          </div>
        )}

        {/* Trend type filter chips */}
        {viewTab !== 'limitdown' && (
          <div style={{ marginTop: 6, display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none', alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, flexShrink: 0 }}>趨勢</span>
            {TREND_TYPES.map(tt => {
              const isActive = activeTrendType === tt.key
              return (
                <button key={tt.key} onClick={() => setActiveTrendType(isActive ? null : tt.key)} style={{
                  flexShrink: 0, fontSize: 11, fontWeight: 600,
                  padding: '4px 10px', borderRadius: 9999, cursor: 'pointer',
                  border: isActive ? '1px solid var(--ios-blue)' : '1px solid var(--ios-sep)',
                  background: isActive ? 'rgba(10,132,255,0.18)' : 'var(--ios-bg3)',
                  color: isActive ? 'var(--ios-blue)' : 'var(--ios-label3)',
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap',
                }}>
                  {isActive ? '✓ ' : ''}{tt.label}
                </button>
              )
            })}
            {activeTrendType && (
              <button onClick={() => setActiveTrendType(null)} style={{
                flexShrink: 0, fontSize: 11, padding: '4px 10px', borderRadius: 9999,
                border: '1px solid rgba(255,51,64,0.3)', background: 'rgba(255,51,64,0.08)',
                color: 'var(--ios-red)', cursor: 'pointer', fontWeight: 600,
              }}>✕</button>
            )}
          </div>
        )}

        {/* Filter preset combos */}
        {viewTab !== 'limitdown' && stocks.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, flexShrink: 0 }}>組合</span>
            {FILTER_PRESETS.map(preset => {
              const isActive = preset.filters.every(k => activeSignals.has(k))
              return (
                <button key={preset.label} onClick={() => {
                  setActiveSignals(prev => {
                    if (isActive) {
                      // deactivate: remove preset's filters
                      const next = new Set(prev)
                      preset.filters.forEach(k => next.delete(k))
                      return next
                    }
                    // activate: add preset's filters (merge)
                    return new Set([...prev, ...preset.filters])
                  })
                }} style={{
                  flexShrink: 0, fontSize: 10, fontWeight: 700,
                  padding: '3px 9px', borderRadius: 9999, cursor: 'pointer',
                  border: `1px solid ${isActive ? preset.color : 'var(--ios-sep)'}`,
                  background: isActive ? `${preset.color}22` : 'var(--ios-bg3)',
                  color: isActive ? preset.color : 'var(--ios-label3)',
                  transition: 'all 0.15s',
                }}>{isActive ? '✓ ' : ''}{preset.label}</button>
              )
            })}
          </div>
        )}

        </div>{/* /natural-height content wrapper */}
        </div>{/* /collapsible secondary controls */}
      </div>

      {/* ── Scrollable Content ───────────────────────────────────── */}
      <div ref={listScrollRef} onScroll={handleListScroll} style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>

        {/* ── Sector Selector Strip — sticky inside scroll so it doesn't overlap header */}
        {viewTab !== 'limitdown' && availableSectors.length > 0 && (
          <div style={{
            position: 'sticky', top: 0, zIndex: 10,
            padding: '6px 12px 6px',
            display: 'flex', gap: 6, overflowX: 'auto',
            scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch',
            background: 'var(--ios-bg)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderBottom: '0.5px solid var(--ios-sep)',
          }}>
            {activeSector && (
              <button
                onClick={() => setActiveSector(null)}
                style={{
                  flexShrink: 0, fontSize: 11, fontWeight: 700,
                  padding: '5px 10px', borderRadius: 9999, cursor: 'pointer',
                  border: '1px solid rgba(255,51,64,0.4)',
                  background: 'rgba(255,51,64,0.1)',
                  color: 'var(--ios-red)',
                  whiteSpace: 'nowrap',
                }}
              >✕ 全部</button>
            )}
            {availableSectors.map(({ sec, count }) => {
              const isActive = activeSector === sec
              return (
                <button
                  key={sec}
                  onClick={() => {
                    const newSec = isActive ? null : sec
                    setActiveSector(newSec)
                    if (newSec) { setSortField('sector_rs_rank'); setSortDir('desc') }
                  }}
                  style={{
                    flexShrink: 0, fontSize: 11, fontWeight: 600,
                    padding: '5px 11px', borderRadius: 9999, cursor: 'pointer',
                    border: isActive ? '1.5px solid var(--ios-blue)' : '0.5px solid var(--ios-sep)',
                    background: isActive ? 'rgba(10,132,255,0.18)' : 'var(--ios-bg2)',
                    color: isActive ? 'var(--ios-blue)' : 'var(--ios-label2)',
                    transition: 'all 0.15s',
                    whiteSpace: 'nowrap',
                    boxShadow: isActive ? '0 0 0 2px rgba(10,132,255,0.12)' : 'none',
                  }}
                >
                  {sec} <span style={{ fontSize: 10, opacity: 0.55 }}>{count}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Market summary banner */}
        {pred && (() => {
          const isBull = pred.xgb_label === '偏多', isBear = pred.xgb_label === '偏空'
          const pColor = isBull ? '#FF3340' : isBear ? '#16D67E' : '#0A84FF'
          return (
          <div style={{
            margin: '12px 16px 0',
            background: `linear-gradient(135deg, ${pColor}13 0%, var(--ios-bg2) 55%)`,
            borderRadius: 16,
            padding: '14px 16px',
            boxShadow: `var(--shadow-card), inset 0 0 0 0.5px ${pColor}28`,
            borderLeft: `3px solid ${pColor}`,
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 15, fontWeight: 600,
                color: pred.xgb_label === '偏多' ? 'var(--ios-red)' : pred.xgb_label === '偏空' ? 'var(--ios-green)' : 'var(--ios-label)',
              }}>
                {pred.xgb_label === '偏多' ? '📈' : pred.xgb_label === '偏空' ? '📉' : '➡️'} 大盤預測 {Math.round((pred.xgb_prob_up || 0) * 100)}% 上漲
              </span>
              {pred.regime?.label_zh && (
                <span style={{
                  fontSize: 12, color: 'var(--ios-blue)',
                  background: 'rgba(10,132,255,0.12)', borderRadius: 8, padding: '2px 8px', fontWeight: 600,
                }}>{pred.regime.label_zh}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {pred.market_data?.vix != null && <span style={{ fontSize: 12, color: 'var(--ios-label2)' }}>VIX <b style={{ color: 'var(--ios-label)' }}>{pred.market_data.vix}</b></span>}
              {pred.market_data?.futures_net != null && <span style={{ fontSize: 12, color: pred.market_data.futures_net < 0 ? 'var(--ios-green)' : 'var(--ios-red)' }}>外資期貨 {pred.market_data.futures_net?.toLocaleString()}口</span>}
              {pred.market_data?.night_change != null && <span style={{ fontSize: 12, color: pred.market_data.night_change > 0 ? 'var(--ios-red)' : 'var(--ios-green)' }}>夜盤 {pred.market_data.night_change > 0 ? '+' : ''}{pred.market_data.night_change}pt</span>}
            </div>
            {pred.scenario?.main_scenario && (
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--ios-label2)', lineHeight: 1.5, borderTop: '0.5px solid var(--ios-sep)', paddingTop: 8 }}>
                <b style={{ color: 'var(--ios-label)', fontWeight: 600 }}>主力劇本 </b>{pred.scenario.main_scenario}
              </div>
            )}
            {pred.scenario?.best_strategy && (
              <div style={{ fontSize: 12, color: 'var(--ios-green)', marginTop: 4 }}>
                最佳策略：{pred.scenario.best_strategy}
              </div>
            )}
            {pred.scenario?.forbidden_actions?.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--ios-red)', marginTop: 3 }}>
                🚫 {pred.scenario.forbidden_actions.join(' · ')}
              </div>
            )}
          </div>
          )
        })()}

        {/* AI picks */}
        {aiText && (
          <div style={{
            margin: '10px 16px 0',
            background: 'linear-gradient(135deg, rgba(191,90,242,0.10) 0%, var(--ios-bg2) 55%)',
            borderRadius: 16,
            padding: '14px 16px',
            boxShadow: 'var(--shadow-card)',
            border: '0.5px solid rgba(191,90,242,0.22)',
            borderLeft: '3px solid var(--ios-purple)',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ios-purple)', marginBottom: 8, letterSpacing: 0.3, textTransform: 'uppercase' }}>🤖 AI 精選推薦</div>
            <pre style={{ fontSize: 13, color: 'var(--ios-label)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'inherit', lineHeight: 1.65 }}>{aiText}</pre>
          </div>
        )}

        {/* Data quality verification panel */}
        <DataQualityPanel dq={data.dataQuality} />

        {/* Outcome stats + daily action panels */}
        <OutcomeStatsPanel outcomeStats={outcomeStats} />
        <StrategyAccuracyPanel accuracy={data.strategyAccuracy} />
        <BacktestSimulator accuracy={data.strategyAccuracy} />
        <DateComparisonPanel scan={scan} prevScan={prevScan} />
        <MarketBreadthBar stocks={allScanStocks} />
        <InstitutionalLeaderboard stocks={allScanStocks} onSelect={setSelectedStock} />
        <SectorRotationTracker scans={data.scans} dates={sortedDates} />
        <DailyActionPanel scan={scan} prevScan={prevScan} persistent={persistent} />

        {/* Margin chip stats */}
        {(marginStats.clean_count > 0 || marginStats.surge_count > 0) && (
          <div style={{ margin: '10px 16px 0', padding: '10px 14px', background: 'var(--ios-bg2)', borderRadius: 12, display: 'flex', gap: 16, flexWrap: 'wrap', boxShadow: 'var(--shadow-card)' }}>
            {marginStats.clean_count > 0 && <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>📉 融資籌碼乾淨：<b style={{ color: 'var(--ios-green)' }}>{marginStats.clean_count}</b> 支</span>}
            {marginStats.surge_count > 0 && <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>⚠️ 融資暴增警告：<b style={{ color: 'var(--ios-red)' }}>{marginStats.surge_count}</b> 支</span>}
          </div>
        )}

        {/* Calendar risk notice */}
        {calendarRisk && (
          <div style={{ margin: '8px 16px 0', padding: '8px 12px', background: 'rgba(255,159,10,0.08)', borderRadius: 10, borderLeft: '3px solid var(--ios-orange)' }}>
            <span style={{ fontSize: 13, color: 'var(--ios-orange)' }}>📅 {calendarRisk}</span>
          </div>
        )}

        {/* Status notes */}
        {scan.is_partial && (
          <div style={{ margin: '8px 16px 0', padding: '8px 12px', background: 'rgba(255,214,10,0.08)', borderRadius: 10, borderLeft: '3px solid var(--ios-yellow)' }}>
            <span style={{ fontSize: 13, color: 'var(--ios-yellow)' }}>⚠ 部分掃描（{scan.total_scanned} 支），完整結果待更新</span>
          </div>
        )}
        {scan.from_notion_fallback && (
          <div style={{ margin: '8px 16px 0', padding: '8px 12px', background: 'rgba(10,132,255,0.07)', borderRadius: 10, borderLeft: '3px solid var(--ios-blue)' }}>
            <span style={{ fontSize: 12, color: 'var(--ios-blue)' }}>ℹ 顯示最近 Notion 完整掃描（今日尚未完成）</span>
          </div>
        )}
        {data.dataQuality?.institutional_ok === false && !scan.is_partial && (
          <div style={{ margin: '8px 16px 0', padding: '8px 12px', background: 'rgba(255,159,10,0.08)', borderRadius: 10, borderLeft: '3px solid var(--ios-orange)' }}>
            <span style={{ fontSize: 12.5, color: 'var(--ios-orange)' }}>
              ⚠ 三大法人資料尚未公布（盤後 16:00–18:00 TWSE 更新後自動補入），目前排名暫以技術面為主，外資／投信加分未計入，分數與名次將在每日 20:15 彙整後重排
            </span>
          </div>
        )}

        {/* Main stock table */}
        <div style={{ marginTop: 12 }}>
          {/* Sector ranking banner */}
          {activeSector && (
            <div style={{ padding: '4px 16px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-blue)' }}>📊 {activeSector}</span>
              <span style={{ fontSize: 11, color: 'var(--ios-label3)' }}>{filteredAndSorted.length} 支 · 依類股RS排名</span>
            </div>
          )}
          <div style={{ padding: '0 20px 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
            {entryStocks.length > 0 && viewTab === 'all' && !searchQuery && (() => {
              const total = scan.total_scanned || stocks.length
              const entryRate = total > 0 ? Math.round(entryStocks.length / total * 100 * 10) / 10 : 0
              const rateColor = entryRate >= 5 ? 'var(--ios-green)' : entryRate >= 2 ? 'var(--ios-yellow)' : 'var(--ios-label3)'
              return (
                <>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ios-green)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                    進場訊號 · {entryStocks.length} 支
                  </span>
                  {total > 0 && (
                    <span style={{ fontSize: 11, color: rateColor, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                      {entryRate}%
                    </span>
                  )}
                  {total > 0 && (
                    <div style={{ flex: 1, height: 3, background: 'var(--ios-fill2)', borderRadius: 9999, overflow: 'hidden', maxWidth: 80 }}>
                      <div style={{ height: '100%', width: `${Math.min(100, entryRate * 10)}%`, background: rateColor, borderRadius: 9999 }} />
                    </div>
                  )}
                </>
              )
            })()}
            {filterCapActive && (
              <span style={{ fontSize: 12, color: 'var(--ios-label2)', fontWeight: 600 }}>
                前 {FILTER_CAP} 強（共 {filteredAndSorted.length} 支符合）
              </span>
            )}
            {searchQuery && (
              <span style={{ fontSize: 12, color: 'var(--ios-label3)' }}>
                找到 {filteredAndSorted.length} 支
              </span>
            )}
          </div>
          <div
            key={`${viewTab}|${page}|${activeSector || ''}|${sortField}|${sortDir}|${searchQuery.trim()}`}
            className="view-swap"
          >
          {viewTab === 'heatmap' ? (
            <SectorHeatmap
              stocks={stocks}
              activeSector={activeSector}
              onSectorClick={sec => {
                setActiveSector(prev => prev === sec ? null : sec)
                if (activeSector !== sec) setViewTab('all')
              }}
            />
          ) : viewTab === 'watchlist' ? (
            <CustomWatchlistTab
              watchlistStocks={pagedStocks}
              customTrack={customTrack}
              allScanStocks={allScanStocks}
              liveData={liveData}
              onAdd={addCustomTrack}
              onRemove={removeCustomTrack}
              onSelect={setSelectedStock}
              notionMap={notionMap}
              watchlist={watchlist}
              toggleWatchlist={toggleWatchlist}
              persistentMap={persistentMap}
              scoreDeltaMap={scoreDeltaMap}
              globalMaxScore={globalMaxScore}
              rankOffset={page * PAGE_SIZE}
            />
          ) : (
            <WatchlistView
              stocks={pagedStocks}
              globalMaxScore={globalMaxScore}
              onSelect={setSelectedStock}
              notionMap={notionMap}
              watchlist={watchlist}
              toggleWatchlist={toggleWatchlist}
              persistentMap={persistentMap}
              scoreDeltaMap={scoreDeltaMap}
              sectorMode={!!activeSector}
              rankOffset={page * PAGE_SIZE}
              liveData={liveData}
            />
          )}
          </div>
          {/* Show-more button when result is capped at top 20 */}
          {filterCapActive && (
            <div style={{ padding: '10px 20px 4px', textAlign: 'center' }}>
              <button
                onClick={() => setShowAllFiltered(true)}
                style={{
                  background: 'var(--ios-bg3)', border: '0.5px solid var(--ios-sep)',
                  color: 'var(--ios-label2)', borderRadius: 12, padding: '8px 20px',
                  fontSize: 13, cursor: 'pointer', width: '100%',
                }}
              >
                顯示全部 {filteredAndSorted.length} 支符合結果 ↓
              </button>
            </div>
          )}
          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '12px 20px 4px' }}>
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                style={{
                  background: page === 0 ? 'var(--ios-fill2)' : 'var(--ios-blue)',
                  color: page === 0 ? 'var(--ios-label3)' : '#fff',
                  border: 'none', borderRadius: 9999, padding: '6px 16px', fontSize: 13, cursor: page === 0 ? 'default' : 'pointer',
                }}
              >上一頁</button>
              <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                style={{
                  background: page >= totalPages - 1 ? 'var(--ios-fill2)' : 'var(--ios-blue)',
                  color: page >= totalPages - 1 ? 'var(--ios-label3)' : '#fff',
                  border: 'none', borderRadius: 9999, padding: '6px 16px', fontSize: 13, cursor: page >= totalPages - 1 ? 'default' : 'pointer',
                }}
              >下一頁</button>
            </div>
          )}
        </div>

        {/* Secondary sections */}
        <SignalChangeSection
          newEntry={signalChanges.newEntry}
          dropped={signalChanges.dropped}
          onSelect={setSelectedStock}
        />
        <ScoreMoversSection stocks={stocks} scoreDeltaMap={scoreDeltaMap} onSelect={setSelectedStock} />

        {persistent.length > 0 && (
          <PersistentSection
            items={persistent}
            onSelect={item => {
              const full = stocks.find(s => s.stock_id === item.stock_id)
              setSelectedStock(full || { stock_id: item.stock_id, name: item.name, industry_category: item.industry_category || '', entry_score: item.latest_score || 0, price_history: item.price_history || [], condition_count: 0, entry_signal: false })
            }}
          />
        )}

        <NearBreakoutSection stocks={stocks} onSelect={setSelectedStock} />
        <VolumeSurgeSection stocks={stocks} onSelect={setSelectedStock} />

        {limitDownAlerts.length > 0 && (
          <LimitDownSection items={limitDownAlerts} onSelect={setSelectedStock} />
        )}

        <ConsecutiveDropSection stocks={stocks} onSelect={setSelectedStock} />

        <div style={{ padding: '12px 20px 24px', fontSize: 12, color: 'var(--ios-label3)', textAlign: 'center' }}>
          點擊任一列查看詳細資料與 K 線圖
        </div>
      </div>

      <StockDetailModal
        stock={selectedStock}
        notionInfo={selectedStock ? notionMap[selectedStock.stock_id] : null}
        onClose={() => setSelectedStock(null)}
        allScans={data?.scans}
        compareHistories={slimHistories}
        historyDates={historyDates}
      />
    </div>
  )
}
