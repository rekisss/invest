// Systematic AI paper-trader — deterministic replay of the scan strategy.
//
// Given the daily scans (ranked entry_score picks) and k-line bars, this
// simulates an autonomous trader from an inception date with a fixed virtual
// capital: each trading day it exits positions that hit the take-profit / stop /
// max-hold rule, then deploys free cash into the day's top entry-signal picks.
// Because it is a pure function of historical data it can be re-run from scratch
// on every build — no persisted state — giving a reproducible, honest track
// record (net of TW transaction costs).
//
// Not investment advice; a fixed rule set, not a live-money account.

export const DEFAULT_CONFIG = {
  startCapital: 1_000_000, // NT$ virtual capital
  startDate: '2026-06-23', // inception (scoring stable since)
  maxPositions: 6,         // diversification cap
  takeProfit: 0.08,        // +8% profit target (backtested high win-rate exit)
  stopLoss: 0.12,          // wide disaster stop (tight stops hurt in backtest)
  maxHold: 15,             // trading days before a time exit
  feeBuy: 0.001425,        // broker fee
  feeSell: 0.004425,       // broker fee + 0.3% securities tax
  // rule-lab switches(預設值 = 與原帳戶完全相同的行為)
  execution: 'close',      // 'close' = 掃描日收盤價買 | 'next_open' = 次日開盤價買
                           //   (掃描收盤後才完成,次日開盤才是真人跟單拿得到的價)
  trailingStop: null,      // 例 0.08 = 從進場後最高點回落 8% 出場(收緊固定停損)
                           //   takeProfit 可設 null 停用停利,搭配移動停損讓利潤跑
  buyGate: null,           // (day)=>bool:回傳 false 的掃描日不進新單(出場照常)。
                           //   例:盤前預測偏空日不買。null = 不過濾
  // 訊號擂台開關(預設 = 原策略:top_stocks 池、要進場訊號、依 entry_score)
  pickPool: 'top',         // 'top' = top_stocks | 'filter' = 全掃描池 filter_stocks
  requireEntrySignal: true, // false = 不要求 entry_signal(改用 rankBy 純排序選股)
  rankBy: null,            // (s)=>number 自訂排序分數(越大越優先)。null = entry_score
  pickFilter: null,        // (s)=>bool 額外硬濾網(回傳 false 的股票不買)。null = 不過濾
}

