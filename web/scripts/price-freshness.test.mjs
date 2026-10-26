import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkPriceFreshness,
  weekdaysBetween,
  taipeiToday,
  parseBarDate,
  latestBarFromHistories,
  WARN_WEEKDAYS,
  STALE_WEEKDAYS,
} from './price-freshness.mjs'

// 2026-10-26 是星期一。UTC 06:00 = 台北 14:00(收盤後)。
const MON = Date.parse('2026-10-26T06:00:00Z')

test('parseBarDate 只接受 YYYY-MM-DD', () => {
  assert.ok(Number.isFinite(parseBarDate('2026-09-03')))
  assert.ok(Number.isNaN(parseBarDate('2026/09/03')))
  assert.ok(Number.isNaN(parseBarDate('')))
  assert.ok(Number.isNaN(parseBarDate(null)))
  assert.ok(Number.isNaN(parseBarDate(20260903)))
})

test('taipeiToday 用台北時區,不是 UTC', () => {
  // UTC 2026-10-25 17:00 = 台北 2026-10-26 01:00 → 台北已經是 26 號
  assert.equal(taipeiToday(Date.parse('2026-10-25T17:00:00Z')), '2026-10-26')
  // UTC 2026-10-25 15:00 = 台北 23:00,還是 25 號
  assert.equal(taipeiToday(Date.parse('2026-10-25T15:00:00Z')), '2026-10-25')
})

test('weekdaysBetween 跳過週末', () => {
  assert.equal(weekdaysBetween('2026-10-26', '2026-10-26'), 0)
  // 週五(23)→ 週一(26):只有 26 這一個平日
  assert.equal(weekdaysBetween('2026-10-23', '2026-10-26'), 1)
  // 週五(23)→ 下週五(30):26,27,28,29,30 共 5 個平日
  assert.equal(weekdaysBetween('2026-10-23', '2026-10-30'), 5)
  // 整個日曆週 = 5 個平日
  assert.equal(weekdaysBetween('2026-10-19', '2026-10-26'), 5)
})

test('weekdaysBetween 反向為負(時鐘異常時用得到)', () => {
  assert.equal(weekdaysBetween('2026-10-30', '2026-10-23'), -5)
})

test('當天的 K 棒 → ok', () => {
  const r = checkPriceFreshness({ latestBar: '2026-10-26', now: MON })
  assert.equal(r.level, 'ok')
  assert.equal(r.weekdaysBehind, 0)
})

test('週一早上還沒有今天 K 棒(最新是上週五)→ ok,不該在每個週一誤報', () => {
  const r = checkPriceFreshness({ latestBar: '2026-10-23', now: MON })
  assert.equal(r.level, 'ok')
  assert.equal(r.weekdaysBehind, 1)
  // 日曆天數是 3 天——用日曆天數判斷就會誤報,這就是改用平日的原因
  assert.equal(r.ageDays, 3)
})

test(`落後 ${WARN_WEEKDAYS} 個平日 → warn`, () => {
  const r = checkPriceFreshness({ latestBar: '2026-10-22', now: MON })
  assert.equal(r.weekdaysBehind, 2)
  assert.equal(r.level, 'warn')
})

test('連假長度的落後仍是 warn,不會誤判成壞掉', () => {
  // 落後 6 個平日,還在農曆年可解釋的範圍內
  const r = checkPriceFreshness({ latestBar: '2026-10-16', now: MON })
  assert.equal(r.weekdaysBehind, 6)
  assert.equal(r.level, 'warn')
})

test(`落後 ${STALE_WEEKDAYS} 個平日 → stale(假日解釋不了)`, () => {
  const r = checkPriceFreshness({ latestBar: '2026-10-15', now: MON })
  assert.equal(r.weekdaysBehind, 7)
  assert.equal(r.level, 'stale')
})

test('回歸:2026-09-03 凍結事件在當時就該被判為 stale', () => {
  // 真實故障——kline_cache.json 自 2026-09-03 起停止更新,41 天沒人發現。
  const r = checkPriceFreshness({ latestBar: '2026-09-03', now: Date.parse('2026-10-14T12:00:00Z') })
  assert.equal(r.level, 'stale')
  assert.equal(r.ageDays, 41)
  assert.ok(r.weekdaysBehind >= 25, `weekdaysBehind=${r.weekdaysBehind}`)
  assert.match(r.message, /kline/)
})

test('回歸:凍結第一週就會進入 stale,不必等 41 天', () => {
  // 09-03(四)凍結,到 09-15(二)已落後 8 個平日 → 當週就該亮紅燈
  const r = checkPriceFreshness({ latestBar: '2026-09-03', now: Date.parse('2026-09-15T06:00:00Z') })
  assert.equal(r.level, 'stale')
})

test('缺日期 → unknown,不當成通過', () => {
  for (const bad of [undefined, null, '', 'N/A']) {
    const r = checkPriceFreshness({ latestBar: bad, now: MON })
    assert.equal(r.level, 'unknown', `latestBar=${JSON.stringify(bad)}`)
  }
})

test('未來日期 → warn 並指出時區/時鐘問題', () => {
  const r = checkPriceFreshness({ latestBar: '2026-11-02', now: MON })
  assert.equal(r.level, 'warn')
  assert.match(r.message, /時區|時鐘/)
})

test('latestBarFromHistories 取最大日期', () => {
  assert.equal(latestBarFromHistories({ dates: ['2026-10-01', '2026-10-26', '2026-10-15'] }), '2026-10-26')
  assert.equal(latestBarFromHistories({ dates: [] }), null)
  assert.equal(latestBarFromHistories({}), null)
  assert.equal(latestBarFromHistories(null), null)
})

test('checkPriceFreshness 不需要參數也不該丟例外', () => {
  const r = checkPriceFreshness()
  assert.equal(r.level, 'unknown')
})
