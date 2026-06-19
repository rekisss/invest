import { useState, useEffect } from 'react'

const STORAGE_KEY = 'tw_portfolio_positions'

function loadPositions() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} }
}
function savePositions(p) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)) } catch {}
}

function getCurrentPrice(stockId, data) {
  if (!data) return null
  const allStocks = [...(data.top_stocks || []), ...(data.scan_results || [])]
  const match = allStocks.find(s => String(s.stock_id) === String(stockId))
  return match?.close ?? null
}

function fmt(v, d = 2) { return v == null || isNaN(v) ? '—' : Number(v).toFixed(d) }
function fmtNum(v) { return v == null ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 0 }) }

const EMPTY_FORM = { stock_id: '', name: '', buyPrice: '', qty: '', buyDate: '', note: '' }

const inputStyle = {
  width: '100%', background: 'var(--ios-fill3)', border: '0.5px solid var(--ios-sep)',
  borderRadius: 8, padding: '8px 10px', color: 'var(--ios-label)', fontSize: 13,
  boxSizing: 'border-box', outline: 'none', WebkitAppearance: 'none',
}

export default function Portfolio({ data }) {
  const [positions, setPositions] = useState(loadPositions)
  const [showForm, setShowForm]   = useState(false)
  const [editId, setEditId]       = useState(null)
  const [form, setForm]           = useState(EMPTY_FORM)
  const [sortBy, setSortBy]       = useState('pnlPct') // pnlPct | daysHeld | cost

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

  const entries = Object.entries(positions).map(([id, p]) => {
    const curPrice = getCurrentPrice(id, data)
    const pnlPct = curPrice ? (curPrice - p.buyPrice) / p.buyPrice * 100 : null
    const pnlAmt = curPrice ? (curPrice - p.buyPrice) * p.qty : null
    const cost = p.buyPrice * p.qty
    const today = new Date()
    const buyDate = p.buyDate ? new Date(p.buyDate) : null
    const daysHeld = buyDate ? Math.max(0, Math.floor((today - buyDate) / 86400000)) : null
    return { id, p, curPrice, pnlPct, pnlAmt, cost, daysHeld }
  })

  const sorted = [...entries].sort((a, b) => {
    if (sortBy === 'pnlPct') return (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity)
    if (sortBy === 'daysHeld') return (b.daysHeld ?? -1) - (a.daysHeld ?? -1)
    return b.cost - a.cost
  })

  const totalCost  = entries.reduce((s, e) => s + e.cost, 0)
  const totalValue = entries.reduce((s, e) => s + (e.curPrice ?? e.p.buyPrice) * e.p.qty, 0)
  const totalPnL   = totalValue - totalCost
  const totalPct   = totalCost > 0 ? totalPnL / totalCost * 100 : 0
  const priceCount = entries.filter(e => e.curPrice != null).length

  return (
    <div style={{ padding: '0 14px 80px', overflowY: 'auto', height: '100%', WebkitOverflowScrolling: 'touch' }}>

      {/* ── Summary card ──────────────────────────────── */}
      {entries.length > 0 && (
        <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '14px 16px', marginBottom: 12, boxShadow: 'var(--shadow-card)' }}>
          <div style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, letterSpacing: 0.8, marginBottom: 8, textTransform: 'uppercase' }}>
            持倉總覽
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: 26, fontWeight: 700, color: totalPnL >= 0 ? 'var(--ios-red)' : 'var(--ios-green)', letterSpacing: '-0.5px' }}>
                {totalPnL >= 0 ? '+' : ''}{fmtNum(totalPnL)} 元
              </div>
              <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 3 }}>
                成本 {fmtNum(totalCost)}｜市值 {fmtNum(totalValue)}
                {priceCount < entries.length && <span style={{ color: 'var(--ios-yellow)', marginLeft: 6 }}>{entries.length - priceCount} 檔無報價</span>}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: totalPct >= 0 ? 'var(--ios-red)' : 'var(--ios-green)' }}>
                {totalPct >= 0 ? '+' : ''}{fmt(totalPct)}%
              </div>
              <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 2 }}>{entries.length} 檔持股</div>
            </div>
          </div>
          {/* P&L bar */}
          <div style={{ height: 4, background: 'var(--ios-fill4)', borderRadius: 2, marginTop: 10, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 2,
              background: totalPct >= 0 ? 'var(--ios-red)' : 'var(--ios-green)',
              width: `${Math.min(100, Math.abs(totalPct) * 5)}%`,
              transition: 'width 0.5s cubic-bezier(0.34,1.56,0.64,1)',
            }} />
          </div>
        </div>
      )}

      {/* ── Sort bar ──────────────────────────────────── */}
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

      {/* ── Empty state ───────────────────────────────── */}
      {entries.length === 0 && !showForm && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--ios-label3)' }}>
          <div style={{ fontSize: 48, marginBottom: 14 }}>📋</div>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ios-label2)', marginBottom: 6 }}>尚無持倉紀錄</div>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>點「＋ 新增持倉」開始追蹤損益</div>
        </div>
      )}

      {/* ── Position cards ────────────────────────────── */}
      {sorted.map(({ id, p, curPrice, pnlPct, pnlAmt, cost, daysHeld }, idx) => {
        const color = pnlPct == null ? 'var(--ios-label)' : pnlPct >= 0 ? 'var(--ios-red)' : 'var(--ios-green)'
        return (
          <div key={id} style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '12px 14px', marginBottom: 8, boxShadow: 'var(--shadow-card)', animation: `rowIn 0.3s ${idx * 40}ms cubic-bezier(0.22,1,0.36,1) both` }}>
            {/* Title row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--ios-label)', marginRight: 8 }}>{id}</span>
                <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>{p.name}</span>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                {pnlPct != null ? (
                  <>
                    <div style={{ fontSize: 16, fontWeight: 700, color }}>{pnlPct >= 0 ? '+' : ''}{fmt(pnlPct)}%</div>
                    <div style={{ fontSize: 11, color }}>{pnlAmt >= 0 ? '+' : ''}{fmtNum(pnlAmt)} 元</div>
                  </>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--ios-label4)' }}>無即時報價</div>
                )}
              </div>
            </div>

            {/* Stats row */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--ios-label3)', marginBottom: pnlPct != null ? 6 : 0 }}>
              <span>買 <b style={{ color: 'var(--ios-label)' }}>{p.buyPrice}</b></span>
              {curPrice != null && <span>現 <b style={{ color }}>{curPrice}</b></span>}
              <span>{(p.qty / 1000).toFixed(p.qty % 1000 === 0 ? 0 : 2)} 張（{fmtNum(p.qty)} 股）</span>
              {daysHeld != null && <span>持 <b style={{ color: 'var(--ios-label)' }}>{daysHeld}</b> 天</span>}
              <span>成本 {fmtNum(cost)}</span>
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

      {/* ── Add/Edit form ─────────────────────────────── */}
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
            { key: 'note',     label: '備注',       ph: '可選，例如：技術突破、法人買超' },
          ].map(f => (
            <div key={f.key} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginBottom: 4 }}>{f.label}</div>
              <input
                type={f.type || 'text'}
                value={form[f.key]}
                disabled={f.disabled}
                placeholder={f.ph}
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

      {/* ── Add button ────────────────────────────────── */}
      {!showForm && (
        <button onClick={openAdd} style={{
          width: '100%', background: 'var(--ios-fill4)', border: '0.5px solid var(--ios-sep)',
          borderRadius: 12, padding: '13px', color: 'var(--ios-blue)', fontSize: 15, fontWeight: 600,
          cursor: 'pointer', marginTop: 6, letterSpacing: 0.2,
        }}>＋ 新增持倉</button>
      )}

      <style>{`
        @keyframes rowIn { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
        @keyframes sheetIn { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }
      `}</style>
    </div>
  )
}
