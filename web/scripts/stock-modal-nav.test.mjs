// resolveStockModalNav — 個股明細 modal 的開/關決策回歸測試。
//
// 守的是一個真實當機:Dashboard 同時傳 stock(選取)與 stocks(整份清單),關閉時
// 只清 stock。舊解析讓殘留的 stocks 把 s_nav 撐住 → 守衛失效 → modal 不卸載,
// 它的 position:fixed / inset:0 / zIndex:1000 根節點蓋住整個 App(面板已動畫到
// 透明所以看不見),之後所有點擊都被吃掉 = 使用者眼中的「退出後卡住」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveStockModalNav } from '../src/utils/stockModalNav.js'

const A = { stock_id: '2330', name: '台積電' }
const B = { stock_id: '2454', name: '聯發科' }
const C = { stock_id: '1101', name: '台泥' }
const LIST = [A, B, C]

test('關鍵回歸:父層清掉 stock 後,殘留的 stocks 不得讓 modal continue 開著', () => {
  const r = resolveStockModalNav(null, LIST, 1)
  assert.equal(r.open, false)
  assert.equal(r.current, null)
  assert.deepEqual(r.list, [])
})

test('開啟時以 idx 選出目前那一檔(左右切換)', () => {
  assert.equal(resolveStockModalNav(A, LIST, 0).current, A)
  assert.equal(resolveStockModalNav(A, LIST, 1).current, B)
  assert.equal(resolveStockModalNav(A, LIST, 2).current, C)
  assert.equal(resolveStockModalNav(A, LIST, 1).open, true)
})

test('沒有清單時退回單一檔(App / 持倉 / 盯盤 等呼叫端)', () => {
  const r = resolveStockModalNav(A, undefined, 0)
  assert.equal(r.open, true)
  assert.equal(r.current, A)
  assert.deepEqual(r.list, [A])

  assert.equal(resolveStockModalNav(A, [], 0).current, A)
})

test('idx 超出範圍時退回清單第一檔(與修正前同一順序,不是退回 stock)', () => {
  assert.equal(resolveStockModalNav(A, LIST, 99).current, A)   // LIST[0] === A
  assert.equal(resolveStockModalNav(B, LIST, 99).current, A)   // 仍取 LIST[0]
})

test('idx 為負數 / 非整數 / undefined 一律當 0,不會算出 undefined', () => {
  for (const bad of [-1, 1.5, NaN, undefined, null, '1']) {
    const r = resolveStockModalNav(A, LIST, bad)
    assert.equal(r.open, true, `idx=${String(bad)} 應仍為開啟`)
    assert.equal(r.current, A)
  }
})

test('全空 → 關閉', () => {
  assert.equal(resolveStockModalNav(null, null, 0).open, false)
  assert.equal(resolveStockModalNav(undefined, [], 0).open, false)
  assert.equal(resolveStockModalNav(null, undefined, 0).current, null)
})

test('開→關→再開同一檔:關閉那一拍必須真的回報關閉(closing 狀態才會被重設)', () => {
  // 重設 swipeX / closing 的 effect 是 key 在「目前這檔的 stock_id」上。
  // 關閉那一拍若仍回報同一檔,effect 不會觸發,closing 會卡在 true,
  // 下次開同一檔就會直接顯示成「已關好」的空白面板。
  const opened = resolveStockModalNav(A, LIST, 0)
  const closed = resolveStockModalNav(null, LIST, 0)
  const reopened = resolveStockModalNav(A, LIST, 0)
  assert.equal(opened.current?.stock_id, '2330')
  assert.equal(closed.current, null)                      // ← key 變成 undefined
  assert.equal(reopened.current?.stock_id, '2330')        // ← key 變回 2330 → effect 觸發
})
