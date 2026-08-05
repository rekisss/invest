// 真實命中率修正(build 層,不改 Python)。
//
// outcome_tracker.py 從 TWSE 取「漲跌點數」時只拿到幅度、丟了正負號(且抓到報酬指數
// 而非價格指數),使 actual_up 每天都 True → 真實命中率虛高(2026-08 現場:顯示 80%
// 卻與夜盤代理 21% 矛盾、逐日多為 ❌)。這裡改用「當日 taiex_close vs 前一交易日 close」
// 重算方向與命中,覆蓋錯誤欄位。日→日的指數方向可靠(報酬指數與價格指數同向)。
//
// 就地修改傳入的紀錄物件(build-data 用的是讀進來的副本),並回傳被翻正的筆數。
const NEUTRAL = 0.05

export function recomputeRealHits(records) {
  if (!Array.isArray(records)) return 0
  const asc = records
    .filter(e => e && typeof e.taiex_close === 'number' && e.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))

  let prevClose = null
  const fix = new Map()
  for (const e of asc) {
    const prob = typeof e.xgb_prob_up === 'number' ? e.xgb_prob_up : null
    const up = prevClose != null ? e.taiex_close > prevClose : null
    let hit = null
    if (up != null && prob != null && Math.abs(prob - 0.5) > NEUTRAL) hit = (prob > 0.5) === up
    fix.set(e.date, {
      up, hit,
      change: prevClose != null ? Math.round((e.taiex_close - prevClose) * 100) / 100 : null,
      pct: (prevClose != null && prevClose !== 0) ? (e.taiex_close - prevClose) / prevClose : null,
    })
    prevClose = e.taiex_close
  }

  let flipped = 0
  for (const e of records) {
    const f = fix.get(e.date)
    if (!f) continue
    if (e.hit !== f.hit) flipped++
    e.actual_up = f.up
    e.hit = f.hit
    if (f.change != null) e.taiex_change = f.change
    if (f.pct != null) e.taiex_pct = f.pct
  }
  return flipped
}

// 模型真正的預測期距。MarketPredictor(horizon=5) 在 main.py / discord_bot.py 都是 5:
// 預測的是「5 個交易日後上漲 ≥0.3%」,不是隔天。過去用隔天結果打分,等於拿五天後的
// 天氣預報去對一小時後有沒有下雨——命中率結構上就不可能對(2026-08 診斷)。
export const PRED_HORIZON = 5
const UP_THRESHOLD = 1.003   // 與訓練時 target 定義一致

// 依預測期距回填 hit_h{n};就地修改並回傳「已打分」的筆數。期距未到者為 null。
export function scoreHorizonHits(records, horizon = PRED_HORIZON) {
  if (!Array.isArray(records)) return 0
  const asc = records
    .filter(e => e && typeof e.taiex_close === 'number' && e.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const key = `hit_h${horizon}`
  let scored = 0
  for (let i = 0; i < asc.length; i++) {
    const e = asc[i]
    const prob = e.xgb_prob_up
    if (typeof prob !== 'number' || Math.abs(prob - 0.5) <= 0.05) { e[key] = null; continue }
    const j = i + horizon
    if (j >= asc.length) { e[key] = null; continue }       // 期距未到,之後補
    const base = e.taiex_close, future = asc[j].taiex_close
    if (!base) { e[key] = null; continue }
    e[key] = (prob > 0.5) === (future > base * UP_THRESHOLD)
    e[`ret_h${horizon}`] = Math.round((future - base) / base * 10000) / 100
    scored++
  }
  return scored
}
