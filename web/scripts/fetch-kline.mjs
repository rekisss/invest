/**
 * Standalone K-line pre-fetch script.
 * Reads top stock IDs from the latest scan CSV files, fetches 65 days of OHLCV
 * from FinMind, and saves the result to output/kline_cache.json.
 *
 * Tokens used (in priority order):
 *   1. FINMIND_TOKEN_10  (dedicated K-line account)
 *   2. FINMIND_TOKEN     (fallback if TOKEN_10 fails or is unset)
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import https from 'https'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAN_DIR   = resolve(__dirname, '../../output/full_scan')
const CACHE_FILE = resolve(__dirname, '../../output/kline_cache.json')
const MAX_STOCKS = 100
const LOOKBACK_DAYS = 65

// ── CSV parser ────────────────────────────────────────────────────────────────
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

// ── HTTP helper ───────────────────────────────────────────────────────────────
function fetchUrl(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
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

// ── Read top stock IDs from latest 3 scan dates ───────────────────────────────
function getTopStockIds() {
  if (!existsSync(SCAN_DIR)) { console.warn('SCAN_DIR not found:', SCAN_DIR); return [] }
  const files = readdirSync(SCAN_DIR)
    .filter(f => f.startsWith('scan_') && f.endsWith('_top50.csv'))
    .sort().reverse()

  const idSet = new Set()
  for (const f of files.slice(0, 3)) {
    try {
      const rows = parseCSV(readFileSync(`${SCAN_DIR}/${f}`, 'utf-8'))
      rows.forEach(r => r.stock_id && idSet.add(r.stock_id))
    } catch (e) {
      console.warn(`  skip ${f}: ${e.message}`)
    }
  }
  return [...idSet].slice(0, MAX_STOCKS)
}

// ── Fetch one stock's K-line ──────────────────────────────────────────────────
async function fetchOne(sid, token, startDate, endDate) {
  const url = `https://api.finmindtrade.com/api/v4/data?token=${encodeURIComponent(token)}&dataset=TaiwanStockPrice&stock_id=${sid}&start_date=${startDate}&end_date=${endDate}`
  const body = await fetchUrl(url)
  const json = JSON.parse(body)
  if (json.status === 200 && Array.isArray(json.data) && json.data.length > 0) {
    return json.data.map(d => ({
      time: d.date, open: d.open, high: d.max, low: d.min,
      close: d.close, volume: d.Trading_Volume || 0,
    }))
  }
  return { _err: true, status: json.status, msg: json.msg || '' }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const token10 = (process.env.FINMIND_TOKEN_10 || '').trim()
const token1  = (process.env.FINMIND_TOKEN   || '').trim()

if (!token10 && !token1) {
  console.error('No FINMIND token set. Set FINMIND_TOKEN_10 or FINMIND_TOKEN.')
  process.exit(1)
}

const endDate   = new Date().toISOString().slice(0, 10)
const startDate = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10)
const stockIds  = getTopStockIds()

console.log(`K-line fetch: ${stockIds.length} stocks (${startDate} ~ ${endDate})`)

// Probe TOKEN_10; fall back to TOKEN_1 if it fails
let activeToken = token10 || token1
if (token10) {
  try {
    const probe = await fetchOne(stockIds[0], token10, startDate, endDate)
    if (probe?._err) {
      console.warn(`TOKEN_10 probe failed (status=${probe.status} msg="${probe.msg}") — using TOKEN_1 fallback`)
      activeToken = token1 || token10
    } else {
      console.log(`TOKEN_10 OK (${probe.length} rows for ${stockIds[0]})`)
    }
  } catch (e) {
    console.warn(`TOKEN_10 probe error: ${e.message} — using TOKEN_1 fallback`)
    activeToken = token1 || token10
  }
}

// Load existing cache so we don't lose data for stocks not in today's top list
const existingCache = existsSync(CACHE_FILE)
  ? JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  : {}

const klineMap = { ...existingCache }
let fetched = 0

for (const sid of stockIds) {
  try {
    const rows = await fetchOne(sid, activeToken, startDate, endDate)
    if (!rows?._err) {
      klineMap[sid] = rows
      fetched++
    }
    await new Promise(r => setTimeout(r, 100))
  } catch (e) {
    console.warn(`  [${sid}] failed: ${e.message}`)
  }
}

const sampleDays = fetched > 0 ? klineMap[stockIds.find(id => klineMap[id])]?.length ?? 0 : 0
console.log(`K-line: ${fetched}/${stockIds.length} fetched (~${sampleDays} days each)`)
writeFileSync(CACHE_FILE, JSON.stringify(klineMap), 'utf-8')
console.log(`Saved to ${CACHE_FILE} (${Object.keys(klineMap).length} stocks total)`)
