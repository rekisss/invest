import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import https from 'https'
import http from 'http'
import { simulatePaperTrader, simulateAdaptiveTrader, simulateEnsembleTrader } from './paper-trader.mjs'

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
        if (diff === 0) return true
        // 隔夜換算（資料日 = 執行日−1）只在「執行日自己沒有資料」時才成立——
        // 否則兩個不同交易日會被併進同一桶（實例：06-16 整天被併進 06-17、
        // 07-01 與 07-02 混桶），一天憑空消失、且去重後顯示到前一天的收盤價。
        return diff > 0 && diff <= 1 && !rawDateMap[d]
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
  // Drop degenerate scans (< MIN_VALID_STOCKS) — including the newest. A scan that
  // ran overnight while FinMind quota was exhausted can produce e.g. 88 stocks; the
  // old `i === 0` exemption made that the PRIMARY date, replacing yesterday's complete
  // scan with a broken 88-stock leaderboard. Now the newest COMPLETE date wins.
  let dates = _allDatesDesc
    .filter(d => uniqueCountPerDate[d] >= MIN_VALID_STOCKS)
    .slice(0, MAX_DATES)
  // Safety net: if every date is tiny (unlikely), fall back to showing them anyway.
  if (dates.length === 0) dates = _allDatesDesc.slice(0, MAX_DATES)
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
    // 壞價（close<=0，停牌/下市殘影）不得進榜/過濾池——前端會顯示 0.00 且百分比運算全爆
    const pricedStocks = allStocks.filter(r => toNum(r.close) > 0)
    const topStocks = pricedStocks.slice(0, TOP_N).map((row, i) => ({ rank: i + 1, ...mapStock(row) }))
    // A/B/C grade only — the "精選" pool. D-grade stocks tracked but not surfaced as actionable.
    // Also exclude rows with an invalid price (≤0 / missing) — halted/delisted stubs.
    const selectableStocks = topStocks.filter(r => ['A','B','C'].includes(r.grade) && toNum(r.close) > 0)
    const limitDownAlerts = allStocks
      .filter(r => toNum(r.limit_down_streak) >= 3)
      .sort((a, b) => toNum(b.limit_down_streak) - toNum(a.limit_down_streak))
      .map(r => mapStock(r))

    // Slim profile for ALL scanned stocks — included on every date so grade/signal
    // filters in the Dashboard work against the full scan universe, not just top N.
    // Fields kept minimal to control data.json growth.
    const filterStocks = pricedStocks.map(row => ({
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
      // 法人 net (張) — carried so the TWSE T86 build-time supplement can backfill
      // the full universe, not just top stocks (FinMind often returns these empty).
      foreign_net: r2(row.foreign_net),
      invest_trust_net: r2(row.invest_trust_net),
      dealer_net: r2(row.dealer_net),
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
      // 風險警示旗標:只在「有進場訊號且旗標為真」時寫入(控制 data.json 體積)。
      // DailyActionBrief 的風險提醒只掃進場訊號股,榜外(非 top N)的進場股原本
      // 缺這些欄位而永遠不會被列入警示。
      ...(toBool(row.entry_signal) ? {
        ...(toBool(row.macd_death_cross) ? { macd_death_cross: true } : {}),
        ...(toBool(row.close_below_ema20) ? { close_below_ema20: true } : {}),
        ...(toBool(row.long_upper_shadow) ? { long_upper_shadow: true } : {}),
        ...(toBool(row.open_high_close_low) ? { open_high_close_low: true } : {}),
      } : {}),
    }))

    const gradeCount = { A: 0, B: 0, C: 0, D: 0, X: 0 }
    for (const r of topStocks) gradeCount[r.grade] = (gradeCount[r.grade] || 0) + 1
    scans[date] = {
      total_scanned: allStocks.length,
      entry_count: allStocks.filter(r => toBool(r.entry_signal)).length,
      top_stocks: topStocks,
      selectable_stocks: selectableStocks,  // A/B/C grade only — excludes D-grade from 精選
      grade_counts: gradeCount,
      filter_stocks: filterStocks,
      limit_down_alerts: limitDownAlerts,
      is_partial: allStocks.length < 500,
      data_date: dominantDataDate,
    }
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
  const mk = () => Object.fromEntries(HORIZONS.map(h => [h, { wins: 0, total: 0, sumRet: 0 }]))
  const groups = { top10: mk(), top25: mk(), baseline: mk() }

  if (dates.length < 2) return finalize()

  // dates sorted desc. Don't skip a fixed maxH window up front — the per-horizon
  // guard below (entryIdx + h >= history.length) already drops horizons without
  // enough forward data, so skipping maxH here needlessly zeroed the d1/d5
  // win rates for every recent date (only d10 needs 10 forward bars).
  // Respect OUTCOME_STATS_SINCE to allow a clean baseline reset.
  for (let i = 0; i < dates.length; i++) {
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
    // 依欄名定位而非寫死索引：ALLBUT0999 版面實際有 19 欄（含外陸資/外資自營商拆分），
    // 固定 row[7]/row[10] 會把「外資自營商」寫進投信、「投信」寫進自營商。
    const fields = Array.isArray(json.fields) ? json.fields.map(f => String(f)) : []
    const idxOf = (...keys) => fields.findIndex(f => keys.every(k => f.includes(k)))
    let iForeign = idxOf('外陸資', '買賣超')
    if (iForeign < 0) iForeign = idxOf('外資', '買賣超')          // 舊版面 fallback
    const iTrust  = idxOf('投信', '買賣超')
    // 「外資自營商買賣超股數」也含「自營商買賣超」字樣，必須排除「外資」才會落在
    // 自營商合計欄（合計欄在(自行買賣)/(避險)拆分欄之前，取第一個符合者即合計）。
    const iDealer = fields.findIndex(f => f.includes('自營商') && f.includes('買賣超') && !f.includes('外資'))
    if (iForeign < 0 || iTrust < 0 || iDealer < 0) {
      console.warn(`  TWSE T86 欄位對不上（fields=${fields.join('|')}），跳過補值以免寫錯欄`)
      return null
    }
    const result = {}
    for (const row of json.data) {
      const sid = (row[0] || '').trim().replace(/\s/g, '')
      if (!sid || !/^\d{4,6}$/.test(sid)) continue
      // Values in 股 (shares) → divide by 1000 to get 張
      const toZhang = v => { const n = parseInt((v || '').replace(/,/g, ''), 10); return isNaN(n) ? 0 : Math.round(n / 1000) }
      result[sid] = {
        foreign_net:       toZhang(row[iForeign]),
        invest_trust_net:  toZhang(row[iTrust]),
        dealer_net:        toZhang(row[iDealer]),
      }
    }
    return Object.keys(result).length > 100 ? result : null
  } catch (e) {
    console.warn(`  TWSE T86 fetch failed: ${e.message}`)
    return null
  }
}

