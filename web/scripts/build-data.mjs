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

// Outcome stats only count scan data on or after this date.
// Set to a date when the scoring system was stable. Changing this resets the win-rate panel.
const OUTCOME_STATS_SINCE = '2026-06-23'

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

// ── Prediction enrichment (fills gaps left null by the Python pipeline) ───────
// Strip leading 【…即時新聞】timestamps and the trailing " - 來源" Google News suffix.
function cleanHeadline(t) {
  return String(t || '')
    .replace(/^【[^】]*】\s*/, '')
    .replace(/\s*[-–—]\s*[^-–—]+$/, '')
    .trim()
}

// Rule-based news sentiment, mirroring NewsFeed.jsx getSentiment().
// Only used to backfill when the pipeline left counts at zero.
function computeNewsSentiment(articles) {
  const bullRe = /買超|利多|看好|創高|突破|拿下|接單|升值|降息|解盲.*過關|FDA.*核准|漲停|大漲|上漲|攀升|勁揚|走強|看俏|樂觀|回升/
  const bearRe = /賣超|利空|看壞|跌停|重挫|暴跌|崩跌|空單增|賣壓|放空|大跌|下跌|走低|下修|承壓|走弱|示警|疑慮/
  let bull = 0, bear = 0
  const bullHeads = [], bearHeads = []
  for (const a of articles) {
    const t = (a.title || '') + ' ' + (a.summary || '')
    const isBull = bullRe.test(t) && !bearRe.test(t)
    const isBear = bearRe.test(t) && !bullRe.test(t)
    if (isBull) { bull++; if (bullHeads.length < 6) bullHeads.push(cleanHeadline(a.title)) }
    else if (isBear) { bear++; if (bearHeads.length < 3) bearHeads.push(cleanHeadline(a.title)) }
  }
  const total = bull + bear
  const impact = total > 0 ? Math.round(((bull - bear) / total) * 100) / 100 : 0
  // key events: lead with bullish headlines, then a couple bearish for balance
  const key_events = [...bullHeads.slice(0, 4), ...bearHeads.slice(0, 1)].filter(Boolean)
  return { bullish_count: bull, bearish_count: bear, market_impact: impact, key_events }
}

