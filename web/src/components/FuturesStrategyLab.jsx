// 自訂策略期貨預測 —— 使用者自己調權重的台指期多空傾向實驗室。
//
// 全部在前端跑:因子權重、方向、門檻、持有期距、交易成本都可即時調整,
// 右邊立刻用 data.json 既有的 predictionHistory + realOutcomes 回測這組設定。
// 不呼叫任何下單/交易 API,只讀已經生出來的資料。
//
// ⚠️ 規則式傾向估計,非投資建議,不保證任何績效。
import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { animate, stagger } from 'animejs'
import { animateListRows } from '../utils/animeUtils.js'
import {
  FACTORS, FACTOR_GROUPS, PRESETS, STORAGE_KEY, OVERFIT_SAMPLE_FLOOR,
  makeDefaultStrategy, normalizeStrategy, applyPreset, scoreEntry,
  buildSamples, backtest, walkForward, optimize, exportStrategy, importStrategy,
} from '../utils/futuresStrategy.js'

// 台股慣例:多方=紅、空方=綠
const UP = 'var(--ios-red)'
const DOWN = 'var(--ios-green)'
const FLAT = 'var(--ios-label3)'
const dirColor = (d) => (d > 0 ? UP : d < 0 ? DOWN : FLAT)
const pctText = (v, d = 1) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`)
const rateText = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

function Card({ title, accent, right, children }) {
  return (
    <div style={{
      background: 'var(--ios-bg2)', borderRadius: 16, marginBottom: 12, overflow: 'hidden',
      boxShadow: 'var(--shadow-card)', ...(accent ? { borderLeft: `3px solid ${accent}` } : {}),
    }}>
      {title && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 0' }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, color: accent || 'var(--ios-label2)', textTransform: 'uppercase' }}>{title}</div>
          {right}
        </div>
      )}
      <div style={{ padding: '12px 16px 14px' }}>{children}</div>
    </div>
  )
}

function Stat({ label, value, sub, color }) {
  return (
    <div style={{ background: 'var(--ios-fill2)', borderRadius: 10, padding: '8px 10px', minWidth: 0 }}>
      <div style={{ fontSize: 10.5, color: 'var(--ios-label3)', marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, fontFamily: 'var(--font-mono)', color: color || 'var(--ios-label)', letterSpacing: '-0.3px' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--ios-label4)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ── 今日分數表:半圓錶 + 數字滾動(anime.js) ───────────────────────────────
function ScoreDial({ score, label, direction, insufficient }) {
  const numRef = useRef(null)
  const arcRef = useRef(null)
  const s = score ?? 0
  const color = insufficient ? FLAT : dirColor(direction)
  const R = 52, CIRC = Math.PI * R           // 半圓弧長
  useLayoutEffect(() => {
    const arc = arcRef.current
    if (arc) {
      arc.style.strokeDasharray = `${CIRC}`
      arc.style.strokeDashoffset = `${CIRC}`
      animate(arc, {
        strokeDashoffset: [CIRC, CIRC * (1 - Math.min(1, Math.abs(s) / 100))],
        duration: 900, ease: 'outCubic',
      })
    }
    const obj = { v: 0 }
    animate(obj, {
      v: s, duration: 900, ease: 'outCubic',
      onUpdate: () => { if (numRef.current) numRef.current.textContent = (obj.v > 0 ? '+' : '') + Math.round(obj.v) },
    })
  }, [s, CIRC])
  // 空方往左長、多方往右長:用 scaleX 鏡射同一條弧
  const mirror = s < 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ position: 'relative', width: 128, height: 72, flexShrink: 0 }}>
        <svg width="128" height="72" viewBox="0 0 128 72" style={{ transform: mirror ? 'scaleX(-1)' : 'none' }}>
          <path d="M 12 64 A 52 52 0 0 1 116 64" fill="none" stroke="var(--ios-fill3)" strokeWidth="9" strokeLinecap="round" />
          <path ref={arcRef} d="M 64 12 A 52 52 0 0 1 116 64" fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${color}55)` }} />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 2 }}>
          <span ref={numRef} style={{ fontSize: 28, fontWeight: 800, fontFamily: 'var(--font-mono)', color, letterSpacing: '-1px' }}>0</span>
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color, letterSpacing: '-0.5px' }}>{label}</div>
        <div style={{ fontSize: 11.5, color: 'var(--ios-label3)', marginTop: 4, lineHeight: 1.5 }}>
          分數範圍 −100(極空)~ +100(極多)<br />依你目前設定的權重與門檻即時計算
        </div>
      </div>
    </div>
  )
}

