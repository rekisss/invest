import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import https from 'https'
import http from 'http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAN_DIR = resolve(__dirname, '../../output/full_scan')
const PRED_FILE = resolve(__dirname, '../../output/prediction_latest.json')
const AGG_FILE  = resolve(__dirname, '../../output/aggregate_latest.json')
const PUBLIC_DIR = resolve(__dirname, '../public')
const OUTPUT_FILE = join(PUBLIC_DIR, 'data.json')
const TOP_N = 50
const MAX_DATES = 30
const MIN_VALID_STOCKS = 100   // fewer than this = very incomplete scan, skip as primary date (partial scans still shown)

// ── CSV parser ──────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const result = []
  let current = '', inQuotes = false
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ',' && !inQuotes) { result.push(current); current = '' }
    else current += ch
  }
  result.push(current)
  return result
}
function parseCSV(content) {
  content = content.replace(/^﻿/, '').replace(/\r/g, '')
  const lines = content.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = parseCSVLine(lines[0])
  return lines.slice(1).map(line => {
    const values = parseCSVLine(line)
    const obj = {}
    headers.forEach((h, i) => { obj[h.trim()] = (values[i] ?? '').trim() })
    return obj
  }).filter(row => row.stock_id)
}
function toNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n }
function toBool(v) { return v === 'True' || v === 'true' || v === '1' }

// ── HTTP fetch helper ────────────────────────────────────────────────────────
function fetchUrl(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject)
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
  })
}

function postJson(url, body, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const parsed = new URL(url)
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }
    const req = https.request(opts, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ── RSS parser ───────────────────────────────────────────────────────────────
function parseRSS(xml) {
  const items = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1]
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/${tag}>`)
      const match = r.exec(block)
      return match ? match[1].trim() : ''
    }
    const title = get('title').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    const link = get('link') || get('guid')
    const pubDate = get('pubDate')
    const source = (() => { const s = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block); return s ? s[1].trim() : '' })()
    const description = get('description').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").slice(0, 300)
    if (title && link) items.push({ title, url: link, source, published: pubDate, summary: description })
  }
  return items
}

// ── Read news corpus ─────────────────────────────────────────────────────────
function readNewsCorpus() {
  const corpusFile = resolve(__dirname, '../../output/news_corpus.json')
  if (!existsSync(corpusFile)) return []
  try {
    const data = JSON.parse(readFileSync(corpusFile, 'utf-8'))
    const cutoff = new Date(Date.now() - 3 * 86400 * 1000)
    const articles = (data.articles || []).filter(a => {
      if (!a.published_at) return true
      try { return new Date(a.published_at) > cutoff } catch { return true }
    })
    console.log(`  Corpus: ${articles.length} articles (updated ${data.updated_at?.slice(0,16) || '?'})`)
    return articles.slice(0, 300)
  } catch (e) {
    console.warn('  Corpus read failed:', e.message)
    return []
  }
}

// ── Fetch news (fallback if no corpus) ───────────────────────────────────────
async function fetchNews() {
  const queries = [
    { q: '台灣股市 大盤', category: 'market', label: '大盤' },
    { q: '台積電 2330', category: 'tsmc', label: '台積電' },
    { q: '外資 期貨 台指', category: 'institutional', label: '外資法人' },
    { q: '美股 那斯達克 費半', category: 'us', label: '美股' },
    { q: '半導體 AI 科技股', category: 'tech', label: '科技半導體' },
  ]
  const allNews = []
  for (const { q, category, label } of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`
      const xml = await fetchUrl(url)
      const items = parseRSS(xml).slice(0, 6).map(item => ({ ...item, category, label }))
      allNews.push(...items)
      console.log(`  News [${label}]: ${items.length} items`)
    } catch (e) {
      console.warn(`  News [${label}] failed: ${e.message}`)
    }
  }
  // Deduplicate by title similarity
  const seen = new Set()
  return allNews.filter(item => {
    const key = item.title.slice(0, 30)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0)).slice(0, 40)
}

// ── Read aggregate latest JSON ───────────────────────────────────────────────
function readAggregateLatest() {
  if (!existsSync(AGG_FILE)) return null
  try {
    const data = JSON.parse(readFileSync(AGG_FILE, 'utf-8'))
    if (!data.date || !data.top_stocks) return null
    console.log(`  Aggregate JSON: date=${data.date}, scanned=${data.total_scanned}, top=${data.top_stocks.length}`)
    return data
  } catch (e) {
    console.warn('  Aggregate JSON read failed:', e.message)
    return null
  }
}

