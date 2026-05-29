import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import https from 'https'
import http from 'http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAN_DIR = resolve(__dirname, '../../output/full_scan')
const PRED_FILE = resolve(__dirname, '../../output/prediction_latest.json')
const PUBLIC_DIR = resolve(__dirname, '../public')
const OUTPUT_FILE = join(PUBLIC_DIR, 'data.json')
const TOP_N = 50
const MAX_DATES = 14

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
  const dates = Object.keys(dateMap).sort().reverse().slice(0, MAX_DATES)
  const scans = {}
  const stockHistory = {}
  for (const date of dates) {
    const stockMap = {}
    for (const row of dateMap[date]) {
      const sid = row.stock_id, score = toNum(row.entry_score)
      if (!stockMap[sid] || score > toNum(stockMap[sid].entry_score)) stockMap[sid] = row
    }
    const allStocks = Object.values(stockMap).sort((a, b) => toNum(b.entry_score) - toNum(a.entry_score))
    const topStocks = allStocks.slice(0, TOP_N).map((row, i) => ({
      rank: i + 1, stock_id: row.stock_id, name: row.name || '',
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
    }))
    const limitDownAlerts = allStocks
      .filter(r => toNum(r.limit_down_streak) >= 3)
      .sort((a, b) => toNum(b.limit_down_streak) - toNum(a.limit_down_streak))
      .map(r => ({
        stock_id: r.stock_id, name: r.name || '',
        industry_category: r.industry_category || '',
        close: toNum(r.close),
        limit_down_streak: toNum(r.limit_down_streak),
      }))
    scans[date] = { total_scanned: allStocks.length, entry_count: allStocks.filter(r => toBool(r.entry_signal)).length, top_stocks: topStocks, limit_down_alerts: limitDownAlerts }
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
  return { dates, scans }
}

// ── FinMind quota ────────────────────────────────────────────────────────────
async function fetchFinMindQuota() {
  const tokens = [
    { key: process.env.FINMIND_TOKEN,   label: '帳號1' },
    { key: process.env.FINMIND_TOKEN_2, label: '帳號2' },
    { key: process.env.FINMIND_TOKEN_3, label: '帳號3' },
  ].filter(t => t.key)
  const results = []
  for (const { key, label } of tokens) {
    try {
      const body = await fetchUrl(`https://api.finmindtrade.com/api/v4/user_info?token=${encodeURIComponent(key)}`, 6000)
      const json = JSON.parse(body)
      if (json.status === 200 && json.data) {
        results.push({ label, limit: json.data.api_request_limit, used: json.data.api_request_count })
        console.log(`  FinMind [${label}]: ${json.data.api_request_count}/${json.data.api_request_limit}`)
      }
    } catch (e) { console.warn(`  FinMind [${label}] quota failed: ${e.message}`) }
  }
  return results
}

// ── Main ─────────────────────────────────────────────────────────────────────
const { dates, scans } = processScanData()
console.log(`Scan data: ${dates.length} dates, latest=${dates[0]}, stocks=${scans[dates[0]]?.total_scanned ?? 0}`)

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

mkdirSync(PUBLIC_DIR, { recursive: true })
writeFileSync(OUTPUT_FILE, JSON.stringify({ generated_at: new Date().toISOString(), dates, scans, prediction, predictionHistory, news, quota }), 'utf-8')
console.log(`data.json written (${(readFileSync(OUTPUT_FILE).length / 1024).toFixed(0)} KB)`)
