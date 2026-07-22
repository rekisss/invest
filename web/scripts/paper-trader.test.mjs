// paper-trader.mjs 單元測試 — node:test,零外部依賴,跑法:node --test web/scripts/
//
// 這個引擎算的是使用者每天看的 AI 操盤金額;所有規則(停利/停損/跳空成交/
// 時間出場/次日開盤/移動停損/日曆延伸)都用小型合成 K 線逐一釘住,防止之後
// 的重構悄悄改變損益數字。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulatePaperTrader, simulateAdaptiveTrader, simulateEnsembleTrader } from './paper-trader.mjs'

// ── fixtures ─────────────────────────────────────────────────────────────────
const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']

// bars: [{o,h,l,c}] 依 D 順序;省略的欄位用 close 補
function mkBars(specs) {
  return specs.map((s, i) => ({
    time: D[i],
    open: s.o ?? s.c, high: s.h ?? s.c, low: s.l ?? s.c, close: s.c,
    volume: 1000,
  }))
}

function mkScan(stocks) {
  return { top_stocks: stocks.map(s => ({ entry_signal: true, entry_score: 10, name: s.id, ...s, stock_id: s.id })) }
}

const baseCfg = { startDate: D[0], maxPositions: 1 }

function run({ scans, bars, config = {} }) {
  return simulatePaperTrader({
    scans,
    klineFor: (sid) => bars[sid] || null,
    config: { ...baseCfg, ...config },
  })
}

// ── 進場與停利 ────────────────────────────────────────────────────────────────
test('掃描日收盤買進,隔日觸及 +8% 停利出場於觸發價', () => {
  const r = run({
    scans: { [D[0]]: mkScan([{ id: 'A' }]) },
    bars: { A: mkBars([{ c: 100 }, { o: 100, h: 109, l: 99, c: 105 }]) },
  })
  assert.equal(r.trades.length, 1)
  const t = r.trades[0]
  assert.equal(t.reason, 'take_profit')
  assert.equal(t.exit, 108)          // 觸發價成交(開盤未跳空過 TP)
  assert.equal(t.tp_price, 108)
  assert.ok(t.ret_pct > 7 && t.ret_pct < 8, `net ret ${t.ret_pct} 應介於 7~8%(扣手續費+稅)`)
})

test('收盤成交當天不出場(高點發生在買進前)', () => {
  const r = run({
    scans: { [D[0]]: mkScan([{ id: 'A' }]) },
    bars: { A: mkBars([{ o: 95, h: 120, l: 94, c: 100 }]) }, // 當日高點早已 >TP
  })
  assert.equal(r.trades.length, 0)
  assert.equal(r.positions.length, 1)
})

test('跳空漲過停利:用更好的開盤價成交', () => {
  const r = run({
    scans: { [D[0]]: mkScan([{ id: 'A' }]) },
    bars: { A: mkBars([{ c: 100 }, { o: 112, h: 115, l: 110, c: 113 }]) },
  })
  assert.equal(r.trades[0].reason, 'take_profit')
  assert.equal(r.trades[0].exit, 112) // 開盤 112 > 觸發價 108 → 照開盤成交
})

// ── 停損 ─────────────────────────────────────────────────────────────────────
test('盤中跌破 −12% 停損:出場於觸發價', () => {
  const r = run({
    scans: { [D[0]]: mkScan([{ id: 'A' }]) },
    bars: { A: mkBars([{ c: 100 }, { o: 92, h: 93, l: 85, c: 86 }]) },
  })
  const t = r.trades[0]
  assert.equal(t.reason, 'stop')
  assert.equal(t.exit, 88)           // sl = 100×0.88;開盤 92 未跳空穿越
  assert.equal(t.sl_price, 88)
})

test('跳空跌破停損:用更差的開盤價成交(不高估績效)', () => {
  const r = run({
    scans: { [D[0]]: mkScan([{ id: 'A' }]) },
    bars: { A: mkBars([{ c: 100 }, { o: 80, h: 82, l: 78, c: 79 }]) },
  })
  assert.equal(r.trades[0].reason, 'stop')
  assert.equal(r.trades[0].exit, 80) // 開盤 80 < sl 88 → 照開盤成交
})

test('同根K棒同時觸及停損與停利:保守假設先停損', () => {
  const r = run({
    scans: { [D[0]]: mkScan([{ id: 'A' }]) },
    bars: { A: mkBars([{ c: 100 }, { o: 100, h: 120, l: 85, c: 110 }]) },
  })
  assert.equal(r.trades[0].reason, 'stop')
})