// Fetch latest daily % change (and last close) for a symbol from Yahoo Finance.
async function fetchYahooQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`
    const txt = await fetchUrl(url, 8000)
    const j = JSON.parse(txt)
    const res = j?.chart?.result?.[0]
    const closes = (res?.indicators?.quote?.[0]?.close || []).filter(v => v != null)
    if (closes.length < 2) return null
    const last = closes[closes.length - 1], prev = closes[closes.length - 2]
    if (!(prev > 0)) return null
    return { ret: (last - prev) / prev, last }
  } catch (e) {
    console.warn(`  Yahoo ${symbol} failed: ${e.message}`)
    return null
  }
}

// Backfill US overnight market fields that the pipeline left null.
async function enrichUsMarketData(md) {
  const out = { ...(md || {}) }
  const r4 = v => Math.round(v * 10000) / 10000
  if (out.nasdaq_ret == null)  { const r = await fetchYahooQuote('^IXIC'); if (r) out.nasdaq_ret = r4(r.ret) }
  if (out.sox_ret == null)     { const r = await fetchYahooQuote('^SOX');  if (r) out.sox_ret = r4(r.ret) }
  if (out.tsm_adr_ret == null) { const r = await fetchYahooQuote('TSM');   if (r) out.tsm_adr_ret = r4(r.ret) }
  if (out.vix == null)         { const r = await fetchYahooQuote('^VIX');  if (r) out.vix = Math.round(r.last * 10) / 10 }
  return out
}

// Enrich a prediction object in-place-ish (returns a new object). Safe no-op on null.
async function enrichPrediction(prediction, articles) {
  if (!prediction) return prediction
  const out = { ...prediction }
  // 1) News sentiment — backfill only when the pipeline produced nothing.
  const ns = out.news_sentiment || {}
  const noCounts = !(ns.bullish_count > 0) && !(ns.bearish_count > 0)
  if (noCounts && Array.isArray(articles) && articles.length > 0) {
    const computed = computeNewsSentiment(articles)
    if (computed.bullish_count + computed.bearish_count > 0) {
      out.news_sentiment = { ...ns, ...computed }
      console.log(`  Enriched news sentiment: 利多${computed.bullish_count}/利空${computed.bearish_count} 影響${computed.market_impact}`)
    }
  }
  // 2) US overnight market data — backfill null fields from Yahoo.
  const md = out.market_data || {}
  if (md.nasdaq_ret == null || md.sox_ret == null || md.tsm_adr_ret == null || md.vix == null) {
    out.market_data = await enrichUsMarketData(md)
    console.log(`  Enriched US market: 那指${out.market_data.nasdaq_ret ?? 'n/a'} 費半${out.market_data.sox_ret ?? 'n/a'} TSM${out.market_data.tsm_adr_ret ?? 'n/a'} VIX${out.market_data.vix ?? 'n/a'}`)
  }
  return out
}


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

    // Always compute score_pct (entry_score percentile rank) for every stock so the
    // detail panel can display 市場百分位 regardless of grade source.
    const sortedScores = allStocks.map(r => toNum(r.entry_score)).sort((a, b) => a - b)
    const n = sortedScores.length
    allStocks.forEach(row => {
      const sc = toNum(row.entry_score)
      let lo = 0, hi = n
      while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedScores[m] <= sc) lo = m + 1; else hi = m }
      row.score_pct = String(Math.round((n > 0 ? lo / n * 100 : 50) * 10) / 10)
    })

    // Apply grade fallback ONLY when grades are truly absent (scan_enrich.py hasn't run yet).
    // If grades are present (any of A/B/C/D/X), honour them even when no A/B exists —
    // a weak day where every stock is legitimately C/D/X is valid signal, not missing data.
    const hasAnyGrade = allStocks.some(r => r.grade && r.grade.trim() !== '')
    if (!hasAnyGrade) {
      console.log(`    [grade] no grades in CSV — applying percentile fallback`)
      allStocks.forEach(row => {
        const ld = toNum(row.limit_down_streak), pct = toNum(row.score_pct)
        row.grade = ld >= 1 ? 'X' : pct >= 98 ? 'A' : pct >= 90 ? 'B' : pct >= 75 ? 'C' : 'D'
      })
    }

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
      // boolean signal flags from strategy.py — used in signal-chip panel
      macd_golden_cross: toBool(row.macd_golden_cross),
      hist_turn_positive: toBool(row.hist_turn_positive),
      above_ema60: toBool(row.above_ema60),
      ema60_gt_ema120: toBool(row.ema60_gt_ema120),
      volume_break: toBool(row.volume_break),
      rsi_strong: toBool(row.rsi_strong),
      adx_trending: toBool(row.adx_trending),
      breakout_20d: toBool(row.breakout_20d),
      foreign_buy_3d: toBool(row.foreign_buy_3d),
      stronger_than_market: toBool(row.stronger_than_market),
      kd_golden_cross: toBool(row.kd_golden_cross),
      obv_uptrend: toBool(row.obv_uptrend),
      invest_trust_buy_2d: toBool(row.invest_trust_buy_2d),
      dealer_buy_3d: toBool(row.dealer_buy_3d),
      bb_squeeze_breakout: toBool(row.bb_squeeze_breakout),
      breakout_volume_confirm: toBool(row.breakout_volume_confirm),
      williams_r_recovery: toBool(row.williams_r_recovery),
      cci_momentum: toBool(row.cci_momentum),
      mfi_strong: toBool(row.mfi_strong),
      above_ichimoku_cloud: toBool(row.above_ichimoku_cloud),
      macd_death_cross: toBool(row.macd_death_cross),
      close_below_ema20: toBool(row.close_below_ema20),
      close_below_swing_low: toBool(row.close_below_swing_low),
      long_upper_shadow: toBool(row.long_upper_shadow),
      open_high_close_low: toBool(row.open_high_close_low),
      // exit signals
      base_exit_signal: toBool(row.base_exit_signal),
      base_exit_reason: row.base_exit_reason || '',
      // insider / buyback
      insider_net_30d: r2(row.insider_net_30d),
      has_buyback: toBool(row.has_buyback),
      // derived boolean flags for UI signal-chip filters
      f_score_high: toNum(row.f_score) >= 7,
      margin_shrinking: r2(row.margin_change_5d) < -1,
      volume_surge_3x: r2(row.volume_ratio) >= 3,
      // extra numeric fields not previously exported
      volume_ma20: r2(row.volume_ma20),
      sma5: r2(row.sma5),
      sma10: r2(row.sma10),
      // attach price history only for latest date (to keep JSON lean)
      price_history: isLatest ? (priceHistoryMap[row.stock_id] || []) : undefined,
      ...extra,
    })
    const topStocks = allStocks.slice(0, TOP_N).map((row, i) => ({ rank: i + 1, ...mapStock(row) }))
    const limitDownAlerts = allStocks
      .filter(r => toNum(r.limit_down_streak) >= 3)
      .sort((a, b) => toNum(b.limit_down_streak) - toNum(a.limit_down_streak))
      .map(r => mapStock(r))

    // Slim profile for ALL scanned stocks — included on every date so grade/signal
    // filters in the Dashboard work against the full scan universe, not just top N.
    // Fields kept minimal to control data.json growth.
    const filterStocks = allStocks.map(row => ({
      stock_id: row.stock_id,
      name: row.name || '',
      industry_category: row.industry_category || '',
      grade: row.grade || '',
      score_pct: toNum(row.score_pct),
      entry_signal: toBool(row.entry_signal),
      entry_score: Math.round(toNum(row.entry_score)),
      close: r2(row.close),
      volume_ratio: r2(row.volume_ratio),
      rsi14: r2(row.rsi14),
      adx14: r2(row.adx14),
      foreign_buy_streak: toNum(row.foreign_buy_streak),
      invest_trust_streak: toNum(row.invest_trust_streak),
      f_score: toNum(row.f_score),
      revenue_yoy: r2(row.revenue_yoy),
      day_return: r2(row.day_return),
      limit_down_streak: toNum(row.limit_down_streak),
      // boolean signal flags (used by signal-chip filters and preset combos)
      macd_golden_cross: toBool(row.macd_golden_cross),
      kd_golden_cross: toBool(row.kd_golden_cross),
      foreign_buy_3d: toBool(row.foreign_buy_3d),
      invest_trust_buy_2d: toBool(row.invest_trust_buy_2d),
      above_ichimoku_cloud: toBool(row.above_ichimoku_cloud),
      bb_squeeze_breakout: toBool(row.bb_squeeze_breakout),
      breakout_20d: toBool(row.breakout_20d),
      volume_break: toBool(row.volume_break),
      adx_trending: toBool(row.adx_trending),
      rsi_strong: toBool(row.rsi_strong),
      above_ema60: toBool(row.above_ema60),
      ema60_gt_ema120: toBool(row.ema60_gt_ema120),
      ma5_above_ma10: toBool(row.ma5_above_ma10),
      breakout_volume_confirm: toBool(row.breakout_volume_confirm),
      f_score_high: toNum(row.f_score) >= 7,
      margin_shrinking: r2(row.margin_change_5d) < -1,
      volume_surge_3x: r2(row.volume_ratio) >= 3,
      // extra fields for full-universe sort, leaderboard, and additional presets
      market_rs_rank: toNum(row.market_rs_rank),
      sector_rs_rank: toNum(row.sector_rs_rank),
      gap_to_20d_high_pct: r2(row.gap_to_20d_high_pct),
      dealer_buy_streak: toNum(row.dealer_buy_streak),
      dealer_buy_3d: toBool(row.dealer_buy_3d),
      foreign_buy_accel: toBool(row.foreign_buy_accel),
      invest_trust_accel: toBool(row.invest_trust_accel),
      is_sector_leader: toBool(row.is_sector_leader),
      base_exit_signal: toBool(row.base_exit_signal),
    }))

    scans[date] = { total_scanned: allStocks.length, entry_count: allStocks.filter(r => toBool(r.entry_signal)).length, top_stocks: topStocks, filter_stocks: filterStocks, limit_down_alerts: limitDownAlerts, is_partial: allStocks.length < 500, data_date: dominantDataDate }
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
      return { stock_id: sid, name: d.name, industry_category: d.industry_category, days_in_top: d.scores.length, latest_score: Math.round(sorted[0].score), score_trend: Math.round(sorted[0].score - sorted[1].score) }
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
  // Only count dates on or after OUTCOME_STATS_SINCE to allow a clean reset.
  for (let i = 5; i < dates.length; i++) {
    const entryDate = dates[i]
    if (OUTCOME_STATS_SINCE && entryDate < OUTCOME_STATS_SINCE) continue
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

// ── Strategy accuracy: score-ranked buckets vs baseline (1/5/10-day) ──────────
// computeOutcomeStats groups by `grade` (a column only present in aggregate-
// enriched data, so it's empty for historical batch CSVs), and entry_signal=True
// is far too rare to measure (≈2 in 7000). This instead ranks each day's scanned
// universe by entry_score and asks: do top-decile / top-quartile picks beat the
// whole-universe baseline on forward return? Validates the dashboard's ranking.
function computeStrategyAccuracy(dates, dateMap, priceHistoryMap) {
  const HORIZONS = [1, 5, 10]
  const maxH = Math.max(...HORIZONS)
  const mk = () => Object.fromEntries(HORIZONS.map(h => [h, { wins: 0, total: 0, sumRet: 0 }]))
  const groups = { top10: mk(), top25: mk(), baseline: mk() }

  if (dates.length < maxH + 1) return finalize()

  // dates sorted desc; skip the maxH most recent (no forward outcome yet)
  // Respect OUTCOME_STATS_SINCE to allow a clean baseline reset.
  for (let i = maxH; i < dates.length; i++) {
    const entryDate = dates[i]
    if (OUTCOME_STATS_SINCE && entryDate < OUTCOME_STATS_SINCE) continue
    const rows = dateMap[entryDate]
    if (!rows) continue

    // dedupe per stock (keep best score), then rank by entry_score for this day
    const best = {}
    for (const row of rows) {
      const sid = row.stock_id
      const sc = parseFloat(row.entry_score)
      if (isNaN(sc)) continue
      if (!best[sid] || sc > best[sid].score) best[sid] = { sid, score: sc }
    }
    const ranked = Object.values(best).sort((a, b) => b.score - a.score)
    const n = ranked.length
    if (n < 10) continue
    const top10Cut = Math.ceil(n * 0.10)
    const top25Cut = Math.ceil(n * 0.25)

    ranked.forEach((item, rank) => {
      const history = priceHistoryMap[item.sid]
      if (!history) return
      const entryIdx = history.findIndex(h => h.time === entryDate)
      if (entryIdx < 0) return
      const entryPrice = history[entryIdx].close
      if (entryPrice <= 0) return
      for (const h of HORIZONS) {
        if (entryIdx + h >= history.length) continue
        const exitPrice = history[entryIdx + h].close
        if (exitPrice <= 0) continue
        const ret = (exitPrice - entryPrice) / entryPrice
        const tally = g => { g[h].total++; g[h].sumRet += ret; if (ret > 0) g[h].wins++ }
        tally(groups.baseline)
        if (rank < top10Cut) tally(groups.top10)
        if (rank < top25Cut) tally(groups.top25)
      }
    })
  }
  return finalize()

  function finalize() {
    const fmt = g => Object.fromEntries(HORIZONS.map(h => {
      const v = g[h]
      return [`d${h}`, {
        total: v.total,
        win_rate: v.total >= 10 ? Math.round(v.wins / v.total * 1000) / 10 : null,
        avg_return_pct: v.total >= 10 ? Math.round(v.sumRet / v.total * 10000) / 100 : null,
      }]
    }))
    return { top10: fmt(groups.top10), top25: fmt(groups.top25), baseline: fmt(groups.baseline), horizons: HORIZONS }
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

// ── TWSE T86 institutional supplement ────────────────────────────────────────
// Fetches 三大法人買賣超 from TWSE public API when scan data is missing it.
// Returns { stock_id: { foreign_net, invest_trust_net, dealer_net } } or null.
async function fetchTWSEInstitutional(dateYYYYMMDD) {
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${dateYYYYMMDD}&selectType=ALLBUT0999`
  try {
    const body = await fetchUrl(url, 12000)
    const json = JSON.parse(body)
    if (json.stat !== 'OK' || !Array.isArray(json.data) || json.data.length < 10) return null
    const result = {}
    for (const row of json.data) {
      const sid = (row[0] || '').trim().replace(/\s/g, '')
      if (!sid || !/^\d{4,6}$/.test(sid)) continue
      // TWSE T86 columns: [代號, 名稱, 外資買, 外資賣, 外資差, 投信買, 投信賣, 投信差, 自營差(自), 自營差(避), 自營差, 合計]
      // Values in 股 (shares) → divide by 1000 to get 張
      const toZhang = v => { const n = parseInt((v || '').replace(/,/g, ''), 10); return isNaN(n) ? 0 : Math.round(n / 1000) }
      result[sid] = {
        foreign_net:       toZhang(row[4]),
        invest_trust_net:  toZhang(row[7]),
        dealer_net:        toZhang(row[10]),
      }
    }
    return Object.keys(result).length > 100 ? result : null
  } catch (e) {
    console.warn(`  TWSE T86 fetch failed: ${e.message}`)
    return null
  }
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

