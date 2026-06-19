/**
 * Supplemental K-line fetcher
 *
 * Detects stocks that are missing or stale in kline_cache.json and fetches
 * only those via Yahoo Finance (same source as kline_fetch.py / yfinance).
 * No API key required.
 *
 * Usage (from repo root):
 *   node web/scripts/kline-supplement.mjs [options]
 *
 * Options:
 *   --max N        Max stocks to fetch this run (default: 200)
 *   --dry-run      Report missing/stale counts only, don't fetch
 *   --stale-days N Treat stocks with last bar older than N calendar days as stale (default: 2)
 *   --lookback N   Days of history to fetch for missing stocks (default: 730)
 *
 * Run repeatedly (each FinMind hourly-quota reset cycle) until no missing/stale remain.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import https from 'https'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT        = resolve(__dirname, '../..')
const CACHE_FILE  = resolve(ROOT, 'output/kline_cache.json')
const SCAN_DIR    = resolve(ROOT, 'output/full_scan')

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
function getArg(flag, defaultVal) {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return defaultVal
  const v = parseInt(args[idx + 1], 10)
  return isNaN(v) ? defaultVal : v
}
const DRY_RUN    = args.includes('--dry-run')
const MAX_STOCKS = getArg('--max', 200)
const STALE_DAYS = getArg('--stale-days', 2)
const LOOKBACK   = getArg('--lookback', 730)

// ── Date helpers ──────────────────────────────────────────────────────────────
function todayISO() {
  return new Date().toISOString().slice(0, 10)
}
function subtractDays(dateISO, n) {
  const d = new Date(dateISO)
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}
function addDays(dateISO, n) {
  const d = new Date(dateISO)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

// ── Step 1: Load kline_cache.json ─────────────────────────────────────────────
console.log('Loading kline_cache.json...')
let klineMap = {}
if (existsSync(CACHE_FILE)) {
  klineMap = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  const sampleKey = Object.keys(klineMap)[0]
  const sampleEntry = sampleKey ? klineMap[sampleKey] : null
  const sampleBars = Array.isArray(sampleEntry) ? sampleEntry : (sampleEntry?.['1d'] || [])
  console.log(`  Loaded: ${Object.keys(klineMap).length} stocks, ~${sampleBars.length} daily bars each`)
} else {
  console.log('  No kline_cache.json found — will fetch from scratch')
}

// Normalise cache entries to the new nested format {1d: [], 1wk: [], 1mo: []}
function getBars(entry, interval = '1d') {
  if (!entry) return []
  if (Array.isArray(entry)) return interval === '1d' ? entry : []
  return Array.isArray(entry[interval]) ? entry[interval] : []
}
function getLastDate(entry) {
  const bars = getBars(entry, '1d')
  return bars.length > 0 ? bars[bars.length - 1].time : null
}

// ── Step 2: Collect scan universe from latest batch_seq CSVs ──────────────────
console.log('Reading scan universe from batch_seq CSVs...')
function parseCSVFirstColumn(content) {
  const lines = content.replace(/^﻿/, '').replace(/\r/g, '').split('\n').filter(Boolean)
  if (lines.length < 2) return []
  const headers = lines[0].split(',')
  const idIdx = headers.findIndex(h => h.trim() === 'stock_id')
  if (idIdx === -1) return []
  return lines.slice(1).map(l => l.split(',')[idIdx]?.trim()).filter(Boolean)
}

const scanFiles = readdirSync(SCAN_DIR)
  .filter(f => /^batch_seq\d+_\d{4}-\d{2}-\d{2}\.csv$/.test(f))
  .sort()
  .reverse()

// Find the most recent scan date
const latestScanDate = scanFiles.length > 0
  ? scanFiles[0].match(/(\d{4}-\d{2}-\d{2})/)[1]
  : todayISO()

// Collect all stocks from that date (all batch_seq segments)
const universeIds = new Set()
for (const f of scanFiles) {
  const fileDate = f.match(/(\d{4}-\d{2}-\d{2})/)[1]
  if (fileDate !== latestScanDate) continue  // skip files from other dates
  const content = readFileSync(resolve(SCAN_DIR, f), 'utf-8')
  for (const id of parseCSVFirstColumn(content)) universeIds.add(id)
}
console.log(`  Scan universe: ${universeIds.size} stocks from ${latestScanDate}`)

// ── Step 3: Identify missing / stale stocks ───────────────────────────────────
const staleCutoff = subtractDays(latestScanDate, STALE_DAYS)
const missing = []
const stale   = []
const fresh   = []

for (const stockId of universeIds) {
  const entry = klineMap[stockId]
  const lastDate = getLastDate(entry)
  if (!lastDate) {
    missing.push(stockId)
  } else if (lastDate < staleCutoff) {
    stale.push(stockId)
  } else {
    fresh.push(stockId)
  }
}

// Also find stocks in cache but not in universe (no action needed, just info)
const notInUniverse = Object.keys(klineMap).filter(id => !universeIds.has(id))

console.log(`\nStatus report:`)
console.log(`  Fresh (up to date):  ${fresh.length}`)
console.log(`  Stale (last bar < ${staleCutoff}):  ${stale.length}`)
console.log(`  Missing (not in cache): ${missing.length}`)
console.log(`  In cache but not in universe: ${notInUniverse.length}`)

if (DRY_RUN) {
  if (missing.length > 0) console.log(`\nMissing (first 20): ${missing.slice(0, 20).join(', ')}`)
  if (stale.length > 0)   console.log(`Stale (first 20):   ${stale.slice(0, 20).join(', ')}`)
  console.log('\n(dry-run mode — no data fetched)')
  process.exit(0)
}

// ── Step 4: Decide what to fetch ──────────────────────────────────────────────
// Priority: missing first, then stale
const toFetch = [...missing, ...stale].slice(0, MAX_STOCKS)
if (toFetch.length === 0) {
  console.log('\nAll stocks are fresh — nothing to fetch!')
  process.exit(0)
}
console.log(`\nWill fetch ${toFetch.length} stocks (${missing.length} missing + ${stale.length} stale, capped at ${MAX_STOCKS})`)

// ── Step 5: Yahoo Finance fetch ───────────────────────────────────────────────
function fetchYahoo(ticker, periodDays) {
  return new Promise((resolve, reject) => {
    const end   = Math.floor(Date.now() / 1000)
    const start = end - periodDays * 86400
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${start}&period2=${end}&includePrePost=false`
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(body)
          const result = json?.chart?.result?.[0]
          if (!result) { resolve([]); return }
          const timestamps = result.timestamp || []
          const quotes = result.indicators?.quote?.[0] || {}
          const bars = []
          for (let i = 0; i < timestamps.length; i++) {
            const o = quotes.open?.[i], h = quotes.high?.[i],
                  l = quotes.low?.[i],  c = quotes.close?.[i], v = quotes.volume?.[i]
            if (c == null || isNaN(c)) continue
            const dt = new Date(timestamps[i] * 1000).toISOString().slice(0, 10)
            bars.push({
              time:   dt,
              open:   Math.round((o || c) * 100) / 100,
              high:   Math.round((h || c) * 100) / 100,
              low:    Math.round((l || c) * 100) / 100,
              close:  Math.round(c * 100) / 100,
              volume: Math.round(v || 0),
            })
          }
          resolve(bars)
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')) })
  })
}

async function fetchStock(stockId, periodDays) {
  // Try .TW first, then .TWO
  for (const suffix of ['.TW', '.TWO']) {
    try {
      const bars = await fetchYahoo(`${stockId}${suffix}`, periodDays)
      if (bars.length > 0) return { suffix, bars }
    } catch (_) {}
  }
  return { suffix: null, bars: [] }
}

// Resample daily bars to weekly / monthly (using last bar of each period)
function resampleBars(bars, interval) {
  if (!bars.length) return []
  const groups = {}
  for (const b of bars) {
    const d = new Date(b.time)
    let key
    if (interval === '1wk') {
      // ISO week: Monday of that week
      const day = d.getDay() || 7
      const monday = new Date(d)
      monday.setDate(d.getDate() - day + 1)
      key = monday.toISOString().slice(0, 10)
    } else {
      key = b.time.slice(0, 7) // YYYY-MM
    }
    if (!groups[key]) groups[key] = []
    groups[key].push(b)
  }
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([, wBars]) => {
    const first = wBars[0], last = wBars[wBars.length - 1]
    return {
      time:   first.time,
      open:   first.open,
      high:   Math.max(...wBars.map(b => b.high)),
      low:    Math.min(...wBars.map(b => b.low)),
      close:  last.close,
      volume: wBars.reduce((s, b) => s + b.volume, 0),
    }
  })
}

// Merge new bars into existing cache entry (dedup by date, keep sorted)
function mergeBars(existing, newBars) {
  const byDate = {}
  for (const b of existing) byDate[b.time] = b
  for (const b of newBars)  byDate[b.time] = b
  return Object.values(byDate).sort((a, b) => a.time.localeCompare(b.time))
}

// ── Step 6: Fetch loop ────────────────────────────────────────────────────────
let fetched = 0, failed = 0
const DELAY_MS = 300  // polite delay between requests

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

for (let i = 0; i < toFetch.length; i++) {
  const stockId = toFetch[i]
  const isMissing = missing.includes(stockId)
  const periodDays = isMissing ? LOOKBACK : 30  // stale: only need recent weeks

  process.stdout.write(`[${i + 1}/${toFetch.length}] ${stockId} (${isMissing ? 'missing' : 'stale'})... `)

  const { suffix, bars } = await fetchStock(stockId, periodDays)

  if (bars.length === 0) {
    console.log('✗ not found')
    failed++
  } else {
    const existing1d = getBars(klineMap[stockId], '1d')
    const merged1d   = mergeBars(existing1d, bars)
    const merged1wk  = resampleBars(merged1d, '1wk')
    const merged1mo  = resampleBars(merged1d, '1mo')
    klineMap[stockId] = { '1d': merged1d, '1wk': merged1wk, '1mo': merged1mo }
    console.log(`✓ ${suffix} ${bars.length} bars → total ${merged1d.length}d`)
    fetched++

    // Save after every 10 stocks to preserve progress on quota interruption
    if ((i + 1) % 10 === 0 || i === toFetch.length - 1) {
      writeFileSync(CACHE_FILE, JSON.stringify(klineMap), 'utf-8')
      console.log(`  💾 Saved (${i + 1}/${toFetch.length} done, ${fetched} fetched, ${failed} failed)`)
    }
  }

  if (i < toFetch.length - 1) await sleep(DELAY_MS)
}

// Final save
writeFileSync(CACHE_FILE, JSON.stringify(klineMap), 'utf-8')

console.log(`\nDone! Fetched: ${fetched}, Failed: ${failed}`)
console.log(`Remaining missing: ${missing.length - Math.min(missing.length, MAX_STOCKS)}`)
console.log(`Remaining stale:   ${Math.max(0, stale.length - Math.max(0, MAX_STOCKS - missing.length))}`)
console.log(`\nRun again to continue fetching the rest.`)