// ── Taiwan stock industry category map from TWSE / TPEX open data ────────────
// Both TWSE (上市) and TPEX (上櫃) are tried; failures are silently swallowed.
async function fetchTaiwanIndustryMap() {
  const map = {}
  // TWSE listed (上市)
  try {
    // 上市公司基本資料 (t187ap03_L) — has 公司代號 + 產業別. The old
    // opendata.twse.com.tw host does not resolve (ENOTFOUND); openapi.twse.com.tw
    // is the working host (same one used for STOCK_DAY_ALL).
    const txt = await fetchUrl('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', 10000)
    const data = JSON.parse(txt)
    if (Array.isArray(data)) {
      for (const item of data) {
        const id  = (item['公司代號'] || item['Company Code'] || item['stockSymbol'] || item['code'] || '').trim()
        const cat = (item['產業別']   || item['Industry'] || item['industryType'] || item['industry'] || '').trim()
        if (id && cat) map[id] = cat
      }
    }
    console.log(`Industry map (TWSE): ${Object.keys(map).length} entries`)
  } catch (e) { console.warn('TWSE industry fetch skipped:', e.message) }
  // TPEX listed (上櫃) — catches most 6xxx/7xxx/8xxx stocks
  try {
    const txt = await fetchUrl('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis', 10000)
    const data = JSON.parse(txt)
    const before = Object.keys(map).length
    if (Array.isArray(data)) {
      for (const item of data) {
        const id  = (item['SecuritiesCompanyCode'] || item['股票代號'] || '').trim()
        const cat = (item['IndustryCategory'] || item['產業別'] || '').trim()
        if (id && cat && !map[id]) map[id] = cat
      }
    }
    console.log(`Industry map (TPEX): +${Object.keys(map).length - before} entries, total=${Object.keys(map).length}`)
  } catch (e) { console.warn('TPEX industry fetch skipped:', e.message) }
  return map
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
  // 用 > 不用 >=：同日時 CSV 掃描的資料較完整（有 selectable_stocks/grade_counts），
  // aggregate 注入會蓋掉並弄丟這些欄位；同日已有 CSV 就不注入。
  const isNewer = !dates.length || aggExecDate > dates[0]
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

// Inject daily price_history into recent dates' stocks and persistent items.
// Weekly/monthly are NOT embedded: the cache's 1wk/1mo arrays cover the same
// ~2-year range as the 1d array, so the frontend's resampleBars(daily) fallback
// reproduces them exactly — embedding both tripled the kline payload in data.json.
for (const d of recentDates) {
  for (const stock of (scans[d]?.top_stocks || [])) {
    const entry = klineMap[stock.stock_id]
    if (!entry) continue
    stock.price_history = getKlineBars(entry, '1d')
  }
  for (const item of (scans[d]?.persistent || [])) {
    const entry = klineMap[item.stock_id]
    if (!entry) continue
    item.price_history = getKlineBars(entry, '1d')
  }
}
console.log(`K-line: injected into stocks across ${recentDates.length} dates`)

// Compute return_1d (next-day forward return) from kline data, then inject into scan stocks.
// Uses kline daily bars first, falls back to priceHistoryMap (scan-date closes).
// Find the next bar with a valid (non-zero) close, looking up to 5 bars forward.
// This handles halted days and holidays where the immediate next bar is missing or zero.
function nextValidClose(bars, fromIdx) {
  for (let j = fromIdx + 1; j < bars.length && j <= fromIdx + 5; j++) {
    if ((bars[j].close ?? 0) > 0) return bars[j].close
  }
  return null
}

const klineReturn1dMap = {}
for (const [sid, entry] of Object.entries(klineMap)) {
  const bars = getKlineBars(entry, '1d')
  if (!bars || bars.length < 2) continue
  klineReturn1dMap[sid] = {}
  for (let i = 0; i < bars.length; i++) {
    const cur = bars[i]
    if (!cur.time || cur.close <= 0) continue
    const nxtClose = nextValidClose(bars, i)
    if (nxtClose != null)
      klineReturn1dMap[sid][cur.time] = Math.round((nxtClose - cur.close) / cur.close * 10000) / 10000
  }
}
const scanReturn1dMap = {}
for (const [sid, bars] of Object.entries(priceHistoryMap)) {
  for (let i = 0; i < bars.length; i++) {
    const cur = bars[i]
    if (!cur.time || cur.close <= 0) continue
    const nxtClose = nextValidClose(bars, i)
    if (nxtClose != null) {
      if (!scanReturn1dMap[sid]) scanReturn1dMap[sid] = {}
      scanReturn1dMap[sid][cur.time] = Math.round((nxtClose - cur.close) / cur.close * 10000) / 10000
    }
  }
}
for (const d of dates) {
  for (const arr of [scans[d]?.top_stocks, scans[d]?.filter_stocks, scans[d]?.persistent]) {
    if (!arr) continue
    for (const stock of arr) {
      if (stock.return_1d == null)
        stock.return_1d = klineReturn1dMap[stock.stock_id]?.[d] ?? scanReturn1dMap[stock.stock_id]?.[d] ?? null
    }
  }
}
console.log(`return_1d: computed from kline data for ${Object.keys(klineReturn1dMap).length} stocks`)

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
const historiesGeneratedAt = new Date().toISOString()
writeFileSync(HISTORIES_FILE, JSON.stringify({ generated_at: historiesGeneratedAt, dates: historiesDates, stocks: historiesStocks, scan_stocks: scanStocksFiltered }), 'utf-8')
console.log(`stock_histories.json written (${Object.keys(historiesStocks).length} kline + ${Object.keys(scanStocksFiltered).length} scan stocks, ${historiesDates.length} kline bars, ${(readFileSync(HISTORIES_FILE).length / 1024).toFixed(0)} KB)`)

let prediction = readPrediction()
const predictionHistory = readPredictionHistory()
console.log(`Prediction: ${prediction ? prediction.date : 'none'}, history: ${predictionHistory.length} entries`)

// ── 真實結果（outcome_tracker.py 產出）───────────────────────────────────────
// 用真實加權收盤替預測打分的紀錄 + TOP20 事後報酬。取代前端目前用夜盤代理值
// 推算的命中率（有真實資料時前端應優先顯示這份）。
let realOutcomes = null
const readOutcomes = (f) => { try { return JSON.parse(readFileSync(resolve(__dirname, `../../output/outcomes/${f}`), 'utf-8')) } catch { return [] } }
try {
  const po = readOutcomes('prediction_outcomes.json')
  const th = readOutcomes('top20_history.json')
  if (!po.length && !th.length) throw new Error('no outcome files yet')
  const scored = po.filter(e => e.hit != null)
  const horizons = [1, 5, 10, 20]
  const top20Summary = {}
  for (const h of horizons) {
    const rets = th.flatMap(s => (s.stocks || []).map(st => st[`ret_${h}d`]).filter(r => r != null))
    if (rets.length) top20Summary[`ret_${h}d`] = {
      count: rets.length,
      avg: +(rets.reduce((a, b) => a + b, 0) / rets.length).toFixed(4),
      win_rate: +(rets.filter(r => r > 0).length / rets.length).toFixed(3),
    }
  }
  realOutcomes = {
    prediction: po.slice(-60),   // 最近 60 筆逐日紀錄（含 taiex 收盤、hit）
    prediction_hit: scored.length ? { hits: scored.filter(e => e.hit).length, total: scored.length } : null,
    top20_summary: Object.keys(top20Summary).length ? top20Summary : null,
    top20_snapshots: th.length,
  }
  console.log(`Real outcomes: ${po.length} pred days (scored ${scored.length}), ${th.length} top20 snapshots`)
} catch { console.log('Real outcomes: none yet (outcome_tracker not run)') }

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
    // Backfill BOTH the top list and the full filter_stocks universe so 法人 net
    // isn't limited to ~20 top stocks (FinMind commonly returns these empty).
    const instTargets = [...topStocks, ...(latestScanObj.filter_stocks || [])]
    for (const stock of instTargets) {
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
    const filterInstCount = (latestScanObj.filter_stocks || []).filter(s =>
      (s.foreign_net || 0) !== 0 || (s.invest_trust_net || 0) !== 0
    ).length
    dataQuality.institutional_ok    = newInstCount >= Math.max(5, Math.floor(totalTop * 0.15))
    dataQuality.institutional_ratio = totalTop > 0 ? Math.round(newInstCount / totalTop * 100) : null
    const filterTotal = (latestScanObj.filter_stocks || []).length
    dataQuality.institutional_ratio_full = filterTotal > 0 ? Math.round(filterInstCount / filterTotal * 100) : null
    if (merged > 0) dataQuality.institutional_source = 'twse_t86'
    console.log(`  TWSE T86 補抓完成：${merged} 支填補，top inst_ratio=${dataQuality.institutional_ratio}%、全池 ${dataQuality.institutional_ratio_full}%`)
  } else {
    console.log('  TWSE T86 無資料（可能盤後尚未公布或非交易日）')
  }
}