console.log('Computing strategy accuracy (entry_signal vs baseline)...')
const strategyAccuracy = computeStrategyAccuracy(dates, dateMap, priceHistoryMap)
console.log(`Strategy accuracy: top10 5d win=${strategyAccuracy.top10?.d5?.win_rate ?? 'n/a'}% (${strategyAccuracy.top10?.d5?.total ?? 0}), baseline 5d win=${strategyAccuracy.baseline?.d5?.win_rate ?? 'n/a'}%`)

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
    // Build grade lookup from the CSV-based scan (scan_enrich.py assigns C/D/X using
    // absolute criteria).  The aggregate uses relative percentile → all top-20 become
    // A even when no entry signal exists, which misleads users.  Prefer scan_enrich
    // grades over aggregate percentile grades when available.
    const csvGradeMap = {}
    for (const s of (scans[aggExecDate]?.top_stocks || [])) {
      if (s.stock_id && s.grade) csvGradeMap[s.stock_id] = s.grade
    }
    const hasCSVGrades = Object.keys(csvGradeMap).length > 0

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
      revenue_yoy: r.revenue_yoy || 0,
      revenue_mom: r.revenue_mom || 0,
      expected_hold_days: r.expected_hold_days || 0,
      base_exit_signal: !!r.base_exit_signal,
      base_exit_reason: r.base_exit_reason || '',
      gap_to_20d_high_pct: r.gap_to_20d_high_pct ?? null,
      // derived boolean flags (must mirror mapStock)
      f_score_high: (r.f_score || 0) >= 7,
      margin_shrinking: (r.margin_change_5d || 0) < -1,
      volume_surge_3x: (r.volume_ratio || 0) >= 3,
      // cross-sectional signals
      // Prefer scan_enrich.py grade (absolute criteria) over aggregate percentile grade.
      // Aggregate scores all top-20 as A (they're all in top 2% of 1412) which is
      // misleading when no entry signals are present — scan_enrich gives C/D/X instead.
      grade: (hasCSVGrades ? (csvGradeMap[String(r.stock_id || '')] || '') : '') || r.grade || '',
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
      // boolean signal flags (mirror of mapStock — needed so 技術訊號 section appears on agg scans)
      macd_golden_cross: !!r.macd_golden_cross,
      hist_turn_positive: !!r.hist_turn_positive,
      above_ema60: !!r.above_ema60,
      ema60_gt_ema120: !!r.ema60_gt_ema120,
      volume_break: !!r.volume_break,
      rsi_strong: !!r.rsi_strong,
      adx_trending: !!r.adx_trending,
      breakout_20d: !!r.breakout_20d,
      foreign_buy_3d: !!r.foreign_buy_3d,
      stronger_than_market: !!r.stronger_than_market,
      kd_golden_cross: !!r.kd_golden_cross,
      obv_uptrend: !!r.obv_uptrend,
      invest_trust_buy_2d: !!r.invest_trust_buy_2d,
      dealer_buy_3d: !!r.dealer_buy_3d,
      bb_squeeze_breakout: !!r.bb_squeeze_breakout,
      breakout_volume_confirm: !!r.breakout_volume_confirm,
      williams_r_recovery: !!r.williams_r_recovery,
      cci_momentum: !!r.cci_momentum,
      mfi_strong: !!r.mfi_strong,
      above_ichimoku_cloud: !!r.above_ichimoku_cloud,
      macd_death_cross: !!r.macd_death_cross,
      close_below_ema20: !!r.close_below_ema20,
      long_upper_shadow: !!r.long_upper_shadow,
      open_high_close_low: !!r.open_high_close_low,
      volume_ma20: r.volume_ma20 || 0,
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
      filter_stocks: scans[aggExecDate]?.filter_stocks,  // preserve slim full-universe list from CSV scan if present
      limit_down_alerts: aggLimitDown,
      persistent: (aggregateLatest.persistent_strong || []).map(p => ({
        stock_id: p.stock_id, name: p.name, industry_category: p.industry_category,
        days_in_top: p.days_in_top, latest_score: p.today_score || p.latest_score || 0,
        score_trend: p.score_delta || 0,
      })),
      margin_stats: aggregateLatest.margin_stats || {},
      ai_picks_text: aggregateLatest.ai_picks_text || '',
      calendar_risk: aggregateLatest.calendar_risk || '',
      data_date: aggDate,
      from_aggregate_json: true,
    }
    // Insert in chronological position (descending) — never blindly to front.
    // A stale aggregate_latest.json (older than the newest CSV scan) must NOT
    // become dates[0], or the dashboard reports it as the latest data.
    if (!dates.includes(aggExecDate)) {
      dates.push(aggExecDate)
      dates.sort((a, b) => b.localeCompare(a))
    }
    const csvOverrideCount = aggTopStocks.filter(s => csvGradeMap[s.stock_id]).length
    console.log(`  Injected aggregate date ${aggDate}→${aggExecDate}: ${aggregateLatest.total_scanned} stocks, ai=${!!aggregateLatest.ai_picks_text}, csv_grades_used=${csvOverrideCount}/${aggTopStocks.length}`)
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
  const firstEntry = firstKey ? klineMap[firstKey] : null
  const sampleDays = Array.isArray(firstEntry) ? firstEntry.length : (firstEntry?.['1d']?.length ?? 0)
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

