import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseISODate,
  latestScanDate,
  aggregateLagDays,
  isAggregateCurrent,
  currentAggregate,
  freshScanRows,
  AGG_MAX_LAG_DAYS,
} from './aggregate-freshness.mjs'

/** 造一份最小的 data.json 形狀。 */
function mk({ aggDate, aggRows = [], scans = {} } = {}) {
  return {
    scans,
    aggregateLatest: aggDate === undefined ? undefined : { date: aggDate, top_stocks: aggRows, calendar_risk: 'AGG風險' },
  }
}
const scanAt = (date, top = [], filter = []) => ({ [date]: { top_stocks: top, filter_stocks: filter } })

test('parseISODate 只吃 YYYY-MM-DD(可帶時間後綴)', () => {
  assert.ok(Number.isFinite(parseISODate('2026-06-22')))
  assert.ok(Number.isFinite(parseISODate('2026-06-22T00:00:00')))
  for (const bad of ['2026/06/22', '', null, undefined, 20260622, 'N/A']) {
    assert.ok(Number.isNaN(parseISODate(bad)), `${JSON.stringify(bad)} 應為 NaN`)
  }
})

test('latestScanDate 取最新一個「真的有列」的掃描日', () => {
  const scans = {
    '2026-11-14': { top_stocks: [{ stock_id: '1' }] },
    '2026-11-16': { top_stocks: [], filter_stocks: [] },   // 空的,要跳過
    '2026-11-15': { filter_stocks: [{ stock_id: '2' }] },
  }
  assert.equal(latestScanDate({ scans }), '2026-11-15')
})

test('latestScanDate 在沒有掃描時回 null,不丟例外', () => {
  assert.equal(latestScanDate({ scans: {} }), null)
  assert.equal(latestScanDate({}), null)
  assert.equal(latestScanDate(null), null)
  assert.equal(latestScanDate({ scans: { '2026-11-16': null } }), null)
})

test('aggregateLagDays 算落後天數;無從判斷時回 null', () => {
  const scans = scanAt('2026-11-16', [{ stock_id: '1' }])
  assert.equal(aggregateLagDays(mk({ aggDate: '2026-11-16', scans })), 0)
  assert.equal(aggregateLagDays(mk({ aggDate: '2026-11-15', scans })), 1)
  assert.equal(aggregateLagDays(mk({ aggDate: '2026-06-22', scans })), 147)
  // aggregate 比掃描還新 → 負數
  assert.equal(aggregateLagDays(mk({ aggDate: '2026-11-17', scans })), -1)
  // 缺一邊 → null
  assert.equal(aggregateLagDays(mk({ aggDate: '2026-11-16', scans: {} })), null)
  assert.equal(aggregateLagDays(mk({ aggDate: undefined, scans })), null)
  assert.equal(aggregateLagDays(mk({ aggDate: 'N/A', scans })), null)
})

test(`落後 0~${AGG_MAX_LAG_DAYS} 天算當期(資料日 vs 執行日差一天是正常的)`, () => {
  const scans = scanAt('2026-11-16', [{ stock_id: '1' }])
  assert.equal(isAggregateCurrent(mk({ aggDate: '2026-11-16', scans })), true)
  assert.equal(isAggregateCurrent(mk({ aggDate: '2026-11-15', scans })), true)
  // 落後 2 天就不是當期
  assert.equal(isAggregateCurrent(mk({ aggDate: '2026-11-14', scans })), false)
})

test('aggregate 比掃描新 → 仍算當期(它自己就是最新的那份)', () => {
  const scans = scanAt('2026-11-16', [{ stock_id: '1' }])
  assert.equal(isAggregateCurrent(mk({ aggDate: '2026-11-18', scans })), true)
})

test('無從判斷時 fail closed —— 不確定就不採用', () => {
  const scans = scanAt('2026-11-16', [{ stock_id: '1' }])
  assert.equal(isAggregateCurrent(mk({ aggDate: undefined, scans })), false)  // 沒有 aggregate
  assert.equal(isAggregateCurrent(mk({ aggDate: 'N/A', scans })), false)      // 日期壞掉
  assert.equal(isAggregateCurrent(mk({ aggDate: '2026-11-16', scans: {} })), false) // 沒有掃描可比
  assert.equal(isAggregateCurrent(null), false)
  assert.equal(isAggregateCurrent(undefined), false)
})

test('currentAggregate 當期回物件、過期回 null', () => {
  const scans = scanAt('2026-11-16', [{ stock_id: '1' }])
  assert.equal(currentAggregate(mk({ aggDate: '2026-11-16', scans }))?.calendar_risk, 'AGG風險')
  assert.equal(currentAggregate(mk({ aggDate: '2026-06-22', scans })), null)
  // 給 ?. 串用時不該丟例外
  assert.equal(currentAggregate(mk({ aggDate: '2026-06-22', scans }))?.calendar_risk, undefined)
})

test('freshScanRows:當日掃描在前,當期 aggregate 排最後', () => {
  const scans = scanAt('2026-11-16', [{ stock_id: 'T' }], [{ stock_id: 'F' }])
  const rows = freshScanRows(mk({ aggDate: '2026-11-16', aggRows: [{ stock_id: 'A' }], scans }))
  assert.deepEqual(rows.map(r => r.stock_id), ['T', 'F', 'A'])
})

test('freshScanRows:aggregate 過期就整份擋掉', () => {
  const scans = scanAt('2026-11-16', [{ stock_id: 'T' }], [{ stock_id: 'F' }])
  const rows = freshScanRows(mk({ aggDate: '2026-06-22', aggRows: [{ stock_id: 'A' }], scans }))
  assert.deepEqual(rows.map(r => r.stock_id), ['T', 'F'])
})

