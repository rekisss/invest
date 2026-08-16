import test from 'node:test'
import assert from 'node:assert/strict'
import { checkDataFile, STALE_WARN_DAYS } from './data-preflight.mjs'

const NOW = Date.parse('2026-08-16T06:00:00Z')
const big = 12_000_000

test('缺檔 → error,並指出要先跑 build-data', () => {
  const r = checkDataFile({ exists: false, now: NOW })
  assert.equal(r.level, 'error')
  assert.match(r.message, /npm run data/)
})

test('檔案存在但幾乎是空的 → error(build-data 中途失敗)', () => {
  const r = checkDataFile({ exists: true, sizeBytes: 12, generatedAt: '2026-08-16T05:00:00Z', now: NOW })
  assert.equal(r.level, 'error')
})

test('新鮮的資料 → ok', () => {
  const r = checkDataFile({ exists: true, sizeBytes: big, generatedAt: '2026-08-16T05:00:00Z', now: NOW })
  assert.equal(r.level, 'ok')
})

test(`超過 ${STALE_WARN_DAYS} 天 → warn,但不擋 build`, () => {
  const r = checkDataFile({ exists: true, sizeBytes: big, generatedAt: '2026-08-01T05:00:00Z', now: NOW })
  assert.equal(r.level, 'warn')
  assert.match(r.message, /2026-08-01/)
})

test('剛好在容忍範圍內不警告', () => {
  const at = new Date(NOW - (STALE_WARN_DAYS * 86400000 - 3600000)).toISOString()
  assert.equal(checkDataFile({ exists: true, sizeBytes: big, generatedAt: at, now: NOW }).level, 'ok')
})

test('沒有 generated_at → warn 而非 error(不因缺欄位擋住部署)', () => {
  const r = checkDataFile({ exists: true, sizeBytes: big, generatedAt: null, now: NOW })
  assert.equal(r.level, 'warn')
})

test('generated_at 無法解析 → warn', () => {
  const r = checkDataFile({ exists: true, sizeBytes: big, generatedAt: 'not-a-date', now: NOW })
  assert.equal(r.level, 'warn')
})

test('generated_at 在未來 → warn(時區/時鐘問題)', () => {
  const r = checkDataFile({ exists: true, sizeBytes: big, generatedAt: '2026-08-20T05:00:00Z', now: NOW })
  assert.equal(r.level, 'warn')
  assert.match(r.message, /未來/)
})

test('now 傳 Date 物件也可以', () => {
  const r = checkDataFile({ exists: true, sizeBytes: big, generatedAt: '2026-08-16T05:00:00Z', now: new Date(NOW) })
  assert.equal(r.level, 'ok')
})
