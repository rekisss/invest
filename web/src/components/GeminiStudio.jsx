import { useState, useRef, useEffect, useCallback, useMemo } from 'react'

// ── Gemini free-tier multi-agent roundtable ──────────────────────────────────
// Four analysts discuss a stock using scan data + system-computed technical
// reference levels. Concise mode: each analyst max 80 chars per point,
// no preamble, no filler. Auto-run keeps the discussion going continuously.

const GEMINI_KEY_STORAGE = 'gemini_api_key'
const GEMINI_MODEL_STORAGE = 'gemini_model'
const MODELS = [
  { id: 'gemini-2.0-flash',      label: 'Gemini 2.0 Flash（推薦）' },
  { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite' },
  { id: 'gemini-1.5-flash',      label: 'Gemini 1.5 Flash（舊版）' },
]

const ANALYSTS = [
  {
    id: 'tech', name: '技術派', emoji: '📈', color: '#0a84ff',
    persona: `台股技術分析師。只引用 RSI/ADX/MACD/均線/量能的實際數字。`,
  },
  {
    id: 'fund', name: '基本面派', emoji: '💰', color: '#30d158',
    persona: `台股基本面分析師。只看 F-Score、月營收 YoY、產業地位，數字說話。`,
  },
  {
    id: 'chip', name: '籌碼派', emoji: '🌐', color: '#ff9f0a',
    persona: `台股籌碼分析師。只看三大法人連買天數、融資5日變化、外資持股。`,
  },
  {
    id: 'risk', name: '風控長', emoji: '🛡️', color: '#f85149',
    persona: `台股風控長，最後發言。裁決：建議進場 / 觀察 / 迴避其中之一。必須用【技術參考位】的數字給出進場區、停損價、目標一/二、風報比。敢否定樂觀派。`,
  },
]

const s = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--ios-bg)' },
  setup: { flex: 1, overflowY: 'auto', padding: '18px 16px', WebkitOverflowScrolling: 'touch' },
  label: { fontSize: 12, fontWeight: 700, color: 'var(--ios-label2)', marginBottom: 8, letterSpacing: 0.3 },
  input: {
    width: '100%', background: 'var(--ios-bg3)', border: '0.5px solid var(--ios-sep)',
    borderRadius: 10, padding: '10px 12px', color: 'var(--ios-label)', fontSize: 14,
    boxSizing: 'border-box', outline: 'none',
  },
  chip: (active, color) => ({
    flexShrink: 0, padding: '7px 13px', borderRadius: 9999, fontSize: 12.5, fontWeight: active ? 700 : 500,
    border: `1px solid ${active ? color : 'var(--ios-sep)'}`,
    background: active ? color + '22' : 'var(--ios-fill4)',
    color: active ? color : 'var(--ios-label2)', cursor: 'pointer', whiteSpace: 'nowrap',
  }),
  msgs: { flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14, WebkitOverflowScrolling: 'touch' },
  msgRow: (role) => ({ display: 'flex', flexDirection: role === 'user' ? 'row-reverse' : 'row', gap: 8, alignItems: 'flex-end' }),
  avatar: (color, role) => ({
    width: 30, height: 30, borderRadius: '50%', flexShrink: 0, fontSize: 15,
    background: role === 'user' ? 'var(--ios-fill3)' : color + '33',
    border: `1px solid ${role === 'user' ? 'var(--ios-sep)' : color + '66'}`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }),
  bubble: (role, color) => ({
    maxWidth: '82%', padding: '10px 13px',
    borderRadius: role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
    background: role === 'user' ? 'var(--ios-blue)' : 'var(--ios-bg3)',
    color: role === 'user' ? '#fff' : 'var(--ios-label)', fontSize: 14.5, lineHeight: 1.55,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    borderLeft: role === 'user' ? 'none' : `2.5px solid ${color}`,
  }),
  name: (color) => ({ fontSize: 11, fontWeight: 700, color, marginBottom: 3 }),
  inputArea: { borderTop: '0.5px solid var(--ios-sep)', padding: '10px 14px 14px', background: 'var(--ios-bg2)', flexShrink: 0 },
}

function geminiKey() { return sessionStorage.getItem(GEMINI_KEY_STORAGE) || '' }
function savedModel() { return localStorage.getItem(GEMINI_MODEL_STORAGE) || MODELS[0].id }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const r2 = v => (v == null || isNaN(v) ? null : Math.round(v * 100) / 100)

