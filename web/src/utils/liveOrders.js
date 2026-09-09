// 以「現價」重跑進出場規則 → 產出紙上指令(純函式,可完整測試)。
//
// paper-trader.mjs 是 build 期的歷史重播:它拿收盤 K 線,算出「AI 到昨天為止做了
// 什麼」。這支模組是它的即時對應版:拿**當下的即時價**,套同一套停利/停損/時間
// 出場規則,回答「如果現在就照規則執行,該下什麼單」。
//
// ⚠️ 這是建議不是委託。本模組不接觸任何下單 API,也不會自動執行 —— 產出的是一張
//    清單,執行與否由人決定。專案硬規則:不自動下單。
// ⚠️ 規則觸發不等於會賺。停利觸發只代表「規則說該獲利了結」,不預測後續走勢。
//
// 與 paper-trader 的規則對齊方式:出場門檻由 aiTrader.config 帶入(take_profit_pct /
// stop_loss_pct / max_hold),所以 build 期改了規則,這裡自動跟著改,不會各走各的。

/** 沒有設定時的保底門檻,與 paper-trader 的 DEFAULT_CONFIG 一致。 */
export const FALLBACK_RULES = { takeProfitPct: 8, stopLossPct: 12, maxHold: 15 }

const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 從 aiTrader.config 取出規則門檻(百分比),缺值時退回保底值。 */
export function rulesFromConfig(config) {
  const tp = num(config?.take_profit_pct)
  const sl = num(config?.stop_loss_pct)
  const mh = num(config?.max_hold)
  return {
    // takeProfit 可以是 null(刻意停用停利,搭配移動停損),要保留 null 不要當成缺值
    takeProfitPct: config && 'take_profit_pct' in config ? tp : FALLBACK_RULES.takeProfitPct,
    stopLossPct: sl ?? FALLBACK_RULES.stopLossPct,
    maxHold: mh ?? FALLBACK_RULES.maxHold,
  }
}

/**
 * 交易日差(近似):用日曆天扣掉週末估算。這裡只用來判斷「是否已達最長持有天數」,
 * 是提示性質,不像 build 期那樣有精確的交易日曆;國定假日會讓它略為高估。
 */
export function tradingDaysBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return null
  const a = new Date(`${fromISO}T00:00:00Z`), b = new Date(`${toISO}T00:00:00Z`)
  if (isNaN(a) || isNaN(b)) return null
  let days = Math.round((b - a) / 86400000)
  if (days <= 0) return 0
  const weeks = Math.floor(days / 7)
  let rest = days - weeks * 7
  let count = weeks * 5
  const startDow = a.getUTCDay()
  for (let i = 1; i <= rest; i++) {
    const d = (startDow + i) % 7
    if (d !== 0 && d !== 6) count++
  }
  return count
}

/**
 * evaluateLiveOrders({ positions, watch, priceOf, config, today, maxPositions })
 *
 * positions  AI 目前持倉 [{stock_id, name, entry, shares, entry_date}]
 * watch      盯盤候選(前五檔)[{stock_id, name, close, ...}]
 * priceOf    (stock_id) => 現價 或 null/undefined
 * config     aiTrader.config(出場門檻來源)
 * today      'YYYY-MM-DD'(台北日期)
 *
 * 回傳 { exits, entries, rules, stale }
 *   exits   該賣的:觸及停利/跌破停損/持有到期
 *   entries 該買的:候選股突破 20 日高且還有空位
 *   stale   有現價的部位/候選數量不足時為 true(提醒判斷可能不完整)
 */
export function evaluateLiveOrders({
  positions = [], watch = [], priceOf = () => null,
  config = null, today = null, maxPositions = 6,
} = {}) {
  const rules = rulesFromConfig(config)
  const exits = []
  const entries = []
  let priced = 0, total = 0

  const held = new Set()

  for (const p of (positions || [])) {
    const sid = String(p?.stock_id ?? '')
    if (!sid) continue
    held.add(sid)
    total++
    const price = num(priceOf(sid))
    const entry = num(p.entry)
    if (price == null || entry == null || entry <= 0) continue
    priced++

    const retPct = (price / entry - 1) * 100
    const tpPrice = rules.takeProfitPct != null ? entry * (1 + rules.takeProfitPct / 100) : null
    const slPrice = entry * (1 - rules.stopLossPct / 100)
    const holdDays = tradingDaysBetween(p.entry_date, today)

    let reason = null, trigger = null
    if (tpPrice != null && price >= tpPrice) {
      reason = 'take_profit'; trigger = tpPrice
    } else if (price <= slPrice) {
      reason = 'stop'; trigger = slPrice
    } else if (holdDays != null && rules.maxHold != null && holdDays >= rules.maxHold) {
      reason = 'time'; trigger = null
    }
    if (!reason) continue

    exits.push({
      action: 'sell',
      stock_id: sid,
      name: p.name || '',
      price: Math.round(price * 100) / 100,
      entry: Math.round(entry * 100) / 100,
      shares: num(p.shares),
      ret_pct: Math.round(retPct * 100) / 100,
      reason,
      trigger: trigger != null ? Math.round(trigger * 100) / 100 : null,
      hold_days: holdDays,
    })
  }

  // 進場:只看盯盤前五檔,且需要突破 20 日高(與 LiveTraderPanel 的突破警示同一條件)
  const openSlots = Math.max(0, maxPositions - (positions?.length || 0))
  for (const w of (watch || [])) {
    const sid = String(w?.stock_id ?? '')
    if (!sid || held.has(sid)) continue
    total++
    const price = num(priceOf(sid))
    if (price == null) continue
    priced++
    const target = num(w.breakout_price)
    if (target == null || price < target) continue

    entries.push({
      action: 'buy',
      stock_id: sid,
      name: w.name || '',
      price: Math.round(price * 100) / 100,
      reason: 'breakout',
      trigger: Math.round(target * 100) / 100,
      expectancy_pct: num(w.expectancy_pct),
      reward_risk: num(w.reward_risk),
      // 沒有空位時仍然列出,但標明要先出場才買得下去 —— 隱藏它會讓人以為沒訊號
      blocked: openSlots <= 0 ? 'no_slot' : null,
    })
  }

  // 期望報酬高的排前面(進場);出場依觸發嚴重度:停損 > 停利 > 到期
  const sev = { stop: 0, take_profit: 1, time: 2 }
  exits.sort((a, b) => (sev[a.reason] ?? 9) - (sev[b.reason] ?? 9))
  entries.sort((a, b) => (b.expectancy_pct ?? -Infinity) - (a.expectancy_pct ?? -Infinity))

  return {
    exits,
    entries,
    rules,
    open_slots: openSlots,
    // 多數標的拿不到現價時,這張清單可能漏掉該出場的部位 → 讓 UI 有辦法提醒
    stale: total > 0 && priced < total,
    priced,
    total,
  }
}
