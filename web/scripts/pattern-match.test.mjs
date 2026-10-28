// patternMatch — 手繪型態搜尋的純函式測試。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resampleDrawing, resampleSeries, zNormalize, correlation, findSimilarPatterns, PRESET_PATTERNS, SAMPLES,
} from '../src/utils/patternMatch.js'

const pts = arr => arr.map(([x, y]) => ({ x, y }))

test('resampleDrawing:排序、去重 x、內插到固定點數', () => {
  const out = resampleDrawing(pts([[1, 1], [0, 0], [0, 0.5]]), 3)
  assert.deepEqual(out, [0.5, 0.75, 1])
  assert.equal(resampleDrawing(pts([[0, 0]])), null)
  assert.equal(resampleDrawing(pts([[2, 0], [2, 1]])), null)
  assert.equal(resampleDrawing(pts([[0, 0], [1, 1]])).length, SAMPLES)
})

test('resampleSeries:端點保留、線性內插', () => {
  assert.deepEqual(resampleSeries([0, 10], 3), [0, 5, 10])
  assert.deepEqual(resampleSeries([1, 2, 3], 3), [1, 2, 3])
})

test('zNormalize:平線回傳 null;相關係數同形=1、反向=-1', () => {
  assert.equal(zNormalize([5, 5, 5]), null)
  assert.equal(zNormalize([100, 100.01, 100], 0.003), null)
  const a = zNormalize([1, 2, 3, 2, 1])
  const b = zNormalize([10, 20, 30, 20, 10])
  const c = zNormalize([3, 2, 1, 2, 3])
  assert.ok(Math.abs(correlation(a, b) - 1) < 1e-9)
  assert.ok(Math.abs(correlation(a, c) + 1) < 1e-9)
})

test('findSimilarPatterns:V 轉範本會把 V 形股票排第一,倒 V 排最後', () => {
  const n = 60
  const v = Array.from({ length: n }, (_, i) => 100 + Math.abs(i - n / 2))
  const inv = Array.from({ length: n }, (_, i) => 100 - Math.abs(i - n / 2))
  const up = Array.from({ length: n }, (_, i) => 50 + i)
  const flat = Array.from({ length: n }, () => 30)
  // 前面加一段雜訊 + null 缺口,確認只取最近的有效收盤
  const pad = [null, 80, 70, null]
  const stocks = {
    V: { c: [...pad, ...v], v: Array(n + 4).fill(1000) },
    INV: { c: [...pad, ...inv], v: Array(n + 4).fill(1000) },
    UP: { c: [...pad, ...up], v: Array(n + 4).fill(1000) },
    FLAT: { c: flat, v: Array(n).fill(1000) },
    SHORT: { c: [1, 2, 3] },
  }
  const vPreset = PRESET_PATTERNS.find(p => p.key === 'vrev')
  const tpl = resampleDrawing(pts(vPreset.points))
  const res = findSimilarPatterns(tpl, stocks, { lookback: 60, flexible: false })
  assert.deepEqual(res.map(r => r.stock_id), ['V', 'UP', 'INV'])
  assert.ok(res[0].score > 0.95)
  assert.ok(res[2].score < -0.9)
  assert.equal(res[0].closes.length, 60)
})

test('findSimilarPatterns:成交量門檻過濾冷門股;topN 生效;壞輸入不炸', () => {
  const n = 30
  const s = Array.from({ length: n }, (_, i) => 10 + i)
  const stocks = { A: { c: s, v: Array(n).fill(5000) }, B: { c: s, v: Array(n).fill(10) }, C: { c: s } }
  const tpl = [0, 1]
  assert.deepEqual(findSimilarPatterns(tpl, stocks, { lookback: 20, minAvgVolume: 1000 }).map(r => r.stock_id), ['A'])
  assert.equal(findSimilarPatterns(tpl, stocks, { lookback: 20, topN: 2 }).length, 2)
  assert.deepEqual(findSimilarPatterns(null, stocks), [])
  assert.deepEqual(findSimilarPatterns([1, 1, 1], stocks), [])
  assert.deepEqual(findSimilarPatterns(tpl, null), [])
})
