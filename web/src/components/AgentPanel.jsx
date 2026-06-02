import { useState, useRef, useEffect, useCallback } from 'react'
import { STOCK_AGENTS } from './StockAgents.jsx'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 600
const INPUT_COST_PER_1M = 0.80
const OUTPUT_COST_PER_1M = 4.00
const SESSION_BUDGET = 5.0

function calcCost(inputTokens, outputTokens) {
  return (inputTokens / 1e6) * INPUT_COST_PER_1M + (outputTokens / 1e6) * OUTPUT_COST_PER_1M
}

const s = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--ios-bg)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '0.5px solid var(--ios-sep)',
    background: 'var(--ios-bg2)',
    flexShrink: 0,
    gap: '12px',
    flexWrap: 'wrap',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    minWidth: 0,
  },
  headerTitle: {
    fontSize: '15px',
    fontWeight: 600,
    color: 'var(--ios-label)',
    whiteSpace: 'nowrap',
  },
  agentBadge: (color) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '3px 10px',
    borderRadius: '9999px',
    fontSize: '12px',
    fontWeight: 600,
    background: color + '22',
    color: color,
    border: `1px solid ${color}44`,
    whiteSpace: 'nowrap',
  }),
  budgetBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '12px',
    color: 'var(--ios-label2)',
    flexShrink: 0,
  },
  budgetFill: (pct, over) => ({
    width: '60px',
    height: '4px',
    background: 'var(--ios-fill3)',
    borderRadius: '2px',
    overflow: 'hidden',
    position: 'relative',
  }),
  budgetFillInner: (pct, over) => ({
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    width: `${Math.min(pct, 100)}%`,
    background: over ? 'var(--ios-red)' : pct > 70 ? 'var(--ios-yellow)' : 'var(--ios-green)',
    borderRadius: '2px',
    transition: 'width 0.3s',
  }),
  keyBtn: {
    background: 'var(--ios-fill4)',
    border: '0.5px solid var(--ios-sep)',
    borderRadius: '9999px',
    padding: '4px 12px',
    color: 'var(--ios-label2)',
    fontSize: '11px',
    cursor: 'pointer',
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  sidebar: {
    width: '200px',
    borderRight: '0.5px solid var(--ios-sep)',
    background: 'var(--ios-bg2)',
    display: 'flex',
    flexDirection: 'column',
    padding: '8px',
    gap: '4px',
    flexShrink: 0,
    overflowY: 'auto',
  },
  sidebarItem: (active, color) => ({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    borderRadius: '12px',
    cursor: 'pointer',
    background: active ? color + '22' : 'transparent',
    border: `1px solid ${active ? color + '44' : 'transparent'}`,
    transition: 'all 0.15s',
  }),
  sidebarEmoji: {
    fontSize: '18px',
    flexShrink: 0,
  },
  sidebarText: {
    fontSize: '13px',
    fontWeight: 500,
    lineHeight: 1.3,
  },
  sidebarDesc: {
    fontSize: '11px',
    color: 'var(--ios-label3)',
    marginTop: '2px',
    lineHeight: 1.4,
  },
  chat: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    WebkitOverflowScrolling: 'touch',
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--ios-label2)',
    textAlign: 'center',
    padding: '32px',
  },
  emptyEmoji: {
    fontSize: '48px',
    marginBottom: '12px',
  },
  emptyTitle: {
    fontSize: '17px',
    fontWeight: 600,
    color: 'var(--ios-label)',
    marginBottom: '8px',
  },
  emptyHint: {
    fontSize: '14px',
    lineHeight: 1.7,
    maxWidth: '320px',
  },
  msg: (role) => ({
    display: 'flex',
    flexDirection: role === 'user' ? 'row-reverse' : 'row',
    gap: '8px',
    alignItems: 'flex-end',
  }),
  avatar: (role, color) => ({
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    background: role === 'user' ? 'var(--ios-fill3)' : color + '33',
    border: `1px solid ${role === 'user' ? 'var(--ios-sep)' : color + '55'}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '12px',
    flexShrink: 0,
  }),
  bubble: (role) => ({
    maxWidth: '78%',
    padding: '10px 14px',
    borderRadius: role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
    background: role === 'user' ? 'var(--ios-blue)' : 'var(--ios-bg3)',
    color: role === 'user' ? '#FFFFFF' : 'var(--ios-label)',
    fontSize: '15px',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  }),
  tokenInfo: {
    fontSize: '11px',
    color: 'var(--ios-label3)',
    marginTop: '5px',
    fontFamily: 'var(--font-mono)',
  },
  inputArea: {
    borderTop: '0.5px solid var(--ios-sep)',
    padding: '10px 16px 14px',
    background: 'var(--ios-bg2)',
    flexShrink: 0,
  },
  inputRow: {
    display: 'flex',
    gap: '10px',
    alignItems: 'flex-end',
  },
  textarea: {
    flex: 1,
    background: 'var(--ios-bg3)',
    border: '0.5px solid var(--ios-sep)',
    borderRadius: '22px',
    padding: '10px 16px',
    color: 'var(--ios-label)',
    fontSize: '15px',
    resize: 'none',
    outline: 'none',
    lineHeight: 1.5,
    minHeight: '42px',
    maxHeight: '140px',
    transition: 'border-color 0.15s',
    fontFamily: 'var(--font-sans)',
  },
  sendBtn: (active, color) => ({
    background: active ? color : 'var(--ios-fill3)',
    border: 'none',
    borderRadius: '9999px',
    padding: '0 18px',
    color: active ? '#fff' : 'var(--ios-label3)',
    fontSize: '15px',
    fontWeight: 600,
    transition: 'all 0.15s',
    flexShrink: 0,
    height: '42px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    cursor: active ? 'pointer' : 'default',
  }),
  placeholderHint: {
    fontSize: '11px',
    color: 'var(--ios-label3)',
    marginTop: '6px',
    paddingLeft: 4,
  },
  errorMsg: {
    padding: '10px 14px',
    background: 'rgba(255,69,58,0.12)',
    border: '0.5px solid rgba(255,69,58,0.3)',
    borderRadius: '12px',
    color: 'var(--ios-red)',
    fontSize: '13px',
  },
  streamCursor: {
    display: 'inline-block',
    width: '2px',
    height: '1em',
    background: 'var(--ios-blue)',
    marginLeft: '2px',
    animation: 'blink 1s infinite',
    verticalAlign: 'text-bottom',
  },
  thinkingDot: {
    display: 'inline-flex',
    gap: '4px',
    alignItems: 'center',
    color: 'var(--ios-label3)',
    fontSize: '13px',
  },
}

function ThinkingIndicator({ color }) {
  return (
    <div style={s.thinkingDot}>
      <span style={{ color }}>●</span>
      <span style={{ animationDelay: '0.2s', color }}>●</span>
      <span style={{ animationDelay: '0.4s', color }}>●</span>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:.2} 50%{opacity:1} }
        span { animation: pulse 1.2s infinite; }
      `}</style>
    </div>
  )
}

