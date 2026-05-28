import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAN_DIR = resolve(__dirname, '../../output/full_scan')
const PUBLIC_DIR = resolve(__dirname, '../public')
const OUTPUT_FILE = join(PUBLIC_DIR, 'data.json')
const TOP_N = 50
const MAX_DATES = 14

function parseCSVLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += ch
    }
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

if (!existsSync(SCAN_DIR)) {
  console.warn('Scan directory not found:', SCAN_DIR)
  mkdirSync(PUBLIC_DIR, { recursive: true })
  writeFileSync(OUTPUT_FILE, JSON.stringify({ generated_at: new Date().toISOString(), dates: [], scans: {} }), 'utf-8')
  process.exit(0)
}

const files = readdirSync(SCAN_DIR)
  .filter(f => /^batch_seq\d+_\d{4}-\d{2}-\d{2}\.csv$/.test(f))
  .sort()

const dateMap = {}
for (const file of files) {
  const match = file.match(/(\d{4}-\d{2}-\d{2})/)
  if (!match) continue
  const date = match[1]
  if (!dateMap[date]) dateMap[date] = []
  try {
    const content = readFileSync(join(SCAN_DIR, file), 'utf-8')
    dateMap[date].push(...parseCSV(content))
  } catch (e) {
    console.warn(`Skip ${file}:`, e.message)
  }
}

const dates = Object.keys(dateMap).sort().reverse().slice(0, MAX_DATES)
const scans = {}

for (const date of dates) {
  const rows = dateMap[date]
  const stockMap = {}
  for (const row of rows) {
    const sid = row.stock_id
    const score = toNum(row.entry_score)
    if (!stockMap[sid] || score > toNum(stockMap[sid].entry_score)) {
      stockMap[sid] = row
    }
  }

  const allStocks = Object.values(stockMap)
    .sort((a, b) => toNum(b.entry_score) - toNum(a.entry_score))

  const topStocks = allStocks.slice(0, TOP_N).map((row, i) => ({
    rank: i + 1,
    stock_id: row.stock_id,
    name: row.name || '',
    industry_category: row.industry_category || '',
    close: toNum(row.close),
    volume_ratio: toNum(row.volume_ratio),
    rsi14: toNum(row.rsi14),
    adx14: toNum(row.adx14),
    entry_score: Math.round(toNum(row.entry_score)),
    entry_signal: toBool(row.entry_signal),
    foreign_buy_streak: toNum(row.foreign_buy_streak),
    invest_trust_streak: toNum(row.invest_trust_streak),
    f_score: toNum(row.f_score),
    condition_count: toNum(row.condition_count),
  }))

  scans[date] = {
    total_scanned: allStocks.length,
    entry_count: allStocks.filter(r => toBool(r.entry_signal)).length,
    top_stocks: topStocks,
  }
}

// Persistent rankings: stocks appearing in TOP 50 on multiple dates
const stockHistory = {}
for (let i = 0; i < dates.length; i++) {
  const date = dates[i]
  for (const stock of scans[date]?.top_stocks || []) {
    const sid = stock.stock_id
    if (!stockHistory[sid]) stockHistory[sid] = { name: stock.name, industry_category: stock.industry_category, scores: [] }
    stockHistory[sid].scores.push({ date, score: stock.entry_score })
  }
}

const persistent = Object.entries(stockHistory)
  .filter(([, d]) => d.scores.length >= 2)
  .map(([sid, d]) => {
    const sorted = d.scores.sort((a, b) => b.date.localeCompare(a.date))
    const latest = sorted[0].score
    const prev = sorted[1].score
    return {
      stock_id: sid,
      name: d.name,
      industry_category: d.industry_category,
      days_in_top: d.scores.length,
      latest_score: latest,
      score_trend: latest - prev,
    }
  })
  .sort((a, b) => b.days_in_top - a.days_in_top || b.latest_score - a.latest_score)
  .slice(0, 20)

if (dates.length > 0 && scans[dates[0]]) {
  scans[dates[0]].persistent = persistent
}

mkdirSync(PUBLIC_DIR, { recursive: true })
const output = { generated_at: new Date().toISOString(), dates, scans }
writeFileSync(OUTPUT_FILE, JSON.stringify(output), 'utf-8')
console.log(`data.json: ${dates.length} dates, latest=${dates[0]}, stocks=${scans[dates[0]]?.total_scanned ?? 0}, entry=${scans[dates[0]]?.entry_count ?? 0}`)
