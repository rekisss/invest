import { useState, useRef, useEffect, useCallback } from 'react'

// ── Gemini free-tier multi-agent roundtable ──────────────────────────────────
// Uses Google's free Gemini API (gemini-2.0-flash). The four analysts each see
// the selected stock's data (pulled from the page's data.json) plus the running
// transcript, then debate. The user can inject a message and they continue.

const GEMINI_MODEL = 'gemini-2.0-flash'
const GEMINI_KEY_STORAGE = 'gemini_api_key'

const ANALYSTS = [
  {
    id: 'tech', name: '技術派', emoji: '📈', color: '#0a84ff',
    persona: `你是台股技術分析師，專精 momentum 與型態。聚焦 RSI/ADX/MACD/均線/量能/K線型態。語氣果斷，給出明確的多空傾向與關鍵價位。`,
  },
  {
    id: 'fund', name: '基本面派', emoji: '💰', color: '#30d158',
    persona: `你是台股基本面分析師。聚焦 F-Score、月營收 YoY、獲利品質、產業前景。會質疑只有技術面強但基本面弱的標的。`,
  },
  {
    id: 'chip', name: '籌碼派', emoji: '🌐', color: '#ff9f0a',
    persona: `你是台股籌碼分析師。聚焦三大法人買賣超、外資連買天數、融資融券變化、主力動向，以及大盤環境（廣度、VIX）。`,
  },
  {
    id: 'risk', name: '風控長', emoji: '🛡️', color: '#f85149',
    persona: `你是台股風險管理長，最後發言。綜合前面三位分析師的觀點，做出裁決：給出「建議進場 / 觀察 / 迴避」其中之一，附上停損位與倉位建議。要客觀，敢於否定樂觀派。`,
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

async function callGemini(apiKey, systemPrompt, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: 600, temperature: 0.85 },
    }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err?.error?.message || `HTTP ${resp.status}`)
  }
  const j = await resp.json()
  const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || ''
  if (!text) throw new Error('Gemini 無回應（可能觸發安全過濾或配額用盡）')
  return text.trim()
}

// Build a compact data brief for the selected stock from page resources.
function buildStockBrief(stock, market) {
  if (!stock) return ''
  const f = (v, suf = '') => (v == null || isNaN(v) ? '—' : `${v}${suf}`)
  const lines = [
    `【標的】${stock.stock_id} ${stock.name || ''} ${stock.industry_category || ''}`,
    `收盤 ${f(stock.close)} | 進場分數 ${f(Math.round(stock.entry_score || 0))}${stock.grade ? ` 評級${stock.grade}` : ''}${stock.entry_signal ? ' ✅入榜' : ''}`,
    `RSI ${f(stock.rsi14)} | ADX ${f(stock.adx14)} | 量比 ${f(stock.volume_ratio, 'x')}`,
    `F-Score ${f(stock.f_score)}/9 | 月營收YoY ${f(stock.revenue_yoy, '%')}`,
    `外資連買 ${f(stock.foreign_buy_streak)}日 | 投信連買 ${f(stock.invest_trust_streak)}日`,
  ]
  if (market) {
    lines.push(`【大盤】XGBoost上漲機率 ${market.prob != null ? Math.round(market.prob * 100) + '%' : '—'} | VIX ${f(market.vix)} | 外資期貨 ${market.futures != null ? market.futures.toLocaleString() + '口' : '—'}`)
  }
  return lines.join('\n')
}

