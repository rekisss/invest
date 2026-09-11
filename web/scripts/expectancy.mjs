// 期望報酬模型 — 把「止盈止損比」從出場規則延伸到選股(build 層,純函式)。
//
// 為什麼要有這個:原本的選股排序用 entry_score,它是為「會不會漲」最佳化的分數,
// 不含「漲多少 vs 跌多少」的資訊。改用報酬率當目標之後,排序也要跟著換成期望值:
//
//     期望報酬 = 勝率 × 上檔空間 − 敗率 × 下檔風險
//
// 三個輸入都取自現成資料,不需要動任何 Python:
//   勝率      該評級的真實歷史勝率(outcomeStats,C 有 929 筆、D 有 26694 筆)
//   上檔空間  到 20 日高的距離(gap_to_20d_high_pct),再以停利上限截頂 ——
//             已經貼著 20 日高的股票沒剩多少空間,再高的 entry_score 也換不到報酬
//   下檔風險  ATR 的倍數(atr14 ÷ close),波動大的股票停損天然要放寬,風險就大
//
// 這個模型會做而 entry_score 不會做的事:同樣看好的兩檔,它偏好「離目標還有空間、
// 波動又不誇張」的那檔 —— 也就是賺賠比划算的那檔。
//
// ⚠️ 這是排序用的期望值估計,不是報酬保證。樣本仍在累積,評級之間的鑑別度目前很弱
//    (D 的歷史勝率甚至高於 C),所以資料不足時一律退回 entry_score,不硬套模型。

/** 停損放在幾倍 ATR — 1.5 是常見的波動停損設定。 */
export const DEFAULT_ATR_MULT = 1.5
/** 預設持有天數,用來估算「這段期間走得到多大幅度」。對齊 paper-trader 的 maxHold。 */
export const DEFAULT_HOLD_DAYS = 15
/** 上檔空間的截頂(%),對齊停利:再大的空間也不會賺超過停利。 */
export const DEFAULT_TP_CAP = 12
/** 評級歷史統計至少要幾筆才採用,否則視為沒有資訊。 */
export const MIN_GRADE_SAMPLE = 100

// null / undefined / '' 都要當成「沒有這個值」。不能只靠 Number.isFinite:
// Number(null) 是 0、Number('') 也是 0,漏擋會把「缺欄位」誤讀成「上檔空間 0%」,
// 於是用錯誤的理由把股票壓到排序末端。
const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * gradeWinRate(grade, gradeStats) → 0..1 或 null
 * 樣本不足(或該評級沒資料)時回 null,由呼叫端決定退路。
 */
export function gradeWinRate(grade, gradeStats, minSample = MIN_GRADE_SAMPLE) {
  const g = typeof grade === 'string' ? grade.trim().toUpperCase() : ''
  const o = gradeStats && gradeStats[g]
  if (!o) return null
  const total = num(o.total) ?? 0
  const wr = num(o.win_rate)
  if (total < minSample || wr == null) return null
  return wr / 100
}

/**
 * expectedReturnPct(stock, opts) → { value, upside, downside, winRate, basis } | null
 *
 * value 是每筆的期望報酬(%),可正可負。basis 說明用了哪條路徑:
 *   'model'    完整期望值模型(有評級勝率 + 上檔 + 下檔)
 *   'fallback' 資料不足,退回 entry_score(值不可與 'model' 直接比較大小)
 */
export function expectedReturnPct(stock, opts = {}) {
  if (!stock) return null
  const {
    gradeStats = null,
    atrMult = DEFAULT_ATR_MULT,
    tpCap = DEFAULT_TP_CAP,
    minSample = MIN_GRADE_SAMPLE,
    holdDays = DEFAULT_HOLD_DAYS,
  } = opts

  const close = num(stock.close)
  const atr = num(stock.atr14)
  const gap = num(stock.gap_to_20d_high_pct)
  const p = gradeWinRate(stock.grade, gradeStats, minSample)

  // 三個輸入缺任何一個都無法算期望值 → 明講是 fallback,不要假裝算得出來
  if (p == null || close == null || close <= 0 || atr == null || atr <= 0 || gap == null) {
    return { value: null, upside: null, downside: null, winRate: p, basis: 'fallback' }
  }

  // 上檔:三個上限取最小 ——
  //   1. 到 20 日高的距離(負值=已突破,視為 0 再由停利接手)
  //   2. tpCap:停利會先出場,超過的部分拿不到
  //   3. 持有期內「走得到」的幅度 ≈ ATR% × √持有天數
  //
  // 第 3 條是必要的。只用前兩條時,全市場掃描裡多數股票距 20 日高都超過 25%,
  // 上限一律被 tpCap 綁住 → 每檔上檔都是 12%,排序完全由下檔決定,整個模型退化
  // 成「買波動最小的」。而且「距高點遠」本身不是利多,那代表股票已經跌了一大段;
  // 把跌深當成潛力是方向性的錯誤。
  // 綁上可達幅度後,低波動股的上檔會跟著縮小,高波動股才拿得到大的上檔 —— 但它的
  // 下檔也同步放大,兩邊都由同一個 ATR 驅動,不會偏袒任何一端。
  const atrPct = (atr / close) * 100
  const reachable = atrPct * Math.sqrt(Math.max(1, holdDays))
  const upside = Math.min(Math.max(gap, 0), tpCap, reachable)
  // 下檔:一個 ATR 佔股價的百分比 × 停損倍數
  const downside = (atr / close) * 100 * atrMult

  const value = p * upside - (1 - p) * downside
  return {
    value: Math.round(value * 1000) / 1000,
    upside: Math.round(upside * 100) / 100,
    reachable: Math.round(reachable * 100) / 100,
    downside: Math.round(downside * 100) / 100,
    winRate: p,
    basis: 'model',
  }
}

/**
 * makeExpectancyRank(gradeStats, opts) → (stock) => number
 *
 * 給 simulatePaperTrader 的 rankBy 用。回傳的分數越大越優先。
 * 算得出期望值的股票一律排在算不出來的前面(後者用 entry_score 相對排序,
 * 並整體壓到負值區,避免「沒資料」被誤當成「期望值 0」而插隊到負期望股之前)。
 */
export function makeExpectancyRank(gradeStats, opts = {}) {
  return (stock) => {
    const e = expectedReturnPct(stock, { ...opts, gradeStats })
    if (e && e.basis === 'model' && e.value != null) return e.value
    // fallback 區間:−1000 起跳,內部仍依 entry_score 排序
    const score = num(stock?.entry_score) ?? 0
    return -1000 + score / 1000
  }
}

/**
 * rankPicksByExpectancy(stocks, opts) → 依期望報酬由高到低排序的新陣列
 * 每個元素附上 _expectancy 供 UI 顯示(不改動原物件)。
 */
export function rankPicksByExpectancy(stocks, opts = {}) {
  if (!Array.isArray(stocks)) return []
  const scored = stocks.map(s => {
    const e = expectedReturnPct(s, opts)
    return {
      ...s,
      _expectancy: e && e.basis === 'model' ? e.value : null,
      _upside: e ? e.upside : null,
      _downside: e ? e.downside : null,
      // 選股層的賺賠比:上檔空間 ÷ 下檔風險。>1 才是划算的一注。
      _reward_risk: (e && e.upside != null && e.downside > 0)
        ? Math.round(e.upside / e.downside * 100) / 100 : null,
    }
  })
  const rank = makeExpectancyRank(opts.gradeStats, opts)
  return scored.sort((a, b) => rank(b) - rank(a))
}