// ── 時間出場 ─────────────────────────────────────────────────────────────────
test('持有滿 maxHold 個交易日以收盤價出場', () => {
  const flat = mkBars([{ c: 100 }, { c: 101 }, { c: 102 }, { c: 103 }])
  const r = run({
    scans: { [D[0]]: mkScan([{ id: 'A' }]) },
    bars: { A: flat },
    config: { maxHold: 2 },
  })
  const t = r.trades[0]
  assert.equal(t.reason, 'time')
  assert.equal(t.exit_date, D[2])    // 進場日+2 個交易日
  assert.equal(t.exit, 102)
  assert.equal(t.hold_days, 2)
})

// ── next_open 執行 ───────────────────────────────────────────────────────────
test('next_open:次日開盤價買進,且開盤成交當天可觸發停利', () => {
  const r = run({
    scans: { [D[0]]: mkScan([{ id: 'A' }]) },
    bars: { A: mkBars([{ c: 100 }, { o: 102, h: 111, l: 101, c: 108 }]) },
    config: { execution: 'next_open' },
  })
  const t = r.trades[0]
  assert.equal(t.entry, 102)              // 次日開盤價
  assert.equal(t.entry_date, D[1])
  assert.equal(t.reason, 'take_profit')   // 同日 high 111 ≥ 102×1.08=110.16
  assert.equal(t.exit_date, D[1])
})

// ── 移動停損 ─────────────────────────────────────────────────────────────────
test('trailingStop:從峰值回落觸發,出場於移動停損價', () => {
  const r = run({
    scans: { [D[0]]: mkScan([{ id: 'A' }]) },
    bars: { A: mkBars([{ c: 100 }, { o: 120, h: 130, l: 119, c: 125 }, { o: 125, h: 126, l: 110, c: 112 }]) },
    config: { trailingStop: 0.1, takeProfit: null },
  })
  const t = r.trades[0]
  assert.equal(t.reason, 'stop')
  assert.equal(t.exit, 117)          // 峰值 130 × (1−0.1) = 117;開盤 125 未跳空穿越
})

// ── 買進守門與選股 ───────────────────────────────────────────────────────────
test('buyGate 回傳 false 的掃描日不進新單', () => {
  const r = run({
    scans: { [D[0]]: mkScan([{ id: 'A' }]) },
    bars: { A: mkBars([{ c: 100 }, { c: 101 }]) },
    config: { buyGate: () => false },
  })
  assert.equal(r.positions.length, 0)
  assert.equal(r.trades.length, 0)
  assert.equal(r.equity, 1_000_000)
})

test('依 entry_score 排序、受 maxPositions 上限約束', () => {
  const r = run({
    scans: { [D[0]]: mkScan([
      { id: 'LOW', entry_score: 1 }, { id: 'HI', entry_score: 9 }, { id: 'MID', entry_score: 5 },
    ]) },
    bars: {
      LOW: mkBars([{ c: 50 }]), HI: mkBars([{ c: 50 }]), MID: mkBars([{ c: 50 }]),
    },
    config: { maxPositions: 2 },
  })
  const ids = r.positions.map(p => p.stock_id).sort()
  assert.deepEqual(ids, ['HI', 'MID'])   // 分數前二,LOW 沒位子
  const hi = r.positions.find(p => p.stock_id === 'HI')
  assert.equal(hi.day_rank, 1)
})

test('pickFilter 硬濾網:回傳 false 的股票不買', () => {
  const r = run({
    scans: { [D[0]]: mkScan([
      { id: 'GROW', revenue_yoy: 0.2, entry_score: 1 },
      { id: 'SHRINK', revenue_yoy: -0.1, entry_score: 9 },
    ]) },
    bars: { GROW: mkBars([{ c: 50 }]), SHRINK: mkBars([{ c: 50 }]) },
    config: { pickFilter: (s) => (s.revenue_yoy ?? -1) > 0 },
  })
  assert.equal(r.positions.length, 1)
  assert.equal(r.positions[0].stock_id, 'GROW') // 分數較高的 SHRINK 被濾網擋下
})

test('無 entry_signal 的股票預設不買;requireEntrySignal:false 則可', () => {
  const scans = { [D[0]]: { top_stocks: [{ stock_id: 'A', name: 'A', entry_signal: false, entry_score: 10 }] } }
  const bars = { A: mkBars([{ c: 100 }]) }
  assert.equal(run({ scans, bars }).positions.length, 0)
  assert.equal(run({ scans, bars, config: { requireEntrySignal: false } }).positions.length, 1)
})

