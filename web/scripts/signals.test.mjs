import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeSignalAgreement } from './signals.mjs'

test('agree bullish: model 看多 + bias 偏多 → agree', () => {
  const a = computeSignalAgreement({ modelProb: 0.68, biasScore: 40 })
  assert.equal(a.state, 'agree')
  assert.equal(a.model_dir, 1)
  assert.equal(a.bias_dir, 1)
  assert.ok(a.label.includes('偏多'))
})

test('agree bearish: model 看空 + bias 偏空 → agree', () => {
  const a = computeSignalAgreement({ modelProb: 0.32, biasScore: -40 })
  assert.equal(a.state, 'agree')
  assert.ok(a.label.includes('偏空'))
})

test('diverge: model 看多 but bias 偏空 → diverge (low confidence)', () => {
  const a = computeSignalAgreement({ modelProb: 0.64, biasScore: -46 })
  assert.equal(a.state, 'diverge')
  assert.ok(a.note.includes('方向不明'))
})

test('mixed: one side neutral → mixed', () => {
  assert.equal(computeSignalAgreement({ modelProb: 0.5, biasScore: 40 }).state, 'mixed')
  assert.equal(computeSignalAgreement({ modelProb: 0.68, biasScore: 5 }).state, 'mixed')
})

test('boundary: prob 0.55 / score 20 count as directional', () => {
  const a = computeSignalAgreement({ modelProb: 0.55, biasScore: 20 })
  assert.equal(a.state, 'agree')
  const b = computeSignalAgreement({ modelProb: 0.45, biasScore: -20 })
  assert.equal(b.state, 'agree')
})

test('null when either source missing', () => {
  assert.equal(computeSignalAgreement({ modelProb: 0.7 }), null)
  assert.equal(computeSignalAgreement({ biasScore: 40 }), null)
  assert.equal(computeSignalAgreement({ modelProb: null, biasScore: 40 }), null)
  assert.equal(computeSignalAgreement({}), null)
})
