import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import https from 'https'
import http from 'http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAN_DIR = resolve(__dirname, '../../output/full_scan')
const PRED_FILE   = resolve(__dirname, '../../output/prediction_latest.json')
const AGG_FILE    = resolve(__dirname, '../../output/aggregate_latest.json')
const KLINE_FILE  = resolve(__dirname, '../../output/kline_cache.json')
const PUBLIC_DIR  = resolve(__dirname, '../public')
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
// 2-decimal rounding keeps data.json lean — full-precision floats cost
// ~17 chars each across 30+ fields × 200+ rows
function r2(v) { return Math.round(toNum(v) * 100) / 100 }
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
  'momentum_score','revenue_yoy','revenue_mom','sma5','sma10','grade','entry_reason','skip_reason','limit_down_streak',
  'kd_level_score','bb_level_signal','gap_to_20d_high_pct','breakout_proximity_score',
  'obv_strength','foreign_buy_accel','invest_trust_accel',
  'expected_hold_days','momentum_decay_signal','estimated_sl_days']

const ALL_COLS = ['rank','stock_id','name','industry_category',
  'entry_score','entry_signal','close','volume_ratio',
  'rsi14','adx14','foreign_buy_streak','invest_trust_streak','dealer_buy_streak',
  'f_score','condition_count','margin_change_5d','relative_strength_5d',
  'return_5d','revenue_yoy','sma5','sma10','grade','entry_reason','limit_down_streak',
  'expected_hold_days','momentum_decay_signal','estimated_sl_days']

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
  const allDirFiles = readdirSync(SCAN_DIR)

  // Execution dates from _attempted_ filenames (the date the cron actually ran)
  // These differ from FinMind data dates when overnight scans fetch previous-day data.
  const execDates = [...new Set(
    allDirFiles.map(f => { const m = f.match(/^_attempted_(\d{4}-\d{2}-\d{2})/) ; return m ? m[1] : null }).filter(Boolean)
  )].sort()  // ascending

  // Read all batch CSVs — initially group by row.date (FinMind data date)
  const rawDateMap = {}
  for (const file of allDirFiles.filter(f => /^batch_seq\d+_\d{4}-\d{2}-\d{2}\.csv$/.test(f))) {
    try {
      const rows = parseCSV(readFileSync(join(SCAN_DIR, file), 'utf-8'))
      for (const row of rows) {
        const date = (row.date || '').slice(0, 10)
        if (!date || date < '2020-01-01' || date > '2099-12-31') continue
        ;(rawDateMap[date] = rawDateMap[date] || []).push(row)
      }
    } catch (e) { console.warn(`Skip ${file}: ${e.message}`) }
  }

  // Remap data dates → execution dates (when _attempted_ files exist).
  // Rule: a FinMind data date maps to the nearest exec date where
  //   execDate >= dataDate AND (execDate - dataDate) <= 1 day.
  // This handles the common case (data date = exec date) and the overnight case
  // (data date = exec date - 1 day, because FinMind had no current-day data yet).
  const dateMap = {}
  if (execDates.length > 0) {
    for (const [dataDate, rows] of Object.entries(rawDateMap)) {
      const execDate = execDates.find(d => {
        const diff = (new Date(d) - new Date(dataDate)) / 86400000
        return diff >= 0 && diff <= 1
      })
      const key = execDate || dataDate  // fall back to data date for old/unmatched entries
      ;(dateMap[key] = dateMap[key] || []).push(...rows)
    }
  } else {
    // No _attempted_ files: keep data dates as-is (legacy / historical data)
    Object.assign(dateMap, rawDateMap)
  }

  // Filter out dates with too few unique stocks (incomplete / partial scans)
  // Exception: always include the most recent available date (even if partial)
  // so users see today's data immediately after the scan completes.
  const uniqueCountPerDate = {}
  for (const [date, rows] of Object.entries(dateMap)) {
    uniqueCountPerDate[date] = new Set(rows.map(r => r.stock_id)).size
  }
  const _allDatesDesc = Object.keys(dateMap).sort().reverse()
  const dates = _allDatesDesc
    .filter((d, i) => i === 0 || uniqueCountPerDate[d] >= MIN_VALID_STOCKS)
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
    // Dominant data date = most frequent row.date among deduped stocks (mode, not max)
    const ddCounts = {}
    for (const row of Object.values(stockMap)) {
      const d = (row.date || '').slice(0, 10)
      if (d) ddCounts[d] = (ddCounts[d] || 0) + 1
    }
    const dominantDataDate = Object.entries(ddCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || date
    const allStocks = Object.values(stockMap).sort((a, b) => toNum(b.entry_score) - toNum(a.entry_score))
    const isLatest = date === dates[0]
    const mapStock = (row, extra = {}) => ({
      stock_id: row.stock_id, name: row.name || '',
      industry_category: row.industry_category || '',
      close: r2(row.close), volume_ratio: r2(row.volume_ratio),
      rsi14: r2(row.rsi14), adx14: r2(row.adx14),
      entry_score: Math.round(toNum(row.entry_score)),
      entry_signal: toBool(row.entry_signal),
      foreign_buy_streak: toNum(row.foreign_buy_streak),
      invest_trust_streak: toNum(row.invest_trust_streak),
      dealer_buy_streak: toNum(row.dealer_buy_streak),
      f_score: toNum(row.f_score), condition_count: toNum(row.condition_count),
      margin_change_5d: r2(row.margin_change_5d),
      short_ratio: r2(row.short_ratio),
      entry_reason: row.entry_reason || '',
      limit_down_streak: toNum(row.limit_down_streak),
      // extra technical fields for detail panel
      macd: r2(row.macd), macd_signal: r2(row.macd_signal), macd_hist: r2(row.macd_hist),
      bb_pct_b: r2(row.bb_pct_b), stoch_k: r2(row.stoch_k), stoch_d: r2(row.stoch_d),
      atr14: r2(row.atr14),
      ema20: r2(row.ema20), ema60: r2(row.ema60),
      foreign_net: r2(row.foreign_net), invest_trust_net: r2(row.invest_trust_net), dealer_net: r2(row.dealer_net),
      momentum_score: r2(row.momentum_score), relative_strength_5d: r2(row.relative_strength_5d),
      return_5d: r2(row.return_5d), day_return: r2(row.day_return),
      revenue_yoy: r2(row.revenue_yoy), revenue_mom: r2(row.revenue_mom),
      sma5: r2(row.sma5), sma10: r2(row.sma10),
      ma5_above_ma10: toBool(row.ma5_above_ma10),
      kd_level_score: r2(row.kd_level_score),
      bb_level_signal: r2(row.bb_level_signal),
      gap_to_20d_high_pct: r2(row.gap_to_20d_high_pct),
      breakout_proximity_score: r2(row.breakout_proximity_score),
      obv_strength: r2(row.obv_strength),
      foreign_buy_accel: toBool(row.foreign_buy_accel),
      invest_trust_accel: toBool(row.invest_trust_accel),
      expected_hold_days: toNum(row.expected_hold_days),
      momentum_decay_signal: toBool(row.momentum_decay_signal),
      estimated_sl_days: toNum(row.estimated_sl_days),
      skip_reason: row.skip_reason || '',
      // advanced oscillators
      williams_r: r2(row.williams_r),
      cci20: r2(row.cci20),
      mfi14: r2(row.mfi14),
      bb_bandwidth: r2(row.bb_bandwidth),
      ema120: r2(row.ema120),
      // support / resistance levels
      close_20d_high: r2(row.close_20d_high),
      close_10d_low: r2(row.close_10d_low),
      lr_slope_20: r2(row.lr_slope_20),
      lr_slope_60: r2(row.lr_slope_60),
      // institutional shareholding depth
      foreign_holding_pct: r2(row.foreign_holding_pct),
      foreign_holding_chg5d: r2(row.foreign_holding_chg5d),
      // revenue momentum continuity
      revenue_3m_yoy: r2(row.revenue_3m_yoy),
      // cross-sectional signals (added by Wave 2 scan_enrich.py)
      grade: row.grade || '',
      score_pct: toNum(row.score_pct),
      regime_label: row.regime_label || '',
      market_rs_rank: toNum(row.market_rs_rank),
      sector_rs: r2(row.sector_rs),
      sector_rs_rank: toNum(row.sector_rs_rank),
      sector_breadth_60: toNum(row.sector_breadth_60),
      sector_vol_zscore: r2(row.sector_vol_zscore),
      is_sector_leader: toBool(row.is_sector_leader),
      sector_stock_count: toNum(row.sector_stock_count),
      data_quality_ok: toBool(row.data_quality_ok),
      // attach price history only for latest date (to keep JSON lean)
      price_history: isLatest ? (priceHistoryMap[row.stock_id] || []) : undefined,
      ...extra,
    })
    const topStocks = allStocks.slice(0, TOP_N).map((row, i) => ({ rank: i + 1, ...mapStock(row) }))
    const limitDownAlerts = allStocks
      .filter(r => toNum(r.limit_down_streak) >= 3)
      .sort((a, b) => toNum(b.limit_down_streak) - toNum(a.limit_down_streak))
      .map(r => mapStock(r))
    scans[date] = { total_scanned: allStocks.length, entry_count: allStocks.filter(r => toBool(r.entry_signal)).length, top_stocks: topStocks, limit_down_alerts: limitDownAlerts, is_partial: allStocks.length < 500, data_date: dominantDataDate }
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
  return { dates, scans, priceHistoryMap, dateMap, execDates }
}