// ── Price cross-validation: compare scan CSV close vs TWSE/TPEX official ─────
// Detects cases where FinMind data differs from TWSE official post-market data.
// 只在 days_behind === 0（同一交易日）時比價：STOCK_DAY_ALL 永遠回「最新一個交易日」，
// T+1 情況會拿今天的盤比昨天的掃描，凡是今天波動 >2% 的股票都被誤標 mismatch。
if (daysBehind === 0 && topStocks.length > 0) {
  console.log('Price cross-validation: fetching TWSE STOCK_DAY_ALL...')
  try {
    const twseBody = await fetchUrl('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', 12000)
    const twseArr  = JSON.parse(twseBody)
    const twsePriceMap = {}
    if (Array.isArray(twseArr)) {
      for (const row of twseArr) {
        const sid  = (row.Code || row['證券代號'] || '').trim()
        const raw  = (row.ClosingPrice || row['收盤價'] || '').replace(/,/g, '')
        const p    = parseFloat(raw)
        if (sid && !isNaN(p) && p > 0) twsePriceMap[sid] = p
      }
    }
    // Also check TPEX (上櫃)
    try {
      const tpexBody = await fetchUrl('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes', 10000)
      const tpexArr  = JSON.parse(tpexBody)
      if (Array.isArray(tpexArr)) {
        for (const row of tpexArr) {
          const sid = (row.SecuritiesCompanyCode || row['SecuritiesCompanyCode'] || '').trim()
          const raw = (row.Close || row['收盤價'] || '').replace(/,/g, '')
          const p   = parseFloat(raw)
          if (sid && !isNaN(p) && p > 0 && !twsePriceMap[sid]) twsePriceMap[sid] = p
        }
      }
    } catch (e2) { console.warn('  TPEX price fetch skipped:', e2.message) }

    // 第二參照:kline(FinMind)同日收盤。晚間建置時 TWSE STOCK_DAY_ALL 常常
    // 還沒更新到今日 → 當天大漲/漲停的股票全被誤標 mismatch(2026-07-20 實例:
    // 晶心科漲停 231,STOCK_DAY_ALL 仍回前日 210,19/50「誤報」)。兩個獨立
    // 來源(掃描、kline)同意時,視為參照過時而非資料錯誤。
    const klineCloseOf = (sid) => {
      const bars = getKlineBars(klineMap[sid], '1d')
      if (!bars?.length) return null
      const last = bars[bars.length - 1]
      return last.time === latestDataDate && last.close > 0 ? last.close : null
    }
    const mismatches = []
    let checked = 0, refStale = 0
    for (const stock of topStocks) {
      const twseClose = twsePriceMap[String(stock.stock_id)]
      const scanClose = toNum(stock.close)
      if (!twseClose || !scanClose) continue
      checked++
      const diffPct = Math.abs(scanClose - twseClose) / twseClose * 100
      if (diffPct <= 2) continue
      const kc = klineCloseOf(String(stock.stock_id))
      if (kc != null && Math.abs(scanClose - kc) / kc * 100 <= 0.5) { refStale++; continue }
      mismatches.push({
        stock_id: stock.stock_id,
        name: stock.name || '',
        scan_close: scanClose,
        twse_close: twseClose,
        kline_close: kc,
        diff_pct: Math.round(diffPct * 10) / 10,
      })
    }
    const sortedMismatches = mismatches.sort((a, b) => b.diff_pct - a.diff_pct).slice(0, 10)
    dataQuality.price_validation = {
      ok: mismatches.length === 0,
      checked,
      reference_stale: refStale, // 掃描與 kline 一致、僅 TWSE 落後的檔數
      total_in_twse: Object.keys(twsePriceMap).length,
      mismatches: sortedMismatches,
      source: 'twse+tpex_opendata+kline',
    }
    if (mismatches.length > 0) {
      console.log(`  Price cross-validation: ${mismatches.length}/${checked} stocks differ >2% from TWSE (kline 也不一致)${refStale ? `;另 ${refStale} 檔僅 TWSE 參照過時` : ''}`)
      for (const m of sortedMismatches.slice(0, 3)) {
        console.log(`    ${m.stock_id} ${m.name}: scan=${m.scan_close} TWSE=${m.twse_close} kline=${m.kline_close ?? '—'} diff=${m.diff_pct}%`)
      }
    } else {
      console.log(`  Price cross-validation: ${checked} stocks checked, all consistent${refStale ? `(${refStale} 檔 TWSE 參照過時,掃描與 kline 一致)` : ''}`)
    }
  } catch (e) {
    console.warn('  Price cross-validation skipped:', e.message)
    dataQuality.price_validation = { ok: null, checked: 0, mismatches: [], error: e.message }
  }
} else {
  dataQuality.price_validation = { ok: null, checked: 0, mismatches: [], skipped: daysBehind !== 0 ? 'not_same_day' : 'no_stocks' }
}

