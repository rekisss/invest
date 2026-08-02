import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeGradeDigest } from './grade-digest.mjs'

const mk = (grades) => grades.map((g, i) => ({ stock_id: String(1000 + i), grade: g }))

test('counts grades and computes actionable (A/B/C)', () => {
  const d = computeGradeDigest(mk(['A', 'A', 'B', 'C', 'D', 'D', 'D']))
  assert.deepEqual(d.counts, { A: 2, B: 1, C: 1, D: 3 })
  assert.equal(d.total, 7)
  assert.equal(d.actionable, 4)
  assert.equal(d.real, null) // 無 outcomeStats
})

test('attaches real win rates only for grades with samples', () => {
  const os = {
    A: { total: 20, win_rate: 58.0, avg_return_pct: 1.2 },
    B: { total: 0, win_rate: null, avg_return_pct: null },   // 無樣本 → 略過
    C: { total: 15, win_rate: 49.5, avg_return_pct: 0.3 },
    D: { total: 0, win_rate: null },
  }
  const d = computeGradeDigest(mk(['A', 'B', 'C']), os)
  assert.ok(d.real.A && d.real.A.win_rate === 58.0)
  assert.equal(d.real.B, undefined)   // B 無樣本
  assert.ok(d.real.C && d.real.C.total === 15)
})

test('tolerates lowercase / whitespace grades', () => {
  const d = computeGradeDigest([{ stock_id: '1', grade: ' a ' }, { stock_id: '2', grade: 'b' }])
  assert.deepEqual(d.counts, { A: 1, B: 1, C: 0, D: 0 })
})

test('returns null when no gradable rows / empty', () => {
  assert.equal(computeGradeDigest([{ stock_id: '1', grade: '' }, { stock_id: '2' }]), null)
  assert.equal(computeGradeDigest([]), null)
  assert.equal(computeGradeDigest(null), null)
})

test('all-zero outcomeStats yields real=null (no misleading numbers)', () => {
  const os = { A: { total: 0, win_rate: null }, B: { total: 0, win_rate: null }, C: { total: 0, win_rate: null }, D: { total: 0, win_rate: null } }
  const d = computeGradeDigest(mk(['A', 'B', 'C']), os)
  assert.equal(d.real, null)
})