async function callGemini(apiKey, model, systemPrompt, userPrompt, onRetry) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: 280, temperature: 0.8 },
      }),
    })
    if (resp.status === 429) {
      const err = await resp.json().catch(() => ({}))
      const msg = err?.error?.message || ''
      const ri = err?.error?.details?.find(d => (d['@type'] || '').includes('RetryInfo'))
      let delay = ri?.retryDelay ? parseFloat(ri.retryDelay) : 0
      if (!delay) { const m = msg.match(/retry in ([\d.]+)/i); if (m) delay = parseFloat(m[1]) }
      delay = Math.min(Math.max(delay || 5, 2), 45)
      if (attempt < 2) { onRetry?.(Math.ceil(delay)); await sleep(delay * 1000); continue }
      throw new Error(`免費額度暫時用盡（${model}）。請稍候約 ${Math.ceil(delay)} 秒再試，或在設定切換模型。`)
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      throw new Error(err?.error?.message || `HTTP ${resp.status}`)
    }
    const j = await resp.json()
    const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || ''
    if (!text) throw new Error('Gemini 無回應（可能觸發安全過濾）')
    return text.trim()
  }
}

// ── Stock resolution + technical level computation ───────────────────────────

function allScanRows(data) {
  const dates = Object.keys(data?.scans || {}).sort().reverse()
  let scan = null
  for (const d of dates) {
    const sc = data.scans[d]
    if (sc && ((sc.top_stocks && sc.top_stocks.length) || (sc.filter_stocks && sc.filter_stocks.length))) { scan = sc; break }
  }
  return [
    ...(data?.aggregateLatest?.top_stocks || []),
    ...(scan?.top_stocks || []),
    ...(scan?.filter_stocks || []),
  ]
}

function resolveStock(stockId, data) {
  const id = String(stockId).trim()
  const rows = allScanRows(data).filter(r => String(r.stock_id) === id)
  if (!rows.length) return null
  const rich = rows.sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0]
  return { stock_id: id, name: rich.name || '', row: rich, isRich: Object.keys(rich).length > 40 }
}

function computeLevels(row) {
  if (!row) return null
  const C = row.close, ATR = row.atr14
  const H20 = row.close_20d_high, L10 = row.close_10d_low
  if (C == null) return null
  const out = { close: r2(C), atr: r2(ATR) }
  if (H20 != null && L10 != null && H20 > L10) {
    const range = H20 - L10
    out.fib = { high: r2(H20), low: r2(L10), f382: r2(H20 - 0.382 * range), f50: r2(H20 - 0.5 * range), f618: r2(H20 - 0.618 * range) }
  }
  const cand = [['EMA20', row.ema20], ['EMA60', row.ema60], ['布林下軌', row.bb_lower], ['10日低', L10], ['布林中軌', row.bb_mid]]
  out.supports = cand.filter(([, v]) => v != null && v < C).map(([k, v]) => [k, r2(v)]).sort((a, b) => b[1] - a[1]).slice(0, 3)
  const res = [['20日高', H20], ['布林上軌', row.bb_upper]].filter(([, v]) => v != null && v > C).map(([k, v]) => [k, r2(v)]).sort((a, b) => a[1] - b[1])
  out.resistances = res
  if (ATR != null) out.atrStop = r2(C - 2 * ATR)
  if (L10 != null) out.swingStop = r2(L10)
  if (H20 != null && L10 != null && H20 > L10) {
    out.target1 = r2(H20); out.target2 = r2(H20 + 0.5 * (H20 - L10))
  } else if (ATR != null) {
    out.target1 = r2(C + 2 * ATR); out.target2 = r2(C + 3 * ATR)
  }
  const stop = out.atrStop ?? out.swingStop
  if (out.target1 != null && stop != null && C - stop > 0) out.rr = r2((out.target1 - C) / (C - stop))
  return out
}

