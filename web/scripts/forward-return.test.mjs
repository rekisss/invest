// buildForwardReturn — 前瞻報酬必須走「真實交易日曆」的回歸測試。
//
// 這裡守的是一個實際發生過的錯誤:勝率統計原本直接對
// priceHistoryMap[sid] 做 `entryIdx + h`,而那個陣列只收「這檔出現過的掃描日」。
// 掃描部分失敗的日子(實測 544 / 1062 / 1148 檔 vs 正常 ~1510 檔)會讓缺席的
// 股票少一格,index 加法就悄悄跳過那一天 → 「5 日報酬」變成 6、7 日報酬。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildForwardReturn } from './forward-return.mjs'

// build-data.mjs 的 getKlineBars:支援 [bars] 與 {'1d': [bars]} 兩種快取格式
const getBars = (entry, interval) => {
  if (!entry) return undefined
  if (Array.isArray(entry)) return interval === '1d' ? entry : undefined
  const bars = entry[interval]
  return Array.isArray(bars) && bars.length >= 2 ? bars : undefined
}

const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12']
const klineBars = D.map((time, i) => ({ time, close: 100 + i }))   // 100,101,…,105

// 掃描歷史:2330 每天都在;1101 缺席 01-07(模擬部分掃描日)
const priceHistoryMap = {
  '2330': D.map((time, i) => ({ time, close: 100 + i })),
  '1101': D.filter(d => d !== '2026-01-07').map((time, i) => ({ time, close: 50 + i })),
}

test('日 K 存在時以真實交易日曆計算,缺席的掃描日不影響期距', () => {
  const fwd = buildForwardReturn(D, priceHistoryMap, { '1101': klineBars }, getBars)
  // 01-05 起算 2 個交易日 → 01-07,close 100 → 102
  assert.equal(fwd('1101', '2026-01-05', 2).toFixed(6), (2 / 100).toFixed(6))
})

test('沒有日 K 時退回掃描收盤,但以全域掃描日對齊', () => {
  const fwd = buildForwardReturn(D, priceHistoryMap, {}, getBars)
  // 2330 每天都在:01-05(100) → 01-07(102)
  assert.equal(fwd('2330', '2026-01-05', 2).toFixed(6), (2 / 100).toFixed(6))
})

test('關鍵回歸:目標日缺價時回 null,絕不把期距順延到下一個有價的日子', () => {
  const fwd = buildForwardReturn(D, priceHistoryMap, {}, getBars)
  // 1101 缺 01-07。舊的 index 加法會拿 01-08 當「2 日後」(其實是 3 日後)。
  assert.equal(fwd('1101', '2026-01-05', 2), null)
  // 起點本身缺價一樣回 null
  assert.equal(fwd('1101', '2026-01-07', 1), null)
})

test('期距未到期回 null(不會借用最後一根 K 棒充數)', () => {
  const fwd = buildForwardReturn(D, priceHistoryMap, { '1101': klineBars }, getBars)
  assert.equal(fwd('1101', '2026-01-12', 1), null)   // 日 K 已到最後一根
  assert.equal(fwd('2330', '2026-01-12', 1), null)   // 掃描日清單已到最後一天
})

test('未知代號 / 未知日期 / 非法價格都回 null', () => {
  const fwd = buildForwardReturn(D, priceHistoryMap, {}, getBars)
  assert.equal(fwd('9999', '2026-01-05', 1), null)
  assert.equal(fwd('2330', '2025-12-31', 1), null)

  const zero = buildForwardReturn(D, {
    '0000': D.map(time => ({ time, close: 0 })),
  }, {}, getBars)
  assert.equal(zero('0000', '2026-01-05', 1), null)
})

test('殘缺的 kline 項目(只有 1 根 bar)自動退回掃描收盤,不會整檔沒資料', () => {
  const fwd = buildForwardReturn(D, priceHistoryMap, { '2330': [{ time: D[0], close: 100 }] }, getBars)
  assert.equal(fwd('2330', '2026-01-05', 2).toFixed(6), (2 / 100).toFixed(6))
})

test('h=1 與 h=5 用的是同一條日曆,報酬可疊加驗證', () => {
  const fwd = buildForwardReturn(D, priceHistoryMap, { '2330': klineBars }, getBars)
  const r1 = fwd('2330', '2026-01-05', 1)   // 100 → 101
  const r5 = fwd('2330', '2026-01-05', 5)   // 100 → 105
  assert.equal(r1.toFixed(6), (1 / 100).toFixed(6))
  assert.equal(r5.toFixed(6), (5 / 100).toFixed(6))
})