// ── Outcome stats: 5-day win rate by grade ───────────────────────────────────
// Reads from historical scan data already loaded; zero network calls.
// For each stock on date D with grade G, checks if close price 5 trading days
// later was higher. Skips the 5 most recent dates (no outcome yet).
function computeOutcomeStats(dates, dateMap, priceHistoryMap) {
  const gradeKeys = ['A', 'B', 'C', 'D']
  const stats = {}
  for (const g of gradeKeys) stats[g] = { wins: 0, total: 0, sumReturn: 0 }

  if (dates.length < 6) return buildResult(stats)

  // dates is sorted desc; skip dates[0..4] (too recent); process dates[5..]
  for (let i = 5; i < dates.length; i++) {
    const entryDate = dates[i]
    const rows = dateMap[entryDate]
    if (!rows) continue

    const seenIds = new Set()
    for (const row of rows) {
      const grade = (row.grade || '').trim()
      if (!stats[grade]) continue

      const sid = row.stock_id
      if (seenIds.has(sid)) continue
      seenIds.add(sid)
      const history = priceHistoryMap[sid]
      if (!history || history.length < 6) continue

      const entryIdx = history.findIndex(h => h.time === entryDate)
      if (entryIdx < 0 || entryIdx + 5 >= history.length) continue

      const entryPrice = history[entryIdx].close
      const exitPrice  = history[entryIdx + 5].close
      if (entryPrice <= 0 || exitPrice <= 0) continue

      const ret = (exitPrice - entryPrice) / entryPrice
      stats[grade].total++
      stats[grade].sumReturn += ret
      if (ret > 0) stats[grade].wins++
    }
  }
  return buildResult(stats)

  function buildResult(s) {
    const out = {}
    for (const [g, v] of Object.entries(s)) {
      out[g] = {
        total: v.total,
        win_rate: v.total >= 10 ? Math.round(v.wins / v.total * 1000) / 10 : null,
        avg_return_pct: v.total >= 10 ? Math.round(v.sumReturn / v.total * 10000) / 100 : null,
      }
    }
    return out
  }
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
    { key: process.env.FINMIND_TOKEN_9,  label: '帳號9（300）' },
    { key: process.env.FINMIND_TOKEN_10, label: '帳號10（K線）' },
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

// ── FinMind K-line pre-fetch ──────────────────────────────────────────────────
async function fetchOneKLine(sid, token, startDate, endDate) {
  const url = `https://api.finmindtrade.com/api/v4/data?token=${encodeURIComponent(token)}&dataset=TaiwanStockPrice&stock_id=${sid}&start_date=${startDate}&end_date=${endDate}`
  const body = await fetchUrl(url, 12000)
  const json = JSON.parse(body)
  if (json.status === 200 && Array.isArray(json.data) && json.data.length > 0) {
    return json.data.map(d => ({
      time: d.date, open: d.open, high: d.max, low: d.min,
      close: d.close, volume: d.Trading_Volume || 0,
    }))
  }
  // Return the status/msg so callers can diagnose plan limitations
  return { _err: true, status: json.status, msg: json.msg || '' }
}

async function fetchKLineData(stockIds, primaryToken, fallbackToken) {
  if (!primaryToken || stockIds.length === 0) return {}
  const endDate = new Date().toISOString().slice(0, 10)
  const startDate = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
  const klineMap = {}
  console.log(`  K-line: fetching ${stockIds.length} stocks (${startDate} ~ ${endDate})`)

  // Probe with the first stock to detect plan limitations early
  let activeToken = primaryToken
  try {
    const probe = await fetchOneKLine(stockIds[0], primaryToken, startDate, endDate)
    if (probe?._err) {
      console.warn(`  K-line TOKEN_10 probe failed (status=${probe.status} msg="${probe.msg}") — switching to fallback token`)
      if (fallbackToken) {
        activeToken = fallbackToken
        // Re-probe with fallback
        const probe2 = await fetchOneKLine(stockIds[0], fallbackToken, startDate, endDate)
        if (!probe2?._err) klineMap[stockIds[0]] = probe2
        else console.warn(`  K-line fallback also failed (status=${probe2.status})`)
      }
    } else {
      klineMap[stockIds[0]] = probe
    }
  } catch (e) {
    console.warn(`  K-line probe error: ${e.message}`)
  }

  for (const sid of stockIds.slice(1)) {
    try {
      const rows = await fetchOneKLine(sid, activeToken, startDate, endDate)
      if (!rows?._err) klineMap[sid] = rows
      await new Promise(r => setTimeout(r, 80))
    } catch (e) {
      console.warn(`  K-line [${sid}] failed: ${e.message}`)
    }
  }
  console.log(`  K-line: ${Object.keys(klineMap).length}/${stockIds.length} fetched (token=${activeToken === primaryToken ? 'TOKEN_10' : 'TOKEN_1 fallback'})`)
  return klineMap
}

// ── Last scan execution date (from _attempted_ filenames) ────────────────────
function getLastScanExecDate() {
  if (!existsSync(SCAN_DIR)) return null
  const dates = readdirSync(SCAN_DIR)
    .map(f => { const m = f.match(/^_attempted_(\d{4}-\d{2}-\d{2})/) ; return m ? m[1] : null })
    .filter(Boolean).sort()
  return dates.length ? dates[dates.length - 1] : null
}

// ── Main ─────────────────────────────────────────────────────────────────────
const { dates, scans, priceHistoryMap, dateMap, execDates } = processScanData()
console.log(`Scan data: ${dates.length} dates, latest=${dates[0]}, stocks=${scans[dates[0]]?.total_scanned ?? 0}`)

console.log('Computing grade outcome stats...')
const outcomeStats = computeOutcomeStats(dates, dateMap, priceHistoryMap)
console.log(`Outcome stats: A=${outcomeStats.A?.total ?? 0} B=${outcomeStats.B?.total ?? 0} C=${outcomeStats.C?.total ?? 0} D=${outcomeStats.D?.total ?? 0} records`)

// Merge aggregate_latest.json: if its date is newer or not in CSV dates, inject it
console.log('Reading aggregate_latest.json...')
const aggregateLatest = readAggregateLatest()
if (aggregateLatest) {
  const aggDate = aggregateLatest.date
  // Map aggregate's FinMind data date to the same exec-date key used in scans
  // (same 1-day window rule as processScanData remap)
  const aggExecDate = execDates.find(d => {
    const diff = (new Date(d) - new Date(aggDate)) / 86400000
    return diff >= 0 && diff <= 1
  }) || aggDate
  const isNewer = !dates.length || aggExecDate >= dates[0]
  const isMissing = !scans[aggExecDate]
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
      // cross-sectional signals
      grade: r.grade || '',
      score_pct: r.score_pct || 0,
      regime_label: r.regime_label || '',
      market_rs_rank: r.market_rs_rank || 0,
      sector_rs: r.sector_rs || 0,
      sector_rs_rank: r.sector_rs_rank || 0,
      sector_breadth_60: r.sector_breadth_60 || 0,
      sector_vol_zscore: r.sector_vol_zscore || 0,
      is_sector_leader: !!r.is_sector_leader,
      sector_stock_count: r.sector_stock_count || 0,
      data_quality_ok: !!r.data_quality_ok,
      price_history: undefined,   // no OHLCV history in aggregate JSON (CSV already deleted)
    }))
    const aggLimitDown = (aggregateLatest.limit_down_alerts || []).map(r => ({
      stock_id: String(r.stock_id || ''), name: r.name || '',
      industry_category: r.industry_category || '',
      close: r.close || 0, limit_down_streak: r.limit_down_streak || 0,
      entry_signal: !!r.entry_signal, entry_score: Math.round(r.entry_score || 0),
    }))
    scans[aggExecDate] = {
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
      calendar_risk: aggregateLatest.calendar_risk || '',
      from_aggregate_json: true,
    }
    if (!dates.includes(aggExecDate)) dates.unshift(aggExecDate)
    console.log(`  Injected aggregate date ${aggDate}→${aggExecDate}: ${aggregateLatest.total_scanned} stocks, ai=${!!aggregateLatest.ai_picks_text}`)
  }
}