// ── Read prediction ──────────────────────────────────────────────────────────
function readPrediction() {
  if (!existsSync(PRED_FILE)) return null
  try {
    return JSON.parse(readFileSync(PRED_FILE, 'utf-8'))
  } catch { return null }
}

function readPredictionHistory() {
  const histFile = resolve(__dirname, '../../output/prediction_history.json')
  if (!existsSync(histFile)) return []
  try {
    const hist = JSON.parse(readFileSync(histFile, 'utf-8'))
    return Array.isArray(hist) ? hist.slice(0, 90) : []
  } catch { return [] }
}

// ── CSV download helpers ──────────────────────────────────────────────────────
const TOP50_COLS = ['rank','stock_id','name','industry_category',
  'entry_score','entry_signal','close','open','high','low','volume','volume_ratio',
  'rsi14','adx14','atr14','macd','macd_hist','bb_pct_b','stoch_k','stoch_d',
  'ema20','ema60','foreign_buy_streak','invest_trust_streak','dealer_buy_streak',
  'foreign_net','invest_trust_net','dealer_net','f_score','condition_count',
  'margin_change_5d','short_ratio','relative_strength_5d','return_5d','day_return',
  'momentum_score','revenue_yoy','revenue_mom','entry_reason','skip_reason','limit_down_streak']

const ALL_COLS = ['rank','stock_id','name','industry_category',
  'entry_score','entry_signal','close','volume_ratio',
  'rsi14','adx14','foreign_buy_streak','invest_trust_streak','dealer_buy_streak',
  'f_score','condition_count','margin_change_5d','relative_strength_5d',
  'return_5d','revenue_yoy','entry_reason','limit_down_streak']

function rowsToCSV(rows, cols) {
  const esc = v => {
    if (v == null || v === '') return ''
    const s = String(v)
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"` : s
  }
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(k => esc(r[k])).join(','))].join('\n')
}

function writeDownloadCSVs(date, allStocksRaw, downloadsDir) {
  mkdirSync(downloadsDir, { recursive: true })
  // TOP 50 — full columns
  const top50 = allStocksRaw.slice(0, 50).map((r, i) => ({ rank: i + 1, ...r }))
  writeFileSync(join(downloadsDir, `scan_${date}_top50.csv`), rowsToCSV(top50, TOP50_COLS), 'utf-8')
  // All stocks — key columns
  const all = allStocksRaw.map((r, i) => ({ rank: i + 1, ...r }))
  writeFileSync(join(downloadsDir, `scan_${date}_all.csv`), rowsToCSV(all, ALL_COLS), 'utf-8')
}

function cleanOldDownloads(currentDates, downloadsDir) {
  if (!existsSync(downloadsDir)) return
  for (const f of readdirSync(downloadsDir)) {
    if (!/^scan_\d{4}-\d{2}-\d{2}_(top50|all)\.csv$/.test(f)) continue
    const d = f.slice(5, 15)  // extract YYYY-MM-DD
    if (!currentDates.includes(d)) {
      try { unlinkSync(join(downloadsDir, f)) } catch {}
    }
  }
}

