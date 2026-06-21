import { useState, useRef, useEffect, useCallback, useMemo } from 'react'

// ── Claude-powered multi-agent roundtable ────────────────────────────────────
// Six roles discuss a stock using scan data + system-computed technical levels:
// a data auditor opens (round 1 only), then tech/fundamental/chip analysts, a
// devil's-advocate, and a risk officer who delivers the verdict. Round 1 is the
// opening; later rounds are cross-examination (must challenge, not agree).
// Hard anti-fabrication rules (see RULES) keep the model from inventing prices
// or metrics that aren't actually in the data.

const ANTHROPIC_KEY_STORAGE = 'anthropic_key'   // shared with main ApiKeyInput
const CLAUDE_MODEL_STORAGE = 'claude_roundtable_model'

const CLAUDE_MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku（快 · ~$0.025/場）' },
  { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet（深度 · ~$0.09/場）' },
]

// Shared rules injected into every analyst's system prompt. The anti-fabrication
// rules are the core fix: most stocks only carry close+RSI (no MA/ATR/highs), so
// without these guards the model invents support/resistance/外資持股率/EPS etc.
const RULES = [
  '語言：繁體中文。',
  '鐵則一：只能引用【資料稽核】與【技術參考位】中「實際出現且有值」的數字；其餘一律不得編造。',
  '鐵則二：標示「缺」或【資料】未提供的指標（外資持股率、EPS、毛利率、產能利用率、MACD…）必須明說「資料未提供」，嚴禁憑記憶或猜測填入數字。',
  '鐵則三：價格唯一基準是收盤價。支撐/壓力/停損/目標若資料未提供，不得自行給出價位，只能說「需更多資料」。',
]

const ANALYSTS = [
  {
    id: 'audit', name: '資料稽核員', emoji: '🔍', color: '#5ac8fa', firstOnly: true,
    persona: `資料稽核員，第一個發言。逐項核對【資料稽核】：有值的覆述關鍵數字，標「缺」的明確點名。最後一行給「資料充足度：足夠 / 技術位不足 / 嚴重不足」並提醒後續發言不得編造缺漏數據。`,
  },
  {
    id: 'tech', name: '技術派', emoji: '📈', color: '#0a84ff',
    persona: `台股技術分析師。只引用【資料】中實際的 RSI/ADX/量比/均線數字；缺的就說「資料未提供」，禁止用「萎靡/徘徊」等模糊形容詞代替數字，禁止編造價位。`,
  },
  {
    id: 'fund', name: '基本面派', emoji: '💰', color: '#30d158',
    persona: `台股基本面分析師。只引用【資料】中的 F-Score、月營收YoY。EPS/毛利率/產能利用率若未提供，必須標「資料未提供」，不得引用記憶中的舊數字。`,
  },
  {
    id: 'chip', name: '籌碼派', emoji: '🌐', color: '#ff9f0a',
    persona: `台股籌碼分析師。只引用【資料】中的三大法人連買天數、融資5日變化。鐵律：融資「增加」＝散戶槓桿升高（不等於認賠）；融資「減少+股價跌」才是認賠/斷頭。外資持股率未提供時不得編造。`,
  },
  {
    id: 'contra', name: '反方派', emoji: '😈', color: '#bf5af2',
    persona: `魔鬼代言人。專挑技術/基本/籌碼三派的漏洞：數據引用錯、與【資料】不符、過度解讀、邏輯跳躍、風報比算錯。至少點名一個具體錯誤，嚴禁附和。`,
  },
  {
    id: 'risk', name: '風控長', emoji: '🛡️', color: '#f85149',
    persona: `台股風控長，最後裁決。風報比一律採用【技術參考位】已算好的數值，不得自行重算。先輸出三劇本（續攻/整理/轉弱：各自觸發條件→操作），再給信心分數0-100。裁決四選一：建議進場 / 建議觀察 / 建議迴避 / 資料不足（若稽核員判定不足則必選此項）。`,
  },
]

