// 每日 AI 操盤日報 — 由外部排程(cron-job.org)透過 workflow_dispatch 觸發,
// 建議每天 21:30(台北)打一次(晚間資料建置完成後)。
//
// 從已部署的 GitHub Pages 抓 data.json,把 AI 交易員一天的產出濃縮成一則
// Discord 訊息:今日戰績(vs 大盤基準)、今日買賣動作、明日作戰計畫、
// 規則實驗室排行。純讀取+通知,不碰任何下單 API。
//
// 環境變數:DISCORD_WEBHOOK_URL(必要)、DATA_URL(預設 Pages;可給本機路徑
// 測試)、DRY_RUN=1(列印不發送)、FORCE_RUN=1(略過資料過期檢查)

import { readFileSync } from 'node:fs'

const DATA_URL = process.env.DATA_URL || 'https://rekisss.github.io/invest/data.json'
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || ''
const DRY = process.env.DRY_RUN === '1'

console.log(`抓取 ${DATA_URL} ...`)
let data
try {
  if (DATA_URL.startsWith('/')) {
    data = JSON.parse(readFileSync(DATA_URL, 'utf8'))
  } else {
    const res = await fetch(DATA_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data = await res.json()
  }
} catch (e) {
  console.error(`data.json 抓取失敗:${e.message}`)
  process.exit(1)
}

const ai = data.aiTrader
if (!ai) { console.log('無 aiTrader 資料,結束。'); process.exit(0) }

// 資料太舊就不發(避免連假期間重複發同一份);FORCE_RUN=1 可略過
const asOf = ai.as_of || data.dates?.[0] || ''
const ageDays = asOf ? Math.floor((Date.now() - new Date(`${asOf}T00:00:00+08:00`).getTime()) / 86400000) : 999
if (ageDays > 4 && process.env.FORCE_RUN !== '1') {
  console.log(`資料日 ${asOf} 已 ${ageDays} 天前(連假?),跳過本次日報。`)
  process.exit(0)
}

const nf = v => v == null ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 0 })
const pct = (v, d = 2) => v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`

const lines = []
lines.push(`📊 **AI 操盤日報** · ${asOf}`)

// 戰績 vs 基準
const bench = ai.benchmark
let vsText = ''
if (bench?.return_pct != null) {
  const diff = Math.round((ai.return_pct - bench.return_pct) * 100) / 100
  vsText = ` · 基準 ${pct(bench.return_pct)} → ${diff >= 0 ? '領先' : '落後'} ${Math.abs(diff).toFixed(1)}pp`
}
lines.push(`💼 總資產 NT$${nf(ai.equity)}(${pct(ai.return_pct)})${vsText}`)

// 今日動作:平倉 + 新進
const REASON = { take_profit: '停利', stop: '停損', time: '期滿' }
const closedToday = (ai.trades || []).filter(t => t.exit_date === asOf)
const openedToday = (ai.positions || []).filter(p => p.entry_date === asOf)
if (closedToday.length) {
  lines.push(`💰 今日平倉:${closedToday.map(t =>
    `${t.stock_id} ${t.name} ${REASON[t.reason] || t.reason} ${pct(t.ret_pct, 1)}(NT$${nf(t.pnl)})`).join('、')}`)
}
if (openedToday.length) {
  lines.push(`🛒 今日新進:${openedToday.map(p => `${p.stock_id} ${p.name} @${p.entry}`).join('、')}`)
}
if (!closedToday.length && !openedToday.length) {
  lines.push(`😴 今日無買賣(持倉 ${ai.positions?.length ?? 0} 檔續抱)`)
}

// 明日作戰計畫
const plan = ai.plan
if (plan) {
  if (plan.buys?.length) {
    lines.push(`📋 明日開盤補進:${plan.buys.map(b =>
      `${b.stock_id} ${b.name}(分${b.entry_score}${b.grade ? '/' + b.grade : ''})`).join('、')}${plan.est_budget_each ? ` · 每檔約 NT$${nf(plan.est_budget_each)}` : ''}`)
  } else {
    lines.push(`📋 明日不進新單(${plan.free_slots === 0 ? '滿倉' : '無新進場訊號'})`)
  }
  if (plan.exits?.length) {
    lines.push(`🎯 出場單:${plan.exits.map(e =>
      `${e.stock_id} 停利${e.tp_price ?? '—'}/停損${e.sl_price ?? '—'}${e.days_left != null ? `/剩${e.days_left}日` : ''}`).join('、')}`)
  }
}

// 預測回顧:盤前預測(偏多/中性/偏空)用「掃描池等權當日報酬」驗證。
// 等權日報酬取自基準曲線相鄰兩點的差(累計值相減,小數值下近似日報酬)。
const ph = data.predictionHistory || []
const benchCurve = ai.benchmark?.curve || []
if (ph.length && benchCurve.length >= 2) {
  const dayRet = {}
  for (let i = 1; i < benchCurve.length; i++) {
    dayRet[benchCurve[i].date] = Math.round((benchCurve[i].ret_pct - benchCurve[i - 1].ret_pct) * 100) / 100
  }
  const isHit = (label, r) => {
    if (label === '偏多' || label === '看多') return r > 0
    if (label === '偏空' || label === '看空') return r < 0
    return Math.abs(r) <= 0.4 // 中性:當日等權漲跌在 ±0.4% 內算命中
  }
  let hits = 0, total = 0, todayLine = null
  for (const p of ph) {
    const r = dayRet[p.date]
    if (r == null || !p.xgb_label) continue
    total++
    const ok = isHit(p.xgb_label, r)
    if (ok) hits++
    if (p.date === asOf) todayLine = `今日 ${p.xgb_label} → 實際 ${pct(r)} ${ok ? '✅' : '❌'}`
  }
  if (total > 0) {
    lines.push(`🔮 預測回顧:${todayLine ? todayLine + ' · ' : ''}近${total}日命中 ${hits}/${total}(${Math.round(hits / total * 100)}%)`)
  }
}

// 規則實驗室:目前領先的規則
if (Array.isArray(ai.variants) && ai.variants.length) {
  const all = [{ label: '主帳戶', return_pct: ai.return_pct }, ...ai.variants]
    .filter(v => v.return_pct != null)
    .sort((a, b) => b.return_pct - a.return_pct)
  const top = all[0]
  lines.push(`🧪 規則排行第一:${top.label}(${pct(top.return_pct, 1)})`)
}

lines.push(`-# 虛擬帳戶紀錄,非投資建議;正式數據以網頁 AI操盤分頁為準`)

const content = lines.join('\n').slice(0, 1990) // Discord 2000 字上限
console.log('--- 日報內容 ---\n' + content)

if (DRY) { console.log('[DRY] 不發送'); process.exit(0) }
if (!WEBHOOK) { console.error('缺 DISCORD_WEBHOOK_URL,結束。'); process.exit(0) }
try {
  const res = await fetch(WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  console.log(`Discord 回應:HTTP ${res.status}`)
} catch (e) {
  console.error(`Discord 發送失敗:${e.message}`)
  process.exit(1)
}