// ── Enrich industry_category from TWSE/TPEX open data ────────────────────────
const industryMap = await fetchTaiwanIndustryMap()
if (Object.keys(industryMap).length > 0) {
  let filled = 0
  for (const d of dates) {
    for (const arr of [scans[d]?.top_stocks, scans[d]?.filter_stocks, scans[d]?.persistent]) {
      if (!arr) continue
      for (const stock of arr) {
        if (!stock.industry_category) {
          const cat = industryMap[String(stock.stock_id)]
          if (cat) { stock.industry_category = cat; filled++ }
        }
      }
    }
  }
  console.log(`Industry enrichment: ${filled} stocks filled`)
}

// ── Slim selectable_stocks: drop duplicated k-line arrays ───────────────────
// selectable_stocks is `top_stocks.filter(A/B/C)` and shares object refs with
// top_stocks, so for the few recent dates that get k-line injection it drags a
// full copy of each stock's price_history (~40–50KB/stock) into data.json,
// roughly doubling the payload for those dates. The frontend only reads scalar
// fields from selectable_stocks (grade / return_1d / return_5d /
// base_exit_signal for the 精選 win-rate tables) and lazy-loads charts from
// stock_histories.json separately, so strip the three k-line arrays here.
// Done just before serialization — after every enrichment pass above (return_1d,
// industry_category, …) has run — and via map() so top_stocks keep their
// price_history intact while the selectable copies shed only the heavy arrays.
for (const d of dates) {
  const sel = scans[d]?.selectable_stocks
  if (Array.isArray(sel)) {
    scans[d].selectable_stocks = sel.map(
      ({ price_history, price_history_wk, price_history_mo, ...rest }) => rest
    )
  }
}

