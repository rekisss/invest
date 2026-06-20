import { useState, useMemo, useEffect } from 'react'

const STORAGE_KEY = 'tw_portfolio_positions'

function loadPositions() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} }
}
function savePositions(p) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)) } catch {}
}

// Rough 上市/上櫃 split by stock-id range — picks which Yahoo suffix to try first.
function isOTC(stockId) {
  const n = parseInt(String(stockId), 10)
  return (n >= 4200 && n <= 4999) || (n >= 5000 && n <= 5999) ||
         (n >= 6000 && n <= 6999) || (n >= 8000 && n <= 8999) || (n >= 9200 && n <= 9999)
}

// Find the most recent scan object that actually has stock rows.
function latestScan(data) {
  if (!data?.scans) return null
  const dates = Object.keys(data.scans).sort().reverse()
  for (const d of dates) {
    const s = data.scans[d]
    if (s && ((s.top_stocks && s.top_stocks.length) || (s.filter_stocks && s.filter_stocks.length))) return s
  }
  return null
}

// All searchable scan rows (top_stocks rich + filter_stocks slim), latest scan + aggregate.
function scanRows(data) {
  const s = latestScan(data)
  return [
    ...(data?.aggregateLatest?.top_stocks || []),
    ...(s?.top_stocks || []),
    ...(s?.filter_stocks || []),
  ]
}

function getScanClose(stockId, data) {
  const m = scanRows(data).find(s => String(s.stock_id) === String(stockId))
  return m?.close ?? null
}
function getScanInfo(stockId, data) {
  return scanRows(data).find(s => String(s.stock_id) === String(stockId)) ?? null
}

function fmt(v, d = 2) { return v == null || isNaN(v) ? '—' : Number(v).toFixed(d) }
function fmtNum(v) { return v == null ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 0 }) }

const EMPTY_FORM = { stock_id: '', name: '', buyPrice: '', qty: '', buyDate: '', note: '' }
const PALETTE = ['#0a84ff','#30d158','#ff9f0a','#ff453a','#bf5af2','#64d2ff','#ffd60a','#ff6961','#34c759','#5e5ce6']
const inputStyle = {
  width: '100%', background: 'var(--ios-fill3)', border: '0.5px solid var(--ios-sep)',
  borderRadius: 8, padding: '8px 10px', color: 'var(--ios-label)', fontSize: 13,
  boxSizing: 'border-box', outline: 'none', WebkitAppearance: 'none',
}

// ── Donut chart ───────────────────────────────────────────────────────────────
function DonutChart({ slices }) {
  const total = slices.reduce((s, x) => s + x.value, 0)
  if (total === 0 || slices.length < 2) return null
  const R = 52, cx = 64, cy = 64, stroke = 22
  let angle = -Math.PI / 2
  const paths = slices.map((s, i) => {
    const pct = s.value / total
    const span = pct * 2 * Math.PI
    const x1 = cx + R * Math.cos(angle)
    const y1 = cy + R * Math.sin(angle)
    angle += span
    const x2 = cx + R * Math.cos(angle)
    const y2 = cy + R * Math.sin(angle)
    const large = span > Math.PI ? 1 : 0
    return { d: `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2}`, color: s.color, pct, label: s.label }
  })
  return (
    <svg width={128} height={128} viewBox="0 0 128 128" style={{ flexShrink: 0 }}>
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill="none" stroke={p.color} strokeWidth={stroke}
          strokeLinecap="butt" style={{ opacity: 0.9 }} />
      ))}
      <circle cx={cx} cy={cy} r={R - stroke / 2 - 1} fill="var(--ios-bg2)" />
    </svg>
  )
}

