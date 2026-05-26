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
    background: 'var(--bg)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
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
    whiteSpace: 'nowrap',
  },
  agentBadge: (color) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '3px 10px',
    borderRadius: '20px',
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
    color: 'var(--muted)',
    flexShrink: 0,
  },
  budgetFill: (pct, over) => ({
    width: '60px',
    height: '4px',
    background: 'var(--surface2)',
    borderRadius: '2px',
    overflow: 'hidden',
    position: 'relative',
  }),
  budgetFillInner: (pct, over) => ({
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    width: `${Math.min(pct, 100)}%`,
    background: over ? 'var(--red)' : pct > 70 ? 'var(--yellow)' : 'var(--green)',
    borderRadius: '2px',
    transition: 'width 0.3s',
  }),
  keyBtn: {
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '4px 10px',
    color: 'var(--muted)',
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
    borderRight: '1px solid var(--border)',
    background: 'var(--surface)',
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
    borderRadius: 'var(--radius)',
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
    color: 'var(--muted)',
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
    gap: '16px',
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--muted)',
    textAlign: 'center',
    padding: '32px',
  },
  emptyEmoji: {
    fontSize: '48px',
    marginBottom: '12px',
  },
  emptyTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--text)',
    marginBottom: '8px',
  },
  emptyHint: {
    fontSize: '13px',
    lineHeight: 1.7,
    maxWidth: '320px',
  },
  msg: (role) => ({
    display: 'flex',
    flexDirection: role === 'user' ? 'row-reverse' : 'row',
    gap: '10px',
    alignItems: 'flex-start',
  }),
  avatar: (role, color) => ({
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    background: role === 'user' ? 'var(--surface2)' : color + '33',
    border: `1px solid ${role === 'user' ? 'var(--border)' : color + '66'}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    flexShrink: 0,
  }),
  bubble: (role) => ({
    maxWidth: '80%',
    padding: '10px 14px',
    borderRadius: role === 'user' ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
    background: role === 'user' ? 'var(--surface2)' : 'var(--surface)',
    border: '1px solid var(--border)',
    fontSize: '14px',
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  }),
  tokenInfo: {
    fontSize: '11px',
    color: 'var(--muted)',
    marginTop: '6px',
    fontFamily: 'var(--font-mono)',
  },
  inputArea: {
    borderTop: '1px solid var(--border)',
    padding: '12px 16px',
    background: 'var(--surface)',
    flexShrink: 0,
  },
  inputRow: {
    display: 'flex',
    gap: '10px',
    alignItems: 'flex-end',
  },
  textarea: {
    flex: 1,
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '10px 14px',
    color: 'var(--text)',
    fontSize: '14px',
    resize: 'none',
    outline: 'none',
    lineHeight: 1.6,
    minHeight: '44px',
    maxHeight: '140px',
    transition: 'border-color 0.15s',
    fontFamily: 'var(--font-sans)',
  },
  sendBtn: (active, color) => ({
    background: active ? color : 'var(--surface2)',
    border: `1px solid ${active ? color : 'var(--border)'}`,
    borderRadius: 'var(--radius)',
    padding: '10px 18px',
    color: active ? '#fff' : 'var(--muted)',
    fontSize: '14px',
    fontWeight: 600,
    transition: 'all 0.15s',
    flexShrink: 0,
    height: '44px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  }),
  placeholderHint: {
    fontSize: '11px',
    color: 'var(--muted)',
    marginTop: '6px',
  },
  errorMsg: {
    padding: '10px 14px',
    background: '#f851491a',
    border: '1px solid #f8514933',
    borderRadius: 'var(--radius)',
    color: 'var(--red)',
    fontSize: '13px',
  },
  streamCursor: {
    display: 'inline-block',
    width: '2px',
    height: '1em',
    background: 'var(--accent)',
    marginLeft: '2px',
    animation: 'blink 1s infinite',
    verticalAlign: 'text-bottom',
  },
  thinkingDot: {
    display: 'inline-flex',
    gap: '4px',
    alignItems: 'center',
    color: 'var(--muted)',
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

export default function AgentPanel({ apiKey, onClearKey }) {
  const [agentId, setAgentId] = useState('premarket')
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [totalCost, setTotalCost] = useState(0)
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
  }

  function autoResize(el) {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
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
    setMessages(prev => [...prev, {
      role: 'assistant',
      content: '',
      id: assistantMsgId,
      streaming: true,
    }])

    try {
      const history = newMessages.map(m => ({ role: m.role, content: m.content }))
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
          max_tokens: MAX_TOKENS,
          system: agent.systemPrompt,
          messages: history,
          stream: true,
        }),
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
        const lines = chunk.split('\n')
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            const ev = JSON.parse(data)
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              accumulated += ev.delta.text
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, content: accumulated } : m
              ))
            }
            if (ev.type === 'message_delta' && ev.usage) {
              outputTokens = ev.usage.output_tokens || 0
            }
            if (ev.type === 'message_start' && ev.message?.usage) {
              inputTokens = ev.message.usage.input_tokens || 0
            }
          } catch {}
        }
      }

      const cost = calcCost(inputTokens, outputTokens)
      setTotalCost(prev => prev + cost)
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId
          ? { ...m, streaming: false, inputTokens, outputTokens, cost }
          : m
      ))
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId
          ? { ...m, streaming: false, error: err.message }
          : m
      ))
    } finally {
      setLoading(false)
    }
  }, [input, loading, budgetOver, messages, apiKey, agent])

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
              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', overflowX: 'auto', paddingBottom: '2px' }}>
                {Object.values(STOCK_AGENTS).map(ag => (
                  <button
                    key={ag.id}
                    style={{
                      flexShrink: 0,
                      padding: '5px 12px',
                      borderRadius: '20px',
                      border: `1px solid ${ag.id === agentId ? ag.color : 'var(--border)'}`,
                      background: ag.id === agentId ? ag.color + '22' : 'transparent',
                      color: ag.id === agentId ? ag.color : 'var(--muted)',
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
