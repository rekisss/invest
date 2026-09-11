// 亂數對照分布測試 — 讓「策略有沒有贏過亂選」這個判斷有統計意義。
//
// 釘住的重點:
//   1. 同種子可重現、不同種子不相關(否則跑 N 次等於跑 1 次)
//   2. 百分位排名的語意正確(50 = 跟亂選沒兩樣)
//   3. verdict 需要兩個指標同時達標,不能單靠報酬率好看就判定有加值
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  seededRank, percentile, percentileRankOf, summarizeControl, scoreAgainstControl,
} from './random-control.mjs'

const ids = Array.from({ length: 200 }, (_, i) => ({ stock_id: String(1000 + i) }))
const order = (rank) => [...ids].sort((a, b) => rank(b) - rank(a)).map(s => s.stock_id)

test('同一個種子完全可重現', () => {
  assert.deepEqual(order(seededRank(7)), order(seededRank(7)))
})

test('不同種子給出不同排序 —— 否則跑 N 次等於跑 1 次', () => {
  const a = order(seededRank(1)), b = order(seededRank(2))
  assert.notDeepEqual(a, b)
  // 前 10 名的重疊度應該很低(隨機排序下期望重疊 10×10/200 = 0.5 檔)
  const overlap = a.slice(0, 10).filter(x => b.slice(0, 10).includes(x)).length
  assert.ok(overlap <= 3, `前 10 名重疊 ${overlap} 檔,種子之間相關性過高`)
})

test('種子 0 與未給值不會炸', () => {
  assert.equal(typeof seededRank(0)({ stock_id: 'A' }), 'number')
  assert.equal(typeof seededRank(undefined)({ stock_id: 'A' }), 'number')
  assert.equal(typeof seededRank(5)({}), 'number', '缺 stock_id 也要回傳數字')
})

test('百分位取最近秩次,不內插', () => {
  const xs = [1, 2, 3, 4, 5]
  assert.equal(percentile(xs, 0), 1)
  assert.equal(percentile(xs, 1), 5)
  assert.equal(percentile(xs, 0.5), 3)
  assert.equal(percentile([], 0.5), null)
})

test('百分位排名:50 代表與亂選無法區分', () => {
  const xs = [-4, -2, 0, 2, 4]
  assert.equal(percentileRankOf(-5, xs), 0, '比全部都差')
  assert.equal(percentileRankOf(5, xs), 100, '比全部都好')
  assert.equal(percentileRankOf(0, xs), 40)
  assert.equal(percentileRankOf(null, xs), null)
})

const mkRun = (ret, exp, win = 50, n = 10) => ({
  return_pct: ret, stats: { avg_ret: exp, win_rate: win, num_trades: n },
})

test('分布摘要涵蓋平均、中位與兩端', () => {
  const runs = [mkRun(-5, -1), mkRun(0, 0), mkRun(5, 1), mkRun(10, 2)]
  const c = summarizeControl(runs)
  assert.equal(c.seeds, 4)
  assert.equal(c.return_pct.mean, 2.5)
  assert.equal(c.return_pct.min, -5)
  assert.equal(c.return_pct.max, 10)
  assert.equal(c.return_pct.median, 2.5)
  assert.equal(c.avg_ret.mean, 0.5)
})

test('空輸入回 null,不回假的零', () => {
  assert.equal(summarizeControl([]), null)
  assert.equal(summarizeControl(null), null)
  assert.equal(summarizeControl([null, undefined]), null)
})

test('verdict 需要兩個指標同時達標', () => {
  const control = summarizeControl([mkRun(-4, -1), mkRun(-2, -0.5), mkRun(0, 0), mkRun(2, 0.5), mkRun(4, 1)])

  const good = scoreAgainstControl(mkRun(99, 99), control)
  assert.equal(good.verdict, 'above')

  const bad = scoreAgainstControl(mkRun(-99, -99), control)
  assert.equal(bad.verdict, 'below')

  const mid = scoreAgainstControl(mkRun(0, 0), control)
  assert.equal(mid.verdict, 'within', '落在分布中間 = 與亂選無法區分')

  // 報酬率亮眼但每筆期望值很差 → 不可判定有加值(可能只是多做幾筆撞運氣)
  const mixed = scoreAgainstControl(mkRun(99, -99), control)
  assert.equal(mixed.verdict, 'within',
    '只有單一指標好看就不該算贏 —— 這正是單一對照組會犯的錯')
})

test('對照分布本身落在自己的中間', () => {
  const runs = [mkRun(-4, -1), mkRun(-2, -0.5), mkRun(0, 0), mkRun(2, 0.5), mkRun(4, 1)]
  const control = summarizeControl(runs)
  const self = scoreAgainstControl(runs[2], control)
  assert.equal(self.verdict, 'within', '對照組的中位樣本必須判為 within,否則尺是歪的')
})