test('freshScanRows 參數殘缺也不丟例外', () => {
  assert.deepEqual(freshScanRows(), [])
  assert.deepEqual(freshScanRows(null), [])
  assert.deepEqual(freshScanRows({}), [])
  assert.deepEqual(freshScanRows({ scans: {} }), [])
})

// ── 回歸:2026-06-22 凍結的 aggregate_latest.json 污染持股價格 ────────────────

test('回歸:六月 aggregate 不得蓋掉當日掃描價(.find() 取第一筆的消費端)', () => {
  // 真實數字(2026-11-16 的 data.json):聯茂 6213 在六月那份是 308,
  // 當日掃描是 480 —— 差 +55.84%。六月那份原本排在最前面,.find() 就拿它。
  const data = mk({
    aggDate: '2026-06-22',
    aggRows: [{ stock_id: '6213', name: '聯茂', close: 308 }],
    scans: scanAt('2026-11-16', [{ stock_id: '6213', name: '聯茂', close: 480 }]),
  })
  const rows = freshScanRows(data)
  const close = rows.find(r => String(r.stock_id) === '6213')?.close
  assert.equal(close, 480, '必須拿到當日掃描價,不是六月價')
  assert.equal(rows.length, 1, '六月那筆不該出現在列表裡')
})

test('回歸:逐檔比對「欄位最多的贏」的消費端也不得被 aggregate 蓋掉', () => {
  // Performance.jsx 的 tiebreak 跟順序無關,只比欄位數。aggregate 的列欄位多,
  // 光排到後面救不了 —— 必須靠「過期就整份擋掉」。
  const data = mk({
    aggDate: '2026-06-22',
    aggRows: [{ stock_id: '6274', name: '台燿', close: 1900, extra1: 1, extra2: 2, extra3: 3 }],
    scans: scanAt('2026-11-16', [{ stock_id: '6274', close: 877 }]),
  })
  const byId = {}
  for (const r of freshScanRows(data)) {
    const id = String(r.stock_id)
    if (!byId[id] || Object.keys(r).length > Object.keys(byId[id]).length) byId[id] = r
  }
  assert.equal(byId['6274'].close, 877, '欄位較多的六月列不該贏')
})

test('回歸:aggregate 當期時仍要照用(閘門不能一律封死)', () => {
  // 修正的目的是擋過期,不是停用這個資料源。同日時 aggregate 仍要進列表,
  // 且因為當日 CSV 掃描較完整而排在它後面。
  const data = mk({
    aggDate: '2026-11-16',
    aggRows: [{ stock_id: '9999', close: 10 }],
    scans: scanAt('2026-11-16', [{ stock_id: '1111', close: 20 }]),
  })
  const rows = freshScanRows(data)
  assert.equal(rows.length, 2)
  assert.equal(rows.find(r => r.stock_id === '9999')?.close, 10, 'aggregate 獨有的列仍要可見')
})

// ── build 端:過期的 aggregate 不寫進 data.json ───────────────────────────────
//
// build-data.mjs 用同一支函式決定要不要把 aggregateLatest 寫出去。這裡用
// build 端的輸入形狀({ scans, aggregateLatest })把那個決策固定下來,避免
// 日後有人改動注入邏輯時讓兩邊的規則漂移。

test('build 端:過期 aggregate → 不寫出(null)', () => {
  // 真實情境:aggregate 停在 2026-06-22,最新掃描是 2026-11-16。
  // 注意六月那份**會**被注入 scans 當成歷史掃描日(按時間順序插入,不是 dates[0]),
  // 所以 scans 同時有兩個日期 —— 判定必須挑到最新那個才會算出 147 天。
  const input = {
    scans: {
      '2026-06-22': { top_stocks: [{ stock_id: '6213', close: 308 }] },
      '2026-11-16': { top_stocks: [{ stock_id: '6213', close: 480 }] },
    },
    aggregateLatest: { date: '2026-06-22', top_stocks: [{ stock_id: '6213', close: 308 }] },
  }
  assert.equal(aggregateLagDays(input), 147)
  assert.equal(isAggregateCurrent(input), false)
  assert.equal(currentAggregate(input), null, 'build 應寫出 null')
})

test('build 端:真的被注入成最新 → 當期,照寫出', () => {
  // aggregate 比所有 CSV 掃描都新時,build-data.mjs 會把它注入成最新掃描日。
  // 判定必須在注入**之後**才算,否則會把剛注入的那份誤判成過期。
  const agg = { date: '2026-11-17', top_stocks: [{ stock_id: '2330', close: 1000 }] }
  const input = {
    scans: {
      '2026-11-16': { top_stocks: [{ stock_id: '2330', close: 990 }] },
      '2026-11-17': { top_stocks: agg.top_stocks, from_aggregate_json: true },
    },
    aggregateLatest: agg,
  }
  assert.equal(aggregateLagDays(input), 0)
  assert.equal(isAggregateCurrent(input), true)
  assert.equal(currentAggregate(input), agg, '當期就該照寫出,閘門不是一律封死')
})

test('build 端:沒有 aggregate 檔案時不丟例外', () => {
  const input = { scans: { '2026-11-16': { top_stocks: [{ stock_id: '1' }] } }, aggregateLatest: null }
  assert.equal(isAggregateCurrent(input), false)
  assert.equal(currentAggregate(input), null)
})