// ── 交易日曆(「持倉慢一天」回歸)──────────────────────────────────────────────
test('日曆延伸到最新K線日:估值/出場不卡在最後掃描日', () => {
  const r = run({
    scans: { [D[0]]: mkScan([{ id: 'A' }]) },   // 只有 D0 有掃描
    bars: { A: mkBars([{ c: 100 }, { c: 103 }, { c: 106 }]) }, // K 線多兩天
  })
  assert.equal(r.as_of, D[2])                    // 最新K線日,不是掃描日 D0
  assert.equal(r.positions[0].price, 106)        // 用最新收盤估值
  assert.equal(r.equity_curve.length, 3)
})

// ── 自適應帳戶 ───────────────────────────────────────────────────────────────
function mkAccount(id, dailyPct, n, exitDates = []) {
  const curve = []
  let lv = 1
  for (let i = 0; i < n; i++) {
    lv *= 1 + dailyPct / 100
    curve.push({ date: D[i] ?? `2026-02-${String(i + 1).padStart(2, '0')}`, ret_pct: Math.round((lv - 1) * 10000) / 100 })
  }
  return { id, label: id, curve, exit_dates: exitDates }
}

test('adaptive:樣本不足前不切換(learning_active=false)', () => {
  const n = 5
  const r = simulateAdaptiveTrader({
    accounts: [mkAccount('base', 0, n), mkAccount('fast', 2, n)],
    window: 2, minTrades: 10, marginPp: 1, switchCostPct: 0.7,
  })
  assert.equal(r.num_switches, 0)
  assert.equal(r.follow_id, 'base')
  assert.equal(r.learning_active, false)
})

test('adaptive:挑戰者贏過 margin 即切換,切換成本記在當日曲線點', () => {
  const n = 5
  const exits = [D[0], D[0]]                     // 2 筆已結 → 過 minTrades=2 門檻
  const r = simulateAdaptiveTrader({
    accounts: [mkAccount('base', 0, n, exits), mkAccount('fast', 2, n)],
    window: 2, minTrades: 2, marginPp: 1, switchCostPct: 0.7,
  })
  assert.equal(r.num_switches, 1)
  assert.equal(r.follow_id, 'fast')
  assert.equal(r.switches[0].from, 'base')
  assert.equal(r.switches[0].to, 'fast')
  // 切換日(i=window=2)當日曲線點要已含 −0.7% 成本:base 累計 0% × 0.993
  const switchPoint = r.curve.find(p => p.date === r.switches[0].date)
  assert.equal(switchPoint.ret_pct, -0.7)
  assert.equal(r.learning_active, true)
})

// ── 群體智慧帳戶(ensemble)──────────────────────────────────────────────────
test('ensemble:樣本不足前維持等權(不學習)', () => {
  const n = 12
  const r = simulateEnsembleTrader({
    accounts: [mkAccount('up', 3, n), mkAccount('down', -1, n)],
    window: 3, minTrades: 999, rebalanceDays: 2,   // minTrades 永遠不達標
  })
  assert.equal(r.learning_active, false)
  assert.equal(r.num_rebalances, 0)
  // 等權未調 → 兩者權重相同
  assert.equal(r.weights[0].weight_pct, r.weights[1].weight_pct)
})

test('ensemble:配權向贏家傾斜,但輸家仍保留分散地板(never abandon)', () => {
  const n = 12
  const exits = Array(5).fill(D[0])              // 樣本充足
  const r = simulateEnsembleTrader({
    accounts: [mkAccount('up', 3, n, exits), mkAccount('down', -1, n)],
    window: 3, minTrades: 2, rebalanceDays: 2, floorMix: 0.4,
  })
  assert.equal(r.learning_active, true)
  assert.ok(r.num_rebalances >= 1, '應有 rebalance')
  const up = r.weights.find(w => w.id === 'up')
  const down = r.weights.find(w => w.id === 'down')
  assert.ok(up.weight_pct > down.weight_pct, '贏家 up 權重應較高')
  assert.ok(down.weight_pct > 0, '輸家 down 權重仍 > 0(分散地板)')
  // floorMix=0.4、K=2 → 每個至少 0.4/2 = 20%
  assert.ok(down.weight_pct >= 19.5, `分散地板約 20%,實際 ${down.weight_pct}%`)
})

test('ensemble:組合報酬介於最好與最差帳戶之間(分散特性)', () => {
  const n = 12
  const exits = Array(5).fill(D[0])
  const accts = [mkAccount('up', 3, n, exits), mkAccount('down', -1, n)]
  const r = simulateEnsembleTrader({ accounts: accts, window: 3, minTrades: 2, rebalanceDays: 2 })
  const upFinal = accts[0].curve[n - 1].ret_pct
  const downFinal = accts[1].curve[n - 1].ret_pct
  assert.ok(r.return_pct < upFinal && r.return_pct > downFinal,
    `組合 ${r.return_pct}% 應介於 ${downFinal}% 與 ${upFinal}% 之間`)
})