const FINMIND_TOOLS = [{
  name: 'query_finmind',
  description: '查詢 FinMind 台灣股市數據庫。可查詢個股股價、三大法人買賣超、融資融券、月營收等資料。',
  input_schema: {
    type: 'object',
    properties: {
      dataset: { type: 'string', description: '資料集名稱，例如 TaiwanStockPrice, TaiwanStockInstitutionalInvestorsBuySell, TaiwanStockMarginPurchaseShortSale, TaiwanStockMonthRevenue' },
      stock_id: { type: 'string', description: '股票代號，例如 2330。不填則查全市場（視資料集而定）' },
      start_date: { type: 'string', description: '開始日期，格式 YYYY-MM-DD' },
      end_date: { type: 'string', description: '結束日期，格式 YYYY-MM-DD' },
    },
    required: ['dataset'],
  },
}]

async function callFinMindAPI(input, token) {
  const params = new URLSearchParams({ dataset: input.dataset, token })
  if (input.stock_id) params.append('stock_id', input.stock_id)
  if (input.start_date) params.append('start_date', input.start_date)
  if (input.end_date) params.append('end_date', input.end_date)
  const r = await fetch(`https://api.finmindtrade.com/api/v4/data?${params}`)
  const j = await r.json()
  if (j.status !== 200) throw new Error(j.msg || 'FinMind 查詢失敗')
  const data = j.data || []
  return { total: data.length, data: data.slice(-30) }
}

