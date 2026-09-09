// 期望報酬模型測試 — 目標從「勝率」改成「報酬率」的核心算式。
//
// 釘住的行為:
//   1. 期望值 = 勝率×上檔 − 敗率×下檔,三個輸入缺一就退回 fallback(不硬套)
//   2. 上檔會被 20 日高的實際空間限制,也會被停利截頂
//   3. 同樣看好的兩檔,賺賠比划算的那檔排前面(這是換目標的整個重點)
//   4. 樣本不足的評級不採用其歷史勝率
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  expectedReturnPct, gradeWinRate, makeExpectancyRank, rankPicksByExpectancy,
  DEFAULT_ATR_MULT, MIN_GRADE_SAMPLE,
} from './expectancy.mjs'

// 真實形狀的評級統計(取自 data.json:C 有 929 筆、D 有 26694 筆、A/B 尚無樣本)
const GRADES = {
  A: { total: 0, win_rate: null, avg_return_pct: null },
  B: { total: 0, win_rate: null, avg_return_pct: null },
  C: { total: 929, win_rate: 49.3, avg_return_pct: 2.19 },
  D: { total: 26694, win_rate: 54.1, avg_return_pct: 1.97 },
}

const stock = (o) => ({ stock_id: 'X', close: 100, atr14: 2, gap_to_20d_high_pct: 6, grade: 'C', entry_score: 50, ...o })

test('評級勝率:樣本足夠才採用', () => {
  assert.equal(gradeWinRate('C', GRADES), 0.493)
  assert.equal(gradeWinRate('D', GRADES), 0.541)
  assert.equal(gradeWinRate('A', GRADES), null, 'A 級 0 筆,不該回傳勝率')
  assert.equal(gradeWinRate('nope', GRADES), null)
  assert.equal(gradeWinRate('C', GRADES, 2000), null, '門檻拉高到 2000 筆時 C 也不夠')
})

test('期望值 = 勝率×上檔 − 敗率×下檔', () => {
  // close 100, atr 2 → 一個 ATR = 2%,停損 1.5 ATR = 3% 下檔
  // gap 6% 上檔,C 級勝率 0.493
  const e = expectedReturnPct(stock(), { gradeStats: GRADES })
  assert.equal(e.basis, 'model')
  assert.equal(e.upside, 6)
  assert.equal(e.downside, 3, `1 ATR=2% × ${DEFAULT_ATR_MULT} = 3%`)
  const want = 0.493 * 6 - 0.507 * 3
  assert.ok(Math.abs(e.value - want) < 0.001, `期望值應為 ${want.toFixed(3)},實得 ${e.value}`)
})

test('上檔受 20 日高空間限制,也被停利截頂', () => {
  const near = expectedReturnPct(stock({ gap_to_20d_high_pct: 1 }), { gradeStats: GRADES })
  assert.equal(near.upside, 1, '貼著 20 日高 → 上檔空間就只有 1%')

  const far = expectedReturnPct(stock({ gap_to_20d_high_pct: 40 }), { gradeStats: GRADES, tpCap: 12 })
  assert.equal(far.upside, 12, '空間再大也拿不到超過停利的部分')

  const broken = expectedReturnPct(stock({ gap_to_20d_high_pct: -3 }), { gradeStats: GRADES })
  assert.equal(broken.upside, 0, '已突破 20 日高 → 上檔以 0 計,不給負空間')
})

test('缺任何一個輸入就退回 fallback,不硬算', () => {
  for (const bad of [{ atr14: null }, { close: 0 }, { gap_to_20d_high_pct: null }, { grade: 'A' }]) {
    const e = expectedReturnPct(stock(bad), { gradeStats: GRADES })
    assert.equal(e.basis, 'fallback', `${JSON.stringify(bad)} 應該退回 fallback`)
    assert.equal(e.value, null)
  }
  assert.equal(expectedReturnPct(null, { gradeStats: GRADES }), null)
})

test('賺賠比划算的排前面 —— 換目標的整個重點', () => {
  // 兩檔同評級同 entry_score:A 空間大波動小,B 空間小波動大
  const picks = [
    { stock_id: 'B窄', close: 100, atr14: 4, gap_to_20d_high_pct: 2, grade: 'C', entry_score: 90 },
    { stock_id: 'A寬', close: 100, atr14: 2, gap_to_20d_high_pct: 8, grade: 'C', entry_score: 50 },
  ]
  const sorted = rankPicksByExpectancy(picks, { gradeStats: GRADES })
  assert.equal(sorted[0].stock_id, 'A寬',
    'entry_score 較低但賺賠比好的應該排第一;舊排序會選 entry_score 90 那檔')
  assert.ok(sorted[0]._reward_risk > sorted[1]._reward_risk)
  assert.ok(sorted[0]._expectancy > sorted[1]._expectancy)
})

test('算得出期望值的一律排在資料不足的前面', () => {
  const rank = makeExpectancyRank(GRADES)
  const ok = rank(stock({ gap_to_20d_high_pct: 0.1 }))          // 期望值為負但算得出來
  const missing = rank(stock({ grade: 'A', entry_score: 99 }))  // 資料不足,entry_score 再高也一樣
  assert.ok(ok > missing,
    `有模型的(${ok})必須排在沒模型的(${missing})前面,否則「沒資料」會被當成期望值 0 插隊`)
})

test('fallback 之間仍依 entry_score 相對排序', () => {
  const rank = makeExpectancyRank(GRADES)
  const hi = rank({ grade: 'A', entry_score: 90 })
  const lo = rank({ grade: 'A', entry_score: 10 })
  assert.ok(hi > lo, '同樣資料不足時,entry_score 高的仍應排前面')
  assert.ok(hi < 0 && lo < 0, 'fallback 區間整體應為負,不與模型值混淆')
})

test('D 級勝率高於 C,但期望值排序可能相反(目標不同結論就不同)', () => {
  assert.ok(GRADES.D.win_rate > GRADES.C.win_rate, '前提:D 的歷史勝率確實較高')
  // 同樣的上檔/下檔條件下,勝率高的期望值才會高 —— 但實際排序還受各股空間與波動影響
  const c = expectedReturnPct(stock({ grade: 'C' }), { gradeStats: GRADES })
  const d = expectedReturnPct(stock({ grade: 'D' }), { gradeStats: GRADES })
  assert.ok(d.value > c.value, '條件相同時,勝率高的評級期望值較高')
  // 但只要 C 級那檔的賺賠比夠好,就能翻轉
  const cBetter = expectedReturnPct(stock({ grade: 'C', gap_to_20d_high_pct: 10 }), { gradeStats: GRADES })
  assert.ok(cBetter.value > d.value, '賺賠比可以蓋過勝率差距 —— 這就是換目標的意義')
})

test('MIN_GRADE_SAMPLE 是有意義的門檻,不是 0', () => {
  assert.ok(MIN_GRADE_SAMPLE >= 30, '樣本門檻太低等於在雜訊上排序')
})