// ── Process scan CSVs ────────────────────────────────────────────────────────
function processScanData() {
  if (!existsSync(SCAN_DIR)) return { dates: [], scans: {} }
  const files = readdirSync(SCAN_DIR)
    .filter(f => /^batch_seq\d+_\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort()
  const dateMap = {}
  for (const file of files) {
    try {
      const rows = parseCSV(readFileSync(join(SCAN_DIR, file), 'utf-8'))
      for (const row of rows) {
        const date = (row.date || '').slice(0, 10)   // use actual data date, not filename
        if (!date || date < '2020-01-01' || date > '2099-12-31') continue
        if (!dateMap[date]) dateMap[date] = []
        dateMap[date].push(row)
      }
    } catch (e) { console.warn(`Skip ${file}: ${e.message}`) }
  }
  // Filter out dates with too few unique stocks (incomplete / partial scans)
  const uniqueCountPerDate = {}
  for (const [date, rows] of Object.entries(dateMap)) {
    uniqueCountPerDate[date] = new Set(rows.map(r => r.stock_id)).size
  }
  const dates = Object.keys(dateMap).sort().reverse()
    .filter(d => uniqueCountPerDate[d] >= MIN_VALID_STOCKS)
    .slice(0, MAX_DATES)
  const scans = {}
  const stockHistory = {}

  // Collect OHLCV price history per stock across all available dates (chronological)
  const priceHistoryMap = {}
  for (const date of [...dates].reverse()) {
    const seen = new Set()
    for (const row of (dateMap[date] || [])) {
      const sid = row.stock_id
      if (seen.has(sid)) continue
      seen.add(sid)
      const c = toNum(row.close)
      if (c <= 0) continue
      if (!priceHistoryMap[sid]) priceHistoryMap[sid] = []
      priceHistoryMap[sid].push({
        time: date,
        open: toNum(row.open) || c,
        high: toNum(row.high) || c,
        low: toNum(row.low) || c,
        close: c,
        volume: toNum(row.volume),
      })
    }
  }

  for (const date of dates) {
    const stockMap = {}
    for (const row of dateMap[date]) {
      const sid = row.stock_id, score = toNum(row.entry_score)
      if (!stockMap[sid] || score > toNum(stockMap[sid].entry_score)) stockMap[sid] = row
    }
    const allStocks = Object.values(stockMap).sort((a, b) => toNum(b.entry_score) - toNum(a.entry_score))
    const isLatest = date === dates[0]
    const mapStock = (row, extra = {}) => ({
      stock_id: row.stock_id, name: row.name || '',
      industry_category: row.industry_category || '',
      close: toNum(row.close), volume_ratio: toNum(row.volume_ratio),
      rsi14: toNum(row.rsi14), adx14: toNum(row.adx14),
      entry_score: Math.round(toNum(row.entry_score)),
      entry_signal: toBool(row.entry_signal),
      foreign_buy_streak: toNum(row.foreign_buy_streak),
      invest_trust_streak: toNum(row.invest_trust_streak),
      dealer_buy_streak: toNum(row.dealer_buy_streak),
      f_score: toNum(row.f_score), condition_count: toNum(row.condition_count),
      margin_change_5d: toNum(row.margin_change_5d),
      short_ratio: toNum(row.short_ratio),
      entry_reason: row.entry_reason || '',
      limit_down_streak: toNum(row.limit_down_streak),
      // extra technical fields for detail panel
      macd: toNum(row.macd), macd_signal: toNum(row.macd_signal), macd_hist: toNum(row.macd_hist),
      bb_pct_b: toNum(row.bb_pct_b), stoch_k: toNum(row.stoch_k), stoch_d: toNum(row.stoch_d),
      rsi14: toNum(row.rsi14), adx14: toNum(row.adx14), atr14: toNum(row.atr14),
      ema20: toNum(row.ema20), ema60: toNum(row.ema60),
      foreign_net: toNum(row.foreign_net), invest_trust_net: toNum(row.invest_trust_net), dealer_net: toNum(row.dealer_net),
      momentum_score: toNum(row.momentum_score), relative_strength_5d: toNum(row.relative_strength_5d),
      return_5d: toNum(row.return_5d), day_return: toNum(row.day_return),
      skip_reason: row.skip_reason || '',
      // attach price history only for latest date (to keep JSON lean)
      price_history: isLatest ? (priceHistoryMap[row.stock_id] || []) : undefined,
      ...extra,
    })
    const topStocks = allStocks.slice(0, TOP_N).map((row, i) => ({ rank: i + 1, ...mapStock(row) }))
    const limitDownAlerts = allStocks
      .filter(r => toNum(r.limit_down_streak) >= 3)
      .sort((a, b) => toNum(b.limit_down_streak) - toNum(a.limit_down_streak))
      .map(r => mapStock(r))
    scans[date] = { total_scanned: allStocks.length, entry_count: allStocks.filter(r => toBool(r.entry_signal)).length, top_stocks: topStocks, limit_down_alerts: limitDownAlerts, is_partial: allStocks.length < 500 }
    // Write static CSV download files (top50 + all) to public/downloads/
    try {
      writeDownloadCSVs(date, allStocks, join(PUBLIC_DIR, 'downloads'))
      console.log(`  CSV: scan_${date}_top50.csv (${topStocks.length}支), scan_${date}_all.csv (${allStocks.length}支)`)
    } catch (e) { console.warn(`  CSV write failed for ${date}: ${e.message}`) }
    for (const stock of topStocks) {
      const sid = stock.stock_id
      if (!stockHistory[sid]) stockHistory[sid] = { name: stock.name, industry_category: stock.industry_category, scores: [] }
      stockHistory[sid].scores.push({ date, score: stock.entry_score })
    }
  }
  // Persistent rankings
  const persistent = Object.entries(stockHistory)
    .filter(([, d]) => d.scores.length >= 2)
    .map(([sid, d]) => {
      const sorted = d.scores.sort((a, b) => b.date.localeCompare(a.date))
      return { stock_id: sid, name: d.name, industry_category: d.industry_category, days_in_top: d.scores.length, latest_score: sorted[0].score, score_trend: sorted[0].score - sorted[1].score }
    })
    .sort((a, b) => b.days_in_top - a.days_in_top || b.latest_score - a.latest_score).slice(0, 20)
  if (dates.length > 0 && scans[dates[0]]) scans[dates[0]].persistent = persistent
  cleanOldDownloads(dates, join(PUBLIC_DIR, 'downloads'))
  return { dates, scans }
}

// ── Notion stocks ────────────────────────────────────────────────────────────
async function fetchNotionStocks() {
  const token = (process.env.NOTION_TOKEN || '').trim()
  const dbId  = (process.env.NOTION_DATABASE_ID || '').trim()
  if (!token || !dbId) { console.log('  Notion: no token/db — skipping'); return { notionMap: {}, notionFullStocks: [] } }

  const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10)
  const headers = { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
  const notionMap = {}
  const notionFullStocks = []
  let cursor = null
  let pageCount = 0
  const MAX_PAGES = 20  // ~2000 stocks max to avoid build timeout

  const getRich = (props, key) => props[key]?.rich_text?.[0]?.text?.content || ''
  const getSelect = (props, key) => props[key]?.select?.name || ''
  const getNum = (props, key) => props[key]?.number ?? null
  const getDate = (props, key) => props[key]?.date?.start || ''

  try {
    do {
      const body = {
        filter: { property: '日期', date: { on_or_after: cutoff } },
        sorts: [{ property: '日期', direction: 'descending' }],
        page_size: 100,
      }
      if (cursor) body.start_cursor = cursor
      const raw = await postJson(`https://api.notion.com/v1/databases/${dbId}/query`, body, headers, 12000)
      const data = JSON.parse(raw)
      pageCount++

      for (const page of (data.results || [])) {
        const props = page.properties || {}
        const sid   = getRich(props, '股票代號')
        if (!sid) continue
        const date  = getDate(props, '日期')

        // notionMap: keep most recent entry per stock (for detail panel)
        if (!notionMap[sid] || (notionMap[sid].date || '') < date) {
          notionMap[sid] = {
            notion_url: page.url || '',
            type:       getSelect(props, '類型'),
            note:       getRich(props, '觀察建議'),
            regime:     getSelect(props, '市場氛圍'),
            confidence: getNum(props, '信心分數'),
            date,
          }
        }

        // notionFullStocks: full indicator data for fallback scan
        const score = getNum(props, '分數') || 0
        const close = getNum(props, '收盤價') || 0
        if (score > 0 && date) {
          // Page title is "2330 台積電" — strip stock ID prefix to get name
          const titleProp = Object.values(props).find(p => p.type === 'title')
          const fullTitle = titleProp?.title?.[0]?.text?.content || sid
          const name = fullTitle.startsWith(sid) ? fullTitle.slice(sid.length).trim() : fullTitle

          const condStr   = getRich(props, '條件達成')   // e.g. "5/23"
          const condCount = parseInt((condStr || '').split('/')[0]) || 0
          const status    = getSelect(props, '狀態')

          notionFullStocks.push({
            stock_id: sid, name, date,
            entry_score: score, close,
            rsi14: getNum(props, 'RSI') || 0,
            adx14: getNum(props, 'ADX') || 0,
            stoch_k: getNum(props, 'KD值') || 0,
            condition_count: condCount,
            industry_category: getRich(props, '產業別'),
            foreign_buy_streak: getNum(props, '外資連買天數') || 0,
            invest_trust_streak: getNum(props, '投信連買天數') || 0,
            dealer_buy_streak: getNum(props, '自營連買天數') || 0,
            volume_ratio: getNum(props, '成交量比') || 0,
            return_5d: (getNum(props, '5日漲幅%') || 0) / 100,
            relative_strength_5d: (getNum(props, '相對強度') || 0) / 100,
            bb_pct_b: (getNum(props, 'BB位置%') || 0) / 100,
            entry_signal: status === 'TOP 20 進場' || status === '候選進場',
            // Fields not stored in Notion — zero-fill
            f_score: 0, margin_change_5d: 0, short_ratio: 0, limit_down_streak: 0,
            macd: 0, macd_signal: 0, macd_hist: 0, atr14: 0, ema20: 0, ema60: 0,
            foreign_net: 0, invest_trust_net: 0, dealer_net: 0,
            momentum_score: 0, day_return: 0, entry_reason: '', skip_reason: '',
          })
        }
      }
      cursor = data.has_more && pageCount < MAX_PAGES ? data.next_cursor : null
    } while (cursor)
    console.log(`  Notion: ${Object.keys(notionMap).length} map entries, ${notionFullStocks.length} full records (${pageCount} pages, last 30d)`)
  } catch (e) {
    console.warn(`  Notion fetch failed: ${e.message}`)
  }
  return { notionMap, notionFullStocks }
}

// ── FinMind quota ────────────────────────────────────────────────────────────
async function fetchOneQuota(token, label) {
  // FinMind v2 API: GET https://api.web.finmindtrade.com/v2/user_info
  // Response is flat (no nested `data`): { status, msg, user_count, api_request_limit, ... }
  const cleanToken = token.trim()  // guard against leading/trailing whitespace in secrets
  const rawBody = await new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.web.finmindtrade.com',
      path: '/v2/user_info',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${cleanToken}`,
        'User-Agent': 'Mozilla/5.0',
      },
    }
    const req = https.request(opts, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      res.on('error', reject)
    })
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
    req.end()
  })

  let json
  try {
    json = JSON.parse(rawBody)
  } catch (e) {
    throw new Error(`JSON parse failed: ${rawBody.slice(0, 200)}`)
  }

  // v2 response is flat: { status: 200, msg: "success", user_count: N, api_request_limit: M, ... }
  if (json.status === 200) {
    const used  = json.user_count ?? 0
    const limit = json.api_request_limit ?? 0
    return { label, limit: Number(limit), used: Number(used) }
  }
  throw new Error(`status=${json.status} msg="${json.msg || json.message || 'unknown'}"`)
}

async function fetchFinMindQuota() {
  const tokens = [
    { key: process.env.FINMIND_TOKEN,   label: '帳號1（600）' },
    { key: process.env.FINMIND_TOKEN_2, label: '帳號2（600）' },
    { key: process.env.FINMIND_TOKEN_3, label: '帳號3（600）' },
    { key: process.env.FINMIND_TOKEN_4, label: '帳號4（600）' },
    { key: process.env.FINMIND_TOKEN_5, label: '帳號5（600）' },
    { key: process.env.FINMIND_TOKEN_6, label: '帳號6（300）' },
    { key: process.env.FINMIND_TOKEN_7, label: '帳號7（300）' },
    { key: process.env.FINMIND_TOKEN_8, label: '帳號8（300）' },
    { key: process.env.FINMIND_TOKEN_9, label: '帳號9（300）' },
  ].filter(t => t.key?.trim())

  console.log(`  FinMind quota: checking ${tokens.length} token(s)`)
  if (tokens.length === 0) {
    console.warn('  ⚠️  No FINMIND_TOKEN env vars found — quota will be empty')
    return []
  }

  const results = []
  for (const { key, label } of tokens) {
    try {
      const r = await fetchOneQuota(key, label)
      results.push(r)
      console.log(`  ✓ [${label}]: ${r.used}/${r.limit}`)
    } catch (e) {
      console.warn(`  ✗ [${label}] failed: ${e.message}`)
    }
  }
  return results
}

// ── FinMind K-line pre-fetch (FINMIND_TOKEN_10) ──────────────────────────────
async function fetchKLineData(stockIds, token) {
  if (!token || stockIds.length === 0) return {}
  const endDate = new Date().toISOString().slice(0, 10)
  const startDate = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10)
  const klineMap = {}
  console.log(`  K-line: fetching ${stockIds.length} stocks (${startDate} ~ ${endDate})`)
  for (const sid of stockIds) {
    try {
      const url = `https://api.finmindtrade.com/api/v4/data?token=${encodeURIComponent(token)}&dataset=TaiwanStockPrice&stock_id=${sid}&start_date=${startDate}&end_date=${endDate}`
      const body = await fetchUrl(url, 12000)
      const json = JSON.parse(body)
      if (json.status === 200 && Array.isArray(json.data) && json.data.length > 0) {
        klineMap[sid] = json.data.map(d => ({
          time: d.date, open: d.open, high: d.max, low: d.min,
          close: d.close, volume: d.Trading_Volume || 0,
        }))
      }
      await new Promise(r => setTimeout(r, 80))
    } catch (e) {
      console.warn(`  K-line [${sid}] failed: ${e.message}`)
    }
  }
  console.log(`  K-line: ${Object.keys(klineMap).length}/${stockIds.length} fetched`)
  return klineMap
}

