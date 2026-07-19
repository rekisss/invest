// 無人值守腳本冒煙測試 — daily-report.mjs 與 intraday-monitor.mjs 都由
// cron-job.org 排程在夜間/盤中自動執行,runtime 掛掉 = 靜默漏報,沒有人會
// 立刻發現。這裡用合成 data.json + mock Fugle server 實跑整支腳本(DRY_RUN),
// 驗證能跑完、關鍵段落有產出,把「腳本壞了」從生產環境提前到 CI。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const here = dirname(fileURLToPath(import.meta.url))

// as_of 固定用 2026-07-17(週五)→ 日報的「📅 本週總結」應自動出現
function fixtureData() {
  const bars = []
  for (let i = 0; i < 25; i++) {
    const day = String(1 + i).padStart(2, '0')
    bars.push({ time: `2026-06-${day}`, open: 100, high: 120, low: 95, close: 100, volume: 1000 })
  }
  return {
    generated_at: new Date().toISOString(),
    dates: ['2026-07-17'],
    scans: {
      '2026-07-17': {
        top_stocks: [{ stock_id: '9999', name: '測試股', entry_signal: true, entry_score: 900, close: 100, price_history: bars }],
      },
    },
    predictionHistory: [{ date: '2026-07-17', xgb_label: '偏多', xgb_prob_up: 0.6 }],
    news: [{ title: '持倉股 8888 獲大單挹注' }],
    aiTrader: {
      as_of: '2026-07-17', equity: 998000, cash: 500000, invested: 498000, return_pct: -0.2,
      positions: [{ stock_id: '8888', name: '持倉股', entry: 100, tp_price: 108, sl_price: 88, entry_date: '2026-07-16', shares: 1000, price: 100 }],
      trades: [{ stock_id: '7777', name: '平倉股', reason: 'take_profit', ret_pct: 7.4, pnl: 7400, entry_date: '2026-07-10', exit_date: '2026-07-17' }],
      equity_curve: [
        { date: '2026-07-13', equity: 1000000, ret_pct: 0 },
        { date: '2026-07-14', equity: 1005000, ret_pct: 0.5 },
        { date: '2026-07-17', equity: 998000, ret_pct: -0.2 },
      ],
      benchmark: {
        return_pct: -1.0,
        curve: [
          { date: '2026-07-13', ret_pct: 0 },
          { date: '2026-07-14', ret_pct: -0.4 },
          { date: '2026-07-17', ret_pct: -1.0 },
        ],
      },
      plan: { buys: [], exits: [{ stock_id: '8888', tp_price: 108, sl_price: 88, days_left: 5 }], free_slots: 5 },
      variants: [{ id: 'trail8', label: '移動停損 8%', return_pct: 0.7 }],
      adaptive: { follow_label: '移動停損 8%', return_pct: -0.1, switches: [], learning_active: true },
    },
  }
}

function runScript(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, script)], {
      env: {
        ...process.env,
        // 隔絕外部服務:沒有金鑰/webhook 時兩支腳本都要能安全跑完
        ANTHROPIC_API_KEY: '', DISCORD_WEBHOOK_URL: '', FUGLE_API_KEY: '',
        DRY_RUN: '1', FORCE_RUN: '1',
        ...env,
      },
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

test('daily-report:週五資料日 DRY_RUN 跑完,含本週總結與規則排行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-smoke-'))
  const dataFile = join(dir, 'data.json')
  const reportFile = join(dir, 'ai_reports.json')
  writeFileSync(dataFile, JSON.stringify(fixtureData()))

  const { code, out } = await runScript('daily-report.mjs', {
    DATA_URL: dataFile, REPORT_FILE: reportFile,
  })
  assert.equal(code, 0, out)
  assert.match(out, /日報內容/)
  assert.match(out, /總資產 NT\$998,000/)
  assert.match(out, /今日平倉:7777 平倉股 停利/)
  assert.match(out, /📅 本週總結/)          // 07-17 是週五 → 自動出現
  assert.match(out, /🧪 規則排行第一/)
  // 日報歷史檔要寫成功,且不含 Discord 專用尾註
  assert.ok(existsSync(reportFile))
  const history = JSON.parse(readFileSync(reportFile, 'utf8'))
  assert.equal(history[0].date, '2026-07-17')
  assert.ok(history[0].lines.every(l => !l.startsWith('-#')))
})

test('intraday-monitor:mock 報價觸發停利警示,狀態檔寫入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-smoke-'))
  const dataFile = join(dir, 'data.json')
  const stateFile = join(dir, 'state.json')
  writeFileSync(dataFile, JSON.stringify(fixtureData()))

  // mock Fugle:任何代號都回 110 → 持倉 8888(停利 108)應觸發停利
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ lastPrice: 110 }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const { code, out } = await runScript('intraday-monitor.mjs', {
      DATA_URL: dataFile, STATE_FILE: stateFile, FUGLE_BASE: base,
      FUGLE_API_KEY: 'smoke-test-key', // 假金鑰:mock server 不驗,只為通過腳本的必填檢查
    })
    assert.equal(code, 0, out)
    assert.match(out, /停利觸發/)
    assert.match(out, /8888/)
    assert.ok(existsSync(stateFile))
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.ok(state.keys.includes('tp:8888'), `state keys: ${JSON.stringify(state.keys)}`)
  } finally {
    server.close()
  }
})
