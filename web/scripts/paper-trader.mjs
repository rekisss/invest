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

  for (const day of days) {
    const di = dayIndex[day]

    // 1) exits — check each holding's bar today for TP/stop/time
    for (const sid of Object.keys(positions)) {
      const pos = positions[sid]
      if (di <= pos.entryDayIdx) continue // never exit on entry day
      const bar = barAt(sid, day)
      const holdDays = di - pos.entryDayIdx
      let exitPrice = null, reason = null
      const tp = pos.entry * (1 + cfg.takeProfit)
      const sl = pos.entry * (1 - cfg.stopLoss)
      if (bar) {
        // conservative: if both stop and target touched same bar, assume stop first
        if (bar.low != null && bar.low <= sl) { exitPrice = sl; reason = 'stop' }
        else if (bar.high != null && bar.high >= tp) { exitPrice = tp; reason = 'take_profit' }
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
      let slots = cfg.maxPositions - Object.keys(positions).length
      for (const s of picks) {
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
        }
        slots--
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
    }
  }).sort((a, b) => b.value - a.value)

  const equity = cash + invested
  const wins = closed.filter(t => t.ret_pct > 0).length
  const stats = {
    num_trades: closed.length,
    win_rate: closed.length ? round2(wins / closed.length * 100) : null,
    avg_ret: closed.length ? round2(closed.reduce((a, t) => a + t.ret_pct, 0) / closed.length) : null,
    best: closed.length ? Math.max(...closed.map(t => t.ret_pct)) : null,
    worst: closed.length ? Math.min(...closed.map(t => t.ret_pct)) : null,
    max_drawdown_pct: round2(maxDD * 100),
    trading_days: days.length,
  }

  return {
    config: { start_capital: cfg.startCapital, start_date: cfg.startDate, max_positions: cfg.maxPositions,
              take_profit_pct: cfg.takeProfit * 100, stop_loss_pct: cfg.stopLoss * 100, max_hold: cfg.maxHold },
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
