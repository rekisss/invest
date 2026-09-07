// 交易計畫的共用純函式 —— 前端(持倉/AI操盤)、build-data、Discord 日報共用同一份
// 計算，避免同一支股票在不同分頁看到不同的停損價。
//
// computeTargets 原本住在 Portfolio.jsx 裡，行為逐字搬過來、沒有任何改動；
// 新增的 buildOrderTicket 在它之上組出「晚上就能掛完、盤中不用看」的委託票。

const fmt = (v, d = 2) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(d))

// 台股一張 = 1000 股
export const LOT_SIZE = 1000
// 券商手續費(買進)。與 paper-trader.mjs 的 feeBuy 一致
export const FEE_BUY = 0.001425
// 跳空放棄門檻:超過「半根 ATR」就等於平白多付半個停損距離 → 放棄這一單。
// 高波動股用 ATR 會算出過寬的門檻，用 GAP_CAP_PCT 封頂。
export const GAP_ATR_MULT = 0.5
export const GAP_CAP_PCT = 0.03
// paper-trader 的 maxHold(交易日)
export const MAX_HOLD_DAYS = 15

// ── 停損 / 停利(ATR 動態) ───────────────────────────────────────────────────
// Compute grounded stop-loss / take-profit from the scan row's technical data.
// Falls back to fixed percentages when no rich data is available.
export function computeTargets(buyPrice, scan) {
  const atr  = scan?.atr14
  const h20  = scan?.close_20d_high
  const l10  = scan?.close_10d_low

  // ── Stop-loss ──
  let stopLoss, stopBasis
  if (atr != null && atr > 0) {
    const atrStop = buyPrice - 2 * atr
    if (l10 != null && l10 < buyPrice && l10 > atrStop) {
      stopLoss = l10; stopBasis = `10日低點支撐 ${fmt(l10, 1)}`
    } else {
      stopLoss = atrStop; stopBasis = `買價 −2×ATR(${fmt(atr, 1)})`
    }
  } else {
    stopLoss = buyPrice * 0.92; stopBasis = '買價 −8%（無技術資料，固定值）'
  }

  // ── Take-profit ──
  let takePrft, tpBasis
  if (h20 != null && l10 != null && h20 > l10) {
    if (h20 > buyPrice * 1.02) {
      takePrft = h20; tpBasis = `20日高點壓力 ${fmt(h20, 1)}`
    } else {
      // measured-move: break 20-day high, project +0.5× swing range
      //
      // 起算點必須是 max(買價, 20日高)。這個掃描器選的就是突破股——實測 1520 筆
      // 掃描列有 70.5% 是「今收 > 20日高」——原本從 h20 起算會讓 258 筆(17.0%)
      // 算出「停利價 ≤ 進場價」,等於買進同時掛一張保證虧損的停利單
      // (例:5443 均豪 今收 120 / 20日高 113.5 → 停利 119.5、RR −0.04)。
      // 買價 ≤ h20 時 max() 取到 h20,行為與修正前完全相同。
      takePrft = Math.max(buyPrice, h20) + 0.5 * (h20 - l10)
      tpBasis = `量度目標（突破後 +½波段）`
    }
  } else if (atr != null && atr > 0) {
    takePrft = buyPrice + 3 * atr; tpBasis = `買價 +3×ATR(${fmt(atr, 1)})`
  } else {
    takePrft = buyPrice * 1.15; tpBasis = '買價 +15%（無技術資料，固定值）'
  }

  const rr = (buyPrice - stopLoss > 0) ? (takePrft - buyPrice) / (buyPrice - stopLoss) : null
  const grounded = atr != null && atr > 0
  // Evidence-based "high win-rate" take-profit. Backtest (strategy_analysis.py)
  // over the top-decile picks showed a flat +8% profit target lifts the trade
  // win rate ~10-13pts vs holding to a far technical target — you lock in more
  // green trades (at the cost of some upside on the rare big runners).
  const quickTP = buyPrice * 1.08
  const quickTPBasis = '買價 +8%（回測：高勝率停利點，較常收綠）'
  return { stopLoss, stopBasis, takePrft, tpBasis, rr, grounded, quickTP, quickTPBasis }
}

// ── 進場限價 = 跳空放棄門檻 ─────────────────────────────────────────────────
// 把限價掛在門檻價，跳空超過門檻時就不會成交 = 自動放棄，盤中不必判斷。
// 開盤價 ≤ 限價時，集合競價以「開盤價」成交(比限價更好)。
export function computeEntryLimit(refClose, atr14) {
  if (!(refClose > 0)) return null
  const capPrice = refClose * (1 + GAP_CAP_PCT)
  const atrPrice = (atr14 > 0) ? refClose + GAP_ATR_MULT * atr14 : null
  const usedAtr = atrPrice != null && atrPrice < capPrice
  const limit = usedAtr ? atrPrice : capPrice
  return {
    limit: round2(limit),
    basis: usedAtr
      ? `今收 +0.5×ATR(${fmt(atr14, 1)})`
      : `今收 +${(GAP_CAP_PCT * 100).toFixed(0)}%（ATR 門檻過寬，封頂）`,
    capped: !usedAtr,
    gap_pct: round2((limit / refClose - 1) * 100),
  }
}