// ── AI paper-trader — deterministic replay of the strategy as a virtual trader ──
// (歷史 filter_stocks 的體積修剪移到 AI trader 之後執行:「強勢股輪動」變體
//  的選股池要吃到每個歷史日期的全池)
let aiTrader = null
try {
  aiTrader = simulatePaperTrader({
    scans,
    klineFor: (sid) => getKlineBars(klineMap[sid], '1d'),
  })
  if (aiTrader) console.log(`AI trader: ${aiTrader.stats.num_trades} trades, ${aiTrader.stats.trading_days} days, return ${aiTrader.return_pct}% (equity ${aiTrader.equity})`)
} catch (e) { console.log(`AI trader: skipped (${e.message})`) }

// 規則實驗室:同一份掃描資料 + 同一起點,只換出場/成交規則的平行虛擬帳戶。
// 用來回答「哪套規則真的比較會賺」——特別是 next_open(次日開盤買進)才是
// 真人跟單實際拿得到的價(掃描收盤後才完成)。只存精簡統計,不存交易明細。
if (aiTrader) {
  // 盤前預測 → 日期→標籤 映射,給「避開偏空日」變體當進場濾網。這是預測
  // 系統與交易系統的第一個接點:預測偏空的掃描日不進新單(出場照常)。
  const predLabelByDate = {}
  for (const p of (predictionHistory || [])) {
    if (p?.date && p?.xgb_label) predLabelByDate[p.date] = p.xgb_label
  }
  const isBearish = (label) => label === '偏空' || label === '看空'
  const VARIANTS = [
    { id: 'next_open', label: '次日開盤買進', note: '貼近實單可執行價', config: { execution: 'next_open' } },
    // 訊號擂台:完全不用 entry_score/進場訊號,直接買全掃描池「市場 RS 最強」
    // 的股票(0-100 百分位,越高越強),出場紀律相同。用來驗證可信度審計的
    // 核心疑問:entry_score 是否輸給簡單的相對強勢動能。
    { id: 'rs_mom', label: '強勢股輪動', note: '不看訊號,買全池RS最強', config: { pickPool: 'filter', requireEntrySignal: false, rankBy: (s) => s.market_rs_rank || 0 } },
    { id: 'bear_filter', label: '避開偏空日', note: '盤前預測偏空不進場', config: { buyGate: (day) => !isBearish(predLabelByDate[day]) } },
    // 準度實驗(2026-07-21 12 種選股規則 21 日實測的最佳者):進場訊號之上
    // 再加「月營收年增為正」硬濾網。回測中唯一正報酬(+0.65%、勝率 67%、
    // MDD −1.27%),避開了主帳戶的停損踩雷;樣本僅 3 筆,先進實驗室累積驗證。
    { id: 'rev_growth', label: '營收成長濾網', note: '訊號+營收YoY>0', config: { pickFilter: (s) => (s.revenue_yoy ?? -1) > 0 } },
    { id: 'trail8', label: '移動停損 8%', note: '不停利,讓利潤跑', config: { takeProfit: null, trailingStop: 0.08 } },
    { id: 'tp12', label: '停利 12%', note: '拉高目標', config: { takeProfit: 0.12 } },
    { id: 'tp5', label: '停利 5%', note: '高勝率短打', config: { takeProfit: 0.05 } },
    { id: 'pos3', label: '集中 3 檔', note: '重押高分股', config: { maxPositions: 3 } },
    // 對照組:選股與任何策略訊號完全無關(股號固定雜湊排序 = 「亂選一籃股票」
    // 的確定性版本,每次 build 結果相同可重現),出場紀律與主帳戶一致。
    // 用途:量化「策略選股」相對「無訊號亂選」到底貢獻多少——這是可信度審計
    // 缺的最後一塊對照。control: true → 不參與自適應帳戶的跟隨候選(對照組
    // 只供比較,不該被學習層跟單)。
    { id: 'random', label: '亂數對照組', note: '無訊號亂選,出場紀律相同', control: true,
      config: { pickPool: 'filter', requireEntrySignal: false, rankBy: hashRank } },
  ]
  function hashRank(s) {
    const id = String(s.stock_id)
    let h = 2166136261
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
    return h % 100000
  }
  const variantResults = VARIANTS.map(v => {
    try {
      const r = simulatePaperTrader({ scans, klineFor: (sid) => getKlineBars(klineMap[sid], '1d'), config: v.config })
      return r ? { v, r } : null
    } catch { return null }
  }).filter(Boolean)
  aiTrader.variants = variantResults.map(({ v, r }) => ({
    id: v.id, label: v.label, note: v.note, control: !!v.control,
    return_pct: r.return_pct, equity: r.equity,
    win_rate: r.stats.win_rate, num_trades: r.stats.num_trades,
    max_drawdown_pct: r.stats.max_drawdown_pct, profit_factor: r.stats.profit_factor,
    open_positions: r.positions.length,
    // ret_pct 序列與主帳戶共用同一交易日曆(同 scans/klines),供疊圖
    curve: r.equity_curve.map(p => p.ret_pct),
    // 交易明細(精簡欄位控制體積):實驗室點開變體可看它實際買賣了什麼
    positions: r.positions.slice(0, 6).map(p => ({
      stock_id: p.stock_id, name: p.name, entry: p.entry, price: p.price,
      pnl_pct: p.pnl_pct, entry_date: p.entry_date,
    })),
    trades: r.trades.slice(0, 8).map(t => ({
      stock_id: t.stock_id, name: t.name, entry: t.entry, exit: t.exit,
      entry_date: t.entry_date, exit_date: t.exit_date,
      reason: t.reason, ret_pct: t.ret_pct, hold_days: t.hold_days,
    })),
  }))
  console.log(`AI trader variants: ${aiTrader.variants.map(v => `${v.id}=${v.return_pct}%`).join(' ')}`)

  // 🎓 自適應帳戶(自我學習層):從主帳戶+變體的實績中學習該跟隨哪套規則。
  // 樣本不足(全體已結 < 10 筆)前固定跟隨主帳戶;之後每天評估近 10 個交易
  // 日績效,挑戰者領先 >1pp 才切換,每次切換扣 0.7% 換倉成本。確定性可重現。
  try {
    const adaptiveAccounts = [
      { id: 'main', label: '主帳戶', curve: aiTrader.equity_curve.map(p => ({ date: p.date, ret_pct: p.ret_pct })), exit_dates: aiTrader.exit_dates },
      // 對照組(control)不進跟隨候選:它存在的意義是被比較,不是被跟單
      ...variantResults.filter(({ v }) => !v.control).map(({ v, r }) => ({ id: v.id, label: v.label, curve: r.equity_curve.map(p => ({ date: p.date, ret_pct: p.ret_pct })), exit_dates: r.exit_dates })),
    ]
    aiTrader.adaptive = simulateAdaptiveTrader({ accounts: adaptiveAccounts })
    if (aiTrader.adaptive) {
      console.log(`AI trader adaptive: ${aiTrader.adaptive.return_pct}% follow=${aiTrader.adaptive.follow_id} switches=${aiTrader.adaptive.num_switches} learning=${aiTrader.adaptive.learning_active}`)
    }
    // 群體智慧帳戶:同一組候選(主帳戶+非對照變體),但按績效分散配權而非單一跟隨
    aiTrader.ensemble = simulateEnsembleTrader({ accounts: adaptiveAccounts })
    if (aiTrader.ensemble) {
      const w = aiTrader.ensemble.weights.slice(0, 3).map(x => `${x.id} ${x.weight_pct}%`).join(' ')
      console.log(`AI trader ensemble: ${aiTrader.ensemble.return_pct}% rebalances=${aiTrader.ensemble.num_rebalances} 前三配權[${w}] learning=${aiTrader.ensemble.learning_active}`)
    }
  } catch (e) { console.log(`AI trader adaptive/ensemble: skipped (${e.message})`) }
  delete aiTrader.exit_dates // 只在 build 期用,不進 data.json
}

