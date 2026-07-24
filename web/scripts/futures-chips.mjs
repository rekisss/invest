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

// Guarded FinMind fetch. `fetchUrl` is injected so build-data.mjs reuses its own
// helper (and tests can stub it). Returns null on any failure — never throws.
// Also pulls TaiwanFuturesDaily for the front-month close (for 期現價差); that
// second call is independently guarded so it never blocks the institutional data.
export async function fetchFuturesChips({ token, fetchUrl, endDate, startDate, code = 'TX' } = {}) {
  if (!token || typeof fetchUrl !== 'function') return null
  const end = endDate || new Date().toISOString().slice(0, 10)
  const start = startDate || new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10)
  const mkUrl = dataset => `https://api.finmindtrade.com/api/v4/data?token=${encodeURIComponent(token)}`
    + `&dataset=${dataset}&data_id=${encodeURIComponent(code)}&start_date=${start}&end_date=${end}`

  let chips = null
  try {
    const json = JSON.parse(await fetchUrl(mkUrl('TaiwanFuturesInstitutionalInvestors'), 12000))
    if (json.status === 200 && Array.isArray(json.data)) chips = parseFuturesInstitutional(json.data)
  } catch { chips = null }
  if (!chips) return null

  // Best-effort front-month daily close (for basis). Never fails the whole result.
  try {
    const json = JSON.parse(await fetchUrl(mkUrl('TaiwanFuturesDaily'), 12000))
    if (json.status === 200 && Array.isArray(json.data)) {
      const daily = parseFuturesDaily(json.data)
      if (daily) chips.daily = daily
    }
  } catch { /* keep chips without daily */ }
  return chips
}