// Write stock_histories.json — last ~120 OHLCV bars for ALL stocks (for Dashboard lazy load).
// Carries full open/high/low/close/volume + dates so the detail modal can draw real candles
// and compute KD / ADX / OBV-based indicators + strategy backtest for every scanned stock
// (not just the rich top_stocks). Loaded lazily so it doesn't block the initial render.
//
// Compact shared-dates layout (Taiwan stocks share one trading calendar):
//   { generated_at, dates: ["YYYY-MM-DD", ...], stocks: { id: { o, h, l, c, v } } }
// Each per-stock array is aligned to `dates`; missing bars are null.
const HISTORIES_FILE = join(PUBLIC_DIR, 'stock_histories.json')
const OHLC_BARS = 200
const round2 = v => (v == null || !isFinite(v)) ? null : Math.round(v * 100) / 100
const perStockRecent = {}
const dateSet = new Set()
for (const [stockId, entry] of Object.entries(klineMap)) {
  const bars = getKlineBars(entry, '1d')
  if (!bars || bars.length < 2) continue
  const recent = bars.slice(-OHLC_BARS)
  perStockRecent[stockId] = recent
  for (const b of recent) if (b.time) dateSet.add(b.time)
}
const historiesDates = [...dateSet].sort().slice(-OHLC_BARS)
const dateIndex = new Map(historiesDates.map((d, i) => [d, i]))
const historiesStocks = {}
for (const [stockId, recent] of Object.entries(perStockRecent)) {
  const N = historiesDates.length
  const o = new Array(N).fill(null), h = new Array(N).fill(null)
  const l = new Array(N).fill(null), c = new Array(N).fill(null), v = new Array(N).fill(null)
  let filled = 0
  for (const b of recent) {
    const idx = b.time != null ? dateIndex.get(b.time) : undefined
    if (idx == null) continue
    o[idx] = round2(b.open); h[idx] = round2(b.high); l[idx] = round2(b.low)
    c[idx] = round2(b.close); v[idx] = (b.volume == null || !isFinite(b.volume)) ? null : Math.round(b.volume)
    filled++
  }
  if (filled < 2) continue
  historiesStocks[stockId] = { o, h, l, c, v }
}

