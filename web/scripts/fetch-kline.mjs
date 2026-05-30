/**
 * K-line incremental fetch + Notion sync + Excel export.
 *
 * Logic:
 *  1. Read batch_seq*.csv from the last 30 days → all scanned stock IDs
 *  2. Diff against kline_cache.json → only fetch stocks missing recent data
 *  3. Data older than 30 days is PRESERVED (never deleted)
 *  4. Save updated kline_cache.json
 *  5. Sync 30-day stats (return%, high, low) to Notion existing entries
 *  6. Export kline_export.xlsx (summary + 30-day OHLCV)
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import https from 'https'
import XLSX from 'xlsx'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const SCAN_DIR   = resolve(__dirname, '../../output/full_scan')
const CACHE_FILE = resolve(__dirname, '../../output/kline_cache.json')
const EXCEL_FILE = resolve(__dirname, '../../output/kline_export.xlsx')
const LOOKBACK_DAYS = 90   // how many days of OHLCV to fetch
const WINDOW_30  = 30      // only fetch stocks scanned in last 30 days

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

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function fetchUrl(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject)
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
  })
}

function notionRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const opts = {
      hostname: 'api.notion.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }
    const req = https.request(opts, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
        catch (e) { reject(e) }
      })
      res.on('error', reject)
    })
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// ── Stock ID collection (last N days of batch_seq CSVs) ───────────────────────
function getStockIdsLast30Days() {
  if (!existsSync(SCAN_DIR)) return []
  const cutoff = new Date(Date.now() - WINDOW_30 * 86400000).toISOString().slice(0, 10)

  const files = readdirSync(SCAN_DIR)
    .filter(f => {
      const m = f.match(/^batch_seq\d+_(\d{4}-\d{2}-\d{2})\.csv$/)
      return m && m[1] >= cutoff
    })
    .sort()

  if (files.length === 0) {
    console.warn('  No batch_seq CSV files found in last 30 days — trying all available')
    // Fallback: use latest date
    const allFiles = readdirSync(SCAN_DIR)
      .filter(f => /^batch_seq\d+_\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort().reverse()
    files.push(...allFiles.slice(0, 9))
  }

  const idSet = new Set()
  for (const f of files) {
    try {
      const rows = parseCSV(readFileSync(`${SCAN_DIR}/${f}`, 'utf-8'))
      rows.forEach(r => r.stock_id && idSet.add(r.stock_id))
    } catch (e) { /* skip */ }
  }
  const dates = [...new Set(files.map(f => f.match(/(\d{4}-\d{2}-\d{2})/)[1]))].sort()
  console.log(`  Scanned dates found: ${dates.join(', ')}`)
  console.log(`  Unique stocks from last 30 days: ${idSet.size}`)
  return [...idSet]
}

// ── Incremental check: which stocks need a K-line update? ─────────────────────
function getStocksNeedingUpdate(existingCache, stockIds) {
  const yesterday = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
  const toFetch = stockIds.filter(sid => {
    const cached = existingCache[sid]
    if (!cached || cached.length === 0) return true
    return cached[cached.length - 1].time < yesterday  // stale
  })
  const skipped = stockIds.length - toFetch.length
  if (skipped > 0) console.log(`  Already up-to-date: ${skipped} stocks (skipping)`)
  return toFetch
}

// ── Fetch single stock K-line ─────────────────────────────────────────────────
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

// ── Fetch a chunk with one token (sequential, with probe) ─────────────────────
async function fetchChunk(stockIds, token, label, startDate, endDate) {
  if (!token || stockIds.length === 0) return {}
  try {
    const probe = await fetchOne(stockIds[0], token, startDate, endDate)
    if (probe?._err) {
      console.warn(`  [${label}] probe failed (status=${probe.status} "${probe.msg}") — skipping`)
      return {}
    }
    const result = { [stockIds[0]]: probe }
    for (const sid of stockIds.slice(1)) {
      try {
        const rows = await fetchOne(sid, token, startDate, endDate)
        if (!rows?._err) result[sid] = rows
        await new Promise(r => setTimeout(r, 80))
      } catch { /* ignore */ }
    }
    console.log(`  [${label}] ${Object.keys(result).length}/${stockIds.length} fetched`)
    return result
  } catch (e) {
    console.warn(`  [${label}] error: ${e.message}`)
    return {}
  }
}