export default function AgentPanel({ apiKey, onClearKey }) {
  const [agentId, setAgentId] = useState('premarket')
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [totalCost, setTotalCost] = useState(0)
  const [finmindToken, setFinmindToken] = useState(() => sessionStorage.getItem('fm_agent_token') || '')
  const [showFmInput, setShowFmInput] = useState(false)
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)

  const agent = STOCK_AGENTS[agentId]
  const budgetPct = (totalCost / SESSION_BUDGET) * 100
  const budgetOver = totalCost >= SESSION_BUDGET

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function handleAgentSwitch(id) {
    setAgentId(id)
    setMessages([])
    setInput('')
    setShowFmInput(STOCK_AGENTS[id]?.useFinmind && !sessionStorage.getItem('fm_agent_token'))
  }

  function autoResize(el) {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }

  async function sendFinmindMessage(history) {
    const token = finmindToken.trim()
    if (!token) throw new Error('請先輸入 FinMind Token')

    let currentHistory = [...history]
    let finalText = ''
    let totalInput = 0, totalOutput = 0

    for (let round = 0; round < 5; round++) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 800,
          system: agent.systemPrompt,
          messages: currentHistory,
          tools: FINMIND_TOOLS,
        }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err?.error?.message || `HTTP ${resp.status}`)
      }
      const data = await resp.json()
      totalInput += data.usage?.input_tokens || 0
      totalOutput += data.usage?.output_tokens || 0

      const textBlocks = (data.content || []).filter(c => c.type === 'text')
      const toolUseBlocks = (data.content || []).filter(c => c.type === 'tool_use')
      if (textBlocks.length) finalText += textBlocks.map(b => b.text).join('')

      if (data.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
        currentHistory.push({ role: 'assistant', content: data.content })
        const toolResults = []
        for (const tu of toolUseBlocks) {
          try {
            const result = await callFinMindAPI(tu.input, token)
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 4000) })
          } catch (e) {
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `查詢失敗：${e.message}`, is_error: true })
          }
        }
        currentHistory.push({ role: 'user', content: toolResults })
      } else {
        break
      }
    }
    return { text: finalText, inputTokens: totalInput, outputTokens: totalOutput }
  }

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || loading || budgetOver) return

    const userMsg = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = '44px'
    setLoading(true)

    const assistantMsgId = Date.now()
    setMessages(prev => [...prev, { role: 'assistant', content: '', id: assistantMsgId, streaming: true }])

    try {
      const history = newMessages.map(m => ({ role: m.role, content: m.content }))

      if (agent.useFinmind) {
        // Non-streaming tool_use loop for FinMind
        const { text: result, inputTokens, outputTokens } = await sendFinmindMessage(history)
        const cost = calcCost(inputTokens, outputTokens)
        setTotalCost(prev => prev + cost)
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId ? { ...m, streaming: false, content: result || '（無回應）', inputTokens, outputTokens, cost } : m
        ))
      } else {
        // Streaming for regular agents
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: agent.systemPrompt, messages: history, stream: true }),
        })

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}))
          throw new Error(err?.error?.message || `HTTP ${resp.status}`)
        }

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let accumulated = ''
        let inputTokens = 0
        let outputTokens = 0

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue
            try {
              const ev = JSON.parse(data)
              if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                accumulated += ev.delta.text
                setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: accumulated } : m))
              }
              if (ev.type === 'message_delta' && ev.usage) outputTokens = ev.usage.output_tokens || 0
              if (ev.type === 'message_start' && ev.message?.usage) inputTokens = ev.message.usage.input_tokens || 0
            } catch {}
          }
        }

        const cost = calcCost(inputTokens, outputTokens)
        setTotalCost(prev => prev + cost)
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId ? { ...m, streaming: false, inputTokens, outputTokens, cost } : m
        ))
      }
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId ? { ...m, streaming: false, error: err.message } : m
      ))
    } finally {
      setLoading(false)
    }
  }, [input, loading, budgetOver, messages, apiKey, agent, finmindToken])

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const userCount = messages.filter(m => m.role === 'user').length

  return (
    <div style={s.root}>
      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
      `}</style>

      {/* Header */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.headerTitle}>台股 AI 助手</span>
          <span style={s.agentBadge(agent.color)}>
            {agent.emoji} {agent.label}
          </span>
        </div>
        <div style={s.budgetBar}>
          {agent.useFinmind && (
            <button
              style={{ ...s.keyBtn, color: finmindToken ? 'var(--green)' : 'var(--yellow)', borderColor: finmindToken ? 'var(--green)33' : 'var(--yellow)33' }}
              onClick={() => setShowFmInput(p => !p)}
              title="設定 FinMind Token"
            >
              📡 {finmindToken ? 'Token ✓' : '設定 Token'}
            </button>
          )}
          <div style={s.budgetFill(budgetPct, budgetOver)}>
            <div style={s.budgetFillInner(budgetPct, budgetOver)} />
          </div>
          <span style={{ color: budgetOver ? 'var(--red)' : 'inherit' }}>
            ${totalCost.toFixed(4)}
          </span>
          <button style={s.keyBtn} onClick={onClearKey} title="更換 API Key">
            🔑 金鑰
          </button>
        </div>
      </div>

      {/* FinMind Token Input */}
      {agent.useFinmind && showFmInput && (
        <div style={{ padding: '10px 16px', background: 'var(--ios-bg3)', borderBottom: '0.5px solid var(--ios-sep)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--ios-label2)', whiteSpace: 'nowrap' }}>📡 FinMind Token：</span>
          <input
            type="password"
            value={finmindToken}
            onChange={e => setFinmindToken(e.target.value)}
            placeholder="貼上你的 FinMind API Token"
            onKeyDown={e => {
              if (e.key === 'Enter') {
                sessionStorage.setItem('fm_agent_token', finmindToken)
                setShowFmInput(false)
              }
            }}
            style={{
              flex: 1, padding: '7px 12px', fontSize: 12, borderRadius: 10,
              background: 'var(--ios-bg)', border: '0.5px solid var(--ios-sep)', color: 'var(--ios-label)', outline: 'none',
            }}
          />
          <button
            onClick={() => { sessionStorage.setItem('fm_agent_token', finmindToken); setShowFmInput(false) }}
            style={{ padding: '7px 14px', fontSize: 12, fontWeight: 700, background: 'var(--ios-blue)', color: '#fff', border: 'none', borderRadius: 9999, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >儲存</button>
          <button onClick={() => setShowFmInput(false)} style={{ background: 'none', border: 'none', color: 'var(--ios-label3)', cursor: 'pointer', fontSize: 14 }}>✕</button>
        </div>
      )}

      {/* Body */}
      <div style={s.body}>
        {/* Sidebar — desktop only */}
        <div style={{ ...s.sidebar, display: window.innerWidth < 640 ? 'none' : 'flex' }}>
          {Object.values(STOCK_AGENTS).map(ag => (
            <div
              key={ag.id}
              style={s.sidebarItem(ag.id === agentId, ag.color)}
              onClick={() => handleAgentSwitch(ag.id)}
            >
              <span style={s.sidebarEmoji}>{ag.emoji}</span>
              <div>
                <div style={{ ...s.sidebarText, color: ag.id === agentId ? ag.color : 'var(--text)' }}>
                  {ag.label}
                </div>
                <div style={s.sidebarDesc}>{ag.description}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Chat */}
        <div style={s.chat}>
          <div style={s.messages}>
            {messages.length === 0 ? (
              <div style={s.emptyState}>
                <div style={s.emptyEmoji}>{agent.emoji}</div>
                <div style={s.emptyTitle}>{agent.label}</div>
                <div style={s.emptyHint}>{agent.description}</div>
                <div style={{ ...s.emptyHint, marginTop: '16px', opacity: 0.6, fontSize: '12px' }}>
                  範例：{agent.placeholder}
                </div>
              </div>
            ) : (
              messages.map((msg, i) => (
                <div key={msg.id || i} style={s.msg(msg.role)}>
                  <div style={s.avatar(msg.role, agent.color)}>
                    {msg.role === 'user' ? '你' : agent.emoji}
                  </div>
                  <div>
                    {msg.error ? (
                      <div style={s.errorMsg}>錯誤：{msg.error}</div>
                    ) : (
                      <div style={s.bubble(msg.role)}>
                        {msg.content}
                        {msg.streaming && !msg.content && <ThinkingIndicator color={agent.color} />}
                        {msg.streaming && msg.content && (
                          <span style={s.streamCursor} />
                        )}
                      </div>
                    )}
                    {msg.role === 'assistant' && !msg.streaming && !msg.error && msg.cost > 0 && (
                      <div style={s.tokenInfo}>
                        in {msg.inputTokens} · out {msg.outputTokens} · ${msg.cost.toFixed(5)}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={s.inputArea}>
            {/* Mobile agent tabs */}
            {window.innerWidth < 640 && (
              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', overflowX: 'auto', paddingBottom: '2px', WebkitOverflowScrolling: 'touch' }}>
                {Object.values(STOCK_AGENTS).map(ag => (
                  <button
                    key={ag.id}
                    style={{
                      flexShrink: 0,
                      padding: '5px 14px',
                      borderRadius: '9999px',
                      border: `1px solid ${ag.id === agentId ? ag.color : 'var(--ios-sep)'}`,
                      background: ag.id === agentId ? ag.color + '22' : 'var(--ios-fill4)',
                      color: ag.id === agentId ? ag.color : 'var(--ios-label2)',
                      fontSize: '12px',
                      fontWeight: ag.id === agentId ? 600 : 400,
                      cursor: 'pointer',
                    }}
                    onClick={() => handleAgentSwitch(ag.id)}
                  >
                    {ag.emoji} {ag.label}
                  </button>
                ))}
              </div>
            )}

            {budgetOver && (
              <div style={{ ...s.errorMsg, marginBottom: '10px' }}>
                本次 session 已達 ${SESSION_BUDGET} 預算上限，請重新整理頁面繼續使用。
              </div>
            )}
            <div style={s.inputRow}>
              <textarea
                ref={textareaRef}
                style={s.textarea}
                value={input}
                onChange={e => { setInput(e.target.value); autoResize(e.target) }}
                onKeyDown={handleKeyDown}
                placeholder={agent.placeholder}
                rows={1}
                disabled={loading || budgetOver}
              />
              <button
                style={s.sendBtn(!loading && input.trim() && !budgetOver, agent.color)}
                onClick={sendMessage}
                disabled={loading || !input.trim() || budgetOver}
              >
                {loading ? '⏳' : '發送'}
              </button>
            </div>
            <div style={s.placeholderHint}>
              Enter 發送 · Shift+Enter 換行 · 共 {userCount} 次對話 · 本次花費 ${totalCost.toFixed(4)}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
