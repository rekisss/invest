// 期貨籌碼 build-layer enrichment (read-only, no trading API).
//
// Mirrors the column-matching logic of the project's taiwan_futures.py
// (fetch_futures_institutional) but in JS, extended to all three institutions
// (外資 / 投信 / 自營商) and emitted as data.json.futuresChips for the frontend.
//
// Design goals:
//   • parseFuturesInstitutional() is a PURE function — fully unit-testable with a
//     mock FinMind payload, no network. FinMind's column names drift between plan
//     tiers, so we match by substring (exactly like the Python) rather than
//     hardcoding, making the parse robust even without live-API access.
//   • fetchFuturesChips() is fully guarded: any failure / missing token / empty
//     response returns null so the build never breaks and the frontend degrades
//     to the futures_net it already has.

const INSTITUTIONS = [
  { key: 'foreign', label: '外資', re: /外資|foreign/i },
  { key: 'trust',   label: '投信', re: /投信|investment trust/i },
  { key: 'dealer',  label: '自營', re: /自營|dealer/i },
]

const toNum = v => {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

// Given raw FinMind TaiwanFuturesInstitutionalInvestors rows, return a structured
// summary: latest-date net open interest (long−short) per institution + a history
// of the aggregate foreign net for the trend sparkline. Returns null when the rows
// carry nothing usable.
export function parseFuturesInstitutional(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null

  // Normalize keys to lowercase once.
  const norm = rows.map(r => {
    const o = {}
    for (const k of Object.keys(r)) o[k.toLowerCase().trim()] = r[k]
    return o
  })
  const cols = Object.keys(norm[0])
  const idCol = cols.find(c => c === 'institutional_investors' || c === 'identity_type' || c === 'name')
  if (!idCol) return null

  const longCol  = cols.find(c => c.includes('long')  && (c.includes('interest') || c.includes('balance')))
  const shortCol = cols.find(c => c.includes('short') && (c.includes('interest') || c.includes('balance')))
  const netCol   = cols.find(c => c.includes('net'))

  // net OI for a row: long−short when both present, else a direct net column.
  const rowNet = (row) => {
    if (longCol && shortCol) {
      const l = toNum(row[longCol]), s = toNum(row[shortCol])
      if (l == null && s == null) return null
      return (l || 0) - (s || 0)
    }
    return netCol ? toNum(row[netCol]) : null
  }
  const rowLong  = (row) => longCol ? toNum(row[longCol]) : null
  const rowShort = (row) => shortCol ? toNum(row[shortCol]) : null

  // Group by date → institution.
  const byDate = new Map()
  for (const row of norm) {
    const date = String(row.date || '').slice(0, 10)
    if (!date) continue
    const label = String(row[idCol] ?? '')
    const inst = INSTITUTIONS.find(i => i.re.test(label))
    if (!inst) continue
    if (!byDate.has(date)) byDate.set(date, {})
    byDate.get(date)[inst.key] = { net: rowNet(row), long: rowLong(row), short: rowShort(row) }
  }
  if (byDate.size === 0) return null

  const dates = [...byDate.keys()].sort()
  const asOf = dates[dates.length - 1]
  const latest = byDate.get(asOf)

  const institutions = INSTITUTIONS.map(i => ({
    key: i.key, label: i.label,
    net: latest[i.key]?.net ?? null,
    long: latest[i.key]?.long ?? null,
    short: latest[i.key]?.short ?? null,
  }))
  const nets = institutions.map(i => i.net).filter(n => n != null)
  const totalNet = nets.length ? nets.reduce((s, n) => s + n, 0) : null

  // Foreign net history (last 20 dates) for the trend line.
  const history = dates.slice(-20).map(d => ({ date: d, foreign_net: byDate.get(d).foreign?.net ?? null }))

  return { as_of: asOf, institutions, total_net: totalNet, history }
}

const round2 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100

// Given raw FinMind TaiwanFuturesDaily rows, return the latest day-session
// front-month close (front month = highest volume per date, mirroring
// taiwan_futures.py). Night/after-hours rows are excluded so the close pairs
// cleanly with the spot index close for basis. Returns null when unusable.
export function parseFuturesDaily(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const norm = rows.map(r => {
    const o = {}
    for (const k of Object.keys(r)) o[k.toLowerCase().trim()] = r[k]
    return o
  })
  const cols = Object.keys(norm[0])
  const closeCol = cols.find(c => c === 'close')
  if (!closeCol) return null
  const volCol = cols.find(c => c === 'volume' || c === 'trading_volume')
  const oiCol  = cols.find(c => c === 'open_interest' || c === 'open_interest_balance')
  const sessionCol = cols.find(c => c.includes('session') || c.includes('夜盤'))
  const isNight = row => {
    if (!sessionCol) return false
    const v = String(row[sessionCol] ?? '').toLowerCase()
    return v.includes('after') || v.includes('night') || v.includes('夜')
  }

  const day = norm.filter(r => !isNight(r) && r.date)
  if (day.length === 0) return null
  const asOf = day.map(r => String(r.date).slice(0, 10)).sort().slice(-1)[0]
  const rowsAsOf = day.filter(r => String(r.date).slice(0, 10) === asOf)
  // front month = highest volume among that date's contract rows
  rowsAsOf.sort((a, b) => (toNum(b[volCol]) ?? -Infinity) - (toNum(a[volCol]) ?? -Infinity))
  const front = rowsAsOf[0]
  const close = toNum(front[closeCol])
  if (close == null) return null
  return {
    as_of: asOf,
    close,
    volume: volCol ? toNum(front[volCol]) : null,
    open_interest: oiCol ? toNum(front[oiCol]) : null,
  }
}

// 期現價差(基差)= 期貨收盤 − 加權指數收盤。正值=正價差(市場偏多/期貨溢價),
// 負值=逆價差(避險買盤/期貨折價)。回 null 若任一輸入缺。
export function computeBasis(futuresClose, spotClose) {
  if (futuresClose == null || spotClose == null || spotClose === 0) return null
  const basis = futuresClose - spotClose
  return {
    futures_close: round2(futuresClose),
    spot_close: round2(spotClose),
    basis: round2(basis),
    basis_pct: round2(basis / spotClose * 100),
    kind: basis >= 0 ? '正價差' : '逆價差',
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// 台指期「籌碼面偏向」分數(純規則、確定性、可解釋)。**不是保證、不是下單訊號**——
// 只把手上的期貨籌碼(外資淨部位、期現價差、外資部位趨勢、夜盤)組合成一個 −100~+100
// 的偏多/偏空傾向,並逐項列出每個因子貢獻多少,讓使用者看得懂「為什麼偏這邊」。
//
// 每個因子先標準化到 [−1,1](多頭為正),乘權重加總,再對「有資料的因子」normalize,
// 缺資料的因子自動跳過(不強塞 0 稀釋)。門檻:≥+20 偏多、≤−20 偏空、之間中性。
const BIAS_FACTORS = [
  { key: 'foreign_oi', label: '外資期貨淨部位', weight: 0.40, scale: 60000,
    note: n => n < 0 ? `淨空 ${Math.abs(Math.round(n)).toLocaleString()} 口(偏空)` : `淨多 ${Math.round(n).toLocaleString()} 口(偏多)` },
  { key: 'basis', label: '期現價差', weight: 0.25, scale: 80,
    note: b => `${b >= 0 ? '正價差' : '逆價差'} ${b > 0 ? '+' : ''}${Math.round(b)} 點` },
  { key: 'oi_trend', label: '外資部位趨勢', weight: 0.20, scale: 15000,
    note: d => d > 0 ? `近日減空/加多(偏多動能)` : d < 0 ? `近日增空(偏空動能)` : '持平' },
  { key: 'night', label: '夜盤', weight: 0.15, scale: 150,
    note: c => `${c > 0 ? '+' : ''}${Math.round(c)} 點` },
]

// chips = futuresChips (institutions/basis/history);opts.nightChange 由 market_data 傳入。
// 回 null 若完全沒有可用因子。
export function computeFuturesBias(chips, opts = {}) {
  if (!chips || typeof chips !== 'object') return null
  const foreign = Array.isArray(chips.institutions) ? chips.institutions.find(i => i.key === 'foreign') : null
  const foreignNet = foreign && typeof foreign.net === 'number' ? foreign.net : null

  // 外資部位趨勢:最新 − 約 5 個交易日前(history 為 foreign_net 升冪)
  let oiTrend = null
  const hist = Array.isArray(chips.history) ? chips.history.filter(h => typeof h.foreign_net === 'number') : []
  if (hist.length >= 2) {
    const last = hist[hist.length - 1].foreign_net
    const backIdx = Math.max(0, hist.length - 6)
    oiTrend = last - hist[backIdx].foreign_net
  }

  const basis = chips.basis && typeof chips.basis.basis === 'number' ? chips.basis.basis : null
  const night = typeof opts.nightChange === 'number' ? opts.nightChange : null

  const raw = { foreign_oi: foreignNet, basis, oi_trend: oiTrend, night }
  const components = []
  let weighted = 0, wSum = 0
  for (const f of BIAS_FACTORS) {
    const v = raw[f.key]
    if (v == null) continue
    const r = clamp(v / f.scale, -1, 1)   // 標準化 [-1,1],多頭為正
    weighted += r * f.weight
    wSum += f.weight
    components.push({ key: f.key, label: f.label, raw_value: round2(v), signal: round2(r),
      contribution: round2(r * f.weight), detail: f.note(v) })
  }
  if (wSum === 0) return null

  const score = Math.round(weighted / wSum * 100)   // −100 ~ +100
  const label = score >= 20 ? '偏多' : score <= -20 ? '偏空' : '中性'

  // 極端淨空的軋空反轉警語(方向仍偏空,但提醒風險,不翻轉分數)
  let caution = null
  if (foreignNet != null && foreignNet <= -80000) caution = '外資極度淨空,一旦回補易軋空反彈,別重壓單邊'

  return { score, label, components, caution, factors_used: components.length }
}

// Guarded FinMind fetch. `fetchUrl` is injected so build-data.mjs reuses its own
// helper (and tests can stub it). Returns null on any failure — never throws.
//
// Token fallback: futures datasets aren't on every FinMind plan tier, and any one
// token can be rate-limited/exhausted. Accept a list (`tokens`) and try each until
// one returns usable institutional data — otherwise this whole feature silently
// stays blank in production even when other tokens would have worked. `token`
// (singular) is still accepted for back-compat.
// Also pulls TaiwanFuturesDaily (with the winning token) for the front-month close
// (期現價差); that second call is independently guarded so it never blocks chips.
export async function fetchFuturesChips({ token, tokens, fetchUrl, endDate, startDate, code = 'TX' } = {}) {
  const list = [...(Array.isArray(tokens) ? tokens : []), token]
    .map(t => (t || '').trim()).filter(Boolean)
  const seen = new Set()
  const uniq = list.filter(t => (seen.has(t) ? false : seen.add(t)))
  if (uniq.length === 0 || typeof fetchUrl !== 'function') return null
  const end = endDate || new Date().toISOString().slice(0, 10)
  const start = startDate || new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10)
  const mkUrl = (dataset, tk) => `https://api.finmindtrade.com/api/v4/data?token=${encodeURIComponent(tk)}`
    + `&dataset=${dataset}&data_id=${encodeURIComponent(code)}&start_date=${start}&end_date=${end}`

  let chips = null, winToken = null
  for (const tk of uniq) {
    try {
      const json = JSON.parse(await fetchUrl(mkUrl('TaiwanFuturesInstitutionalInvestors', tk), 12000))
      if (json.status === 200 && Array.isArray(json.data)) {
        const c = parseFuturesInstitutional(json.data)
        if (c) { chips = c; winToken = tk; break }
      }
    } catch { /* try next token */ }
  }
  if (!chips) return null

  // Best-effort front-month daily close (for basis). Never fails the whole result.
  try {
    const json = JSON.parse(await fetchUrl(mkUrl('TaiwanFuturesDaily', winToken), 12000))
    if (json.status === 200 && Array.isArray(json.data)) {
      const daily = parseFuturesDaily(json.data)
      if (daily) chips.daily = daily
    }
  } catch { /* keep chips without daily */ }
  return chips
}
