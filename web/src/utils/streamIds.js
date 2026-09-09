// 全站 Shioaji 串流訂閱清單的合併規則（純函式，方便單元測試）。
//
// 背景：ShioajiStreamProvider 把各分頁登記的代號攤平成單一訂閱清單送給
// shioaji_stream/server.py。伺服器端會做 `ids[:MAX_SUBSCRIPTIONS]` 硬截斷
// （預設 190，Shioaji 個股訂閱上限約 200），所以「誰排在前面」直接決定誰有
// 零延遲 tick。持倉必須永遠排在掃描結果前面 —— 代號總數爆掉時，被犧牲的該是
// 「看看而已」的掃描股，而不是自己的部位（那些股票仍有輪詢價，只是慢一點）。

/** 登記優先序：數字小的先進訂閱清單。 */
export const STREAM_PRIORITY = {
  positions: 0,   // 持倉 / AI 操盤 / 績效
  monitor:   1,   // 盯盤清單
  scan:      3,   // 掃描結果
  other:     5,
}

/** 伺服器 MAX_SUBSCRIPTIONS 預設 190；留餘裕避免卡在邊界。 */
export const MAX_STREAM_IDS = 180

/**
 * mergeStreamIds(entries, max) → string[]
 *
 * @param entries {Array<{ids: string[], priority: number}>} 各呼叫端的登記
 * @param max     {number} 訂閱上限
 * 依 priority 由小到大攤平、去重、保序，截斷到 max。
 */
export function mergeStreamIds(entries, max = MAX_STREAM_IDS) {
  const sorted = [...(entries || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  const seen = new Set()
  const out = []
  for (const e of sorted) {
    for (const raw of (e?.ids || [])) {
      // 先擋 nullish 再轉字串：String(null) 是 'null'（truthy），漏掉這一步
      // 會把字面上的 'null' 當成合法代號送去訂閱，白白吃掉一個名額。
      if (raw == null) continue
      const id = String(raw)
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
      if (out.length >= max) return out
    }
  }
  return out
}
