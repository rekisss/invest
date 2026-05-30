/**
 * K-line fetch script — 10 accounts parallel, same distribution as scan.
 * Reads all stock IDs from the latest scan_*_all.csv, splits evenly across
 * available tokens, fetches 65-day OHLCV in parallel, merges with existing
 * cache, and saves to output/kline_cache.json.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import https from 'https'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAN_DIR   = resolve(__dirname, '../../output/full_scan')
const CACHE_FILE = resolve(__dirname, '../../output/kline_cache.json')
const LOOKBACK_DAYS = 90

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

// ── Fetch single stock ────────────────────────────────────────────────────────
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

// ── Fetch a chunk of stocks sequentially with one token ───────────────────────
async function fetchChunk(stockIds, token, label, startDate, endDate) {
  if (!token || stockIds.length === 0) return {}
  // Probe first stock to detect plan limitations
  try {
    const probe = await fetchOne(stockIds[0], token, startDate, endDate)
    if (probe?._err) {
      console.warn(`  [${label}] probe failed (status=${probe.status} msg="${probe.msg}") — skipping`)
      return {}
    }
    const result = { [stockIds[0]]: probe }
    for (const sid of stockIds.slice(1)) {
      try {
        const rows = await fetchOne(sid, token, startDate, endDate)
        if (!rows?._err) result[sid] = rows
        await new Promise(r => setTimeout(r, 80))
      } catch (e) {
        // skip individual failures silently
      }
    }
    console.log(`  [${label}] ${Object.keys(result).length}/${stockIds.length} fetched`)
    return result
  } catch (e) {
    console.warn(`  [${label}] error: ${e.message}`)
    return {}
  }
}

// ── Read all stock IDs from batch_seq*_YYYY-MM-DD.csv files ──────────────────
function getAllStockIds() {
  if (!existsSync(SCAN_DIR)) { console.warn('SCAN_DIR not found:', SCAN_DIR); return [] }

  // Find all batch_seq files, group by date, take the latest date's files
  const files = readdirSync(SCAN_DIR)
    .filter(f => /^batch_seq\d+_\d{4}-\d{2}-\d{2}\.csv$/.test(f))
    .sort().reverse()

  if (files.length === 0) { console.warn('No batch_seq CSV files found in', SCAN_DIR); return [] }

  // Extract the latest date
  const latestDate = files[0].match(/(\d{4}-\d{2}-\d{2})/)[1]
  const latestFiles = files.filter(f => f.includes(latestDate))

  const idSet = new Set()
  for (const f of latestFiles) {
    try {
      const rows = parseCSV(readFileSync(`${SCAN_DIR}/${f}`, 'utf-8'))
      rows.forEach(r => r.stock_id && idSet.add(r.stock_id))
    } catch (e) { console.warn(`  skip ${f}: ${e.message}`) }
  }
  console.log(`  Loaded ${idSet.size} stocks from ${latestFiles.length} batch_seq files (${latestDate})`)
  return [...idSet]
}

// ── Main ──────────────────────────────────────────────────────────────────────
const tokenDefs = [
  { key: (process.env.FINMIND_TOKEN    || '').trim(), label: '帳號1（600）' },
  { key: (process.env.FINMIND_TOKEN_2  || '').trim(), label: '帳號2（600）' },
  { key: (process.env.FINMIND_TOKEN_3  || '').trim(), label: '帳號3（600）' },
  { key: (process.env.FINMIND_TOKEN_4  || '').trim(), label: '帳號4（600）' },
  { key: (process.env.FINMIND_TOKEN_5  || '').trim(), label: '帳號5（600）' },
  { key: (process.env.FINMIND_TOKEN_6  || '').trim(), label: '帳號6（300）' },
  { key: (process.env.FINMIND_TOKEN_7  || '').trim(), label: '帳號7（300）' },
  { key: (process.env.FINMIND_TOKEN_8  || '').trim(), label: '帳號8（300）' },
  { key: (process.env.FINMIND_TOKEN_9  || '').trim(), label: '帳號9（300）' },
  { key: (process.env.FINMIND_TOKEN_10 || '').trim(), label: '帳號10（K線）' },
].filter(t => t.key)

if (tokenDefs.length === 0) {
  console.error('No FINMIND tokens set.')
  process.exit(1)
}

const endDate   = new Date().toISOString().slice(0, 10)
const startDate = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10)
const stockIds  = getAllStockIds()

console.log(`K-line fetch: ${stockIds.length} stocks × ${tokenDefs.length} accounts (${startDate} ~ ${endDate})`)

// Distribute stocks evenly across tokens
const chunkSize = Math.ceil(stockIds.length / tokenDefs.length)
const chunks = tokenDefs.map((t, i) => ({
  ...t,
  ids: stockIds.slice(i * chunkSize, (i + 1) * chunkSize),
})).filter(c => c.ids.length > 0)

// Fetch all chunks in parallel
const results = await Promise.all(
  chunks.map(c => fetchChunk(c.ids, c.key, c.label, startDate, endDate))
)

// Merge with existing cache
const existingCache = existsSync(CACHE_FILE)
  ? JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  : {}

const klineMap = { ...existingCache }
for (const r of results) Object.assign(klineMap, r)

const fetched = results.reduce((s, r) => s + Object.keys(r).length, 0)
const sampleId = Object.keys(klineMap).find(k => klineMap[k]?.length > 0)
const sampleDays = sampleId ? klineMap[sampleId].length : 0

console.log(`K-line: ${fetched}/${stockIds.length} fetched this run (~${sampleDays} days each)`)
console.log(`Cache total: ${Object.keys(klineMap).length} stocks`)
writeFileSync(CACHE_FILE, JSON.stringify(klineMap), 'utf-8')
console.log(`Saved to ${CACHE_FILE}`)
