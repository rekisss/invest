// 全站 Shioaji 串流訂閱清單的合併規則測試。
//
// 釘住的行為：shioaji_stream/server.py 收到訂閱時會做 `ids[:MAX_SUBSCRIPTIONS]`
// 硬截斷，所以排序決定誰拿得到零延遲 tick。持倉必須永遠贏過掃描結果 ——
// 任何人改壞優先序（例如改成先到先得、或忘了去重導致名額被吃光）都會在這裡紅燈。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeStreamIds, STREAM_PRIORITY, MAX_STREAM_IDS } from '../src/utils/streamIds.js'

test('依 priority 排序：持倉排在掃描前面', () => {
  const ids = mergeStreamIds([
    { ids: ['9999', '8888'], priority: STREAM_PRIORITY.scan },
    { ids: ['2330', '2317'], priority: STREAM_PRIORITY.positions },
    { ids: ['2603'],         priority: STREAM_PRIORITY.monitor },
  ])
  assert.deepEqual(ids, ['2330', '2317', '2603', '9999', '8888'])
})

test('跨呼叫端去重，保留最高優先序的位置', () => {
  const ids = mergeStreamIds([
    { ids: ['1101', '2330'], priority: STREAM_PRIORITY.scan },
    { ids: ['2330'],         priority: STREAM_PRIORITY.positions },
  ])
  assert.deepEqual(ids, ['2330', '1101'], '2330 應只出現一次，且吃持倉的排序')
})

test('超過上限時截斷，且犧牲的是低優先序的代號', () => {
  const scan = Array.from({ length: MAX_STREAM_IDS + 50 }, (_, i) => `9${String(i).padStart(3, '0')}`)
  const ids = mergeStreamIds([
    { ids: scan,             priority: STREAM_PRIORITY.scan },
    { ids: ['2330', '2317'], priority: STREAM_PRIORITY.positions },
  ])
  assert.equal(ids.length, MAX_STREAM_IDS, '不得超過伺服器訂閱上限')
  assert.deepEqual(ids.slice(0, 2), ['2330', '2317'], '持倉一定要進得去')
  assert.ok(!ids.includes(scan.at(-1)), '尾端的掃描股應被截掉')
})

test('空值與畸形輸入不會炸掉', () => {
  assert.deepEqual(mergeStreamIds([]), [])
  assert.deepEqual(mergeStreamIds(undefined), [])
  assert.deepEqual(mergeStreamIds([{ priority: 0 }, { ids: null, priority: 1 }]), [])
  assert.deepEqual(mergeStreamIds([{ ids: ['', null, '2330'], priority: 0 }]), ['2330'])
})

test('數字型代號會正規化成字串（去重才有效）', () => {
  const ids = mergeStreamIds([
    { ids: [2330], priority: STREAM_PRIORITY.positions },
    { ids: ['2330', 2317], priority: STREAM_PRIORITY.scan },
  ])
  assert.deepEqual(ids, ['2330', '2317'])
})