const QUICK_QUESTIONS = [
  '停損該設在哪裡？', '何時是最佳出場時機？', '三大法人方向一致嗎？',
  '適合多大倉位比例？', '短線還是波段操作？', '目前最大的風險是？',
  '近期有哪些催化劑？', '與同類股相比強弱如何？',
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

function anthropicKey() { return sessionStorage.getItem(ANTHROPIC_KEY_STORAGE) || '' }
function savedClaudeModel() { return localStorage.getItem(CLAUDE_MODEL_STORAGE) || CLAUDE_MODELS[0].id }
const r2 = v => (v == null || isNaN(v) ? null : Math.round(v * 100) / 100)

// ── Discussion history (localStorage) ────────────────────────────────────────
// Keep legacy key names to preserve users' existing saved discussions.
const HISTORY_STORAGE = 'gemini_discussion_history'
const SESSION_STATE_KEY = 'gemini_session_state'  // survives page refresh (sessionStorage)

// Build a per-analyst summary: each analyst's latest first bullet.
function summarize(msgs) {
  const last = {}
  for (const m of msgs) {
    if (m.role === 'analyst' && m.content && !m.error && !m.streaming) last[m.analyst.id] = m
  }
  return ANALYSTS
    .filter(a => last[a.id])
    .map(a => {
      const c = last[a.id].content
      const point = (c.split('\n').find(l => l.trim()) || c).replace(/^[・\-•\s]+/, '').trim().slice(0, 60)
      return { id: a.id, name: a.name, emoji: a.emoji, color: a.color, point }
    })
    .filter(x => x.point)
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_STORAGE) || '[]') } catch { return [] }
}
function saveHistoryRecord(rec) {
  try {
    const all = loadHistory().filter(r => r.id !== rec.id)
    all.unshift(rec)
    localStorage.setItem(HISTORY_STORAGE, JSON.stringify(all.slice(0, 30)))
  } catch { /* quota — ignore */ }
}
function deleteHistoryRecord(id) {
  try {
    localStorage.setItem(HISTORY_STORAGE, JSON.stringify(loadHistory().filter(r => r.id !== id)))
  } catch { /* ignore */ }
}
function fmtTime(ts) {
  try {
    return new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts))
  } catch { return '' }
}

// ── Claude API ────────────────────────────────────────────────────────────────
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

async function fetchClaude(headers, body) {
  // On iOS, fetch() with custom CORS headers can throw "Load failed" even on
  // non-streaming requests. Using XMLHttpRequest is more reliable on iOS Safari.
  if (isIOS) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', 'https://api.anthropic.com/v1/messages', true)
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v))
      xhr.timeout = 30000
      xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json: () => Promise.resolve(JSON.parse(xhr.responseText)) })
      xhr.onerror = () => reject(new Error('網路連線失敗，請確認網路後重試'))
      xhr.ontimeout = () => reject(new Error('連線逾時（30秒），請重試'))
      xhr.send(JSON.stringify(body))
    })
  }
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers, body: JSON.stringify(body),
    mode: 'cors', credentials: 'omit',
  })
}

