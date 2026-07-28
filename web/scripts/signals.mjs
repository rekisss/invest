// 雙訊號一致性(build 層,純函式)。
//
// 大盤方向現在有兩個「相互獨立」的估計:
//   1) XGB 大盤預測(吃美股隔夜/技術/基本面特徵)
//   2) 台指期籌碼面偏向(吃外資期貨淨部位/期現價差/夜盤)
// 兩者資料來源不同、方法不同——一致時是高信心訊號,分歧時代表方向不明、該保守。
// 這比單看任一個更誠實。純規則、可解釋、確定性;不改任何決策,只做「信心」提示。

const dirFromProb = p => {
  if (typeof p !== 'number' || Number.isNaN(p)) return null
  return p >= 0.55 ? 1 : p <= 0.45 ? -1 : 0
}
const dirFromScore = s => {
  if (typeof s !== 'number' || Number.isNaN(s)) return null
  return s >= 20 ? 1 : s <= -20 ? -1 : 0
}

// Returns null when either source is missing (can't compare). Otherwise:
//   state: 'agree'   兩者同向且皆非中性(高信心)
//          'diverge' 兩者反向(低信心,方向不明)
//          'mixed'   至少一方中性(單邊訊號)
export function computeSignalAgreement({ modelProb, biasScore } = {}) {
  const m = dirFromProb(modelProb)
  const b = dirFromScore(biasScore)
  if (m == null || b == null) return null

  let state, label, note
  if (m !== 0 && b !== 0 && m === b) {
    state = 'agree'
    const side = m > 0 ? '偏多' : '偏空'
    label = `模型與期貨籌碼一致${side}`
    note = '兩個獨立訊號同向 — 相對高信心'
  } else if (m !== 0 && b !== 0 && m !== b) {
    state = 'diverge'
    label = '模型與期貨籌碼分歧'
    note = `模型${m > 0 ? '偏多' : '偏空'}、期貨籌碼${b > 0 ? '偏多' : '偏空'} — 方向不明,建議降低倉位、別當鐵口`
  } else {
    state = 'mixed'
    const active = m !== 0 ? `模型${m > 0 ? '偏多' : '偏空'}` : b !== 0 ? `期貨籌碼${b > 0 ? '偏多' : '偏空'}` : '雙方皆中性'
    label = '單邊訊號'
    note = `${active}(另一方中性)— 訊號不強`
  }
  return { model_dir: m, bias_dir: b, state, label, note }
}
