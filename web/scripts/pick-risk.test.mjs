import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePickRiskFlags } from './pick-risk.mjs'

test('clean pick (no contradictory signals) → empty', () => {
  assert.deepEqual(computePickRiskFlags({ entry_signal: true, rsi14: 62, base_exit_signal: false }), [])
})

test('flags an exit signal on a bullish pick', () => {
  const f = computePickRiskFlags({ base_exit_signal: true })
  assert.deepEqual(f, [{ key: 'exit', label: '出場訊號' }])
})

test('collects multiple flags in severity order', () => {
  const f = computePickRiskFlags({
    momentum_decay_signal: true,   // decay
    base_exit_signal: true,        // exit (higher severity)
    long_upper_shadow: true,       // upshadow (lower)
  })
  assert.deepEqual(f.map(x => x.key), ['exit', 'decay', 'upshadow'])
})

test('RSI過熱 fires only at ≥80', () => {
  assert.equal(computePickRiskFlags({ rsi14: 79.9 }).length, 0)
  assert.deepEqual(computePickRiskFlags({ rsi14: 80 }), [{ key: 'overbought', label: 'RSI過熱' }])
})

test('tolerates raw CSV string booleans and string numbers', () => {
  const f = computePickRiskFlags({ open_high_close_low: 'True', macd_death_cross: '1', rsi14: '85' })
  assert.deepEqual(f.map(x => x.key), ['ohcl', 'macd_death', 'overbought'])
})

test('guards non-object / missing input', () => {
  assert.deepEqual(computePickRiskFlags(null), [])
  assert.deepEqual(computePickRiskFlags(undefined), [])
  assert.deepEqual(computePickRiskFlags(42), [])
})

test('falsey / absent fields never flag', () => {
  const f = computePickRiskFlags({
    base_exit_signal: false, momentum_decay_signal: 0, open_high_close_low: '',
    macd_death_cross: 'false', close_below_ema20: undefined, long_upper_shadow: null, rsi14: null,
  })
  assert.deepEqual(f, [])
})
