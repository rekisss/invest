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