// ── Main ─────────────────────────────────────────────────────────────────────
const { dates, scans } = processScanData()
console.log(`Scan data: ${dates.length} dates, latest=${dates[0]}, stocks=${scans[dates[0]]?.total_scanned ?? 0}`)

// Merge aggregate_latest.json: if its date is newer or not in CSV dates, inject it
console.log('Reading aggregate_latest.json...')
const aggregateLatest = readAggregateLatest()
if (aggregateLatest) {
  const aggDate = aggregateLatest.date
  const isNewer = !dates.length || aggDate >= dates[0]
  const isMissing = !scans[aggDate]
  const aggSufficient = (aggregateLatest.total_scanned || 0) >= MIN_VALID_STOCKS
  if ((isNewer || isMissing) && aggSufficient) {
    // Build scan entry from aggregate JSON (matches processScanData output format)
    const aggTopStocks = (aggregateLatest.top_stocks || []).map((r, i) => ({
      rank: i + 1,
      stock_id: String(r.stock_id || ''),
      name: r.name || '',
      industry_category: r.industry_category || '',
      close: r.close || 0,
      volume_ratio: r.volume_ratio || 0,
      rsi14: r.rsi14 || 0,
      adx14: r.adx14 || 0,
      entry_score: Math.round(r.entry_score || 0),
      entry_signal: !!r.entry_signal,
      foreign_buy_streak: r.foreign_buy_streak || 0,
      invest_trust_streak: r.invest_trust_streak || 0,
      dealer_buy_streak: r.dealer_buy_streak || 0,
      f_score: r.f_score ?? 0,
      condition_count: r.condition_count || 0,
      margin_change_5d: r.margin_change_5d || 0,
      short_ratio: r.short_ratio || 0,
      entry_reason: r.entry_reason || '',
      limit_down_streak: r.limit_down_streak || 0,
      // technical fields
      macd: r.macd || 0, macd_signal: r.macd_signal || 0, macd_hist: r.macd_hist || 0,
      bb_pct_b: r.bb_pct_b || 0, stoch_k: r.stoch_k || 0, stoch_d: r.stoch_d || 0,
      atr14: r.atr14 || 0, ema20: r.ema20 || 0, ema60: r.ema60 || 0,
      foreign_net: r.foreign_net || 0, invest_trust_net: r.invest_trust_net || 0, dealer_net: r.dealer_net || 0,
      momentum_score: r.momentum_score || 0, relative_strength_5d: r.relative_strength_5d || 0,
      return_5d: r.return_5d || 0, day_return: r.day_return || 0,
      skip_reason: r.skip_reason || '',
      price_history: undefined,   // no OHLCV history in aggregate JSON (CSV already deleted)
    }))
    const aggLimitDown = (aggregateLatest.limit_down_alerts || []).map(r => ({
      stock_id: String(r.stock_id || ''), name: r.name || '',
      industry_category: r.industry_category || '',
      close: r.close || 0, limit_down_streak: r.limit_down_streak || 0,
      entry_signal: !!r.entry_signal, entry_score: Math.round(r.entry_score || 0),
    }))
    scans[aggDate] = {
      total_scanned: aggregateLatest.total_scanned || aggTopStocks.length,
      entry_count: aggregateLatest.entry_count || 0,
      top_stocks: aggTopStocks,
      limit_down_alerts: aggLimitDown,
      persistent: (aggregateLatest.persistent_strong || []).map(p => ({
        stock_id: p.stock_id, name: p.name, industry_category: p.industry_category,
        days_in_top: p.days_in_top, latest_score: p.today_score || p.latest_score || 0,
        score_trend: p.score_delta || 0,
      })),
      margin_stats: aggregateLatest.margin_stats || {},
      ai_picks_text: aggregateLatest.ai_picks_text || '',
      from_aggregate_json: true,
    }
    if (!dates.includes(aggDate)) dates.unshift(aggDate)
    console.log(`  Injected aggregate date ${aggDate}: ${aggregateLatest.total_scanned} stocks, ai=${!!aggregateLatest.ai_picks_text}`)
  }
}