// klineFor(sid) -> ascending [{time, open, high, low, close}] or null/undefined
export function simulatePaperTrader({ scans, klineFor, config: cfgIn = {} }) {
  const cfg = { ...DEFAULT_CONFIG, ...cfgIn }
  const scanDates = new Set(Object.keys(scans || {}))

  // Per-stock date -> bar index, plus cache the bars. All keying is normalized
  // to a String stock id so the buy site (raw stock_id, sometimes a Number) and
  // the exit/mark-to-market sites (String keys from Object.keys(positions)) can
  // never key barsCache / idxCache / lastClose under two different forms.
  const barsCache = {}
  const idxCache = {}
  const barsOf = (sidRaw) => {
    const sid = String(sidRaw)
    if (sid in barsCache) return barsCache[sid]
    const b = klineFor(sid) || null
    barsCache[sid] = b
    if (b) {
      const m = {}
      for (let i = 0; i < b.length; i++) m[b[i].time] = i
      idxCache[sid] = m
    }
    return b
  }
  const barAt = (sidRaw, date) => {
    const sid = String(sidRaw)
    const b = barsOf(sid); if (!b) return null
    const i = idxCache[sid][date]
    return i == null ? null : b[i]
  }

  // Trading calendar: union of all bar dates >= startDate from every scan-listed
  // stock's kline, PLUS the scan dates themselves. 重要:不設「≤最新掃描日」的
  // 上限——延伸到最新 K 線日,讓持倉估值/出場檢查用「最新收盤」而非「最新掃描
  // 日收盤」。這修正「持倉慢一天」:K 線每交易日盤後(~14:13)更新,獨立於
  // 掃描是否跑完;買進仍只發生在掃描日(下方 scanDates.has 守門),故延伸的
  // 交易日只做續抱→出場與逐日 mark-to-market,不會憑空進場。
  const calendar = new Set()
  for (const d of scanDates) {
    if (d < cfg.startDate) continue
    for (const s of (scans[d].top_stocks || [])) {
      const b = barsOf(s.stock_id); if (!b) continue
      for (const bar of b) if (bar.time >= cfg.startDate) calendar.add(bar.time)
    }
  }
  // also include all scan dates themselves
  for (const d of scanDates) if (d >= cfg.startDate) calendar.add(d)
  const days = [...calendar].sort()
  if (!days.length) return null

  const dayIndex = {}; days.forEach((d, i) => { dayIndex[d] = i })

  let cash = cfg.startCapital
  const positions = {} // sid -> {shares, entry, entryDate, entryDayIdx, name}
  const closed = []
  const curve = []
  let peakEquity = cfg.startCapital
  let maxDD = 0
  let lastClose = {} // sid -> last known close (carry when halted)

  const priceOn = (sidRaw, date) => {
    const sid = String(sidRaw)
    const bar = barAt(sid, date)
    if (bar && bar.close > 0) { lastClose[sid] = bar.close; return bar.close }
    return lastClose[sid] ?? null
  }

  let pending = [] // next_open execution: picks queued on scan day, filled at a later open

  for (const day of days) {
    const di = dayIndex[day]

    // 0) next_open fills — buy queued picks at today's open (before exit checks;
    //    a same-day exit is impossible anyway because entryDayIdx === today)
    if (cfg.execution === 'next_open' && pending.length) {
      const stillPending = []
      let slots = cfg.maxPositions - Object.keys(positions).length
      for (const q of pending) {
        if (positions[q.sid]) continue
        if (slots <= 0) { if (di - q.queuedDayIdx <= 3) stillPending.push(q); continue }
        const bar = barAt(q.sid, day)
        const openPx = bar && bar.open > 0 ? bar.open : null
        if (!openPx) { if (di - q.queuedDayIdx < 3) stillPending.push(q); continue } // 停牌等 3 個交易日,否則放棄
        const budget = cash / slots
        const shares = Math.floor(budget / (openPx * (1 + cfg.feeBuy)))
        if (shares < 1) continue
        const spend = shares * openPx * (1 + cfg.feeBuy)
        cash -= spend
        positions[q.sid] = {
          shares, entry: openPx, entryDate: day, entryDayIdx: di,
          openFill: true, // 開盤成交:整個時段在場內,當天即可觸發停利/停損
          name: q.name, entryScore: q.entryScore, grade: q.grade,
          entryReason: q.entryReason, dayRank: q.dayRank, cost: Math.round(spend),
        }
        slots--
      }
      pending = stillPending
    }

    // 1) exits — check each holding's bar today for TP/stop/time
    for (const sid of Object.keys(positions)) {
      const pos = positions[sid]
      if (di < pos.entryDayIdx) continue
      // 收盤成交的部位當天不出場(高低點發生在買進之前);開盤成交(next_open)
      // 整個時段都在場內,當天觸及停利/停損就要出場
      if (di === pos.entryDayIdx && !pos.openFill) continue
      const bar = barAt(sid, day)
      const holdDays = di - pos.entryDayIdx
      let exitPrice = null, reason = null
      const tp = cfg.takeProfit != null ? pos.entry * (1 + cfg.takeProfit) : null
      let sl = pos.entry * (1 - cfg.stopLoss)
      if (cfg.trailingStop != null) {
        // trailing floor from the peak since entry(含今日高點——若同一根K棒先衝高再
        // 回落,保守假設回落發生在衝高之後,觸發移動停損)
        if (bar && bar.high != null && bar.high > (pos.peak ?? pos.entry)) pos.peak = bar.high
        const trail = (pos.peak ?? pos.entry) * (1 - cfg.trailingStop)
        if (trail > sl) sl = trail
      }
      if (bar) {
        // conservative: if both stop and target touched same bar, assume stop first
        // 跳空修正:開盤已穿越觸發價時,真實成交是「開盤價」不是觸發價——
        // 跳空跌破停損要用更差的開盤價成交(消除高估績效的樂觀偏誤);
        // 跳空漲過停利用更好的開盤價成交(同一原則,對稱處理)。
        if (bar.low != null && bar.low <= sl) {
          exitPrice = (bar.open > 0 && bar.open < sl) ? bar.open : sl
          reason = 'stop'
        } else if (tp != null && bar.high != null && bar.high >= tp) {
          exitPrice = (bar.open > 0 && bar.open > tp) ? bar.open : tp
          reason = 'take_profit'
        }
      }
      if (exitPrice == null && holdDays >= cfg.maxHold) {
        exitPrice = priceOn(sid, day); reason = 'time'
      }
      if (exitPrice != null && exitPrice > 0) {
        const proceeds = pos.shares * exitPrice * (1 - cfg.feeSell)
        const costBasis = pos.shares * pos.entry * (1 + cfg.feeBuy)
        cash += proceeds
        closed.push({
          stock_id: sid, name: pos.name,
          entry: round2(pos.entry), exit: round2(exitPrice),
          entry_date: pos.entryDate, exit_date: day,
          hold_days: holdDays, reason,
          ret_pct: round2((proceeds - costBasis) / costBasis * 100),
          pnl: Math.round(proceeds - costBasis),
          // buy-time context carried from the position + exit trigger levels/fees
          entry_score: pos.entryScore ?? null,
          grade: pos.grade || '',
          entry_reason: pos.entryReason || '',
          day_rank: pos.dayRank ?? null,
          shares: pos.shares,
          cost: pos.cost ?? Math.round(costBasis),
          tp_price: tp != null ? round2(tp) : null,
          sl_price: round2(sl),
          fees: Math.round(pos.shares * pos.entry * cfg.feeBuy + pos.shares * exitPrice * cfg.feeSell),
        })
        delete positions[sid]
      }
    }

    // 2) buys — only on scan days, fill open slots with top entry-signal picks
    //    (buyGate 為 false 的日子跳過進場決策;既有持倉的出場檢查不受影響)
    if (scanDates.has(day) && (!cfg.buyGate || cfg.buyGate(day))) {
      const held = new Set(Object.keys(positions))
      const pool = cfg.pickPool === 'filter'
        ? (scans[day].filter_stocks?.length ? scans[day].filter_stocks : scans[day].top_stocks || [])
        : (scans[day].top_stocks || [])
      const score = cfg.rankBy || ((s) => s.entry_score || 0)
      const picks = pool
        .filter(s => (cfg.requireEntrySignal === false || s.entry_signal)
          && (!cfg.pickFilter || cfg.pickFilter(s))
          && !held.has(String(s.stock_id)))
        .sort((a, b) => score(b) - score(a))
      if (cfg.execution === 'next_open') {
        // queue picks for a later open; cap the queue at the free slots
        const pendingIds = new Set(pending.map(q => q.sid))
        let free = cfg.maxPositions - Object.keys(positions).length - pending.length
        for (let pi = 0; pi < picks.length && free > 0; pi++) {
          const s = picks[pi]
          const sid = String(s.stock_id)
          if (pendingIds.has(sid)) continue
          pending.push({
            sid, name: s.name || sid, queuedDayIdx: di,
            entryScore: s.entry_score ?? null, grade: s.grade || '',
            entryReason: s.entry_reason || '', dayRank: pi + 1,
          })
          free--
        }
      } else {
      let slots = cfg.maxPositions - Object.keys(positions).length
      for (let pi = 0; pi < picks.length; pi++) {
        const s = picks[pi]
        if (slots <= 0) break
        const price = priceOn(s.stock_id, day)
        if (!price || price <= 0) continue
        const budget = cash / slots           // equal-weight remaining cash
        const shares = Math.floor(budget / (price * (1 + cfg.feeBuy)))
        if (shares < 1) continue
        const spend = shares * price * (1 + cfg.feeBuy)
        cash -= spend
        positions[String(s.stock_id)] = {
          shares, entry: price, entryDate: day, entryDayIdx: di,
          name: s.name || String(s.stock_id),
          // buy-time context, recorded for the trade log (display only —
          // none of this feeds back into any decision)
          entryScore: s.entry_score ?? null,
          grade: s.grade || '',
          entryReason: s.entry_reason || '',
          dayRank: pi + 1,                    // rank among that day's entry-signal candidates
          cost: Math.round(spend),
        }
        slots--
      }
      }
    }

    // 3) mark to market + record equity
    let invested = 0
    for (const sid of Object.keys(positions)) {
      const px = priceOn(sid, day) ?? positions[sid].entry
      invested += positions[sid].shares * px
    }
    const equity = cash + invested
    peakEquity = Math.max(peakEquity, equity)
    maxDD = Math.max(maxDD, (peakEquity - equity) / peakEquity)
    curve.push({ date: day, equity: Math.round(equity), ret_pct: round2((equity / cfg.startCapital - 1) * 100) })
  }

  const asOf = days[days.length - 1]
  let invested = 0
  const openPositions = Object.keys(positions).map(sid => {
    const pos = positions[sid]
    const px = priceOn(sid, asOf) ?? pos.entry
    invested += pos.shares * px
    return {
      stock_id: sid, name: pos.name, shares: pos.shares,
      entry: round2(pos.entry), price: round2(px),
      entry_date: pos.entryDate, hold_days: dayIndex[asOf] - pos.entryDayIdx,
      value: Math.round(pos.shares * px),
      pnl_pct: round2((px / pos.entry - 1) * 100),
      entry_score: pos.entryScore ?? null,
      grade: pos.grade || '',
      entry_reason: pos.entryReason || '',
      day_rank: pos.dayRank ?? null,
      cost: pos.cost ?? null,
      tp_price: cfg.takeProfit != null ? round2(pos.entry * (1 + cfg.takeProfit)) : null,
      sl_price: round2(Math.max(pos.entry * (1 - cfg.stopLoss),
        cfg.trailingStop != null ? (pos.peak ?? pos.entry) * (1 - cfg.trailingStop) : 0)),
    }
  }).sort((a, b) => b.value - a.value)

  const equity = cash + invested
  const wins = closed.filter(t => t.ret_pct > 0).length
  const grossWin = closed.reduce((a, t) => a + Math.max(t.pnl, 0), 0)
  const grossLoss = closed.reduce((a, t) => a + Math.max(-t.pnl, 0), 0)
  // Open positions' buy fees were already paid out of cash, so 總交易成本 must
  // include them too — otherwise costs are underreported while a book is open.
  const openBuyFees = Object.values(positions).reduce((a, p) => a + p.shares * p.entry * cfg.feeBuy, 0)
  const stats = {
    num_trades: closed.length,
    win_rate: closed.length ? round2(wins / closed.length * 100) : null,
    avg_ret: closed.length ? round2(closed.reduce((a, t) => a + t.ret_pct, 0) / closed.length) : null,
    best: closed.length ? Math.max(...closed.map(t => t.ret_pct)) : null,
    worst: closed.length ? Math.min(...closed.map(t => t.ret_pct)) : null,
    max_drawdown_pct: round2(maxDD * 100),
    trading_days: days.length,
    exits: {
      take_profit: closed.filter(t => t.reason === 'take_profit').length,
      stop: closed.filter(t => t.reason === 'stop').length,
      time: closed.filter(t => t.reason === 'time').length,
    },
    avg_hold_days: closed.length ? round2(closed.reduce((a, t) => a + t.hold_days, 0) / closed.length) : null,
    profit_factor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    total_fees: Math.round(closed.reduce((a, t) => a + (t.fees || 0), 0) + openBuyFees),
  }

  return {
    // 全部已結交易的出場日(供自適應帳戶統計「截至某日累積了幾筆樣本」;
    // trades 只保留最後 40 筆,這裡要完整)
    exit_dates: closed.map(t => t.exit_date),
    config: { start_capital: cfg.startCapital, start_date: cfg.startDate, max_positions: cfg.maxPositions,
              take_profit_pct: cfg.takeProfit != null ? cfg.takeProfit * 100 : null,
              stop_loss_pct: cfg.stopLoss * 100, max_hold: cfg.maxHold,
              execution: cfg.execution,
              trailing_stop_pct: cfg.trailingStop != null ? cfg.trailingStop * 100 : null },
    as_of: asOf,
    equity: Math.round(equity),
    cash: Math.round(cash),
    invested: Math.round(invested),
    return_pct: round2((equity / cfg.startCapital - 1) * 100),
    positions: openPositions,
    trades: closed.slice(-40).reverse(),
    equity_curve: curve,
    stats,
  }
}