// ── Scan signal badge ─────────────────────────────────────────────────────────
function ScanBadge({ scan }) {
  if (!scan) return null
  const score = scan.entry_score != null ? Math.round(scan.entry_score) : null
  const signal = scan.entry_signal
  const grade = scan.grade
  if (signal) {
    return (
      <span style={{ fontSize: 10, fontWeight: 700, background: 'rgba(48,209,88,0.15)', color: '#30d158', padding: '2px 7px', borderRadius: 5 }}>
        ✅ 掃描入榜{score ? ` ${score}分` : ''}{grade ? ` [${grade}]` : ''}
      </span>
    )
  }
  if (score != null) {
    const weak = score < 500
    return (
      <span style={{ fontSize: 10, fontWeight: 700, background: weak ? 'rgba(255,69,58,0.12)' : 'rgba(255,159,10,0.12)', color: weak ? 'var(--ios-red)' : 'var(--ios-yellow)', padding: '2px 7px', borderRadius: 5 }}>
        {weak ? '⚠️ 訊號轉弱' : '📊 觀察中'}{score ? ` ${score}分` : ''}
      </span>
    )
  }
  return null
}

// ── Cost averaging calculator ─────────────────────────────────────────────────
function CostAvgCalc({ buyPrice, qty }) {
  const [avgQty, setAvgQty] = useState('')
  const [avgPrice, setAvgPrice] = useState('')
  const bp = Number(buyPrice), q = Number(qty), aq = Number(avgQty), ap = Number(avgPrice)
  const newAvg = (bp > 0 && q > 0 && aq > 0 && ap > 0)
    ? (bp * q + ap * aq) / (q + aq) : null
  return (
    <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--ios-fill4)', borderRadius: 10 }}>
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, marginBottom: 8, letterSpacing: 0.5 }}>成本攤平試算</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 3 }}>再買股數</div>
          <input type="number" value={avgQty} placeholder="1000" inputMode="decimal"
            onChange={e => setAvgQty(e.target.value)}
            style={{ ...inputStyle, fontSize: 12, padding: '6px 8px' }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 3 }}>攤平價格</div>
          <input type="number" value={avgPrice} placeholder="價格" inputMode="decimal"
            onChange={e => setAvgPrice(e.target.value)}
            style={{ ...inputStyle, fontSize: 12, padding: '6px 8px' }} />
        </div>
      </div>
      {newAvg != null && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ios-label2)', display: 'flex', gap: 12 }}>
          <span>攤平後成本 <b style={{ color: 'var(--ios-blue)', fontSize: 14 }}>{fmt(newAvg)} 元</b></span>
          <span style={{ color: 'var(--ios-label3)' }}>{fmtNum(q + aq)} 股</span>
        </div>
      )}
    </div>
  )
}