// Build extended scan price history for ALL scanned stocks not in klineMap.
// Uses all available scan dates (not just the display dates limit of MAX_DATES) so the
// frontend has enough daily bars for MACD/RSI warmup on weekly/monthly indicator charts.
// Format: compact [date, open, high, low, close, volume] tuples per stock.
const scanStocksHistory = {}
const allScanDatesAsc = Object.keys(dateMap).sort()  // ascending = oldest first
for (const d of allScanDatesAsc) {
  const seen = new Set()
  for (const row of (dateMap[d] || [])) {
    const sid = row.stock_id
    if (seen.has(sid)) continue
    seen.add(sid)
    if (klineMap[sid]) continue  // klineMap has richer OHLCV data, skip
    const c = toNum(row.close)
    if (c <= 0 || c > 100000) continue
    if (!scanStocksHistory[sid]) scanStocksHistory[sid] = []
    if (scanStocksHistory[sid].length < 250) {
      scanStocksHistory[sid].push([
        d,
        Math.round((toNum(row.open) || c) * 100) / 100,
        Math.round((toNum(row.high) || c) * 100) / 100,
        Math.round((toNum(row.low) || c) * 100) / 100,
        Math.round(c * 100) / 100,
        Math.round(toNum(row.volume) || 0),
      ])
    }
  }
}
const scanStocksFiltered = Object.fromEntries(
  Object.entries(scanStocksHistory).filter(([, bars]) => bars.length >= 10)
)
writeFileSync(HISTORIES_FILE, JSON.stringify({ generated_at: new Date().toISOString(), dates: historiesDates, stocks: historiesStocks, scan_stocks: scanStocksFiltered }), 'utf-8')
console.log(`stock_histories.json written (${Object.keys(historiesStocks).length} kline + ${Object.keys(scanStocksFiltered).length} scan stocks, ${historiesDates.length} kline bars, ${(readFileSync(HISTORIES_FILE).length / 1024).toFixed(0)} KB)`)