// ── Trim historical filter_stocks:只保留最近 N 天的全掃描池 ─────────────────
// filter_stocks(~1500 支 × ~40 欄)每個日期約 1–1.5MB,30 個日期累計 ~30MB,
// 是 data.json 最大的體積來源(手機端下載/解析卡頓的主因)。前端只在近期日期
// 使用全池;更舊的日期自動退回 top_stocks(既有 fallback)。所有會讀舊日期
// 全池的 build 期計算(strategyAccuracy、return_1d、產業補齊、T86 回填、
// AI trader 的強勢股輪動變體)都在上面完成了,這裡只影響序列化輸出。
{
  const FILTER_STOCKS_KEEP_DATES = 6
  let trimmedFilterDates = 0
  for (const d of dates.slice(FILTER_STOCKS_KEEP_DATES)) {
    if (scans[d]?.filter_stocks) { delete scans[d].filter_stocks; trimmedFilterDates++ }
  }
  if (trimmedFilterDates) console.log(`filter_stocks trimmed: kept ${Math.min(FILTER_STOCKS_KEEP_DATES, dates.length)} recent dates, dropped ${trimmedFilterDates} historical dates`)
}

// 大盤基準:掃描池等權日報酬複利。AI 就是從這個池子選股,等權基準比加權指數
// 更公平(不被權值股綁架);排除單日 |r|>11% 的異常(除權息/資料錯誤,台股
// 漲跌幅限制 10%)。對齊 AI 帳戶的交易日曆,起點同為 0%。
if (aiTrader?.equity_curve?.length > 1) {
  const days = aiTrader.equity_curve.map(p => p.date)
  const daySet = new Set(days)
  const sumRet = {}, cntRet = {}
  for (const entry of Object.values(klineMap)) {
    const bars = getKlineBars(entry, '1d')
    if (!bars) continue
    for (let i = 1; i < bars.length; i++) {
      const d = bars[i].time
      if (!daySet.has(d)) continue
      const c0 = bars[i - 1].close, c1 = bars[i].close
      if (!(c0 > 0) || !(c1 > 0)) continue
      const r = c1 / c0 - 1
      if (Math.abs(r) > 0.11) continue
      sumRet[d] = (sumRet[d] || 0) + r
      cntRet[d] = (cntRet[d] || 0) + 1
    }
  }
  let level = 1
  const benchCurve = days.map((d, i) => {
    if (i > 0 && (cntRet[d] || 0) >= 30) level *= 1 + sumRet[d] / cntRet[d]
    return { date: d, ret_pct: Math.round((level - 1) * 10000) / 100 }
  })
  aiTrader.benchmark = {
    label: '掃描池等權基準',
    return_pct: benchCurve[benchCurve.length - 1].ret_pct,
    curve: benchCurve,
  }
  console.log(`AI trader benchmark: ${aiTrader.benchmark.return_pct}% (universe equal-weight, ${days.length} days)`)
}

