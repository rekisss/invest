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

  // Trading calendar: union of all bar dates >= startDate that appear in scans
  // or in any held stock's kline. Simplest robust source: the scan dates plus
  // every kline date within range from the picks' stocks. We use the union of
  // kline dates across all scan-listed stocks so exits can fire between scans.
  const calendar = new Set()
  for (const d of scanDates) {
    if (d < cfg.startDate) continue
    for (const s of (scans[d].top_stocks || [])) {
      const b = barsOf(s.stock_id); if (!b) continue
      for (const bar of b) if (bar.time >= cfg.startDate && bar.time <= d) calendar.add(bar.time)
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
      if (di <= pos.entryDayIdx) continue // never exit on entry day
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
        if (bar.low != null && bar.low <= sl) { exitPrice = sl; reason = 'stop' }
        else if (tp != null && bar.high != null && bar.high >= tp) { exitPrice = tp; reason = 'take_profit' }
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
    if (scanDates.has(day)) {
      const held = new Set(Object.keys(positions))
      const picks = (scans[day].top_stocks || [])
        .filter(s => s.entry_signal && !held.has(String(s.stock_id)))
        .sort((a, b) => (b.entry_score || 0) - (a.entry_score || 0))
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