// ── Compute K-line stats for a stock ──────────────────────────────────────────
function computeStats(bars, cutoff30) {
  if (!bars || bars.length === 0) return null
  const bars30 = bars.filter(b => b.time >= cutoff30)
  const latest = bars[bars.length - 1]
  const first30 = bars30[0]
  const return30d = first30 && first30.close > 0
    ? parseFloat(((latest.close - first30.close) / first30.close * 100).toFixed(2))
    : null
  const high30d = bars30.length ? parseFloat(Math.max(...bars30.map(b => b.high)).toFixed(2)) : null
  const low30d  = bars30.length ? parseFloat(Math.min(...bars30.map(b => b.low)).toFixed(2))  : null
  // Also compute 90d return if enough data
  const first90 = bars[0]
  const return90d = first90 && first90.close > 0 && bars.length >= 10
    ? parseFloat(((latest.close - first90.close) / first90.close * 100).toFixed(2))
    : null
  return { latestClose: latest.close, latestDate: latest.time, return30d, high30d, low30d, return90d, days: bars.length }
}

// ── Excel export ──────────────────────────────────────────────────────────────
function exportExcel(klineMap, outputPath) {
  const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const wb = XLSX.utils.book_new()

  // Sheet 1: Summary (one row per stock)
  const summary = Object.entries(klineMap).map(([sid, bars]) => {
    const s = computeStats(bars, cutoff30) || {}
    return {
      '股票代號':   sid,
      '最新收盤':   s.latestClose || '',
      '最後更新':   s.latestDate  || '',
      '30日漲幅%':  s.return30d   ?? '',
      '90日漲幅%':  s.return90d   ?? '',
      '30日最高':   s.high30d     ?? '',
      '30日最低':   s.low30d      ?? '',
      '資料天數':   s.days        || 0,
    }
  }).sort((a, b) => (b['30日漲幅%'] || -999) - (a['30日漲幅%'] || -999))

  const ws1 = XLSX.utils.json_to_sheet(summary)
  ws1['!cols'] = [{ wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 8 }]
  XLSX.utils.book_append_sheet(wb, ws1, 'K線匯總')

  // Sheet 2: Raw OHLCV for last 30 days only (to keep file manageable)
  const raw = []
  for (const [sid, bars] of Object.entries(klineMap)) {
    for (const b of bars.filter(b => b.time >= cutoff30)) {
      raw.push({ '股票代號': sid, '日期': b.time, '開盤': b.open, '最高': b.high, '最低': b.low, '收盤': b.close, '成交量': b.volume })
    }
  }
  raw.sort((a, b) => a['股票代號'].localeCompare(b['股票代號']) || a['日期'].localeCompare(b['日期']))

  const ws2 = XLSX.utils.json_to_sheet(raw)
  XLSX.utils.book_append_sheet(wb, ws2, 'OHLCV(近30日)')

  XLSX.writeFile(wb, outputPath)
  console.log(`Excel saved: ${outputPath} (${summary.length} stocks, ${raw.length} OHLCV rows)`)
}

