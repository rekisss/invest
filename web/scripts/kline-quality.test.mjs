// K 線品質閘門測試 — 擋掉會讓報酬率最佳化走偏的壞資料。
//
// 釘住的重點:
//   1. 台股 ±10% 漲跌幅上限:單日超過就是缺交易日或未還原權值,不是真實走勢
//   2. 未還原分割要能辨識(緯穎 6669 單日 −67% 的真實案例)
//   3. 零振幅 bar(開=高=低=收)偶爾一根可接受,連續多根是資料問題
//   4. 乾淨的序列不可被誤擋 —— 閘門太嚴會把樣本砍到沒東西可測
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inspectBars, makeKlineQualityGate, DAILY_LIMIT, MIN_BARS, MAX_ZERO_RANGE,
} from './kline-quality.mjs'

// 造 n 根正常波動的日 K(每日 ±1%,有正常振幅)
function normalBars(n, start = 100) {
  const out = []
  let c = start
  for (let i = 0; i < n; i++) {
    c = c * (1 + (i % 2 ? 0.01 : -0.008))
    out.push({
      time: `d${i}`,
      open: +(c * 0.998).toFixed(2), high: +(c * 1.005).toFixed(2),
      low: +(c * 0.995).toFixed(2), close: +c.toFixed(2), volume: 100000,
    })
  }
  return out
}

test('正常序列通過', () => {
  const r = inspectBars(normalBars(60))
  assert.equal(r.ok, true, `不該被擋,reason=${r.reason}`)
  assert.equal(r.limitBreaks, 0)
  assert.equal(r.zeroRange, 0)
})

test('根數不足直接擋下', () => {
  assert.equal(inspectBars(normalBars(MIN_BARS - 1)).reason, 'too_few')
  assert.equal(inspectBars([]).reason, 'too_few')
  assert.equal(inspectBars(null).reason, 'too_few')
  assert.equal(inspectBars(null).bars, 0)
})

test('超過 ±10% 漲跌幅上限的跳動被擋下', () => {
  const b = normalBars(60)
  const last = b[b.length - 1]
  b.push({ time: 'jump', open: last.close * 1.2, high: last.close * 1.2,
           low: last.close * 1.19, close: last.close * 1.2, volume: 1000 })
  const r = inspectBars(b)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'limit_break')
  assert.equal(r.limitBreaks, 1)
  assert.ok(r.worstJumpPct > 10, `應記錄跳幅,實得 ${r.worstJumpPct}`)
})

test('剛好在上限內不擋 —— 閘門不可過嚴', () => {
  const b = normalBars(60)
  const last = b[b.length - 1]
  const c = last.close * (1 + DAILY_LIMIT - 0.005)
  b.push({ time: 'ok', open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1000 })
  assert.equal(inspectBars(b).ok, true, '漲停附近的合法走勢不該被誤擋')
})

test('未還原分割:緯穎 6669 的真實形狀(單日 −67%)', () => {
  const b = normalBars(60, 7800)
  const last = b[b.length - 1]
  b.push({ time: 'split', open: last.close / 3, high: last.close / 3 * 1.03,
           low: last.close / 3 * 0.93, close: last.close / 3, volume: 5000 })
  const r = inspectBars(b)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'limit_break')
  assert.equal(r.splitSuspect, true, '單日腰斬以上要標記為疑似分割')
  assert.ok(r.worstJumpPct < -30)
})

test('零振幅 bar:偶爾一根可接受,過多則擋', () => {
  const mkZero = (n, c) => Array.from({ length: n }, (_, i) => ({
    time: `z${i}`, open: c, high: c, low: c, close: c, volume: 0,
  }))
  const few = [...normalBars(60), ...mkZero(MAX_ZERO_RANGE, 100)]
  // 尾端價位要接得上,避免觸發 limit_break 而不是我們要測的 zero_range
  const tailPx = normalBars(60)[59].close
  const fewOk = [...normalBars(60), ...mkZero(MAX_ZERO_RANGE, tailPx)]
  assert.equal(inspectBars(fewOk).reason, null, '容許根數內不該擋')

  const many = [...normalBars(60), ...mkZero(MAX_ZERO_RANGE + 3, tailPx)]
  const r = inspectBars(many)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'zero_range')
  assert.ok(r.zeroRange > MAX_ZERO_RANGE)
  assert.ok(few.length > 0)
})

test('只看近期視窗 —— 很久以前的跳動不影響現在的交易決策', () => {
  const old = normalBars(20, 100)
  old.push({ time: 'oldjump', open: 200, high: 200, low: 200, close: 200, volume: 1 })
  const b = [...old, ...normalBars(60, 200)]
  assert.equal(inspectBars(b, { window: 40 }).ok, true, '視窗外的跳動不該擋下整檔')
  assert.equal(inspectBars(b, { window: 200 }).ok, false, '視窗放大後應該看得到')
})

test('閘門會快取並統計覆蓋率', () => {
  const data = {
    GOOD: normalBars(60),
    SHORT: normalBars(5),
    JUMP: (() => { const b = normalBars(60); b.push({ time: 'j', open: 999, high: 999, low: 999, close: 999, volume: 1 }); return b })(),
  }
  let calls = 0
  const gate = makeKlineQualityGate((sid) => { calls++; return data[sid] })

  assert.equal(gate.isClean({ stock_id: 'GOOD' }), true)
  assert.equal(gate.isClean({ stock_id: 'GOOD' }), true)
  assert.equal(calls, 1, '同一檔只該檢查一次')

  assert.equal(gate.isClean({ stock_id: 'SHORT' }), false)
  assert.equal(gate.isClean({ stock_id: 'JUMP' }), false)

  const s = gate.stats()
  assert.equal(s.total, 3)
  assert.equal(s.ok, 1)
  assert.equal(s.too_few, 1)
  assert.equal(s.limit_break, 1)
  assert.ok(Math.abs(s.clean_pct - 33.3) < 0.2)
})

test('缺 stock_id 不會炸,視為不乾淨', () => {
  const gate = makeKlineQualityGate(() => normalBars(60))
  assert.equal(gate.isClean({}), false)
  assert.equal(gate.isClean(null), false)
})