let prediction = readPrediction()
const predictionHistory = readPredictionHistory()
console.log(`Prediction: ${prediction ? prediction.date : 'none'}, history: ${predictionHistory.length} entries`)

console.log('Reading news corpus...')
let news = readNewsCorpus()
if (news.length === 0) {
  console.log('Corpus empty, fetching live news...')
  news = await fetchNews()
}
console.log(`News: ${news.length} total items`)

// Backfill prediction gaps (US market data + news sentiment) the pipeline left empty.
try {
  prediction = await enrichPrediction(prediction, news)
} catch (e) {
  console.warn('  Prediction enrichment skipped:', e.message)
}

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

// ── Data quality verification ─────────────────────────────────────────────────
const todayTW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
const latestExecDate = dates[0] || ''
const latestScanObj = latestExecDate ? (scans[latestExecDate] || {}) : {}
// Use actual FinMind market data date (data_date) when available; fall back to exec date
const latestDataDate = latestScanObj.data_date || latestExecDate
const topStocks = latestScanObj.top_stocks || []
// Count stocks with valid technical data (RSI > 0, ADX > 0)
const validCount = topStocks.filter(s => (s.rsi14 || 0) > 0 && (s.adx14 || 0) > 0).length
const totalTop = topStocks.length
// Count stocks carrying any institutional signal. Taiwan 三大法人 data is published
// after market close (~15-17:00 CST); a morning scan returns all-zero institutional
// fields, which strips the foreign/invest/dealer soft-signal bonuses and reshuffles
// the TOP ranking. Detect that degenerate state so the UI can warn instead of
// silently showing a technical-only ranking.
const instCount = topStocks.filter(s =>
  (s.foreign_net || 0) !== 0 || (s.foreign_buy_streak || 0) !== 0 ||
  (s.invest_trust_net || 0) !== 0 || (s.invest_trust_streak || 0) !== 0
).length
const instRatio = totalTop > 0 ? Math.round(instCount / totalTop * 100) : null
const institutionalOk = totalTop === 0 ? null : instCount >= Math.max(5, Math.floor(totalTop * 0.15))
// Detect trading day gap between actual market data date and today
function tradingDaysBehind(latest, today) {
  if (!latest || !today) return null
  const d1 = new Date(latest), d2 = new Date(today)
  let diff = 0, cur = new Date(d1)
  cur.setDate(cur.getDate() + 1)
  while (cur <= d2) {
    const dow = cur.getDay()
    if (dow !== 0 && dow !== 6) diff++
    cur.setDate(cur.getDate() + 1)
  }
  return diff
}
const daysBehind = tradingDaysBehind(latestDataDate, todayTW)
const isFresh = daysBehind !== null && daysBehind <= 1  // 0=same day, 1=T+1 normal
const dataQuality = {
  latest_data_date: latestDataDate,
  today_tw: todayTW,
  days_behind: daysBehind,
  is_fresh: isFresh,
  total_stocks: latestScanObj.total_scanned || 0,
  top_valid_ratio: totalTop > 0 ? Math.round(validCount / totalTop * 100) : null,
  fields_ok: totalTop === 0 ? null : validCount >= Math.floor(totalTop * 0.9),
  institutional_ok: institutionalOk,
  institutional_ratio: instRatio,
  build_time: new Date().toISOString(),
}
console.log(`Data quality: fresh=${dataQuality.is_fresh}, days_behind=${daysBehind}, valid_ratio=${dataQuality.top_valid_ratio}%, inst_ratio=${instRatio}%`)