// Fetch K-line data for top 50 stocks using dedicated account 10
console.log('Fetching K-line data...')
const klineToken = (process.env.FINMIND_TOKEN_10 || '').trim()
if (klineToken && dates.length > 0) {
  const latestTop = scans[dates[0]]?.top_stocks || []
  const top50ids = latestTop.slice(0, 50).map(s => s.stock_id)
  const klineMap = await fetchKLineData(top50ids, klineToken)
  for (const stock of latestTop) {
    if (klineMap[stock.stock_id]) stock.price_history = klineMap[stock.stock_id]
  }
  console.log(`K-line: injected into ${Object.keys(klineMap).length} stocks`)
} else {
  console.log(`K-line: ${klineToken ? 'no dates' : 'FINMIND_TOKEN_10 not set'}, skipping`)
}

const prediction = readPrediction()
const predictionHistory = readPredictionHistory()
console.log(`Prediction: ${prediction ? prediction.date : 'none'}, history: ${predictionHistory.length} entries`)

console.log('Reading news corpus...')
let news = readNewsCorpus()
if (news.length === 0) {
  console.log('Corpus empty, fetching live news...')
  news = await fetchNews()
}
console.log(`News: ${news.length} total items`)

console.log('Fetching FinMind quota...')
const quota = await fetchFinMindQuota()
console.log(`Quota: ${quota.length} accounts`)