// Inject K-line data — read from kline_cache.json (populated by kline-fetch.yml workflow)
// Falls back to live fetch (with TOKEN_10 → TOKEN_1) if cache is missing
console.log('Loading K-line data...')
const recentDates = dates.slice(0, 3)
let klineMap = {}
if (existsSync(KLINE_FILE)) {
  klineMap = JSON.parse(readFileSync(KLINE_FILE, 'utf-8'))
  const firstKey = Object.keys(klineMap)[0]
  const sampleDays = firstKey ? (klineMap[firstKey].length ?? 0) : 0
  console.log(`K-line: loaded cache (${Object.keys(klineMap).length} stocks, ~${sampleDays} days each)`)
} else {
  console.log('K-line: no cache found — falling back to live fetch')
  const klineToken10 = (process.env.FINMIND_TOKEN_10 || '').trim()
  const klineToken1  = (process.env.FINMIND_TOKEN   || '').trim()
  if (klineToken10 || klineToken1) {
    const idSet = new Set()
    for (const d of recentDates) {
      for (const s of (scans[d]?.top_stocks || [])) idSet.add(s.stock_id)
    }
    klineMap = await fetchKLineData([...idSet].slice(0, 100), klineToken10 || klineToken1, klineToken10 ? klineToken1 : null)
  }
}
// Support both cache formats:
// Old: {stock_id: [bars]}
// New: {stock_id: {"1d": [bars], "1wk": [bars], "1mo": [bars]}}
function getKlineBars(entry, interval) {
  if (!entry) return undefined
  if (Array.isArray(entry)) return interval === '1d' ? entry : undefined
  const bars = entry[interval]
  return Array.isArray(bars) && bars.length >= 2 ? bars : undefined
}