async function callClaude(apiKey, model, systemPrompt, userPrompt, onChunk, maxTokens = 350) {
  const HEADERS = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  }
  const BODY = { model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }

  // Desktop: try streaming first for typewriter effect
  if (!isIOS && typeof ReadableStream !== 'undefined') {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: HEADERS, mode: 'cors', credentials: 'omit',
        body: JSON.stringify({ ...BODY, stream: true }),
      })
      if (resp.ok) {
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let text = '', buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n'); buf = lines.pop()
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (!raw || raw === '[DONE]') continue
            try {
              const j = JSON.parse(raw)
              if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
                text += j.delta.text; onChunk?.(text)
              }
            } catch { /* ignore malformed SSE */ }
          }
        }
        if (text) return text.trim()
      }
    } catch { /* streaming failed — fall through */ }
  }

  // Non-streaming (iOS uses XHR, desktop uses fetch)
  const resp = await fetchClaude(HEADERS, BODY)
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    const msg = err?.error?.message || `HTTP ${resp.status}`
    if (resp.status === 401) throw new Error('API Key 無效，請重新整理頁面重新輸入')
    if (resp.status === 529 || resp.status === 503) throw new Error('Claude 服務暫時繁忙，請稍後再試')
    throw new Error(msg)
  }
  const data = await resp.json()
  const text = data?.content?.[0]?.text?.trim() || ''
  if (!text) throw new Error('Claude 無回應（可能觸發安全過濾）')
  onChunk?.(text)
  return text
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
  if (tg.length) L.push(`目標價：${tg.join(' / ')}`)
  // Spell out the risk/reward arithmetic so the model can't miscompute it.
  const stop = lv.atrStop ?? lv.swingStop
  if (lv.target1 != null && stop != null && lv.close != null) {
    const risk = r2(lv.close - stop), reward = r2(lv.target1 - lv.close)
    if (risk > 0 && reward != null) {
      L.push(`風報比計算（請直接採用此結果）：風險=收盤${lv.close}−停損${stop}=${risk}；報酬=目標1 ${lv.target1}−收盤${lv.close}=${reward}；風報比=${reward}÷${risk}=${r2(reward / risk)}`)
    }
  }
  return L.join('\n')
}

// Data-audit summary: every key field with its value or 「缺」. Drives the
// 資料稽核員's brief and the anti-fabrication guardrails.
function buildAudit(resolved, levels) {
  if (!resolved) return null
  const r = resolved.row || {}
  const ok = v => v != null && !isNaN(v)
  const rows = [
    ['收盤價', ok(r.close) ? r.close : null],
    ['RSI(14)', ok(r.rsi14) ? r.rsi14.toFixed(1) : null],
    ['ADX(14)', ok(r.adx14) ? r.adx14.toFixed(1) : null],
    ['量比(/20日均量)', ok(r.volume_ratio) ? r.volume_ratio.toFixed(2) + 'x' : null],
    ['EMA20 / EMA60', (ok(r.ema20) || ok(r.ema60)) ? `${ok(r.ema20) ? r.ema20 : '—'} / ${ok(r.ema60) ? r.ema60 : '—'}` : null],
    ['20日高 / 10日低', (ok(r.close_20d_high) || ok(r.close_10d_low)) ? `${ok(r.close_20d_high) ? r.close_20d_high : '—'} / ${ok(r.close_10d_low) ? r.close_10d_low : '—'}` : null],
    ['ATR(14)', ok(r.atr14) ? r.atr14 : null],
    ['F-Score', ok(r.f_score) ? r.f_score + '/9' : null],
    ['月營收YoY', ok(r.revenue_yoy) ? r.revenue_yoy.toFixed(1) + '%' : null],
    ['外資/投信/自營連買', (ok(r.foreign_buy_streak) || ok(r.invest_trust_streak) || ok(r.dealer_buy_streak)) ? `${r.foreign_buy_streak ?? '—'} / ${r.invest_trust_streak ?? '—'} / ${r.dealer_buy_streak ?? '—'} 日` : null],
    ['融資5日變化', ok(r.margin_change_5d) ? r.margin_change_5d.toFixed(1) + '%' : null],
  ]
  const text = rows.map(([k, v]) => `${k}：${v == null ? '缺' : v}`).join('\n')
  const hasLevels = !!(levels && (levels.supports?.length || levels.resistances?.length))
  const insufficient = !ok(r.close)
  return {
    text, hasLevels, insufficient,
    note: insufficient
      ? '⚠️ 連收盤價都缺，資料嚴重不足，禁止給任何買賣建議與價位。'
      : !hasLevels
        ? '⚠️ 僅有收盤價與部分指標，缺均線/高低點 → 無法計算支撐/壓力/停損/目標，後續嚴禁自行編造這些價位。'
        : null,
  }
}

// Find news headlines relevant to the stock (by id, name keywords, or sector)
function findNewsForStock(stockId, name, industry, news) {
  if (!Array.isArray(news) || !news.length) return []
  const terms = [
    stockId,
    ...(name?.match(/[一-龥]{2,4}/g) || []),
    (industry || '').split(/[/\s]/)[0] || '',
  ].filter(t => t && t.length >= 2)
  return news
    .filter(n => terms.some(t => (n.title || '').includes(t) || (n.summary || '').includes(t)))
    .slice(0, 2)
    .map(n => n.title || '')
    .filter(Boolean)
}