// Fetch latest price from Yahoo Finance for a Taiwan stock.
// Tries .TW (上市) then .TWO (上櫃). Returns last close or null.
async function fetchYahooPrice(stockId) {
  const suffixes = isOTC(stockId) ? ['.TWO', '.TW'] : ['.TW', '.TWO']
  for (const sfx of suffixes) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${stockId}${sfx}?range=5d&interval=1d`
      const r = await fetch(url)
      if (!r.ok) continue
      const j = await r.json()
      const res = j?.chart?.result?.[0]
      const closes = (res?.indicators?.quote?.[0]?.close || []).filter(v => v != null)
      const live = res?.meta?.regularMarketPrice
      const last = live ?? (closes.length ? closes[closes.length - 1] : null)
      if (last != null && last > 0) return Math.round(last * 100) / 100
    } catch { /* try next suffix */ }
  }
  return null
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Portfolio({ data }) {
  const [positions, setPositions] = useState(loadPositions)
  const [showForm, setShowForm]   = useState(false)
  const [editId, setEditId]       = useState(null)
  const [form, setForm]           = useState(EMPTY_FORM)
  const [sortBy, setSortBy]       = useState('pnlPct')
  const [showChart, setShowChart] = useState(true)
  const [livePrices, setLivePrices] = useState({})   // { stockId: price } from Yahoo
  const [priceLoading, setPriceLoading] = useState(false)

  // Fetch live prices from Yahoo whenever the set of held stocks changes.
  const posKey = Object.keys(positions).sort().join(',')
  useEffect(() => {
    const ids = Object.keys(positions)
    if (ids.length === 0) { setLivePrices({}); return }
    let cancelled = false
    setPriceLoading(true)
    Promise.all(ids.map(async id => [id, await fetchYahooPrice(id)]))
      .then(pairs => {
        if (cancelled) return
        const next = {}
        for (const [id, px] of pairs) if (px != null) next[id] = px
        setLivePrices(next)
      })
      .finally(() => { if (!cancelled) setPriceLoading(false) })
    return () => { cancelled = true }
  }, [posKey])

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

  // ── Computed entries ──────────────────────────────────────────────────────
  const entries = useMemo(() => Object.entries(positions).map(([id, p], i) => {
    const curPrice  = livePrices[id] ?? getScanClose(id, data)
    const scan      = getScanInfo(id, data)
    const pnlPct    = curPrice ? (curPrice - p.buyPrice) / p.buyPrice * 100 : null
    const pnlAmt    = curPrice ? (curPrice - p.buyPrice) * p.qty : null
    const cost      = p.buyPrice * p.qty
    const curVal    = (curPrice ?? p.buyPrice) * p.qty
    const buyDate   = p.buyDate ? new Date(p.buyDate) : null
    const daysHeld  = buyDate ? Math.max(0, Math.floor((Date.now() - buyDate) / 86400000)) : null
    const annReturn = (pnlPct != null && daysHeld != null && daysHeld >= 7) ? pnlPct / daysHeld * 365 : null
    const stopLoss  = p.buyPrice * 0.92
    const takePrft  = p.buyPrice * 1.15
    return { id, p, curPrice, scan, pnlPct, pnlAmt, cost, curVal, daysHeld, annReturn, stopLoss, takePrft, color: PALETTE[i % PALETTE.length] }
  }), [positions, data, livePrices])

  const sorted = useMemo(() => [...entries].sort((a, b) => {
    if (sortBy === 'pnlPct') return (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity)
    if (sortBy === 'daysHeld') return (b.daysHeld ?? -1) - (a.daysHeld ?? -1)
    return b.cost - a.cost
  }), [entries, sortBy])

  const totalCost  = entries.reduce((s, e) => s + e.cost, 0)
  const totalValue = entries.reduce((s, e) => s + e.curVal, 0)
  const totalPnL   = totalValue - totalCost
  const totalPct   = totalCost > 0 ? totalPnL / totalCost * 100 : 0
  const priceCount = entries.filter(e => e.curPrice != null).length
  const alertCount = entries.filter(e => e.scan && !e.scan.entry_signal && e.scan.entry_score != null && e.scan.entry_score < 500).length

  const donutSlices = entries.map(e => ({ label: e.id, value: e.curVal, color: e.color }))

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '0 14px 80px', overflowY: 'auto', height: '100%', WebkitOverflowScrolling: 'touch' }}>
      <style>{`
        @keyframes rowIn   { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
        @keyframes sheetIn { from { opacity:0; transform:translateY(16px) } to { opacity:1; transform:translateY(0) } }
      `}</style>

      {/* ── Summary card ─────────────────────────────── */}
      {entries.length > 0 && (
        <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '14px 16px', marginBottom: 12, boxShadow: 'var(--shadow-card)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase' }}>持倉總覽</div>
            <button onClick={() => setShowChart(c => !c)} style={{ fontSize: 10, color: 'var(--ios-blue)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}>
              {showChart ? '隱藏圖表' : '顯示圖表'}
            </button>
          </div>

          {showChart && entries.length >= 2 && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <DonutChart slices={donutSlices} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {entries.map(e => (
                  <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: e.color, flexShrink: 0 }} />
                    <span style={{ color: 'var(--ios-label2)', flex: 1 }}>{e.id} {e.p.name}</span>
                    <span style={{ color: 'var(--ios-label3)', fontWeight: 600 }}>
                      {totalValue > 0 ? (e.curVal / totalValue * 100).toFixed(1) : '—'}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700, color: totalPnL >= 0 ? 'var(--ios-red)' : 'var(--ios-green)', letterSpacing: '-0.5px', lineHeight: 1.1 }}>
                {totalPnL >= 0 ? '+' : ''}{fmtNum(Math.round(totalPnL))} 元
              </div>
              <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 4 }}>
                成本 {fmtNum(Math.round(totalCost))}｜市值 {fmtNum(Math.round(totalValue))}
                {priceCount < entries.length && (
                  <span style={{ color: 'var(--ios-yellow)', marginLeft: 6 }}>
                    {priceLoading ? '報價載入中…' : `${entries.length - priceCount} 檔無報價`}
                  </span>
                )}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: totalPct >= 0 ? 'var(--ios-red)' : 'var(--ios-green)' }}>
                {totalPct >= 0 ? '+' : ''}{fmt(totalPct)}%
              </div>
              <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 2 }}>{entries.length} 檔</div>
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

          {alertCount > 0 && (
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ios-red)', background: 'rgba(255,69,58,0.1)', borderRadius: 7, padding: '6px 10px', fontWeight: 600 }}>
              ⚠️ {alertCount} 檔持股訊號轉弱，請向下查看
            </div>
          )}
        </div>
      )}

      {/* ── Sort bar ─────────────────────────────────── */}
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

      {/* ── Empty state ──────────────────────────────── */}
      {entries.length === 0 && !showForm && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--ios-label3)' }}>
          <div style={{ fontSize: 48, marginBottom: 14 }}>📋</div>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ios-label2)', marginBottom: 6 }}>尚無持倉紀錄</div>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>點「＋ 新增持倉」開始追蹤損益</div>
        </div>
      )}

      {/* ── Position cards ───────────────────────────── */}
      {sorted.map(({ id, p, curPrice, scan, pnlPct, pnlAmt, cost, curVal, daysHeld, annReturn, stopLoss, takePrft, color }, idx) => {
        const pnlColor   = pnlPct == null ? 'var(--ios-label)' : pnlPct >= 0 ? 'var(--ios-red)' : 'var(--ios-green)'
        const nearStop   = curPrice != null && curPrice <= stopLoss * 1.02
        const nearTarget = curPrice != null && curPrice >= takePrft * 0.98
        const scanWeak   = scan && !scan.entry_signal && scan.entry_score != null && scan.entry_score < 500
        const borderColor = nearStop ? 'rgba(255,69,58,0.55)' : scanWeak ? 'rgba(255,69,58,0.3)' : nearTarget ? 'rgba(255,149,0,0.5)' : 'transparent'
        return (
          <div key={id} style={{
            background: 'var(--ios-bg2)', borderRadius: 14, padding: '12px 14px', marginBottom: 8,
            boxShadow: (nearStop || nearTarget || scanWeak) ? `0 0 0 1.5px ${borderColor}` : 'var(--shadow-card)',
            animation: `rowIn 0.3s ${idx * 40}ms cubic-bezier(0.22,1,0.36,1) both`,
          }}>
            {/* Alert banner */}
            {(nearStop || nearTarget) && (
              <div style={{ fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 6, marginBottom: 8,
                background: nearStop ? 'rgba(255,69,58,0.12)' : 'rgba(255,149,0,0.12)',
                color: nearStop ? 'var(--ios-red)' : 'var(--ios-yellow)',
              }}>
                {nearStop ? `⚠️ 接近停損線 ${fmt(stopLoss)} 元` : `🎯 接近止盈目標 ${fmt(takePrft)} 元`}
              </div>
            )}

            {/* Title row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 10, height: 10, borderRadius: 3, background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--ios-label)' }}>{id}</span>
                <span style={{ fontSize: 13, color: 'var(--ios-label2)' }}>{p.name}</span>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                {pnlPct != null ? (
                  <>
                    <div style={{ fontSize: 17, fontWeight: 700, color: pnlColor }}>{pnlPct >= 0 ? '+' : ''}{fmt(pnlPct)}%</div>
                    <div style={{ fontSize: 11, color: pnlColor }}>{pnlAmt >= 0 ? '+' : ''}{fmtNum(Math.round(pnlAmt))} 元</div>
                  </>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--ios-label4)' }}>{priceLoading ? '報價載入中…' : '無即時報價'}</div>
                )}
              </div>
            </div>

            {/* Scan badge */}
            <div style={{ marginBottom: 6 }}>
              <ScanBadge scan={scan} />
            </div>

            {/* Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px 8px', fontSize: 11, color: 'var(--ios-label3)', marginBottom: 6 }}>
              <div>買入 <b style={{ color: 'var(--ios-label)' }}>{p.buyPrice}</b></div>
              <div>現價 <b style={{ color: curPrice ? pnlColor : 'var(--ios-label3)' }}>{curPrice ?? '—'}</b></div>
              <div>持有 <b style={{ color: 'var(--ios-label)' }}>{daysHeld ?? '—'}</b> 天</div>
              <div>張數 <b style={{ color: 'var(--ios-label)' }}>{(p.qty / 1000).toFixed(p.qty % 1000 === 0 ? 0 : 2)}</b></div>
              <div>成本 <b style={{ color: 'var(--ios-label)' }}>{fmtNum(Math.round(cost))}</b></div>
              <div>市值 <b style={{ color: 'var(--ios-label)' }}>{fmtNum(Math.round(curVal))}</b></div>
            </div>

            {/* Tags */}
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', fontSize: 10, marginBottom: 6 }}>
              {annReturn != null && (
                <span style={{ background: annReturn >= 0 ? 'rgba(255,59,48,0.1)' : 'rgba(48,209,88,0.1)', color: annReturn >= 0 ? 'var(--ios-red)' : 'var(--ios-green)', padding: '2px 7px', borderRadius: 5, fontWeight: 600 }}>
                  年化 {annReturn >= 0 ? '+' : ''}{fmt(annReturn, 1)}%
                </span>
              )}
              <span style={{ background: 'rgba(255,59,48,0.07)', color: 'var(--ios-label3)', padding: '2px 7px', borderRadius: 5 }}>
                停損 {fmt(stopLoss)}
              </span>
              <span style={{ background: 'rgba(255,149,0,0.07)', color: 'var(--ios-label3)', padding: '2px 7px', borderRadius: 5 }}>
                目標 {fmt(takePrft)}
              </span>
              {totalValue > 0 && (
                <span style={{ background: `${color}18`, color, padding: '2px 7px', borderRadius: 5, fontWeight: 600 }}>
                  占比 {(curVal / totalValue * 100).toFixed(1)}%
                </span>
              )}
            </div>

            {/* P&L bar */}
            {pnlPct != null && (
              <div style={{ height: 3, background: 'var(--ios-fill4)', borderRadius: 2, marginBottom: 8, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 2, background: pnlColor,
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

      {/* ── Add/Edit form ────────────────────────────── */}
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

          {/* Cost averaging calculator — shown when editing or when buyPrice+qty are filled */}
          {(form.buyPrice && form.qty) && (
            <CostAvgCalc buyPrice={form.buyPrice} qty={form.qty} />
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={() => { setShowForm(false); setEditId(null) }} style={{ flex: 1, background: 'var(--ios-fill4)', border: 'none', borderRadius: 10, padding: '11px', color: 'var(--ios-label2)', fontSize: 13, cursor: 'pointer' }}>取消</button>
            <button onClick={handleSave} style={{ flex: 2, background: 'var(--ios-blue)', border: 'none', borderRadius: 10, padding: '11px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>儲存</button>
          </div>
        </div>
      )}

      {/* ── Add button ───────────────────────────────── */}
      {!showForm && (
        <button onClick={openAdd} style={{
          width: '100%', background: 'var(--ios-fill4)', border: '0.5px solid var(--ios-sep)',
          borderRadius: 12, padding: '13px', color: 'var(--ios-blue)', fontSize: 15, fontWeight: 600,
          cursor: 'pointer', marginTop: 6, letterSpacing: 0.2,
        }}>＋ 新增持倉</button>
      )}
    </div>
  )
}