// 明日作戰計畫:AI 下一個交易日會做什麼——武裝中的出場價位(持倉)+ 開盤
// 會補進的候選。補進清單要以「最新掃描之前就持有的部位」當基準:主回放在
// 掃描日收盤已把新訊號買成持倉,若用全部持倉過濾,會把真人明天開盤該買的
// 剛好全部濾掉(Codex review #381)。掃描日新建持倉的成本加回現金,還原
// 掃描前的資金來估每檔預算。純推導顯示,不影響回放本身。
if (aiTrader) {
  const latestDate = dates[0]
  const latest = scans[latestDate] || {}
  const carried = aiTrader.positions.filter(p => p.entry_date !== latestDate)
  const heldBefore = new Set(carried.map(p => String(p.stock_id)))
  const freshCost = aiTrader.positions
    .filter(p => p.entry_date === latestDate)
    .reduce((a, p) => a + (p.cost || 0), 0)
  const cashBefore = aiTrader.cash + freshCost
  const freeSlots = Math.max(0, (aiTrader.config.max_positions || 6) - carried.length)
  const planBuys = (latest.top_stocks || [])
    .filter(s => s.entry_signal && !heldBefore.has(String(s.stock_id)))
    .sort((a, b) => (b.entry_score || 0) - (a.entry_score || 0))
    .slice(0, freeSlots)
    .map((s, i) => ({
      stock_id: String(s.stock_id), name: s.name || '', rank: i + 1,
      entry_score: Math.round(s.entry_score || 0), grade: s.grade || '', close: s.close ?? null,
    }))
  aiTrader.plan = {
    as_of: latestDate,
    free_slots: freeSlots,
    est_budget_each: planBuys.length ? Math.floor(cashBefore / Math.min(freeSlots, planBuys.length)) : null,
    buys: planBuys,
    exits: aiTrader.positions.map(p => ({
      stock_id: p.stock_id, name: p.name,
      tp_price: p.tp_price, sl_price: p.sl_price,
      days_left: Math.max(0, (aiTrader.config.max_hold || 15) - (p.hold_days || 0)),
    })),
  }
}