// Parse 風控長's last message for a verdict keyword
function parseVerdict(messages) {
  const riskMsgs = messages.filter(m => m.role === 'analyst' && m.analyst?.id === 'risk' && !m.error && !m.streaming)
  if (!riskMsgs.length) return null
  const txt = riskMsgs[riskMsgs.length - 1].content || ''
  if (/資料不足|數據不足|資訊不足|無法判斷|不足以(判斷|決策)/.test(txt)) return { verdict: '資料不足', color: '#8e8e93', emoji: '❓' }
  if (/建議進場|可以進場|適合買進|進場訊號|值得買/.test(txt)) return { verdict: '建議進場', color: '#30d158', emoji: '✅' }
  if (/建議迴避|暫時迴避|避開|不建議|風險過高|先回避/.test(txt)) return { verdict: '建議迴避', color: '#f85149', emoji: '🚫' }
  if (/建議觀察|先觀察|觀望|等待確認|觀察等待/.test(txt)) return { verdict: '建議觀察', color: '#ff9f0a', emoji: '👀' }
  return null
}

function buildBrief(resolved, levels, market, news, audit) {
  if (!resolved) return ''
  const r = resolved.row || {}
  const f = (v, suf = '') => (v == null || isNaN(v) ? '—' : `${v}${suf}`)
  const lines = [`【標的】${resolved.stock_id} ${resolved.name || '(名稱未知)'} ${r.industry_category || ''}`.trim()]
  // Data audit first — the canonical list of what's actually available.
  if (audit?.text) {
    lines.push(`\n【資料稽核（只能引用有值欄位，標「缺」者嚴禁編造）】\n${audit.text}`)
    if (audit.note) lines.push(audit.note)
  }
  // Scan-derived signals — only when present.
  if (r.entry_score != null) lines.push(`\n進場分數 ${f(Math.round(r.entry_score))}${r.grade ? ` 評級${r.grade}` : ''}${r.entry_signal ? ' ✅入榜' : ''}`)
  if (r.relative_strength_5d != null) lines.push(`相對大盤5日 ${(r.relative_strength_5d * 100).toFixed(1)}%`)
  if (r.entry_reason) lines.push(`系統入場理由：${r.entry_reason}`)
  if (levels && (levels.fib || levels.supports?.length || levels.resistances?.length || levels.target1 != null)) {
    lines.push(`\n【技術參考位（依此數值發言，缺漏者不得自行編造）】\n${fmtLevels(levels)}`)
  }
  if (market) {
    lines.push(`\n【大盤】XGBoost上漲機率 ${market.prob != null ? Math.round(market.prob * 100) + '%' : '—'} | VIX ${f(market.vix)} | 外資期貨 ${market.futures != null ? market.futures.toLocaleString() + '口' : '—'}`)
  }
  const newsHeadlines = findNewsForStock(resolved.stock_id, resolved.name, r.industry_category, news)
  if (newsHeadlines.length) lines.push(`\n【近期相關新聞】\n${newsHeadlines.map(h => `・${h}`).join('\n')}`)
  return lines.join('\n')
}