export default function GeminiStudio({ data, onBack }) {
  const [apiKey, setApiKey] = useState(geminiKey)
  const [keyInput, setKeyInput] = useState('')
  const [stockId, setStockId] = useState('')
  const [customTopic, setCustomTopic] = useState('')
  const [messages, setMessages] = useState([])  // {role:'analyst'|'user', analyst, content, error}
  const [running, setRunning] = useState(false)
  const [round, setRound] = useState(0)
  const [userInput, setUserInput] = useState('')
  const endRef = useRef(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // Candidate stocks from page resources
  const candidates = (data?.aggregateLatest?.top_stocks || []).slice(0, 20)
  const market = data?.aggregateLatest || data?.prediction ? {
    prob: data?.prediction?.xgb_prob_up ?? data?.aggregateLatest?.xgb_prob_up,
    vix: data?.prediction?.vix,
    futures: data?.prediction?.futures_net,
  } : null
  const selectedStock = candidates.find(c => String(c.stock_id) === String(stockId)) || null
  const brief = buildStockBrief(selectedStock, market)
  const topic = selectedStock ? `針對 ${selectedStock.stock_id} ${selectedStock.name} 的進場決策` : customTopic.trim()

  const saveKey = () => {
    const k = keyInput.trim()
    if (!k) return
    sessionStorage.setItem(GEMINI_KEY_STORAGE, k)
    setApiKey(k)
  }

  // Build the transcript text the next analyst will read.
  const transcriptText = (msgs) => msgs.map(m =>
    m.role === 'user'
      ? `【使用者插話】${m.content}`
      : `【${m.analyst.name}】${m.content}`
  ).join('\n\n')

  // Run one full roundtable: all 4 analysts speak in order, each seeing prior turns.
  const runRound = useCallback(async (priorMessages, userNote) => {
    if (!apiKey) return
    setRunning(true)
    let acc = [...priorMessages]
    if (userNote) acc.push({ role: 'user', content: userNote })
    setMessages(acc)

    for (const analyst of ANALYSTS) {
      // placeholder bubble while generating
      const pid = `${analyst.id}-${Date.now()}-${Math.random()}`
      setMessages(prev => [...prev, { id: pid, role: 'analyst', analyst, content: '', streaming: true }])
      const sys = `${analyst.persona}\n\n回答用繁體中文，150字以內，條列重點，語氣口語像在開會討論。可以直接點名或反駁前面分析師。不要重複別人說過的話。`
      const prompt = [
        `這是一場台股投資圓桌討論，主題：${topic}`,
        brief ? `\n資料：\n${brief}` : '',
        acc.length ? `\n目前討論：\n${transcriptText(acc)}` : '',
        `\n現在輪到你（${analyst.name}）發言。`,
      ].join('\n')
      try {
        const text = await callGemini(apiKey, sys, prompt)
        const msg = { id: pid, role: 'analyst', analyst, content: text }
        acc.push(msg)
        setMessages(prev => prev.map(m => m.id === pid ? msg : m))
      } catch (e) {
        setMessages(prev => prev.map(m => m.id === pid ? { id: pid, role: 'analyst', analyst, error: e.message } : m))
        setRunning(false)
        return
      }
    }
    setRound(r => r + 1)
    setRunning(false)
  }, [apiKey, topic, brief])

  const start = () => { if (topic) { setMessages([]); setRound(0); runRound([], null) } }
  const sendUser = () => {
    const t = userInput.trim()
    if (!t || running) return
    setUserInput('')
    runRound(messages.filter(m => !m.streaming && !m.error), t)
  }

  // ── No key yet ──────────────────────────────────────────────────────────────
  if (!apiKey) {
    return (
      <div style={s.root}>
        <Header onBack={onBack} />
        <div style={s.setup}>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🎯</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--ios-label)' }}>AI 圓桌研究室</div>
            <div style={{ fontSize: 13, color: 'var(--ios-label2)', marginTop: 6, lineHeight: 1.6 }}>
              四位 AI 分析師用你的掃描資料即時討論一支股票。<br />由 Google Gemini 驅動，<b style={{ color: 'var(--ios-green)' }}>完全免費</b>。
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

  // ── Setup screen (pick stock) ─────────────────────────────────────────────────
  if (messages.length === 0) {
    return (
      <div style={s.root}>
        <Header onBack={onBack} onClearKey={() => { sessionStorage.removeItem(GEMINI_KEY_STORAGE); setApiKey('') }} />
        <div style={s.setup}>
          <div style={{ textAlign: 'center', marginBottom: 18 }}>
            <div style={{ fontSize: 34 }}>🎯</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ios-label)', marginTop: 4 }}>AI 圓桌研究室</div>
            <div style={{ fontSize: 12.5, color: 'var(--ios-label2)', marginTop: 4 }}>選一支今日掃描股，讓四位分析師開會討論</div>
          </div>

          {/* Analyst lineup */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 14, marginBottom: 20 }}>
            {ANALYSTS.map(a => (
              <div key={a.id} style={{ textAlign: 'center' }}>
                <div style={s.avatar(a.color, 'analyst')}>{a.emoji}</div>
                <div style={{ fontSize: 10, color: a.color, fontWeight: 700, marginTop: 4 }}>{a.name}</div>
              </div>
            ))}
          </div>

          <div style={s.label}>選擇標的（今日 TOP {candidates.length}）</div>
          {candidates.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 16 }}>
              {candidates.map(c => (
                <div key={c.stock_id} onClick={() => { setStockId(String(c.stock_id)); setCustomTopic('') }}
                  style={s.chip(String(c.stock_id) === stockId, '#0a84ff')}>
                  {c.stock_id} {c.name}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--ios-label3)', marginBottom: 16 }}>暫無掃描資料，可用下方自訂主題</div>
          )}

          <div style={s.label}>或自訂討論主題</div>
          <input style={s.input} value={customTopic} placeholder="例：台積電法說會後是否該加碼？"
            onChange={e => { setCustomTopic(e.target.value); setStockId('') }} />

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
      <Header onBack={onBack} title={topic} onReset={() => { setMessages([]); setRound(0) }} />
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

      <div style={s.inputArea}>
        {round > 0 && !running && (
          <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 8, textAlign: 'center' }}>
            第 {round} 輪討論完成 · 可插話讓他們繼續，或
            <span onClick={() => runRound(messages.filter(m => !m.streaming && !m.error), '請各位針對以上再深入一輪，聚焦最關鍵的分歧點。')}
              style={{ color: 'var(--ios-blue)', cursor: 'pointer', marginLeft: 4 }}>再討論一輪 →</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <textarea value={userInput} onChange={e => setUserInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUser() } }}
            placeholder={running ? '分析師討論中…' : '插話加入討論，例：如果停損破了怎麼辦？'}
            rows={1} disabled={running}
            style={{ flex: 1, background: 'var(--ios-bg3)', border: '0.5px solid var(--ios-sep)', borderRadius: 20, padding: '10px 16px', color: 'var(--ios-label)', fontSize: 15, resize: 'none', outline: 'none', minHeight: 42, maxHeight: 120, fontFamily: 'inherit' }} />
          <button onClick={sendUser} disabled={running || !userInput.trim()} style={{
            background: !running && userInput.trim() ? 'var(--ios-blue)' : 'var(--ios-fill3)', border: 'none',
            borderRadius: 9999, padding: '0 18px', height: 42, color: !running && userInput.trim() ? '#fff' : 'var(--ios-label3)',
            fontSize: 15, fontWeight: 700, cursor: !running && userInput.trim() ? 'pointer' : 'default', flexShrink: 0,
          }}>{running ? '⏳' : '發送'}</button>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--ios-label3)', marginTop: 6, textAlign: 'center' }}>
          🆓 由 Gemini 免費驅動 · Enter 發送 · Shift+Enter 換行
        </div>
      </div>
    </div>
  )
}

function Header({ onBack, title, onReset, onClearKey }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '0.5px solid var(--ios-sep)', background: 'var(--ios-bg2)', flexShrink: 0, gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <button onClick={onBack} style={{ background: 'var(--ios-fill4)', border: '0.5px solid var(--ios-sep)', borderRadius: 9999, padding: '4px 11px', color: 'var(--ios-label2)', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}>← 團隊</button>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ios-label)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {title ? title : '🎯 圓桌研究室'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {onReset && <button onClick={onReset} style={{ background: 'var(--ios-fill4)', border: '0.5px solid var(--ios-sep)', borderRadius: 9999, padding: '4px 11px', color: 'var(--ios-label2)', fontSize: 12, cursor: 'pointer' }}>新主題</button>}
        {onClearKey && <button onClick={onClearKey} style={{ background: 'var(--ios-fill4)', border: '0.5px solid var(--ios-sep)', borderRadius: 9999, padding: '4px 11px', color: 'var(--ios-label2)', fontSize: 12, cursor: 'pointer' }}>🔑</button>}
      </div>
    </div>
  )
}
