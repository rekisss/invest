// 選股風險註記(build 層,read-only)。
//
// 一支「進場候選」若同時帶出場/出貨/轉弱/過熱訊號,代表訊號內部矛盾——這種
// 「進場分數高、但型態已露疲態」的股票最容易套人。原本這些警示只在點開個股明細
// 才看得到;這裡在 build 期把它濃縮成幾個短標籤掛到清單列,讓使用者掃一眼就能
// 避開,不必逐檔點開。純函式、零依賴、可單元測試;不改任何選股決策,只做提示。

const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'True'
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null }

// 依嚴重度排序(出場訊號最重 → 過熱最輕)。每條都是「與偏多進場相矛盾」的警訊。
const RULES = [
  { key: 'exit',        label: '出場訊號', test: s => truthy(s.base_exit_signal) },
  { key: 'decay',       label: '動能衰退', test: s => truthy(s.momentum_decay_signal) },
  { key: 'ohcl',        label: '開高走低', test: s => truthy(s.open_high_close_low) },
  { key: 'macd_death',  label: 'MACD死叉', test: s => truthy(s.macd_death_cross) },
  { key: 'below_ema20', label: '跌破20MA', test: s => truthy(s.close_below_ema20) },
  { key: 'upshadow',    label: '長上影',   test: s => truthy(s.long_upper_shadow) },
  { key: 'overbought',  label: 'RSI過熱',  test: s => { const r = num(s.rsi14); return r != null && r >= 80 } },
]

// Returns an array of { key, label } risk flags (severity-ordered), or [] when the
// pick shows no contradictory signal. Tolerant of raw CSV rows (string booleans).
export function computePickRiskFlags(stock) {
  if (!stock || typeof stock !== 'object') return []
  const out = []
  for (const r of RULES) {
    try { if (r.test(stock)) out.push({ key: r.key, label: r.label }) } catch { /* skip */ }
  }
  return out
}
