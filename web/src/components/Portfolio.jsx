import { useState, useRef } from 'react'

const STORAGE_KEY = 'tw_portfolio_positions'

function loadPositions() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} }
}
function savePositions(p) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)) } catch {}
}

function getCurrentPrice(stockId, data) {
  if (!data) return null
  const all = [...(data.top_stocks || []), ...(data.scan_results || [])]
  const m = all.find(s => String(s.stock_id) === String(stockId))
  return m?.close ?? null
}

function fmt(v, d = 2) { return v == null || isNaN(v) ? '—' : Number(v).toFixed(d) }
function fmtNum(v) { return v == null ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 0 }) }
function getApiKey() { return sessionStorage.getItem('anthropic_key') || '' }

const EMPTY_FORM = { stock_id: '', name: '', buyPrice: '', qty: '', buyDate: '', note: '' }
const inputStyle = {
  width: '100%', background: 'var(--ios-fill3)', border: '0.5px solid var(--ios-sep)',
  borderRadius: 8, padding: '8px 10px', color: 'var(--ios-label)', fontSize: 13,
  boxSizing: 'border-box', outline: 'none', WebkitAppearance: 'none',
}

async function fileToBase64(file) {
  return new Promise(resolve => {
    const r = new FileReader()
    r.onload = e => resolve(e.target.result.split(',')[1])
    r.readAsDataURL(file)
  })
}

async function callClaude(key, body) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`API ${resp.status}`)
  return resp.json()
}