function round2(v) { return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100 }

// ── 自適應帳戶(自我學習層)──────────────────────────────────────────────────
// 透明的績效跟隨機制,不是黑箱 ML:每個交易日看「過去 window 個交易日」哪個
// 帳戶(主帳戶+變體)的實績最好,滿足保護欄才切換跟隨對象:
//   1. 樣本保護:全體帳戶累積已結交易 < minTrades 前,固定跟隨第一個帳戶(主帳戶)
//   2. 遲滯保護:挑戰者近期績效要贏過現任 marginPp 個百分點才切換(避免頻繁震盪)
//   3. 切換成本:每次切換扣 switchCostPct%(模擬全數換倉的手續費+滑價)
// 輸入的各帳戶 curve 共用同一交易日曆(同一份 scans/klines 跑出來的)。
// 完全確定性、可重現,每次切換都有紀錄可解釋。
export function simulateAdaptiveTrader({ accounts, window = 10, minTrades = 10, marginPp = 1, switchCostPct = 0.7 }) {
  const base = accounts?.[0]
  if (!base?.curve?.length || accounts.length < 2) return null
  const days = base.curve.map(p => p.date)
  const n = days.length
  // 累積報酬 → 水位序列(1 + ret/100);曲線長度不齊的帳戶直接排除
  const usable = accounts.filter(a => a.curve?.length === n)
  const levels = usable.map(a => a.curve.map(p => 1 + p.ret_pct / 100))
  // 各帳戶「截至第 i 日」的累積已結筆數
  const closedByDay = usable.map(a => {
    const sorted = [...(a.exit_dates || [])].sort()
    const m = new Array(n).fill(0)
    let j = 0
    for (let i = 0; i < n; i++) {
      while (j < sorted.length && sorted[j] <= days[i]) j++
      m[i] = j
    }
    return m
  })

  let cur = 0            // 目前跟隨的帳戶(起始:主帳戶)
  let level = 1
  const curve = []
  const switches = []
  let eligibleSince = null
  for (let i = 0; i < n; i++) {
    if (i > 0) level *= levels[cur][i] / levels[cur][i - 1]
    curve.push({ date: days[i], ret_pct: round2((level - 1) * 100) })
    // 今天收盤後評估「明天起要跟誰」——樣本與回看窗都要夠
    if (i < window) continue
    const totalClosed = closedByDay.reduce((a, m) => a + m[i], 0)
    if (totalClosed < minTrades) continue
    if (eligibleSince == null) eligibleSince = days[i]
    const trail = (k) => levels[k][i] / levels[k][i - window] - 1
    const curPerf = trail(cur)
    let best = cur
    for (let k = 0; k < usable.length; k++) {
      if (k === cur) continue
      const p = trail(k)
      if (p > curPerf + marginPp / 100 && (best === cur || p > trail(best))) best = k
    }
    if (best !== cur) {
      level *= 1 - switchCostPct / 100
      // 換倉成本記在「切換當日」的曲線點上——當日點已先 push,要回填;否則
      // 成本會延後一天入帳,若切換發生在最後一個交易日更會完全漏掉
      // (return_pct 取自 curve 最後一點)。(Codex review #385)
      curve[curve.length - 1].ret_pct = round2((level - 1) * 100)
      switches.push({
        date: days[i], from: usable[cur].id, to: usable[best].id,
        from_trail_pct: round2(curPerf * 100), to_trail_pct: round2(trail(best) * 100),
      })
      cur = best
    }
  }
  const totalClosedNow = closedByDay.reduce((a, m) => a + m[n - 1], 0)
  return {
    return_pct: curve[n - 1].ret_pct,
    follow_id: usable[cur].id,
    follow_label: usable[cur].label || usable[cur].id,
    switches,
    num_switches: switches.length,
    curve,
    learning_active: totalClosedNow >= minTrades,
    samples: { closed_trades: totalClosedNow, required: minTrades },
    eligible_since: eligibleSince,
    config: { window, min_trades: minTrades, margin_pp: marginPp, switch_cost_pct: switchCostPct },
  }
}