// Inject price_history (all 3 intervals) into recent dates' stocks and persistent items
for (const d of recentDates) {
  for (const stock of (scans[d]?.top_stocks || [])) {
    const entry = klineMap[stock.stock_id]
    if (!entry) continue
    stock.price_history    = getKlineBars(entry, '1d')
    stock.price_history_wk = getKlineBars(entry, '1wk')
    stock.price_history_mo = getKlineBars(entry, '1mo')
  }
  for (const item of (scans[d]?.persistent || [])) {
    const entry = klineMap[item.stock_id]
    if (!entry) continue
    item.price_history    = getKlineBars(entry, '1d')
    item.price_history_wk = getKlineBars(entry, '1wk')
    item.price_history_mo = getKlineBars(entry, '1mo')
  }
}
console.log(`K-line: injected into stocks across ${recentDates.length} dates`)

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
const lastScanExecDate = getLastScanExecDate()
console.log(`Last scan execution date: ${lastScanExecDate ?? 'unknown'}`)
writeFileSync(OUTPUT_FILE, JSON.stringify({ generated_at: new Date().toISOString(), last_scan_exec_date: lastScanExecDate, dates, scans, prediction, predictionHistory, news, quota, notionMap, aggregateLatest, outcomeStats }), 'utf-8')
console.log(`data.json written (${(readFileSync(OUTPUT_FILE).length / 1024).toFixed(0)} KB)`)