function fmtLevels(lv) {
  if (!lv) return ''
  const L = []
  L.push(`收盤 ${lv.close}${lv.atr != null ? ` | ATR ${lv.atr}` : ''}`)
  if (lv.fib) L.push(`費波那契（${lv.fib.high}→${lv.fib.low}）：38.2%=${lv.fib.f382} / 50%=${lv.fib.f50} / 61.8%=${lv.fib.f618}`)
  if (lv.supports?.length) L.push(`支撐：${lv.supports.map(([k, v]) => `${k} ${v}`).join(' / ')}`)
  if (lv.resistances?.length) L.push(`壓力：${lv.resistances.map(([k, v]) => `${k} ${v}`).join(' / ')}`)
  const stops = []
  if (lv.atrStop != null) stops.push(`ATR停損 ${lv.atrStop}`)
  if (lv.swingStop != null) stops.push(`結構停損(10日低) ${lv.swingStop}`)
  if (stops.length) L.push(`建議停損：${stops.join(' / ')}`)
  const tg = []
  if (lv.target1 != null) tg.push(`目標1 ${lv.target1}`)
  if (lv.target2 != null) tg.push(`目標2 ${lv.target2}`)
  if (tg.length) L.push(`目標價：${tg.join(' / ')}${lv.rr != null ? ` | 風報比≈${lv.rr}` : ''}`)
  return L.join('\n')
}

function buildBrief(resolved, levels, market) {
  if (!resolved) return ''
  const r = resolved.row || {}
  const f = (v, suf = '') => (v == null || isNaN(v) ? '—' : `${v}${suf}`)
  const lines = [`【標的】${resolved.stock_id} ${resolved.name || '(名稱未知)'} ${r.industry_category || ''}`.trim()]
  if (resolved.isRich) {
    lines.push(`進場分數 ${f(Math.round(r.entry_score || 0))}${r.grade ? ` 評級${r.grade}` : ''}${r.entry_signal ? ' ✅入榜' : ''}`)
    lines.push(`RSI ${f(r.rsi14 && r.rsi14.toFixed(0))} | ADX ${f(r.adx14 && r.adx14.toFixed(0))} | 量比 ${f(r.volume_ratio && r.volume_ratio.toFixed(1), 'x')}`)
    lines.push(`F-Score ${f(r.f_score)}/9 | 月營收YoY ${f(r.revenue_yoy && r.revenue_yoy.toFixed(1), '%')}`)
    lines.push(`外資連買 ${f(r.foreign_buy_streak)}日 | 投信連買 ${f(r.invest_trust_streak)}日 | 融資5日變化 ${f(r.margin_change_5d && r.margin_change_5d.toFixed(1), '%')}`)
    if (r.entry_reason) lines.push(`系統入場理由：${r.entry_reason}`)
  } else {
    lines.push(`收盤 ${f(r.close)} | RSI ${f(r.rsi14 && r.rsi14.toFixed(0))} | 評級 ${r.grade || '—'}`)
  }
  if (levels) lines.push(`\n【技術參考位（依此數值發言，不得自行編造）】\n${fmtLevels(levels)}`)
  if (market) {
    lines.push(`\n【大盤】XGBoost上漲機率 ${market.prob != null ? Math.round(market.prob * 100) + '%' : '—'} | VIX ${f(market.vix)} | 外資期貨 ${market.futures != null ? market.futures.toLocaleString() + '口' : '—'}`)
  }
  return lines.join('\n')
}