console.log('Fetching Notion stocks...')
const { notionMap, notionFullStocks } = await fetchNotionStocks()
console.log(`Notion: ${Object.keys(notionMap).length} map entries, ${notionFullStocks.length} full records`)

// Build Notion fallback scan if primary data is insufficient (e.g., only 1 account had quota)
const latestScan = scans[dates[0]]
if ((!latestScan || latestScan.total_scanned < MIN_VALID_STOCKS) && notionFullStocks.length >= 100) {
  console.log(`Primary data insufficient (${latestScan?.total_scanned ?? 0} stocks). Building Notion fallback...`)
  // Group stocks by date
  const dateGroups = {}
  for (const s of notionFullStocks) {
    if (!s.date) continue
    if (!dateGroups[s.date]) dateGroups[s.date] = []
    dateGroups[s.date].push(s)
  }
  // Find most recent date with enough stocks
  const bestFallbackDate = Object.keys(dateGroups)
    .filter(d => dateGroups[d].length >= 100)
    .sort().pop()
  if (bestFallbackDate) {
    const fallbackStocks = dateGroups[bestFallbackDate].sort((a, b) => b.entry_score - a.entry_score)
    scans[bestFallbackDate] = {
      total_scanned: fallbackStocks.length,
      entry_count: fallbackStocks.filter(s => s.entry_signal).length,
      top_stocks: fallbackStocks.slice(0, TOP_N).map((s, i) => ({ rank: i + 1, ...s })),
      limit_down_alerts: [],
      from_notion_fallback: true,
    }
    if (!dates.includes(bestFallbackDate)) dates.unshift(bestFallbackDate)
    else if (dates[0] !== bestFallbackDate) { dates.splice(dates.indexOf(bestFallbackDate), 1); dates.unshift(bestFallbackDate) }
    console.log(`  Notion fallback scan: ${bestFallbackDate}, ${fallbackStocks.length} stocks`)
  } else {
    console.warn(`⚠️  No Notion fallback date found with 100+ stocks`)
  }
} else if (!latestScan || latestScan.total_scanned < MIN_VALID_STOCKS) {
  console.warn(`⚠️  Data warning: latest date ${dates[0]} has only ${latestScan?.total_scanned ?? 0} stocks. Neither aggregate nor Notion has sufficient data.`)
}

mkdirSync(PUBLIC_DIR, { recursive: true })
writeFileSync(OUTPUT_FILE, JSON.stringify({ generated_at: new Date().toISOString(), dates, scans, prediction, predictionHistory, news, quota, notionMap, aggregateLatest }), 'utf-8')
console.log(`data.json written (${(readFileSync(OUTPUT_FILE).length / 1024).toFixed(0)} KB)`)