// ── Import confirmation modal ─────────────────────────────────────────────────
function ImportConfirm({ positions, onConfirm, onCancel }) {
  const [selected, setSelected] = useState(() => new Set(positions.map((_, i) => i)))
  const toggle = i => setSelected(prev => {
    const next = new Set(prev)
    next.has(i) ? next.delete(i) : next.add(i)
    return next
  })
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 999,
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--ios-bg)', borderRadius: '18px 18px 0 0', padding: '20px 18px 40px',
        width: '100%', maxHeight: '75vh', overflowY: 'auto',
        animation: 'sheetIn 0.28s cubic-bezier(0.22,1,0.36,1) both',
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ios-blue)', marginBottom: 4, letterSpacing: 0.5, textTransform: 'uppercase' }}>📸 偵測到持倉</div>
        <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 14 }}>勾選要匯入的持倉，可手動修改後再確認</div>
        {positions.map((pos, i) => (
          <label key={i} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
            background: selected.has(i) ? 'rgba(10,132,255,0.08)' : 'var(--ios-fill4)',
            borderRadius: 10, marginBottom: 6, cursor: 'pointer',
            border: `1px solid ${selected.has(i) ? 'rgba(10,132,255,0.3)' : 'transparent'}`,
            transition: 'all 0.15s',
          }}>
            <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} style={{ width: 16, height: 16, accentColor: 'var(--ios-blue)', flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ios-label)' }}>
                {pos.stock_id} <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--ios-label2)' }}>{pos.name}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <span>成本 <b style={{ color: 'var(--ios-label)' }}>{pos.buyPrice ?? '—'}</b></span>
                <span>股數 <b style={{ color: 'var(--ios-label)' }}>{fmtNum(pos.qty)}</b></span>
                {pos.currentPrice && <span>現價 <b style={{ color: 'var(--ios-blue)' }}>{pos.currentPrice}</b></span>}
              </div>
            </div>
          </label>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button onClick={onCancel} style={{ flex: 1, background: 'var(--ios-fill4)', border: 'none', borderRadius: 10, padding: 12, color: 'var(--ios-label2)', fontSize: 13, cursor: 'pointer' }}>取消</button>
          <button onClick={() => onConfirm(positions.filter((_, i) => selected.has(i)))} style={{ flex: 2, background: 'var(--ios-blue)', border: 'none', borderRadius: 10, padding: 12, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            匯入 {selected.size} 筆
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Portfolio({ data }) {
  const [positions, setPositions] = useState(loadPositions)
  const [showForm, setShowForm]   = useState(false)
  const [editId, setEditId]       = useState(null)
  const [form, setForm]           = useState(EMPTY_FORM)
  const [sortBy, setSortBy]       = useState('pnlPct')
  const [aiStatus, setAiStatus]   = useState(null) // null | 'photo' | 'ai' | 'error' | 'nokey' | 'none'
  const [aiText, setAiText]       = useState('')
  const [importPreview, setImportPreview] = useState(null)
  const fileRef = useRef(null)

  const update = p => { setPositions(p); savePositions(p) }
  const openAdd = () => { setForm(EMPTY_FORM); setEditId(null); setShowForm(true) }
  const openEdit = id => {
    const p = positions[id]
    setForm({ stock_id: id, name: p.name || '', buyPrice: String(p.buyPrice), qty: String(p.qty), buyDate: p.buyDate || '', note: p.note || '' })
    setEditId(id); setShowForm(true)
  }
  const handleSave = () => {
    const id = form.stock_id.trim()
    if (!id || !form.buyPrice || !form.qty) return
    update({ ...positions, [id]: { name: form.name.trim(), buyPrice: Number(form.buyPrice), qty: Number(form.qty), buyDate: form.buyDate, note: form.note.trim() } })
    setShowForm(false); setEditId(null); setForm(EMPTY_FORM)
  }
  const handleDelete = id => {
    if (!window.confirm(`確定刪除 ${id} ${positions[id]?.name || ''} 持倉？`)) return
    const next = { ...positions }; delete next[id]; update(next)
  }

  // ── Entries with computed metrics ──────────────────────────────────────────
  const entries = Object.entries(positions).map(([id, p]) => {
    const curPrice  = getCurrentPrice(id, data)
    const pnlPct    = curPrice ? (curPrice - p.buyPrice) / p.buyPrice * 100 : null
    const pnlAmt    = curPrice ? (curPrice - p.buyPrice) * p.qty : null
    const cost      = p.buyPrice * p.qty
    const curVal    = (curPrice ?? p.buyPrice) * p.qty
    const buyDate   = p.buyDate ? new Date(p.buyDate) : null
    const daysHeld  = buyDate ? Math.max(0, Math.floor((Date.now() - buyDate) / 86400000)) : null
    const annReturn = (pnlPct != null && daysHeld != null && daysHeld >= 7)
      ? pnlPct / daysHeld * 365 : null
    const stopLoss  = p.buyPrice * 0.92  // –8% stop
    const takePrft  = p.buyPrice * 1.15  // +15% target
    return { id, p, curPrice, pnlPct, pnlAmt, cost, curVal, daysHeld, annReturn, stopLoss, takePrft }
  })

  const sorted = [...entries].sort((a, b) => {
    if (sortBy === 'pnlPct') return (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity)
    if (sortBy === 'daysHeld') return (b.daysHeld ?? -1) - (a.daysHeld ?? -1)
    return b.cost - a.cost
  })

  const totalCost  = entries.reduce((s, e) => s + e.cost, 0)
  const totalValue = entries.reduce((s, e) => s + e.curVal, 0)
  const totalPnL   = totalValue - totalCost
  const totalPct   = totalCost > 0 ? totalPnL / totalCost * 100 : 0
  const priceCount = entries.filter(e => e.curPrice != null).length

  // ── Photo import ───────────────────────────────────────────────────────────
  const handlePhoto = async e => {
    const file = e.target.files[0]; e.target.value = ''
    if (!file) return
    const key = getApiKey()
    if (!key) { setAiStatus('nokey'); return }
    setAiStatus('photo'); setAiText('')
    try {
      const base64 = await fileToBase64(file)
      const result = await callClaude(key, {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: file.type || 'image/jpeg', data: base64 } },
            { type: 'text', text: `請分析這張台股持倉截圖，提取所有持倉。
以JSON陣列回傳，格式：[{"stock_id":"4位代號","name":"名稱","qty":股數整數,"buyPrice":買入均價,"currentPrice":現價或null}]
只回傳JSON陣列，不要任何說明文字或markdown。看不到持倉則回傳[]。` }
          ]
        }]
      })
      const text = result.content?.[0]?.text?.trim() || '[]'
      let parsed = []
      try { parsed = JSON.parse(text) } catch {
        const m = text.match(/\[[\s\S]*\]/)
        if (m) parsed = JSON.parse(m[0])
      }
      if (parsed.length > 0) { setImportPreview(parsed); setAiStatus(null) }
      else { setAiStatus('none'); setTimeout(() => setAiStatus(null), 3000) }
    } catch (err) {
      setAiStatus('error'); setAiText(err.message)
      setTimeout(() => { setAiStatus(null); setAiText('') }, 4000)
    }
  }

  const confirmImport = selected => {
    const next = { ...positions }
    for (const pos of selected) {
      if (!pos.stock_id) continue
      next[String(pos.stock_id)] = {
        name: pos.name || '', buyPrice: Number(pos.buyPrice) || 0,
        qty: Number(pos.qty) || 0,
        buyDate: new Date().toISOString().slice(0, 10),
        note: '📸 照片匯入',
      }
    }
    update(next); setImportPreview(null)
  }

  // ── AI analysis of existing portfolio ─────────────────────────────────────
  const analyzePortfolio = async () => {
    const key = getApiKey()
    if (!key) { setAiStatus('nokey'); return }
    if (entries.length === 0) return
    setAiStatus('ai'); setAiText('')
    const txt = entries.map(({ id, p, curPrice, pnlPct, daysHeld }) =>
      `${id} ${p.name}：持 ${(p.qty / 1000).toFixed(p.qty % 1000 === 0 ? 0 : 2)} 張，成本 ${p.buyPrice}，` +
      `現價 ${curPrice ?? '未知'}，損益 ${pnlPct != null ? (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + '%' : '未知'}，` +
      `持 ${daysHeld ?? '?'} 天`
    ).join('\n')
    try {
      const result = await callClaude(key, {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: '你是台股投資顧問，用繁體中文給出簡潔有用的建議，條列式，每條不超過30字。',
        messages: [{ role: 'user', content: `請分析持倉並給出：①整體風險等級 ②各股持有/減碼/停損建議 ③最重要的一個注意事項\n\n${txt}` }]
      })
      setAiText(result.content?.[0]?.text?.trim() || '分析失敗')
      setAiStatus('ai_done')
    } catch (err) {
      setAiStatus('error'); setAiText(err.message)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '0 14px 80px', overflowY: 'auto', height: '100%', WebkitOverflowScrolling: 'touch' }}>
      <style>{`
        @keyframes rowIn   { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
        @keyframes sheetIn { from { opacity:0; transform:translateY(16px) } to { opacity:1; transform:translateY(0) } }
        @keyframes fadeIn  { from { opacity:0 } to { opacity:1 } }
      `}</style>

      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhoto} />
      {importPreview && <ImportConfirm positions={importPreview} onConfirm={confirmImport} onCancel={() => setImportPreview(null)} />}

      {/* ── Status banner ──────────────────────────────── */}
      {aiStatus && (
        <div style={{
          background: aiStatus === 'error' ? 'rgba(255,59,48,0.12)' : aiStatus === 'nokey' ? 'rgba(255,159,10,0.12)' : 'rgba(10,132,255,0.10)',
          border: `0.5px solid ${aiStatus === 'error' ? 'rgba(255,59,48,0.3)' : aiStatus === 'nokey' ? 'rgba(255,159,10,0.3)' : 'rgba(10,132,255,0.25)'}`,
          borderRadius: 10, padding: '10px 14px', marginBottom: 10, fontSize: 12,
          color: aiStatus === 'error' ? 'var(--ios-red)' : aiStatus === 'nokey' ? 'var(--ios-yellow)' : 'var(--ios-blue)',
          animation: 'fadeIn 0.2s both',
        }}>
          {aiStatus === 'photo'    && '🔍 正在分析截圖中⋯'}
          {aiStatus === 'ai'       && '🤖 AI 分析持倉中⋯'}
          {aiStatus === 'none'     && '📭 截圖中未偵測到持倉'}
          {aiStatus === 'nokey'    && '⚠️ 請先前往「AI」頁面輸入 Anthropic API Key'}
          {aiStatus === 'error'    && `❌ 錯誤：${aiText}`}
        </div>
      )}

      {/* ── AI analysis result ─────────────────────────── */}
      {aiStatus === 'ai_done' && aiText && (
        <div style={{
          background: 'rgba(10,132,255,0.07)', border: '0.5px solid rgba(10,132,255,0.2)',
          borderRadius: 12, padding: '12px 14px', marginBottom: 10,
          animation: 'sheetIn 0.3s cubic-bezier(0.22,1,0.36,1) both',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-blue)', letterSpacing: 0.5 }}>🤖 AI 持倉分析</div>
            <button onClick={() => { setAiStatus(null); setAiText('') }} style={{ background: 'none', border: 'none', color: 'var(--ios-label3)', fontSize: 14, cursor: 'pointer', padding: '0 4px' }}>✕</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ios-label)', lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>{aiText}</div>
        </div>
      )}

      {/* ── Summary card ───────────────────────────────── */}
      {entries.length > 0 && (
        <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '14px 16px', marginBottom: 12, boxShadow: 'var(--shadow-card)' }}>
          <div style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, letterSpacing: 0.8, marginBottom: 8, textTransform: 'uppercase' }}>持倉總覽</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700, color: totalPnL >= 0 ? 'var(--ios-red)' : 'var(--ios-green)', letterSpacing: '-0.5px', lineHeight: 1.1 }}>
                {totalPnL >= 0 ? '+' : ''}{fmtNum(Math.round(totalPnL))} 元
              </div>
              <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 4 }}>
                成本 {fmtNum(Math.round(totalCost))}｜市值 {fmtNum(Math.round(totalValue))}
                {priceCount < entries.length && <span style={{ color: 'var(--ios-yellow)', marginLeft: 6 }}>{entries.length - priceCount} 檔無報價</span>}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: totalPct >= 0 ? 'var(--ios-red)' : 'var(--ios-green)' }}>
                {totalPct >= 0 ? '+' : ''}{fmt(totalPct)}%
              </div>
              <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 2 }}>{entries.length} 檔 · {priceCount} 有報價</div>
            </div>
          </div>
          <div style={{ height: 4, background: 'var(--ios-fill4)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 2,
              background: totalPct >= 0 ? 'var(--ios-red)' : 'var(--ios-green)',
              width: `${Math.min(100, Math.abs(totalPct) * 5)}%`,
              transition: 'width 0.5s cubic-bezier(0.34,1.56,0.64,1)',
            }} />
          </div>
          {/* AI analysis button */}
          <button onClick={analyzePortfolio} disabled={aiStatus === 'ai'} style={{
            marginTop: 10, width: '100%', background: 'rgba(10,132,255,0.1)', border: '0.5px solid rgba(10,132,255,0.25)',
            borderRadius: 8, padding: '8px', color: 'var(--ios-blue)', fontSize: 12, fontWeight: 600,
            cursor: aiStatus === 'ai' ? 'default' : 'pointer', opacity: aiStatus === 'ai' ? 0.6 : 1,
          }}>
            {aiStatus === 'ai' ? '🤖 分析中⋯' : '🤖 AI 分析整體持倉'}
          </button>
        </div>
      )}

      {/* ── Sort bar ───────────────────────────────────── */}
      {entries.length > 1 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {[['pnlPct', '報酬率'], ['daysHeld', '持有天數'], ['cost', '成本']].map(([key, label]) => (
            <button key={key} onClick={() => setSortBy(key)} style={{
              background: sortBy === key ? 'var(--ios-blue)' : 'var(--ios-fill4)',
              color: sortBy === key ? '#fff' : 'var(--ios-label3)',
              border: 'none', borderRadius: 8, padding: '5px 12px', fontSize: 11,
              cursor: 'pointer', fontWeight: sortBy === key ? 700 : 400, transition: 'all 0.15s',
            }}>{label}</button>
          ))}
        </div>
      )}

      {/* ── Empty state ────────────────────────────────── */}
      {entries.length === 0 && !showForm && (
        <div style={{ textAlign: 'center', padding: '50px 20px 20px', color: 'var(--ios-label3)' }}>
          <div style={{ fontSize: 48, marginBottom: 14 }}>📋</div>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ios-label2)', marginBottom: 6 }}>尚無持倉紀錄</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>手動輸入或上傳券商截圖自動匯入</div>
          <button onClick={() => fileRef.current?.click()} style={{
            background: 'rgba(10,132,255,0.1)', border: '0.5px solid rgba(10,132,255,0.3)',
            borderRadius: 12, padding: '12px 28px', color: 'var(--ios-blue)', fontSize: 14, fontWeight: 600,
            cursor: 'pointer', display: 'inline-block',
          }}>📸 上傳持倉截圖</button>
        </div>
      )}

      {/* ── Position cards ─────────────────────────────── */}
      {sorted.map(({ id, p, curPrice, pnlPct, pnlAmt, cost, curVal, daysHeld, annReturn, stopLoss, takePrft }, idx) => {
        const color = pnlPct == null ? 'var(--ios-label)' : pnlPct >= 0 ? 'var(--ios-red)' : 'var(--ios-green)'
        const nearStop   = curPrice != null && curPrice <= stopLoss * 1.02  // within 2% of stop
        const nearTarget = curPrice != null && curPrice >= takePrft * 0.98  // within 2% of target
        return (
          <div key={id} style={{
            background: 'var(--ios-bg2)', borderRadius: 14, padding: '12px 14px', marginBottom: 8,
            boxShadow: nearStop ? '0 0 0 1.5px rgba(255,59,48,0.5)' : nearTarget ? '0 0 0 1.5px rgba(255,149,0,0.5)' : 'var(--shadow-card)',
            animation: `rowIn 0.3s ${idx * 40}ms cubic-bezier(0.22,1,0.36,1) both`,
          }}>
            {/* Alert banner */}
            {(nearStop || nearTarget) && (
              <div style={{
                fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 6, marginBottom: 8,
                background: nearStop ? 'rgba(255,59,48,0.12)' : 'rgba(255,149,0,0.12)',
                color: nearStop ? 'var(--ios-red)' : 'var(--ios-yellow)',
              }}>
                {nearStop ? `⚠️ 接近停損線 ${fmt(stopLoss)} 元` : `🎯 接近止盈目標 ${fmt(takePrft)} 元`}
              </div>
            )}

            {/* Title row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--ios-label)', marginRight: 8 }}>{id}</span>
                <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>{p.name}</span>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                {pnlPct != null ? (
                  <>
                    <div style={{ fontSize: 17, fontWeight: 700, color }}>{pnlPct >= 0 ? '+' : ''}{fmt(pnlPct)}%</div>
                    <div style={{ fontSize: 11, color }}>{pnlAmt >= 0 ? '+' : ''}{fmtNum(Math.round(pnlAmt))} 元</div>
                  </>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--ios-label4)' }}>無即時報價</div>
                )}
              </div>
            </div>

            {/* Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px 8px', fontSize: 11, color: 'var(--ios-label3)', marginBottom: 6 }}>
              <div>買入 <b style={{ color: 'var(--ios-label)' }}>{p.buyPrice}</b></div>
              <div>現價 <b style={{ color: curPrice ? color : 'var(--ios-label3)' }}>{curPrice ?? '—'}</b></div>
              <div>持有 <b style={{ color: 'var(--ios-label)' }}>{daysHeld ?? '—'}</b> 天</div>
              <div>張數 <b style={{ color: 'var(--ios-label)' }}>{(p.qty / 1000).toFixed(p.qty % 1000 === 0 ? 0 : 2)}</b></div>
              <div>成本 <b style={{ color: 'var(--ios-label)' }}>{fmtNum(Math.round(cost))}</b></div>
              <div>市值 <b style={{ color: 'var(--ios-label)' }}>{fmtNum(Math.round(curVal))}</b></div>
            </div>

            {/* Annualized return + stop/target hints */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 10, marginBottom: 6 }}>
              {annReturn != null && (
                <span style={{ background: annReturn >= 0 ? 'rgba(255,59,48,0.1)' : 'rgba(48,209,88,0.1)', color: annReturn >= 0 ? 'var(--ios-red)' : 'var(--ios-green)', padding: '2px 7px', borderRadius: 5, fontWeight: 600 }}>
                  年化 {annReturn >= 0 ? '+' : ''}{fmt(annReturn, 1)}%
                </span>
              )}
              <span style={{ background: 'rgba(255,59,48,0.08)', color: 'var(--ios-label3)', padding: '2px 7px', borderRadius: 5 }}>
                停損 {fmt(stopLoss)}
              </span>
              <span style={{ background: 'rgba(255,149,0,0.08)', color: 'var(--ios-label3)', padding: '2px 7px', borderRadius: 5 }}>
                目標 {fmt(takePrft)}
              </span>
            </div>

            {/* P&L bar */}
            {pnlPct != null && (
              <div style={{ height: 3, background: 'var(--ios-fill4)', borderRadius: 2, marginBottom: 8, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 2, background: color,
                  width: `${Math.min(100, Math.abs(pnlPct) * 4)}%`,
                  transition: 'width 0.5s cubic-bezier(0.34,1.56,0.64,1)',
                }} />
              </div>
            )}

            {p.note && (
              <div style={{ fontSize: 11, color: 'var(--ios-label3)', padding: '4px 8px', background: 'var(--ios-fill4)', borderRadius: 6, marginBottom: 8 }}>{p.note}</div>
            )}

            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button onClick={() => openEdit(id)} style={{ fontSize: 11, color: 'var(--ios-blue)', background: 'var(--ios-fill4)', border: 'none', borderRadius: 7, padding: '5px 14px', cursor: 'pointer' }}>編輯</button>
              <button onClick={() => handleDelete(id)} style={{ fontSize: 11, color: 'var(--ios-red)', background: 'var(--ios-fill4)', border: 'none', borderRadius: 7, padding: '5px 14px', cursor: 'pointer' }}>刪除</button>
            </div>
          </div>
        )
      })}

      {/* ── Add/Edit form ──────────────────────────────── */}
      {showForm && (
        <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '14px 16px', marginBottom: 12, boxShadow: 'var(--shadow-card)', animation: 'sheetIn 0.25s cubic-bezier(0.22,1,0.36,1) both' }}>
          <div style={{ fontSize: 11, color: 'var(--ios-blue)', fontWeight: 700, marginBottom: 12, letterSpacing: 0.8, textTransform: 'uppercase' }}>
            {editId ? '編輯持倉' : '新增持倉'}
          </div>
          {[
            { key: 'stock_id', label: '股票代號 *', ph: '例如 2330', disabled: !!editId },
            { key: 'name',     label: '股票名稱',   ph: '例如 台積電' },
            { key: 'buyPrice', label: '買入均價 (元) *', ph: '例如 950', type: 'number' },
            { key: 'qty',      label: '持有股數 *', ph: '例如 1000（= 1 張）', type: 'number' },
            { key: 'buyDate',  label: '買入日期',   ph: '', type: 'date' },
            { key: 'note',     label: '備注',       ph: '可選' },
          ].map(f => (
            <div key={f.key} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 4 }}>{f.label}</div>
              <input
                type={f.type || 'text'} value={form[f.key]} disabled={f.disabled} placeholder={f.ph}
                inputMode={f.type === 'number' ? 'decimal' : undefined}
                onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                style={{ ...inputStyle, background: f.disabled ? 'var(--ios-fill4)' : 'var(--ios-fill3)', color: f.disabled ? 'var(--ios-label3)' : 'var(--ios-label)' }}
              />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button onClick={() => { setShowForm(false); setEditId(null) }} style={{ flex: 1, background: 'var(--ios-fill4)', border: 'none', borderRadius: 10, padding: '11px', color: 'var(--ios-label2)', fontSize: 13, cursor: 'pointer' }}>取消</button>
            <button onClick={handleSave} style={{ flex: 2, background: 'var(--ios-blue)', border: 'none', borderRadius: 10, padding: '11px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>儲存</button>
          </div>
        </div>
      )}

      {/* ── Bottom action bar ──────────────────────────── */}
      {!showForm && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button onClick={openAdd} style={{
            flex: 3, background: 'var(--ios-fill4)', border: '0.5px solid var(--ios-sep)',
            borderRadius: 12, padding: '13px', color: 'var(--ios-blue)', fontSize: 14, fontWeight: 600,
            cursor: 'pointer', letterSpacing: 0.2,
          }}>＋ 新增持倉</button>
          <button onClick={() => fileRef.current?.click()} disabled={aiStatus === 'photo'} style={{
            flex: 2, background: 'var(--ios-fill4)', border: '0.5px solid var(--ios-sep)',
            borderRadius: 12, padding: '13px', color: aiStatus === 'photo' ? 'var(--ios-label3)' : 'var(--ios-label)',
            fontSize: 13, fontWeight: 600, cursor: aiStatus === 'photo' ? 'default' : 'pointer',
          }}>
            {aiStatus === 'photo' ? '分析中⋯' : '📸 截圖匯入'}
          </button>
        </div>
      )}
    </div>
  )
}
