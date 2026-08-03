// 模型健檢(build 層,純函式)。
//
// 2026-08 診斷:修好真實命中率的符號 bug 後露出真相——模型近期方向連續判錯
// (07-27~07-30 連 4 天喊偏多,加權指數卻跌 10.7%)。進一步比對「模型機率 vs 它自己
// 吃的特徵」發現關聯是**反向**的:美股隔夜漲→模型看空、VIX 高(恐慌)→模型看多。
// 這支程式把這件事量化並持續監看,讓「模型是不是壞了」有客觀證據,而不是憑感覺。
//
// 注意:這是**診斷**,不是修理。真正的修法(重訓/檢查特徵順序)要動訓練管線。
// 樣本少時只提示、不下定論——所有結論都附 n。

// 每個特徵與「上漲機率」的**預期**關聯方向:
//   +1 = 特徵越高應該越看多(美股漲、台股動能強)
//   -1 = 特徵越高應該越看空(VIX 恐慌指數)
const FEATURES = [
  { key: 'sp500_ret',    label: 'S&P500 隔夜', expect: +1, group: 'us' },
  { key: 'nasdaq_ret',   label: 'Nasdaq 隔夜', expect: +1, group: 'us' },
  { key: 'sox_ret',      label: '費半 SOX 隔夜', expect: +1, group: 'us' },
  { key: 'tsm_adr_ret',  label: '台積 ADR 隔夜', expect: +1, group: 'us' },
  { key: 'vix',          label: 'VIX 恐慌指數', expect: -1, group: 'us' },
  { key: 'night_change', label: '夜盤', expect: +1, group: 'tw' },
  { key: 'taiex_ret_5d', label: '台股5日動能', expect: +1, group: 'tw' },
]

function pearson(xs, ys) {
  const n = xs.length
  if (n < 3) return null
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my
    num += a * b; dx += a * a; dy += b * b
  }
  // 常數欄位的變異數在浮點下不會剛好等於 0(例如十個 0.01 相加後平均有 1e-18 誤差),
  // 用相對 epsilon 判定「幾乎沒有變異」,否則會把數值雜訊算成相關性。
  const eps = (m) => Math.max(Math.abs(m), 1) * 1e-12
  if (dx <= eps(mx) || dy <= eps(my)) return null
  return num / Math.sqrt(dx * dy)
}

// history:predictionHistory(需含 date / xgb_prob_up / market_data)。
// opts.minN 最少樣本數、opts.strong 判定「明顯反向」的相關係數門檻。
// 回 null 若沒有任何特徵達到樣本門檻。
export function computeModelHealth(history, opts = {}) {
  const minN = opts.minN ?? 8
  const strong = opts.strong ?? 0.5
  if (!Array.isArray(history) || history.length === 0) return null

  const rows = history.filter(e => e && typeof e.xgb_prob_up === 'number' && e.market_data)
  const features = []
  for (const f of FEATURES) {
    const xs = [], ys = []
    for (const e of rows) {
      const v = e.market_data[f.key]
      if (typeof v === 'number' && !Number.isNaN(v)) { xs.push(v); ys.push(e.xgb_prob_up) }
    }
    if (xs.length < minN) continue
    const r = pearson(xs, ys)
    if (r == null) continue
    // 「對齊度」= 相關係數 × 預期方向。負值代表模型與該特徵的關係跟常識相反。
    const aligned = r * f.expect
    features.push({
      key: f.key, label: f.label, group: f.group, n: xs.length,
      corr: Math.round(r * 1000) / 1000,
      aligned: Math.round(aligned * 1000) / 1000,
      inverted: aligned <= -strong,
    })
  }
  if (features.length === 0) return null

  const inverted = features.filter(f => f.inverted)
  const usInverted = inverted.filter(f => f.group === 'us')
  // 兩個以上美股隔夜特徵明顯反向 → 高度可疑(這組是模型最強的輸入)
  const verdict = usInverted.length >= 2 ? 'suspect_inverted'
    : inverted.length >= 1 ? 'partial_inverted' : 'ok'
  const maxN = Math.max(...features.map(f => f.n))
  // 「支撐這個結論的樣本數」必須看**被標記反向的那些特徵**,不能用全體最大值——
  // 否則會出現「結論建立在 10 筆美股資料上,卻因夜盤有 35 筆而宣稱樣本充足」的誤導。
  const verdictN = inverted.length ? Math.min(...inverted.map(f => f.n)) : maxN

  return {
    verdict,
    features: features.sort((a, b) => a.aligned - b.aligned),
    inverted_count: inverted.length,
    us_inverted_count: usInverted.length,
    sample_max: maxN,
    verdict_sample: verdictN,
    // 樣本仍少時明講,避免把雜訊當定論
    low_sample: verdictN < 15,
  }
}