// ── 最晚出場日(估算) ────────────────────────────────────────────────────────
// 只跳過週末，不含國定假日 → 一定是「不晚於」真實的第 N 個交易日,標示為估算。
export function addTradingDaysEst(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  let left = n
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) left--
  }
  return d.toISOString().slice(0, 10)
}

function round2(v) { return Math.round(v * 100) / 100 }

// ── 委託票 ──────────────────────────────────────────────────────────────────
// stock: 掃描列(需要 close / atr14 / close_20d_high / close_10d_low)
// budget: 這一檔的預算(NT$)
// entryDate: 預計進場日(通常是掃描日的下一個交易日)
// equity: 帳戶總資產,用來換算風險佔比
export function buildOrderTicket(stock, { budget, entryDate, equity } = {}) {
  const ref = Number(stock?.close)
  if (!(ref > 0)) return null

  const entry = computeEntryLimit(ref, stock?.atr14)
  const tg = computeTargets(ref, stock)

  // 張數以「今收」估:限價成交多半就是開盤價,實際張數以成交價為準。
  const lots = (budget > 0) ? Math.floor(budget / (ref * LOT_SIZE * (1 + FEE_BUY))) : 0
  const shares = lots * LOT_SIZE
  const estCost = shares > 0 ? Math.round(shares * ref * (1 + FEE_BUY)) : 0

  const slPrice = round2(tg.stopLoss)
  const tpPrice = round2(tg.takePrft)
  const riskPerShare = ref - slPrice
  const rewardPerShare = tpPrice - ref
  const riskAmount = shares > 0 && riskPerShare > 0 ? Math.round(riskPerShare * shares) : null
  const rewardAmount = shares > 0 && rewardPerShare > 0 ? Math.round(rewardPerShare * shares) : null

  return {
    stock_id: String(stock.stock_id), name: stock.name || '',
    entry_score: Math.round(stock.entry_score || 0), grade: stock.grade || '',
    ref_close: round2(ref),
    // 進場:限價單,限價即放棄門檻
    limit_price: entry?.limit ?? null,
    limit_basis: entry?.basis ?? null,
    gap_abandon_pct: entry?.gap_pct ?? null,
    // 部位
    lots, shares, est_cost: estCost,
    lots_zero: lots === 0,
    // 出場(多數是固定價位,與成交價無關;僅 −2×ATR 那一支隨成交價浮動)
    sl_price: slPrice, sl_basis: tg.stopBasis,
    tp_price: tpPrice, tp_basis: tg.tpBasis,
    sl_atr_offset: stock?.atr14 > 0 ? round2(2 * stock.atr14) : null,
    rr: tg.rr != null ? round2(tg.rr) : null,
    // 風報比 < 1 = 賠的比賺的多,單筆期望值要靠很高的勝率才撐得住。不自動剔除
    // (那是策略決定),但委託票上要標出來讓你決定要不要掛這一單。
    rr_warn: tg.rr != null && tg.rr < 1,
    grounded: tg.grounded,
    // 風險
    risk_amount: riskAmount,
    risk_pct: (riskAmount != null && equity > 0) ? round2(riskAmount / equity * 100) : null,
    reward_amount: rewardAmount,
    // 時間
    max_hold_days: MAX_HOLD_DAYS,
    exit_by_est: entryDate ? addTradingDaysEst(entryDate, MAX_HOLD_DAYS) : null,
    // 原始輸入(讓委託票可被稽核)
    atr14: stock?.atr14 ?? null,
    close_20d_high: stock?.close_20d_high ?? null,
    close_10d_low: stock?.close_10d_low ?? null,
  }
}

// 整份計畫的曝險彙總 —— 「六檔全掛、全部觸及停損」最壞會賠多少。
export function summarizeTickets(tickets, equity) {
  const live = (tickets || []).filter(t => t && t.shares > 0)
  if (!live.length) return null
  const totalCost = live.reduce((a, t) => a + (t.est_cost || 0), 0)
  const totalRisk = live.reduce((a, t) => a + (t.risk_amount || 0), 0)
  const totalReward = live.reduce((a, t) => a + (t.reward_amount || 0), 0)
  return {
    count: live.length,
    total_cost: totalCost,
    total_risk: totalRisk,
    total_reward: totalReward,
    risk_pct: equity > 0 ? round2(totalRisk / equity * 100) : null,
    rr: totalRisk > 0 ? round2(totalReward / totalRisk) : null,
    rr_warn_count: live.filter(t => t.rr_warn).length,
  }
}