// AI 操盤日報歷史(由 daily_report workflow 每晚寫入;檔案不存在時為空)
let aiReports = []
try {
  const raw = JSON.parse(readFileSync(resolve(__dirname, '../../output/ai_reports.json'), 'utf-8'))
  if (Array.isArray(raw)) aiReports = raw.slice(0, 14)
  if (aiReports.length) console.log(`AI reports: ${aiReports.length} 份(最新 ${aiReports[0]?.date})`)
} catch { /* 尚無日報 */ }

const dataGeneratedAt = new Date().toISOString()
writeFileSync(OUTPUT_FILE, JSON.stringify({ generated_at: dataGeneratedAt, last_scan_exec_date: lastScanExecDate, dates, scans, prediction, predictionHistory, realOutcomes, news, quota, notionMap, aggregateLatest, outcomeStats, strategyAccuracy, dataQuality, aiTrader, aiReports }), 'utf-8')
console.log(`data.json written (${(readFileSync(OUTPUT_FILE).length / 1024).toFixed(0)} KB)`)

// Small sidecar so the frontend can cheaply check "did anything change?" (a few
// hundred bytes) before deciding to re-download and re-parse the multi-MB
// data.json / stock_histories.json on its periodic auto-refresh.
const META_FILE = join(PUBLIC_DIR, 'meta.json')
writeFileSync(META_FILE, JSON.stringify({ data_generated_at: dataGeneratedAt, histories_generated_at: historiesGeneratedAt }), 'utf-8')
console.log(`meta.json written`)