// ── 因子貢獻長條(左負右正) ─────────────────────────────────────────────────
function ContribBars({ components }) {
  const ref = useRef(null)
  const used = components.filter(c => !c.missing && Math.abs(c.share || 0) > 0.05)
    .sort((a, b) => Math.abs(b.share) - Math.abs(a.share))
  useLayoutEffect(() => {
    const els = ref.current?.querySelectorAll('[data-bar]')
    if (!els?.length) return
    els.forEach(el => { el.style.transform = 'scaleX(0)' })
    animate(els, { scaleX: [0, 1], duration: 520, ease: 'outQuart', delay: stagger(35) })
  }, [components])
  if (!used.length) return <div style={{ fontSize: 12, color: 'var(--ios-label3)' }}>目前沒有任何有資料的因子。</div>
  const max = Math.max(...used.map(c => Math.abs(c.share)), 1)
  return (
    <div ref={ref}>
      {used.map(c => {
        const w = (Math.abs(c.share) / max) * 46
        const pos = c.share >= 0
        return (
          <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{ width: 96, fontSize: 11, color: 'var(--ios-label2)', textAlign: 'right', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</div>
            <div style={{ flex: 1, position: 'relative', height: 14 }}>
              <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--ios-sep)' }} />
              <div data-bar style={{
                position: 'absolute', top: 2, height: 10, borderRadius: 3,
                background: pos ? UP : DOWN, opacity: 0.85,
                left: pos ? '50%' : `${50 - w}%`, width: `${w}%`,
                transformOrigin: pos ? 'left center' : 'right center',
              }} />
            </div>
            <div style={{ width: 84, fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--ios-label3)', flexShrink: 0 }}>
              {c.share > 0 ? '+' : ''}{c.share.toFixed(1)}
            </div>
          </div>
        )
      })}
      <div style={{ fontSize: 10, color: 'var(--ios-label4)', marginTop: 6, lineHeight: 1.6 }}>
        每條 = 該因子對總分的實際貢獻(已依權重 normalize),全部加總 = 上方分數。
      </div>
    </div>
  )
}

// ── 權益曲線 ────────────────────────────────────────────────────────────────
function EquityCurve({ curve, hold }) {
  const pathRef = useRef(null)
  const pts = curve || []
  const geom = useMemo(() => {
    if (pts.length < 2) return null
    const W = 300, H = 84
    const vals = pts.map(p => p.equity)
    const lo = Math.min(...vals, 1), hi = Math.max(...vals, 1)
    const pad = (hi - lo) * 0.12 || 0.01
    const y = (v) => H - ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * H
    const x = (i) => (i / (pts.length - 1)) * W
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ')
    const base = `M0,${y(1).toFixed(1)} L${W},${y(1).toFixed(1)}`
    return { W, H, d, base }
  }, [pts])
  useLayoutEffect(() => {
    const el = pathRef.current
    if (!el || !geom) return
    const len = el.getTotalLength?.() || 0
    if (!len) return
    el.style.strokeDasharray = `${len}`
    el.style.strokeDashoffset = `${len}`
    animate(el, { strokeDashoffset: [len, 0], duration: 900, ease: 'outQuart' })
  }, [geom])
  if (!geom) return <div style={{ fontSize: 12, color: 'var(--ios-label3)' }}>可回測的天數不足,尚無法畫出權益曲線。</div>
  const last = pts[pts.length - 1].equity - 1
  const color = last >= 0 ? UP : DOWN
  return (
    <div>
      <svg width="100%" height="92" viewBox={`0 0 ${geom.W} ${geom.H + 8}`} preserveAspectRatio="none">
        <path d={geom.base} stroke="var(--ios-sep)" strokeWidth="1" strokeDasharray="3 3" fill="none" />
        <path ref={pathRef} d={geom.d} stroke={color} strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 4px ${color}44)` }} vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--ios-label4)', marginTop: 2 }}>
        <span>{pts[0].date}</span>
        <span><span style={{ color }}>策略累積 {pctText(last, 2)}</span>　·　同期買進持有 {pctText(hold, 2)}</span>
        <span>{pts[pts.length - 1].date}</span>
      </div>
    </div>
  )
}

// ── 單一因子設定列 ──────────────────────────────────────────────────────────
function FactorRow({ factor, cfg, value, signal, onChange, advanced }) {
  const on = cfg.enabled && cfg.weight > 0
  return (
    <div data-row style={{ padding: '9px 0', borderBottom: '0.5px solid var(--ios-sep)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => onChange({ enabled: !cfg.enabled, weight: !cfg.enabled && cfg.weight === 0 ? 20 : cfg.weight })}
          title={cfg.enabled ? '停用此因子' : '啟用此因子'}
          style={{
            width: 20, height: 20, borderRadius: 6, flexShrink: 0, cursor: 'pointer',
            border: `1px solid ${on ? 'var(--ios-blue)' : 'var(--ios-sep)'}`,
            background: on ? 'var(--ios-blue)' : 'transparent', color: '#fff', fontSize: 12, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >{on ? '✓' : ''}</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: on ? 'var(--ios-label)' : 'var(--ios-label3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {factor.label}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--ios-label4)', fontFamily: 'var(--font-mono)' }}>
            今日 {value == null ? '無資料' : factor.fmt(value)}
            {signal != null && <span style={{ color: signal > 0 ? UP : signal < 0 ? DOWN : FLAT }}>　訊號 {signal > 0 ? '+' : ''}{signal.toFixed(2)}</span>}
          </div>
        </div>
        <button
          onClick={() => onChange({ dir: cfg.dir === 1 ? -1 : 1 })}
          title="順向 = 數值越大越偏多;逆向 = 反過來(逆勢/軋空派)"
          style={{
            fontSize: 10.5, padding: '3px 8px', borderRadius: 7, cursor: 'pointer', flexShrink: 0,
            border: '0.5px solid var(--ios-sep)', background: 'var(--ios-fill2)',
            color: cfg.dir === 1 ? 'var(--ios-blue)' : 'var(--ios-orange)', fontWeight: 700,
          }}
        >{cfg.dir === 1 ? '順向' : '逆向'}</button>
        <div style={{ width: 34, textAlign: 'right', fontSize: 12, fontFamily: 'var(--font-mono)', color: on ? 'var(--ios-label)' : 'var(--ios-label4)', flexShrink: 0 }}>
          {cfg.weight}
        </div>
      </div>
      <input
        type="range" min="0" max="100" step="1" value={cfg.weight}
        onChange={(e) => onChange({ weight: Number(e.target.value), enabled: Number(e.target.value) > 0 })}
        style={{ width: '100%', marginTop: 6, accentColor: on ? 'var(--ios-blue)' : 'var(--ios-label4)' }}
      />
      {advanced && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, fontSize: 10.5, color: 'var(--ios-label3)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            滿分刻度
            <input type="number" value={cfg.scale} step="any"
              onChange={(e) => onChange({ scale: Number(e.target.value) || factor.scale })}
              style={{ width: 78, background: 'var(--ios-fill2)', border: '0.5px solid var(--ios-sep)', borderRadius: 6, color: 'var(--ios-label)', padding: '2px 6px', fontSize: 11, fontFamily: 'var(--font-mono)' }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            中心值
            <input type="number" value={cfg.center} step="any"
              onChange={(e) => onChange({ center: Number(e.target.value) || 0 })}
              style={{ width: 62, background: 'var(--ios-fill2)', border: '0.5px solid var(--ios-sep)', borderRadius: 6, color: 'var(--ios-label)', padding: '2px 6px', fontSize: 11, fontFamily: 'var(--font-mono)' }} />
          </label>
          {factor.hint && <span style={{ flex: 1, minWidth: 120, color: 'var(--ios-label4)' }}>{factor.hint}</span>}
        </div>
      )}
    </div>
  )
}

function Slider({ label, value, min, max, step = 1, suffix = '', onChange, hint }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ios-label2)', marginBottom: 3 }}>
        <span>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ios-label)' }}>{value}{suffix}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--ios-blue)' }} />
      {hint && <div style={{ fontSize: 10, color: 'var(--ios-label4)', marginTop: 2 }}>{hint}</div>}
    </div>
  )
}

// ── 主元件 ──────────────────────────────────────────────────────────────────
export default function FuturesStrategyLab({ prediction, history = [], realOutcomes = null, futuresChips = null }) {
  const [strategy, setStrategy] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
      if (saved?.current) return normalizeStrategy(saved.current)
    } catch { /* 壞掉的舊資料就當沒有 */ }
    return makeDefaultStrategy('均衡型')
  })
  const [saved, setSaved] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')?.list || [] } catch { return [] }
  })
  const [advanced, setAdvanced] = useState(false)
  const [showFactors, setShowFactors] = useState(true)
  const [ioOpen, setIoOpen] = useState(false)
  const [ioText, setIoText] = useState('')
  const [ioMsg, setIoMsg] = useState(null)
  const [opt, setOpt] = useState(null)
  const [optObjective, setOptObjective] = useState('hit')
  const [optBusy, setOptBusy] = useState(false)
  const [prevStrategy, setPrevStrategy] = useState(null)

  // 持久化:current 與 list 一起存,重新整理後設定不會不見
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ current: strategy, list: saved })) } catch { /* 隱私模式忽略 */ }
  }, [strategy, saved])

  const samples = useMemo(
    () => buildSamples({ history, prediction, futuresChips, outcomes: realOutcomes?.prediction || [] }),
    [history, prediction, futuresChips, realOutcomes]
  )
  const today = samples.length ? samples[samples.length - 1] : null
  const todayScore = useMemo(() => scoreEntry(today, strategy), [today, strategy])
  const result = useMemo(() => backtest(samples, strategy), [samples, strategy])
  const wf = useMemo(() => walkForward(samples, strategy), [samples, strategy])

  const patchFactor = useCallback((key, patch) => {
    setStrategy(s => normalizeStrategy({ ...s, factors: { ...s.factors, [key]: { ...s.factors[key], ...patch } } }))
  }, [])
  const patchStrategy = useCallback((patch) => setStrategy(s => normalizeStrategy({ ...s, ...patch })), [])

  const runOptimize = () => {
    setOptBusy(true)
    // 讓 busy 狀態先畫出來再跑(搜尋是同步的,約數百毫秒)
    setTimeout(() => {
      try {
        const o = optimize(samples, strategy, { iterations: 600, objective: optObjective })
        setOpt(o)
      } finally { setOptBusy(false) }
    }, 30)
  }
  const applyOptimized = () => {
    if (!opt?.strategy) return
    setPrevStrategy(strategy)
    setStrategy(normalizeStrategy({ ...opt.strategy, name: `${strategy.name}(最佳化)` }))
    setOpt(null)
  }

  const saveCurrent = () => {
    const entry = { id: Date.now(), name: strategy.name, strategy, savedAt: new Date().toISOString().slice(0, 10) }
    setSaved(list => [entry, ...list.filter(x => x.name !== strategy.name)].slice(0, 12))
  }

  const listRef = useRef(null)
  useLayoutEffect(() => { if (showFactors) animateListRows(listRef.current) }, [showFactors, advanced])

  const headRef = useRef(null)
  useLayoutEffect(() => {
    const el = headRef.current
    if (!el) return
    el.style.opacity = '0'
    el.style.transform = 'translateY(10px)'
    animate(el, { opacity: [0, 1], translateY: [10, 0], duration: 420, ease: 'outQuart' })
  }, [])

  const enabledCount = FACTORS.filter(f => strategy.factors[f.key].enabled && strategy.factors[f.key].weight > 0).length
  const lowSample = (result.samples ?? 0) < OVERFIT_SAMPLE_FLOOR
  const beatModel = result.hitRate != null && result.model.hitRate != null && result.hitRate > result.model.hitRate

  if (!samples.length) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 48 }}>🧪</div>
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ios-label)' }}>尚無可用的盤前資料</div>
        <div style={{ fontSize: 14, color: 'var(--ios-label2)', maxWidth: 280, lineHeight: 1.6 }}>
          等盤前預測跑過一次後,這裡就能開始調權重、回測自己的期貨策略。
        </div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 2, padding: '6px 20px',
        background: 'var(--ios-bg)', borderBottom: '0.5px solid var(--ios-sep)',
        fontSize: 13, color: 'var(--ios-label2)', display: 'flex', justifyContent: 'space-between',
      }}>
        <span>{today?.date || '—'}</span>
        <span>{strategy.name} · {enabledCount} 個因子</span>
      </div>

      <div style={{ padding: '14px 16px 0' }}>
        {/* ── 今日訊號 ────────────────────────────────────────────── */}
        <div ref={headRef}>
          <Card title="今日台指期傾向 · 你的策略" accent={dirColor(todayScore.direction)}>
            <ScoreDial score={todayScore.score} label={todayScore.label} direction={todayScore.direction} insufficient={todayScore.insufficient} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 12 }}>
              <Stat label="有資料因子" value={`${todayScore.used}/${enabledCount}`} sub={`需 ≥ ${strategy.minFactors}`} />
              <Stat label="多方門檻" value={`+${strategy.longThreshold}`} color={UP} />
              <Stat label="空方門檻" value={`${strategy.shortThreshold}`} color={DOWN} />
            </div>
            {todayScore.insufficient && (
              <div style={{ marginTop: 10, padding: '8px 10px', background: 'rgba(255,159,10,0.12)', borderRadius: 10, fontSize: 11.5, color: 'var(--ios-orange)', lineHeight: 1.6 }}>
                今日有資料的因子({todayScore.used})少於你設定的最低門檻({strategy.minFactors}),因此不出方向訊號。可降低門檻或改用資料較齊的因子。
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ios-label3)', marginBottom: 8 }}>因子貢獻拆解</div>
              <ContribBars components={todayScore.components} />
            </div>
          </Card>
        </div>

        {/* ── 回測 ────────────────────────────────────────────────── */}
        <Card title={`回測 · 持有 ${strategy.horizon} 個交易日`} accent="var(--ios-teal)">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            <Stat label="方向命中率" value={rateText(result.hitRate)} sub={`${result.hits}/${result.samples} 次訊號`}
              color={result.hitRate == null ? undefined : result.hitRate >= 0.5 ? UP : DOWN} />
            <Stat label="模型基準" value={rateText(result.model.hitRate)} sub={`${result.model.hits}/${result.model.n} 次`} />
            <Stat label="訊號覆蓋率" value={rateText(result.coverage)} sub="有訊號天數占比" />
            <Stat label="策略累積" value={pctText(result.totalRet, 1)} color={result.totalRet == null ? undefined : result.totalRet >= 0 ? UP : DOWN} sub={`含成本 ${strategy.costBps} bps`} />
            <Stat label="買進持有" value={pctText(result.hold, 1)} sub="同期加權指數" />
            <Stat label="最大回撤" value={pctText(result.maxDrawdown, 1)} color={DOWN} />
            <Stat label="做多命中" value={result.long.n ? `${result.long.hits}/${result.long.n}` : '—'} color={UP} />
            <Stat label="做空命中" value={result.short.n ? `${result.short.hits}/${result.short.n}` : '—'} color={DOWN} />
            <Stat label="平均單次" value={pctText(result.avgDirRet, 2)} sub="方向調整後" />
          </div>

          <div style={{ marginTop: 14 }}>
            <EquityCurve curve={result.curve} hold={result.hold} />
          </div>

          {wf && (
            <div style={{ marginTop: 12, background: 'var(--ios-fill2)', borderRadius: 10, padding: '9px 11px' }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ios-label2)', marginBottom: 6 }}>樣本外檢查(前 70% 調參 / 後 30% 驗證)</div>
              <div style={{ display: 'flex', gap: 14, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--ios-label2)' }}>
                <span>訓練段 {rateText(wf.train.hitRate)}（{wf.train.n} 次）</span>
                <span>驗證段 {rateText(wf.test.hitRate)}（{wf.test.n} 次）</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--ios-label4)', marginTop: 5, lineHeight: 1.6 }}>
                若訓練段亮眼、驗證段崩掉,代表這組權重多半是被歷史噪音喂出來的,別當真。
              </div>
            </div>
          )}

          <div style={{ marginTop: 10, padding: '8px 10px', background: lowSample ? 'rgba(255,159,10,0.12)' : 'var(--ios-fill2)', borderRadius: 10, fontSize: 11, color: lowSample ? 'var(--ios-orange)' : 'var(--ios-label3)', lineHeight: 1.65 }}>
            {lowSample
              ? `⚠️ 目前只有 ${result.samples} 次訊號(有實際結果可比對的只有 ${result.tradableDays} 天),遠低於統計上可信的樣本量。命中率${beatModel ? '看起來贏過模型也' : ''}極可能只是運氣,不要據此加碼。`
              : `樣本 ${result.samples} 次訊號 / ${result.tradableDays} 個可比對交易日。回測未計滑價與稅費,實際成交價與盤前訊號一定有落差。`}
          </div>
        </Card>

        {/* ── 策略範本 ────────────────────────────────────────────── */}
        <Card title="策略範本" accent="var(--ios-purple)">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {PRESETS.map(p => (
              <button key={p.id} onClick={() => { setPrevStrategy(strategy); setStrategy(applyPreset(p.id, strategy)); setOpt(null) }}
                title={p.desc}
                style={{
                  fontSize: 12, padding: '6px 12px', borderRadius: 9999, cursor: 'pointer',
                  border: '0.5px solid var(--ios-sep)',
                  background: strategy.name === p.name ? 'var(--ios-blue)' : 'var(--ios-fill2)',
                  color: strategy.name === p.name ? '#fff' : 'var(--ios-label)', fontWeight: 600,
                }}>{p.name}</button>
            ))}
            {prevStrategy && (
              <button onClick={() => { setStrategy(prevStrategy); setPrevStrategy(null) }}
                style={{ fontSize: 12, padding: '6px 12px', borderRadius: 9999, cursor: 'pointer', border: '0.5px solid var(--ios-sep)', background: 'transparent', color: 'var(--ios-label3)' }}>↩︎ 還原上一組</button>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ios-label4)', marginTop: 8, lineHeight: 1.6 }}>
            {PRESETS.find(p => p.name === strategy.name)?.desc || '目前是自訂權重 —— 下面每一條都可以自己拉。'}
          </div>
        </Card>

        {/* ── 因子權重 ────────────────────────────────────────────── */}
        <Card
          title="因子權重"
          accent="var(--ios-blue)"
          right={
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setAdvanced(a => !a)} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 7, border: '0.5px solid var(--ios-sep)', background: advanced ? 'var(--ios-blue)' : 'var(--ios-fill2)', color: advanced ? '#fff' : 'var(--ios-label2)', cursor: 'pointer' }}>進階</button>
              <button onClick={() => setShowFactors(s => !s)} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 7, border: '0.5px solid var(--ios-sep)', background: 'var(--ios-fill2)', color: 'var(--ios-label2)', cursor: 'pointer' }}>{showFactors ? '收合' : '展開'}</button>
            </div>
          }
        >
          {showFactors && (
            <div ref={listRef}>
              {FACTOR_GROUPS.map(group => (
                <div key={group} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.5, margin: '8px 0 2px' }}>{group}</div>
                  {FACTORS.filter(f => f.group === group).map(f => (
                    <FactorRow
                      key={f.key} factor={f} cfg={strategy.factors[f.key]}
                      value={today ? f.pick(today) : null}
                      signal={todayScore.components.find(c => c.key === f.key && !c.missing)?.signal ?? null}
                      advanced={advanced}
                      onChange={(patch) => patchFactor(f.key, patch)}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* ── 進出場設定 ──────────────────────────────────────────── */}
        <Card title="進出場設定" accent="var(--ios-orange)">
          <Slider label="持有期距(交易日)" value={strategy.horizon} min={1} max={10}
            onChange={(v) => patchStrategy({ horizon: v })}
            hint="1 = 只賭當天;5 = 與既有模型的實際期距一致" />
          <Slider label="做多門檻" value={strategy.longThreshold} min={0} max={80} suffix=" 分"
            onChange={(v) => patchStrategy({ longThreshold: v })}
            hint="分數要超過這個值才算多方訊號 —— 拉高 = 出手少但更挑" />
          <Slider label="做空門檻" value={strategy.shortThreshold} min={-80} max={0} suffix=" 分"
            onChange={(v) => patchStrategy({ shortThreshold: v })} />
          <Slider label="最少可用因子數" value={strategy.minFactors} min={1} max={Math.max(1, enabledCount)}
            onChange={(v) => patchStrategy({ minFactors: v })}
            hint="當天有資料的因子太少就不出訊號,避免拿半套資料下結論" />
          <Slider label="換倉成本" value={strategy.costBps} min={0} max={30} suffix=" bps"
            onChange={(v) => patchStrategy({ costBps: v })}
            hint="每次調整部位扣掉的手續費+稅+滑價估計(台指期單邊約 2~5 bps)" />
        </Card>

        {/* ── 自動找權重 ──────────────────────────────────────────── */}
        <Card title="自動找權重(隨機搜尋)" accent="var(--ios-pink)">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={optObjective} onChange={(e) => { setOptObjective(e.target.value); setOpt(null) }}
              style={{ fontSize: 12, padding: '6px 10px', borderRadius: 8, background: 'var(--ios-fill2)', color: 'var(--ios-label)', border: '0.5px solid var(--ios-sep)' }}>
              <option value="hit">目標:方向命中率</option>
              <option value="ret">目標:累積報酬</option>
              <option value="sharpe">目標:風險調整後報酬</option>
            </select>
            <button onClick={runOptimize} disabled={optBusy || !enabledCount}
              style={{ fontSize: 12.5, fontWeight: 700, padding: '7px 16px', borderRadius: 9999, border: 'none', background: optBusy ? 'var(--ios-fill3)' : 'var(--ios-blue)', color: '#fff', cursor: optBusy ? 'default' : 'pointer' }}>
              {optBusy ? '搜尋中⋯' : '搜尋 600 組權重'}
            </button>
          </div>
          {opt && (
            <div style={{ marginTop: 10, background: 'var(--ios-fill2)', borderRadius: 10, padding: '10px 12px' }}>
              {opt.improved ? (
                <>
                  <div style={{ fontSize: 12.5, color: 'var(--ios-label)', fontWeight: 600 }}>
                    找到更好的一組:命中率 {rateText(opt.result.hitRate)}、累積 {pctText(opt.result.totalRet, 1)}({opt.result.samples} 次訊號)
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--ios-label4)', marginTop: 5, lineHeight: 1.6 }}>
                    搜尋只調「已啟用因子」的權重,方向與門檻維持你的設定;要求至少 {opt.minSamples} 次訊號才納入比較。
                  </div>
                  <button onClick={applyOptimized}
                    style={{ marginTop: 8, fontSize: 12, fontWeight: 700, padding: '6px 14px', borderRadius: 9999, border: 'none', background: 'var(--ios-blue)', color: '#fff', cursor: 'pointer' }}>套用這組權重</button>
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: 'var(--ios-label2)' }}>搜尋 {opt.iterations} 組後,沒有一組在門檻內贏過你目前的設定。</div>
              )}
              {opt.overfitRisk && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--ios-orange)', lineHeight: 1.65 }}>
                  ⚠️ 這次最佳化只有 {opt.result.samples} 次訊號可用。在這種樣本量下「跑出漂亮數字」幾乎是必然的 —— 把它當成探索方向的工具,不是可以下注的結論。務必看上面的樣本外檢查。
                </div>
              )}
            </div>
          )}
        </Card>

        {/* ── 儲存 / 匯出 ─────────────────────────────────────────── */}
        <Card title="我的策略" accent="var(--ios-green)">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={strategy.name} onChange={(e) => patchStrategy({ name: e.target.value })}
              placeholder="策略名稱"
              style={{ flex: 1, minWidth: 0, background: 'var(--ios-fill2)', border: '0.5px solid var(--ios-sep)', borderRadius: 8, color: 'var(--ios-label)', padding: '7px 10px', fontSize: 13 }} />
            <button onClick={saveCurrent}
              style={{ fontSize: 12.5, fontWeight: 700, padding: '7px 14px', borderRadius: 9999, border: 'none', background: 'var(--ios-green)', color: '#fff', cursor: 'pointer', flexShrink: 0 }}>儲存</button>
          </div>
          {saved.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {saved.map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '0.5px solid var(--ios-sep)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: 'var(--ios-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--ios-label4)' }}>{s.savedAt}</div>
                  </div>
                  <button onClick={() => { setPrevStrategy(strategy); setStrategy(normalizeStrategy(s.strategy)) }}
                    style={{ fontSize: 11, padding: '3px 10px', borderRadius: 7, border: '0.5px solid var(--ios-sep)', background: 'var(--ios-fill2)', color: 'var(--ios-blue)', cursor: 'pointer' }}>載入</button>
                  <button onClick={() => setSaved(list => list.filter(x => x.id !== s.id))}
                    style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: '0.5px solid var(--ios-sep)', background: 'transparent', color: 'var(--ios-label3)', cursor: 'pointer' }}>刪除</button>
                </div>
              ))}
            </div>
          )}
          <button onClick={() => { setIoOpen(o => !o); setIoText(exportStrategy(strategy)); setIoMsg(null) }}
            style={{ marginTop: 10, fontSize: 11.5, padding: '5px 12px', borderRadius: 8, border: '0.5px solid var(--ios-sep)', background: 'var(--ios-fill2)', color: 'var(--ios-label2)', cursor: 'pointer' }}>
            {ioOpen ? '收起匯出/匯入' : '匯出 / 匯入 JSON'}
          </button>
          {ioOpen && (
            <div style={{ marginTop: 8 }}>
              <textarea value={ioText} onChange={(e) => setIoText(e.target.value)} rows={8}
                style={{ width: '100%', boxSizing: 'border-box', background: 'var(--ios-fill2)', border: '0.5px solid var(--ios-sep)', borderRadius: 8, color: 'var(--ios-label)', padding: 8, fontSize: 11, fontFamily: 'var(--font-mono)', resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                <button onClick={() => {
                  const r = importStrategy(ioText)
                  if (r.ok) { setPrevStrategy(strategy); setStrategy(r.strategy); setIoMsg('已套用匯入的策略') }
                  else setIoMsg(`匯入失敗:${r.error}`)
                }}
                  style={{ fontSize: 12, padding: '6px 14px', borderRadius: 9999, border: 'none', background: 'var(--ios-blue)', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>套用這段 JSON</button>
                {ioMsg && <span style={{ fontSize: 11, color: 'var(--ios-label3)' }}>{ioMsg}</span>}
              </div>
            </div>
          )}
        </Card>

        <div style={{ fontSize: 10.5, color: 'var(--ios-label4)', lineHeight: 1.75, padding: '0 2px 4px' }}>
          本頁是規則式的多空傾向試算與歷史回測工具,<b>不是投資建議,也不保證任何獲利</b>。
          回測樣本僅涵蓋既有盤前紀錄與加權指數收盤,未計滑價、稅費與夜盤跳空,且台指期為槓桿商品、風險遠高於現股。
          任何設定都請自行判斷後再決定是否使用。
        </div>
      </div>

      <div style={{ height: 24 }} />
    </div>
  )
}