export default function GeminiStudio({ data }) {
  const [apiKey, setApiKey] = useState(anthropicKey)
  const [keyInput, setKeyInput] = useState('')
  const [claudeModel, setClaudeModel] = useState(savedClaudeModel)
  const [showSettings, setShowSettings] = useState(false)
  const [stockInput, setStockInput] = useState('')
  const [customTopic, setCustomTopic] = useState('')
  const [messages, setMessages] = useState(() => {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_STATE_KEY) || 'null')
      return Array.isArray(s?.messages) ? s.messages.filter(m => !m.streaming) : []
    } catch { return [] }
  })
  const [running, setRunning] = useState(false)
  const [round, setRound] = useState(() => {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_STATE_KEY) || 'null')
      return s?.round ?? 0
    } catch { return 0 }
  })
  const [retryNote, setRetryNote] = useState('')
  const [userInput, setUserInput] = useState('')
  const [autoRun, setAutoRun] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [showSummary, setShowSummary] = useState(true)
  const [view, setView] = useState('chat')      // 'chat' | 'history'
  const [history, setHistory] = useState(loadHistory)
  const [openRec, setOpenRec] = useState(null)  // expanded history record id

  const endRef = useRef(null)
  const autoRunRef = useRef(false)
  const lastAccRef = useRef([])   // latest acc after each round
  const countdownRef = useRef(null)
  const sessionIdRef = useRef(null)
  const claudeModelRef = useRef(claudeModel)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { localStorage.setItem(CLAUDE_MODEL_STORAGE, claudeModel); claudeModelRef.current = claudeModel }, [claudeModel])
  useEffect(() => { autoRunRef.current = autoRun }, [autoRun])
  // Persist in-progress session to sessionStorage so it survives page refreshes
  useEffect(() => {
    try {
      if (messages.length > 0) sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify({ messages, round }))
      else sessionStorage.removeItem(SESSION_STATE_KEY)
    } catch { /* quota */ }
  }, [messages, round])

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
  const levels = resolved ? computeLevels(resolved.row) : null
  const audit = resolved ? buildAudit(resolved, levels) : null
  const brief = buildBrief(resolved, levels, market, data?.news, audit)
  const verdict = useMemo(() => parseVerdict(messages), [messages])
  const topic = resolved
    ? `針對 ${resolved.stock_id} ${resolved.name || ''} 的進場決策`.trim()
    : customTopic.trim()

  const saveKey = () => { const k = keyInput.trim(); if (k) { sessionStorage.setItem(ANTHROPIC_KEY_STORAGE, k); setApiKey(k) } }

  const transcriptText = (msgs) => msgs.map(m =>
    m.role === 'user' ? `【使用者插話】${m.content}` : `【${m.analyst.name}】${m.content}`
  ).join('\n\n')

  // Summary: each analyst's latest first bullet
  const summary = useMemo(() => summarize(messages), [messages])

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
    const curAnthKey = sessionStorage.getItem(ANTHROPIC_KEY_STORAGE) || ''
    if (!curAnthKey) return
    setRunning(true); setRetryNote(''); setCountdown(0)
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
    let acc = [...priorMessages]
    if (userNote) acc.push({ role: 'user', content: userNote })
    setMessages(acc)

    // First round runs the data auditor; later rounds skip it and become
    // cross-examination instead of repeated opening statements.
    const isFirstRound = !priorMessages.some(m => m.role === 'analyst')
    const roster = ANALYSTS.filter(a => !a.firstOnly || isFirstRound)

    for (let ai = 0; ai < roster.length; ai++) {
      const analyst = roster[ai]
      const pid = `${analyst.id}-${Date.now()}-${Math.random()}`
      setMessages(prev => [...prev, { id: pid, role: 'analyst', analyst, content: '', streaming: true }])

      const fmt = analyst.id === 'audit'
        ? '格式：逐欄列出有值/缺漏的關鍵數字（每行一項），最後一行寫「資料充足度：…」。'
        : analyst.id === 'risk'
          ? '格式：先列三劇本（續攻/整理/轉弱，各一行：觸發條件→操作），再一行「信心 X/100」，最後一行「裁決：建議進場/建議觀察/建議迴避/資料不足」。'
          : '格式：最多3條，每條25字內，「・」開頭，無前言廢話，直接切重點。'

      const roundLine = analyst.id === 'audit' ? ''
        : isFirstRound ? '本輪為初判：提出你的立場與數據依據。'
          : '本輪為交叉質詢：必須針對前面至少一位的具體論點提出反駁或補強，禁止只說「同意」或重複附和。'

      const sys = [analyst.persona, ...RULES, fmt, roundLine].filter(Boolean).join('\n')

      const prompt = [
        `圓桌主題：${topic}`,
        brief ? `\n資料：\n${brief}` : '',
        acc.length ? `\n討論紀錄：\n${transcriptText(acc)}` : '',
        `\n現在輪到你（${analyst.name}）。`,
      ].join('\n')

      const maxTokens = (analyst.id === 'audit' || analyst.id === 'risk') ? 600 : 350

      try {
        const text = await callClaude(curAnthKey, claudeModelRef.current, sys, prompt, partial => {
          setMessages(prev => prev.map(m => m.id === pid
            ? { id: pid, role: 'analyst', analyst, content: partial, streaming: true } : m))
        }, maxTokens)
        setRetryNote('')
        const msg = { id: pid, role: 'analyst', analyst, content: text }
        acc.push(msg)
        setMessages(prev => prev.map(m => m.id === pid ? msg : m))
      } catch (e) {
        setMessages(prev => prev.map(m => m.id === pid ? { id: pid, role: 'analyst', analyst, error: e.message } : m))
        setRunning(false); setRetryNote(''); setAutoRun(false)
        return
      }
    }

    lastAccRef.current = acc
    setRound(r => r + 1)
    setRunning(false)

    // Persist this discussion to history (upsert by session id)
    if (sessionIdRef.current) {
      const clean = acc.filter(m => !m.streaming && !m.error)
      const rec = {
        id: sessionIdRef.current,
        topic, stockId: typedId, time: Date.now(),
        summary: summarize(acc),
        messages: clean.map(m => ({
          role: m.role,
          name: m.analyst?.name || '使用者',
          emoji: m.analyst?.emoji || '🙋',
          color: m.analyst?.color || '#0a84ff',
          content: m.content,
        })),
      }
      saveHistoryRecord(rec)
      setHistory(loadHistory())
    }

    if (autoRunRef.current) scheduleAutoRound(acc)
  }, [topic, brief, typedId, scheduleAutoRound])

  const runRound = useCallback((priorMessages, userNote) => {
    return runRoundInternal(priorMessages, userNote)
  }, [runRoundInternal])

  const start = () => {
    if (!topic) return
    sessionIdRef.current = `${Date.now()}-${typedId || 'topic'}`
    sessionStorage.removeItem(SESSION_STATE_KEY)
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

  // ── No Anthropic key yet ─────────────────────────────────────────────────────
  if (!apiKey) {
    return (
      <div style={s.root}>
        <Header />
        <div style={s.setup}>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🎯</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--ios-label)' }}>AI 圓桌研究室</div>
            <div style={{ fontSize: 13, color: 'var(--ios-label2)', marginTop: 6, lineHeight: 1.6 }}>
              六位 AI 角色（含資料稽核員與反方派）用掃描資料 + 系統技術位討論一支股票。<br />
              先稽核資料、再交叉質詢、由風控長裁決。由 <b style={{ color: 'var(--ios-blue)' }}>Claude</b> 串流驅動。
            </div>
          </div>
          <div style={s.label}>Anthropic API Key</div>
          <input style={s.input} type="password" value={keyInput} placeholder="貼上你的 Anthropic API Key（sk-ant-...）"
            onChange={e => setKeyInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveKey()} />
          <button onClick={saveKey} disabled={!keyInput.trim()} style={{
            width: '100%', marginTop: 12, padding: '11px', borderRadius: 10, border: 'none',
            background: keyInput.trim() ? 'var(--ios-blue)' : 'var(--ios-fill3)',
            color: keyInput.trim() ? '#fff' : 'var(--ios-label3)', fontSize: 15, fontWeight: 700,
            cursor: keyInput.trim() ? 'pointer' : 'default',
          }}>開始使用</button>
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={{
            display: 'block', textAlign: 'center', marginTop: 14, fontSize: 13, color: 'var(--ios-blue)',
          }}>→ 取得 Anthropic API Key（Console）</a>
          <div style={{ marginTop: 16, fontSize: 11, color: 'var(--ios-label3)', lineHeight: 1.6, textAlign: 'center' }}>
            Key 僅存於本分頁（sessionStorage），不上傳、不留存<br />
            一場討論約 $0.025（&lt; 1 TWD）
          </div>
        </div>
      </div>
    )
  }

  // ── History view ──────────────────────────────────────────────────────────────
  if (view === 'history') {
    return (
      <div style={s.root}>
        <Header title="📜 討論紀錄" onReset={() => setView('chat')} resetLabel="← 返回" />
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', WebkitOverflowScrolling: 'touch' }}>
          {history.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--ios-label3)' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
              <div style={{ fontSize: 14 }}>尚無討論紀錄</div>
              <div style={{ fontSize: 12, marginTop: 6 }}>每次圓桌討論結束後會自動存檔於此</div>
            </div>
          ) : history.map(rec => {
            const expanded = openRec === rec.id
            return (
              <div key={rec.id} style={{ background: 'var(--ios-bg2)', borderRadius: 12, padding: '12px 14px', marginBottom: 10, boxShadow: 'var(--shadow-card)' }}>
                <div onClick={() => setOpenRec(expanded ? null : rec.id)} style={{ cursor: 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ios-label)', flex: 1 }}>{rec.topic}</span>
                    <span style={{ fontSize: 11, color: 'var(--ios-label3)', flexShrink: 0 }}>{fmtTime(rec.time)}</span>
                  </div>
                  {/* Summary points */}
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {(rec.summary || []).map(item => (
                      <div key={item.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                        <span style={{ fontSize: 12, flexShrink: 0 }}>{item.emoji}</span>
                        <span style={{ fontSize: 12, color: 'var(--ios-label2)', flex: 1, lineHeight: 1.4 }}>
                          <b style={{ color: item.color }}>{item.name}：</b>{item.point}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 11, color: 'var(--ios-blue)' }}>
                    {expanded ? '▲ 收合全文' : '▼ 展開完整對話'}
                  </div>
                </div>
                {expanded && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '0.5px solid var(--ios-sep)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {(rec.messages || []).map((m, i) => (
                      <div key={i}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: m.color, marginBottom: 2 }}>{m.emoji} {m.name}</div>
                        <div style={{ fontSize: 13, color: 'var(--ios-label)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{m.content}</div>
                      </div>
                    ))}
                    <button onClick={() => { deleteHistoryRecord(rec.id); setHistory(loadHistory()); setOpenRec(null) }}
                      style={{ alignSelf: 'flex-end', marginTop: 4, fontSize: 11, color: 'var(--ios-red)', background: 'var(--ios-fill4)', border: 'none', borderRadius: 7, padding: '5px 14px', cursor: 'pointer' }}>
                      刪除此紀錄
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Setup screen ──────────────────────────────────────────────────────────────
  if (messages.length === 0 && !running) {
    return (
      <div style={s.root}>
        <Header onSettings={() => setShowSettings(v => !v)}
          onHistory={history.length ? () => setView('history') : null} />
        {showSettings && <ModelPicker claudeModel={claudeModel} setClaudeModel={setClaudeModel} />}
        <div style={s.setup}>
          <div style={{ textAlign: 'center', marginBottom: 18 }}>
            <div style={{ fontSize: 34 }}>🎯</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ios-label)', marginTop: 4 }}>AI 圓桌研究室</div>
            <div style={{ fontSize: 12.5, color: 'var(--ios-label2)', marginTop: 4 }}>輸入股號，先稽核資料再六方交叉質詢</div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
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
        onHistory={history.length ? () => setView('history') : null}
        onSettings={() => setShowSettings(v => !v)} />
      {showSettings && <ModelPicker claudeModel={claudeModel} setClaudeModel={setClaudeModel} />}

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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.4 }}>📋 討論重點摘要</span>
              {verdict && !showSummary && (
                <span style={{ fontSize: 11, fontWeight: 700, color: verdict.color, background: verdict.color + '22', padding: '2px 8px', borderRadius: 9999, border: `1px solid ${verdict.color}55` }}>
                  {verdict.emoji} {verdict.verdict}
                </span>
              )}
            </div>
            <span style={{ fontSize: 11, color: 'var(--ios-label3)' }}>{showSummary ? '▲' : '▼'}</span>
          </button>
          {showSummary && (
            <div style={{ padding: '0 14px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {summary.map(item => (
                <div key={item.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 13, flexShrink: 0 }}>{item.emoji}</span>
                  <span style={{ fontSize: 12, color: 'var(--ios-label2)', flex: 1, lineHeight: 1.4 }}>
                    <b style={{ color: item.color }}>{item.name}：</b>{item.point}
                  </span>
                </div>
              ))}
              {verdict && (
                <div style={{ marginTop: 4, padding: '6px 10px', borderRadius: 8, background: verdict.color + '18', border: `1px solid ${verdict.color}44`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: verdict.color }}>{verdict.emoji} 風控裁決：{verdict.verdict}</span>
                  <button
                    onClick={() => {
                      const txt = `圓桌討論：${topic}\n\n` + messages.filter(m => !m.streaming && !m.error).map(m =>
                        m.role === 'user' ? `【你】${m.content}` : `【${m.analyst.name}】\n${m.content}`
                      ).join('\n\n')
                      navigator.clipboard?.writeText(txt).catch(() => {})
                    }}
                    style={{ fontSize: 11, color: 'var(--ios-label3)', background: 'var(--ios-fill4)', border: 'none', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>
                    📋 複製
                  </button>
                </div>
              )}
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

        {/* Quick question chips */}
        {!running && round > 0 && !countdown && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
            {QUICK_QUESTIONS.map(q => (
              <div key={q} onClick={() => setUserInput(q)}
                style={{ padding: '4px 10px', borderRadius: 9999, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
                  background: userInput === q ? 'rgba(10,132,255,0.18)' : 'var(--ios-fill4)',
                  color: userInput === q ? 'var(--ios-blue)' : 'var(--ios-label3)',
                  border: `0.5px solid ${userInput === q ? 'var(--ios-blue)' : 'var(--ios-sep)'}` }}>
                {q}
              </div>
            ))}
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
          ✨ Claude 串流驅動 · Enter 插話 · Shift+Enter 換行
        </div>
      </div>
    </div>
  )
}

function ModelPicker({ claudeModel, setClaudeModel }) {
  const chip = (active) => ({
    padding: '6px 11px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--ios-blue)' : 'var(--ios-sep)'}`,
    background: active ? 'rgba(10,132,255,0.18)' : 'var(--ios-fill4)',
    color: active ? 'var(--ios-blue)' : 'var(--ios-label2)', fontWeight: active ? 700 : 400,
  })
  return (
    <div style={{ padding: '12px 16px', background: 'var(--ios-bg3)', borderBottom: '0.5px solid var(--ios-sep)', flexShrink: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 7 }}>Claude 模型</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {CLAUDE_MODELS.map(m => (
          <div key={m.id} onClick={() => setClaudeModel(m.id)} style={chip(m.id === claudeModel)}>{m.label}</div>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--ios-label3)' }}>
        串流逐字顯示 · 無速率限制 · 一場約 $0.025
      </div>
    </div>
  )
}

function Header({ title, onReset, resetLabel, onHistory, onSettings, onClearKey }) {
  const btn = { background: 'var(--ios-fill4)', border: '0.5px solid var(--ios-sep)', borderRadius: 9999, padding: '4px 11px', color: 'var(--ios-label2)', fontSize: 12, cursor: 'pointer', flexShrink: 0 }
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '0.5px solid var(--ios-sep)', background: 'var(--ios-bg2)', flexShrink: 0, gap: 10 }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ios-label)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
        {title ? title : '🎯 圓桌研究室'}
      </span>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {onReset && <button onClick={onReset} style={btn}>{resetLabel || '新主題'}</button>}
        {onHistory && <button onClick={onHistory} style={btn} title="討論紀錄">📜</button>}
        {onSettings && <button onClick={onSettings} style={btn}>⚙️</button>}
        {onClearKey && <button onClick={onClearKey} style={btn}>🔑</button>}
      </div>
    </div>
  )
}