export default function GeminiStudio({ data }) {
  const [apiKey, setApiKey] = useState(geminiKey)
  const [keyInput, setKeyInput] = useState('')
  const [model, setModel] = useState(savedModel)
  const [showSettings, setShowSettings] = useState(false)
  const [stockInput, setStockInput] = useState('')
  const [customTopic, setCustomTopic] = useState('')
  const [messages, setMessages] = useState([])
  const [running, setRunning] = useState(false)
  const [round, setRound] = useState(0)
  const [retryNote, setRetryNote] = useState('')
  const [userInput, setUserInput] = useState('')
  const [autoRun, setAutoRun] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [showSummary, setShowSummary] = useState(true)

  const endRef = useRef(null)
  const autoRunRef = useRef(false)
  const lastAccRef = useRef([])   // latest acc after each round
  const countdownRef = useRef(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { localStorage.setItem(GEMINI_MODEL_STORAGE, model) }, [model])
  useEffect(() => { autoRunRef.current = autoRun }, [autoRun])

  // Read localStorage prefill from StockDetailModal's 🎯 button
  useEffect(() => {
    const prefill = localStorage.getItem('gemini_prefill_stock')
    if (prefill) {
      setStockInput(prefill)
      setCustomTopic('')
      localStorage.removeItem('gemini_prefill_stock')
    }
  }, [])

  const candidates = (data?.aggregateLatest?.top_stocks || []).slice(0, 20)
  const market = (data?.prediction || data?.aggregateLatest) ? {
    prob: data?.prediction?.xgb_prob_up ?? data?.aggregateLatest?.xgb_prob_up,
    vix: data?.prediction?.vix,
    futures: data?.prediction?.futures_net,
  } : null

  const typedId = (stockInput.match(/\d{4,6}/) || [])[0] || ''
  const resolved = typedId ? resolveStock(typedId, data) : null
  const levels = resolved?.isRich ? computeLevels(resolved.row) : null
  const brief = buildBrief(resolved, levels, market)
  const topic = resolved
    ? `針對 ${resolved.stock_id} ${resolved.name || ''} 的進場決策`.trim()
    : customTopic.trim()

  const saveKey = () => { const k = keyInput.trim(); if (k) { sessionStorage.setItem(GEMINI_KEY_STORAGE, k); setApiKey(k) } }

  const transcriptText = (msgs) => msgs.map(m =>
    m.role === 'user' ? `【使用者插話】${m.content}` : `【${m.analyst.name}】${m.content}`
  ).join('\n\n')

  // Summary: last message from each analyst, first sentence
  const summary = useMemo(() => {
    if (!messages.length) return []
    const last = {}
    for (const m of messages) {
      if (m.role === 'analyst' && m.content && !m.error && !m.streaming) last[m.analyst.id] = m
    }
    return ANALYSTS
      .filter(a => last[a.id])
      .map(a => ({
        analyst: a,
        point: last[a.id].content.split(/[。！？\n]/)[0]?.trim().slice(0, 55) || '',
      }))
      .filter(x => x.point)
  }, [messages])

  // Schedule next auto-round
  const scheduleAutoRound = useCallback((acc) => {
    if (countdownRef.current) clearInterval(countdownRef.current)
    let c = 3
    setCountdown(c)
    countdownRef.current = setInterval(() => {
      c -= 1
      setCountdown(c)
      if (c <= 0) {
        clearInterval(countdownRef.current)
        countdownRef.current = null
        setCountdown(0)
        if (autoRunRef.current) runRoundInternal(acc, null)
      }
    }, 1000)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const cancelAutoRun = () => {
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
    setCountdown(0)
    setAutoRun(false)
  }

  const runRoundInternal = useCallback(async (priorMessages, userNote) => {
    if (!apiKey) return
    setRunning(true); setRetryNote(''); setCountdown(0)
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
    let acc = [...priorMessages]
    if (userNote) acc.push({ role: 'user', content: userNote })
    setMessages(acc)

    for (let ai = 0; ai < ANALYSTS.length; ai++) {
      const analyst = ANALYSTS[ai]
      const pid = `${analyst.id}-${Date.now()}-${Math.random()}`
      setMessages(prev => [...prev, { id: pid, role: 'analyst', analyst, content: '', streaming: true }])

      // Tight system prompt: no preamble, get to the point, cite actual numbers
      const sys = [
        analyst.persona,
        '語言：繁體中文。',
        '格式：最多3條，每條20字以內，用「・」開頭，不說前言不廢話，直接切重點。',
        '可點名反駁前位。引用【技術參考位】的實際價位，不得自行捏造數字。',
      ].join('\n')

      const prompt = [
        `圓桌主題：${topic}`,
        brief ? `\n資料：\n${brief}` : '',
        acc.length ? `\n討論紀錄：\n${transcriptText(acc)}` : '',
        `\n現在輪到你（${analyst.name}）。`,
      ].join('\n')

      try {
        const text = await callGemini(apiKey, model, sys, prompt, secs => setRetryNote(`額度限流，${secs}秒後自動重試…`))
        setRetryNote('')
        const msg = { id: pid, role: 'analyst', analyst, content: text }
        acc.push(msg)
        setMessages(prev => prev.map(m => m.id === pid ? msg : m))
        if (ai < ANALYSTS.length - 1) await sleep(900)
      } catch (e) {
        setMessages(prev => prev.map(m => m.id === pid ? { id: pid, role: 'analyst', analyst, error: e.message } : m))
        setRunning(false); setRetryNote(''); setAutoRun(false)
        return
      }
    }

    lastAccRef.current = acc
    setRound(r => r + 1)
    setRunning(false)

    if (autoRunRef.current) scheduleAutoRound(acc)
  }, [apiKey, model, topic, brief, scheduleAutoRound])

  const runRound = useCallback((priorMessages, userNote) => {
    return runRoundInternal(priorMessages, userNote)
  }, [runRoundInternal])

  const start = () => {
    if (!topic) return
    setMessages([]); setRound(0); setAutoRun(false)
    runRoundInternal([], null)
  }

  const sendUser = () => {
    const t = userInput.trim()
    if (!t || running) return
    setUserInput('')
    // Cancel pending auto-round and inject the user note
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; setCountdown(0) }
    const cleanMsgs = messages.filter(m => !m.streaming && !m.error)
    // After user interruption, if autoRun was on, add a note to rejoin original topic
    const note = autoRun ? `${t}\n（回答完後請繼續原本討論主題）` : t
    runRoundInternal(cleanMsgs, note)
  }

  const toggleAutoRun = () => {
    if (autoRun) {
      cancelAutoRun()
    } else {
      setAutoRun(true)
      if (!running && round > 0) scheduleAutoRound(lastAccRef.current)
    }
  }

  // ── No key yet ──────────────────────────────────────────────────────────────
  if (!apiKey) {
    return (
      <div style={s.root}>
        <Header />
        <div style={s.setup}>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🎯</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--ios-label)' }}>AI 圓桌研究室</div>
            <div style={{ fontSize: 13, color: 'var(--ios-label2)', marginTop: 6, lineHeight: 1.6 }}>
              四位 AI 分析師用掃描資料 + 系統計算技術位即時討論一支股票。<br />
              由 Google Gemini 驅動，<b style={{ color: 'var(--ios-green)' }}>完全免費</b>。
            </div>
          </div>
          <div style={s.label}>Gemini API Key</div>
          <input style={s.input} type="password" value={keyInput} placeholder="貼上你的 Gemini API Key"
            onChange={e => setKeyInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveKey()} />
          <button onClick={saveKey} disabled={!keyInput.trim()} style={{
            width: '100%', marginTop: 12, padding: '11px', borderRadius: 10, border: 'none',
            background: keyInput.trim() ? 'var(--ios-blue)' : 'var(--ios-fill3)',
            color: keyInput.trim() ? '#fff' : 'var(--ios-label3)', fontSize: 15, fontWeight: 700,
            cursor: keyInput.trim() ? 'pointer' : 'default',
          }}>開始使用</button>
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" style={{
            display: 'block', textAlign: 'center', marginTop: 14, fontSize: 13, color: 'var(--ios-blue)',
          }}>→ 免費取得 Gemini API Key（Google AI Studio）</a>
          <div style={{ marginTop: 16, fontSize: 11, color: 'var(--ios-label3)', lineHeight: 1.6, textAlign: 'center' }}>
            Key 僅存於本分頁（sessionStorage），不上傳、不留存
          </div>
        </div>
      </div>
    )
  }

  // ── Setup screen ──────────────────────────────────────────────────────────────
  if (messages.length === 0 && !running) {
    return (
      <div style={s.root}>
        <Header onSettings={() => setShowSettings(v => !v)}
          onClearKey={() => { sessionStorage.removeItem(GEMINI_KEY_STORAGE); setApiKey('') }} />
        {showSettings && <ModelPicker model={model} setModel={setModel} />}
        <div style={s.setup}>
          <div style={{ textAlign: 'center', marginBottom: 18 }}>
            <div style={{ fontSize: 34 }}>🎯</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ios-label)', marginTop: 4 }}>AI 圓桌研究室</div>
            <div style={{ fontSize: 12.5, color: 'var(--ios-label2)', marginTop: 4 }}>輸入股號，四位分析師依系統技術位開會討論</div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: 14, marginBottom: 20 }}>
            {ANALYSTS.map(a => (
              <div key={a.id} style={{ textAlign: 'center' }}>
                <div style={s.avatar(a.color, 'analyst')}>{a.emoji}</div>
                <div style={{ fontSize: 10, color: a.color, fontWeight: 700, marginTop: 4 }}>{a.name}</div>
              </div>
            ))}
          </div>

          <div style={s.label}>輸入股號（自動帶出名稱）</div>
          <input style={s.input} value={stockInput} inputMode="numeric"
            placeholder="例：2303（只打號碼即可）"
            onChange={e => { setStockInput(e.target.value); setCustomTopic('') }} />
          {typedId && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: resolved ? 'var(--ios-green)' : 'var(--ios-yellow)' }}>
              {resolved ? `✓ ${resolved.stock_id} ${resolved.name || '(名稱未知，仍可分析)'}` : `找不到 ${typedId} 的掃描資料（仍可用自訂主題分析）`}
            </div>
          )}

          {candidates.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={s.label}>或從今日 TOP {candidates.length} 快選</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {candidates.map(c => (
                  <div key={c.stock_id} onClick={() => { setStockInput(String(c.stock_id)); setCustomTopic('') }}
                    style={s.chip(String(c.stock_id) === typedId, '#0a84ff')}>
                    {c.stock_id} {c.name}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ ...s.label, marginTop: 16 }}>或自訂討論主題</div>
          <input style={s.input} value={customTopic} placeholder="例：台積電法說會後是否該加碼？"
            onChange={e => { setCustomTopic(e.target.value); setStockInput('') }} />

          {brief && (
            <div style={{ marginTop: 16, padding: '12px 14px', background: 'var(--ios-bg2)', borderRadius: 12, fontSize: 12, color: 'var(--ios-label2)', whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>
              {brief}
            </div>
          )}

          <button onClick={start} disabled={!topic} style={{
            width: '100%', marginTop: 18, padding: '13px', borderRadius: 12, border: 'none',
            background: topic ? 'var(--ios-blue)' : 'var(--ios-fill3)',
            color: topic ? '#fff' : 'var(--ios-label3)', fontSize: 15, fontWeight: 700,
            cursor: topic ? 'pointer' : 'default',
          }}>🎬 開始圓桌討論</button>
        </div>
      </div>
    )
  }

  // ── Discussion view ───────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      <Header title={topic} onReset={() => { cancelAutoRun(); setMessages([]); setRound(0) }}
        onSettings={() => setShowSettings(v => !v)} />
      {showSettings && <ModelPicker model={model} setModel={setModel} />}

      {/* Messages */}
      <div style={s.msgs}>
        {messages.map((m, i) => (
          <div key={m.id || i} style={s.msgRow(m.role)}>
            <div style={s.avatar(m.role === 'user' ? '#0a84ff' : m.analyst.color, m.role)}>
              {m.role === 'user' ? '你' : m.analyst.emoji}
            </div>
            <div>
              {m.role === 'analyst' && <div style={s.name(m.analyst.color)}>{m.analyst.name}</div>}
              {m.error ? (
                <div style={{ ...s.bubble('analyst', '#f85149'), color: 'var(--ios-red)' }}>⚠️ {m.error}</div>
              ) : (
                <div style={s.bubble(m.role, m.role === 'user' ? '#0a84ff' : m.analyst.color)}>
                  {m.content || (m.streaming && <span style={{ opacity: 0.5 }}>思考中…</span>)}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Summary panel — collapsible, shown when summary is available */}
      {summary.length > 0 && (
        <div style={{ borderTop: '0.5px solid var(--ios-sep)', background: 'var(--ios-bg3)', flexShrink: 0 }}>
          <button
            onClick={() => setShowSummary(v => !v)}
            style={{
              width: '100%', padding: '7px 14px', background: 'none', border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer',
            }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.4 }}>📋 討論重點摘要</span>
            <span style={{ fontSize: 11, color: 'var(--ios-label3)' }}>{showSummary ? '▲' : '▼'}</span>
          </button>
          {showSummary && (
            <div style={{ padding: '0 14px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {summary.map(({ analyst, point }) => (
                <div key={analyst.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 13, flexShrink: 0 }}>{analyst.emoji}</span>
                  <span style={{ fontSize: 12, color: 'var(--ios-label2)', flex: 1, lineHeight: 1.4 }}>
                    <b style={{ color: analyst.color }}>{analyst.name}：</b>{point}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Input area */}
      <div style={s.inputArea}>
        {retryNote && <div style={{ fontSize: 11.5, color: 'var(--ios-yellow)', marginBottom: 8, textAlign: 'center' }}>⏳ {retryNote}</div>}

        {/* Auto-run status row */}
        {!running && round > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            {countdown > 0 ? (
              <div style={{ fontSize: 11, color: 'var(--ios-label3)', flex: 1 }}>
                🔄 {countdown} 秒後自動繼續…
                <span onClick={cancelAutoRun} style={{ color: 'var(--ios-blue)', cursor: 'pointer', marginLeft: 8 }}>取消</span>
              </div>
            ) : (
              <>
                <button
                  onClick={toggleAutoRun}
                  style={{
                    flex: 1, padding: '7px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: autoRun ? 'rgba(10,132,255,0.15)' : 'var(--ios-fill4)',
                    color: autoRun ? 'var(--ios-blue)' : 'var(--ios-label3)',
                    fontSize: 12, fontWeight: 700,
                  }}>
                  {autoRun ? '🔄 自動繼續（開啟中）' : '🔄 自動繼續'}
                </button>
                <button
                  onClick={() => runRoundInternal(messages.filter(m => !m.streaming && !m.error), '請各位繼續深入一輪，聚焦最關鍵的分歧點與具體價位。')}
                  style={{
                    padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: 'var(--ios-fill4)', color: 'var(--ios-label2)', fontSize: 12, fontWeight: 700,
                  }}>
                  再一輪
                </button>
              </>
            )}
          </div>
        )}

        {/* User input row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea value={userInput} onChange={e => setUserInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUser() } }}
            placeholder={running ? '分析師討論中…' : countdown > 0 ? '插話（Enter 發送，中斷倒數）' : '插話加入討論，或提問…'}
            rows={1} disabled={false}
            style={{ flex: 1, background: 'var(--ios-bg3)', border: '0.5px solid var(--ios-sep)', borderRadius: 18, padding: '9px 14px', color: 'var(--ios-label)', fontSize: 15, resize: 'none', outline: 'none', minHeight: 40, maxHeight: 100, fontFamily: 'inherit' }} />
          <button onClick={sendUser} disabled={running || !userInput.trim()} style={{
            background: !running && userInput.trim() ? 'var(--ios-blue)' : 'var(--ios-fill3)', border: 'none',
            borderRadius: 9999, padding: '0 16px', height: 40, color: !running && userInput.trim() ? '#fff' : 'var(--ios-label3)',
            fontSize: 14, fontWeight: 700, cursor: !running && userInput.trim() ? 'pointer' : 'default', flexShrink: 0,
          }}>{running ? '⏳' : '插話'}</button>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--ios-label3)', marginTop: 6, textAlign: 'center' }}>
          🆓 Gemini 免費驅動 · Enter 插話 · Shift+Enter 換行
        </div>
      </div>
    </div>
  )
}

function ModelPicker({ model, setModel }) {
  return (
    <div style={{ padding: '10px 16px', background: 'var(--ios-bg3)', borderBottom: '0.5px solid var(--ios-sep)', flexShrink: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 6 }}>遇到「額度用盡 limit: 0」時可切換模型：</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {MODELS.map(m => (
          <div key={m.id} onClick={() => setModel(m.id)} style={{
            padding: '6px 11px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
            border: `1px solid ${m.id === model ? 'var(--ios-blue)' : 'var(--ios-sep)'}`,
            background: m.id === model ? 'rgba(10,132,255,0.18)' : 'var(--ios-fill4)',
            color: m.id === model ? 'var(--ios-blue)' : 'var(--ios-label2)', fontWeight: m.id === model ? 700 : 400,
          }}>{m.label}</div>
        ))}
      </div>
    </div>
  )
}

function Header({ title, onReset, onSettings, onClearKey }) {
  const btn = { background: 'var(--ios-fill4)', border: '0.5px solid var(--ios-sep)', borderRadius: 9999, padding: '4px 11px', color: 'var(--ios-label2)', fontSize: 12, cursor: 'pointer', flexShrink: 0 }
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '0.5px solid var(--ios-sep)', background: 'var(--ios-bg2)', flexShrink: 0, gap: 10 }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ios-label)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
        {title ? title : '🎯 圓桌研究室'}
      </span>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {onReset && <button onClick={onReset} style={btn}>新主題</button>}
        {onSettings && <button onClick={onSettings} style={btn}>⚙️</button>}
        {onClearKey && <button onClick={onClearKey} style={btn}>🔑</button>}
      </div>
    </div>
  )
}