// ── Notion sync ───────────────────────────────────────────────────────────────
async function syncToNotion(klineMap, token, databaseId) {
  if (!token || !databaseId) { console.log('Notion: skipped (no token/db)'); return }
  const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)

  // Ensure K-line properties exist in the database schema
  try {
    await notionRequest('PATCH', `/v1/databases/${databaseId}`, token, {
      properties: {
        '30日漲幅%': { number: { format: 'percent' } },
        '30日最高':  { number: { format: 'number'  } },
        '30日最低':  { number: { format: 'number'  } },
        '90日漲幅%': { number: { format: 'percent' } },
        'K線更新日': { rich_text: {} },
      },
    })
  } catch (e) { console.warn(`  Notion schema patch warning: ${e.message}`) }

  // Query existing pages (paginate through all)
  let cursor = undefined
  let updated = 0, failed = 0
  do {
    let resp
    try {
      resp = await notionRequest('POST', `/v1/databases/${databaseId}/query`, token, {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      })
    } catch (e) { console.warn(`  Notion query error: ${e.message}`); break }

    const pages = resp.results || []
    for (const page of pages) {
      const sidProp = page.properties?.['股票代號']?.rich_text?.[0]?.text?.content || ''
      if (!sidProp || !klineMap[sidProp]) continue
      const stats = computeStats(klineMap[sidProp], cutoff30)
      if (!stats) continue
      try {
        await notionRequest('PATCH', `/v1/pages/${page.id}`, token, {
          properties: {
            '30日漲幅%': { number: stats.return30d != null ? stats.return30d / 100 : null },
            '90日漲幅%': { number: stats.return90d != null ? stats.return90d / 100 : null },
            '30日最高':  { number: stats.high30d },
            '30日最低':  { number: stats.low30d  },
            'K線更新日': { rich_text: [{ text: { content: stats.latestDate } }] },
          },
        })
        updated++
        await new Promise(r => setTimeout(r, 50))
      } catch (e) { failed++ }
    }

    cursor = resp.has_more ? resp.next_cursor : undefined
  } while (cursor)

  console.log(`Notion: updated ${updated} entries${failed ? `, ${failed} failed` : ''}`)
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

if (tokenDefs.length === 0) { console.error('No FINMIND tokens set.'); process.exit(1) }

const endDate   = new Date().toISOString().slice(0, 10)
const startDate = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10)

console.log('=== K-line incremental fetch ===')
const allStockIds = getStockIdsLast30Days()

// Load existing cache (never deleted below 30-day line)
const existingCache = existsSync(CACHE_FILE)
  ? JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  : {}
console.log(`Cache: ${Object.keys(existingCache).length} stocks already cached`)

// Determine which stocks need an update
const toFetch = getStocksNeedingUpdate(existingCache, allStockIds)
console.log(`To fetch: ${toFetch.length} stocks (${startDate} ~ ${endDate})`)

// Distribute across tokens and fetch in parallel
let klineMap = { ...existingCache }
if (toFetch.length > 0) {
  const chunkSize = Math.ceil(toFetch.length / tokenDefs.length)
  const chunks = tokenDefs.map((t, i) => ({
    ...t, ids: toFetch.slice(i * chunkSize, (i + 1) * chunkSize),
  })).filter(c => c.ids.length > 0)

  const results = await Promise.all(
    chunks.map(c => fetchChunk(c.ids, c.key, c.label, startDate, endDate))
  )
  for (const r of results) Object.assign(klineMap, r)

  const fetched = results.reduce((s, r) => s + Object.keys(r).length, 0)
  const sampleId = Object.keys(klineMap).find(k => klineMap[k]?.length > 0)
  const sampleDays = sampleId ? klineMap[sampleId].length : 0
  console.log(`Fetched: ${fetched}/${toFetch.length} stocks (~${sampleDays} days each)`)
} else {
  console.log('All stocks already up-to-date, skipping API calls')
}

// Save cache (old data preserved, new data merged)
writeFileSync(CACHE_FILE, JSON.stringify(klineMap), 'utf-8')
console.log(`Cache saved: ${Object.keys(klineMap).length} stocks total`)

// Export Excel
console.log('\n=== Excel export ===')
exportExcel(klineMap, EXCEL_FILE)

// Sync to Notion
const notionToken = (process.env.NOTION_TOKEN || '').trim()
const notionDbId  = (process.env.NOTION_DATABASE_ID || '').trim()
console.log('\n=== Notion sync ===')
await syncToNotion(klineMap, notionToken, notionDbId)

console.log('\nDone.')