// ── 群體智慧帳戶(集成/ensemble 學習層)──────────────────────────────────────
// 與「自適應帳戶」互補:自適應是『贏家全拿』(同時只跟一個),這個是
// 『參考全體』——把資金按近期績效分散到所有交易員,表現好的多配、但每個
// 都保留分散地板(never abandon)。每 rebalanceDays 重新配權一次,調整時
// 依換手率扣一點成本。樣本不足前用等權(純分散,還沒開始學)。
// 完全確定性:constant-mix 組合,每日報酬 = 各帳戶當日報酬的權重和。
export function simulateEnsembleTrader({ accounts, window = 10, minTrades = 10, rebalanceDays = 5, floorMix = 0.4, costPct = 0.1 }) {
  const base = accounts?.[0]
  if (!base?.curve?.length || accounts.length < 2) return null
  const days = base.curve.map(p => p.date)
  const n = days.length
  const usable = accounts.filter(a => a.curve?.length === n)
  const K = usable.length
  if (K < 2) return null
  const levels = usable.map(a => a.curve.map(p => 1 + p.ret_pct / 100))
  const closedByDay = usable.map(a => {
    const sorted = [...(a.exit_dates || [])].sort()
    const m = new Array(n).fill(0); let j = 0
    for (let i = 0; i < n; i++) { while (j < sorted.length && sorted[j] <= days[i]) j++; m[i] = j }
    return m
  })

  let w = new Array(K).fill(1 / K)   // 目前權重(起始等權)
  let level = 1
  const curve = []
  const rebalances = []
  let eligibleSince = null

  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // constant-mix:組合當日毛報酬 = Σ 權重 × 各帳戶當日毛報酬
      let g = 0
      for (let k = 0; k < K; k++) g += w[k] * (levels[k][i] / levels[k][i - 1])
      level *= g
    }
    curve.push({ date: days[i], ret_pct: round2((level - 1) * 100) })

    if (i < window) continue
    const totalClosed = closedByDay.reduce((a, m) => a + m[i], 0)
    if (totalClosed < minTrades) continue
    if (eligibleSince == null) eligibleSince = days[i]
    if ((i - window) % rebalanceDays !== 0) continue   // 每 rebalanceDays 才調權一次

    // 近 window 日各帳戶報酬 → 傾斜權重(平滑讓最差者仍非零)+ 分散地板
    const trails = usable.map((_, k) => levels[k][i] / levels[k][i - window] - 1)
    const lo = Math.min(...trails)
    const raw = trails.map(t => (t - lo) + 0.02)     // 2pp 平滑
    const rawSum = raw.reduce((a, b) => a + b, 0) || K
    const wNew = raw.map(r => floorMix / K + (1 - floorMix) * (r / rawSum))
    // rebalance 成本 = 換手率 × costPct(換手率 = ½Σ|Δw|)
    let turnover = 0
    for (let k = 0; k < K; k++) turnover += Math.abs(wNew[k] - w[k])
    turnover *= 0.5
    if (turnover > 0) {
      level *= 1 - turnover * costPct / 100
      curve[curve.length - 1].ret_pct = round2((level - 1) * 100)
    }
    w = wNew
    rebalances.push({ date: days[i],
      top: usable.map((a, k) => ({ id: a.id, w: round2(w[k] * 100) })).sort((a, b) => b.w - a.w).slice(0, 3) })
  }

  const totalClosedNow = closedByDay.reduce((a, m) => a + m[n - 1], 0)
  const finalWeights = usable
    .map((a, k) => ({ id: a.id, label: a.label || a.id, weight_pct: round2(w[k] * 100) }))
    .sort((a, b) => b.weight_pct - a.weight_pct)
  return {
    return_pct: curve[n - 1].ret_pct,
    curve,
    weights: finalWeights,          // 目前各交易員的參考權重(高→低)
    num_rebalances: rebalances.length,
    learning_active: totalClosedNow >= minTrades,
    samples: { closed_trades: totalClosedNow, required: minTrades },
    eligible_since: eligibleSince,
    config: { window, min_trades: minTrades, rebalance_days: rebalanceDays, floor_mix: floorMix, cost_pct: costPct },
  }
}