// ── Supplement 法人 data from TWSE T86 ───────────────────────────────────────
// Always run when fresh, filling only gaps (don't overwrite existing scan data).
// This catches the common case where coverage is partial (e.g. 60%) but not zero.
if (latestDataDate && isFresh) {
  const dateStr = latestDataDate.replace(/-/g, '')
  console.log(`嘗試從 TWSE T86 補抓法人資料 (${dateStr}, 目前 inst_ratio=${instRatio}%)...`)
  const twseData = await fetchTWSEInstitutional(dateStr)
  if (twseData) {
    let merged = 0
    for (const stock of topStocks) {
      const inst = twseData[stock.stock_id]
      if (!inst) continue
      // Only fill gaps — don't overwrite non-zero scan data
      const missingForeign = (stock.foreign_net || 0) === 0 && inst.foreign_net !== 0
      const missingTrust   = (stock.invest_trust_net || 0) === 0 && inst.invest_trust_net !== 0
      const missingDealer  = (stock.dealer_net || 0) === 0 && inst.dealer_net !== 0
      if (missingForeign) { stock.foreign_net      = inst.foreign_net;      merged++ }
      if (missingTrust)   { stock.invest_trust_net = inst.invest_trust_net }
      if (missingDealer)  { stock.dealer_net       = inst.dealer_net }
    }
    const newInstCount = topStocks.filter(s =>
      (s.foreign_net || 0) !== 0 || (s.invest_trust_net || 0) !== 0
    ).length
    dataQuality.institutional_ok    = newInstCount >= Math.max(5, Math.floor(totalTop * 0.15))
    dataQuality.institutional_ratio = totalTop > 0 ? Math.round(newInstCount / totalTop * 100) : null
    if (merged > 0) dataQuality.institutional_source = 'twse_t86'
    console.log(`  TWSE T86 補抓完成：${merged} 支填補，inst_ratio=${dataQuality.institutional_ratio}%`)
  } else {
    console.log('  TWSE T86 無資料（可能盤後尚未公布或非交易日）')
  }
}

writeFileSync(OUTPUT_FILE, JSON.stringify({ generated_at: new Date().toISOString(), last_scan_exec_date: lastScanExecDate, dates, scans, prediction, predictionHistory, news, quota, notionMap, aggregateLatest, outcomeStats, strategyAccuracy, dataQuality }), 'utf-8')
console.log(`data.json written (${(readFileSync(OUTPUT_FILE).length / 1024).toFixed(0)} KB)`)
