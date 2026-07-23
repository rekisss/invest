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
    // 真實收盤打分(outcome_tracker → realOutcomes.prediction_hit)比代理更準,
    // 樣本足夠(≥5 日)才附上;不足時只用代理(避免 1/1 這種誤導數字)。
    const rh = data.realOutcomes?.prediction_hit
    const realStr = (rh && rh.total >= 5)
      ? ` · 真實收盤 ${rh.hits}/${rh.total}(${Math.round(rh.hits / rh.total * 100)}%)`
      : ''
    lines.push(`🔮 預測回顧:${todayLine ? todayLine + ' · ' : ''}代理估算近${total}日 ${hits}/${total}(${Math.round(hits / total * 100)}%)${realStr}`)
  }
}

// 持倉相關新聞(確定性關鍵字比對:新聞標題含持倉/明日補進的股名或代號)
const watchStocks = [
  ...(ai.positions || []).map(p => ({ id: String(p.stock_id), name: p.name || '' })),
  ...((plan?.buys) || []).map(b => ({ id: String(b.stock_id), name: b.name || '' })),
]
const newsList = data.news || []
const relatedNews = []
for (const n of newsList) {
  const t = n.title || ''
  const hit = watchStocks.find(w => (w.name && w.name.length >= 2 && t.includes(w.name)) || t.includes(w.id))
  if (hit && !relatedNews.some(x => x.title === t)) relatedNews.push({ title: t, stock: hit })
  if (relatedNews.length >= 3) break
}
if (relatedNews.length) {
  lines.push(`📰 持倉相關新聞:${relatedNews.map(n => `【${n.stock.name || n.stock.id}】${n.title.slice(0, 36)}`).join(' / ')}`)
}

// 🧠 AI 操盤手札:用 Claude 把當天的事實寫成 3-4 句人話復盤(顯示層;
// 交易決策仍是 100% 確定性規則,LLM 只解讀、不參與任何買賣判斷)。
// 無金鑰或呼叫失敗時靜默跳過,日報其餘內容不受影響。
const AI_KEY = process.env.ANTHROPIC_API_KEY || ''
if (AI_KEY && !DRY) {
  try {
    const facts = {
      日期: asOf,
      總資產: ai.equity, 報酬pct: ai.return_pct,
      大盤基準pct: bench?.return_pct ?? null,
      今日平倉: closedToday.map(t => `${t.name} ${t.reason} ${t.ret_pct}%`),
      今日新進: openedToday.map(p => `${p.name} @${p.entry}`),
      持倉數: ai.positions?.length ?? 0,
      明日補進: (plan?.buys || []).map(b => `${b.name} 分${b.entry_score}`),
      明日預測: (data.predictionHistory || []).find(p => p.date > asOf)?.xgb_label || null,
      持倉相關新聞: relatedNews.map(n => n.title.slice(0, 50)),
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 30000)
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `你是一位謹慎的台股操盤手。根據以下今日事實,寫一段今晚的操盤手札(繁體中文、最多120字、2-4句)。只能使用給定事實,不得捏造任何數字或消息;不得有「保證獲利」之類的敘述;語氣專業冷靜,聚焦「今天發生什麼、明天注意什麼」。直接輸出手札內容,不要任何開頭語或標題。\n\n事實:${JSON.stringify(facts)}`,
        }],
      }),
    })
    clearTimeout(timer)
    if (res.ok) {
      const out = await res.json()
      const text = (out.content?.[0]?.text || '').trim().replace(/\s*\n+\s*/g, ' ')
      if (text) lines.push(`🧠 AI手札:${text.slice(0, 300)}`)
    } else {
      console.warn(`AI 手札跳過:HTTP ${res.status}`)
    }
  } catch (e) { console.warn(`AI 手札跳過:${e.message}`) }
}

// 規則實驗室:目前領先的規則 + 自我學習帳戶動態
if (Array.isArray(ai.variants) && ai.variants.length) {
  // 對照組(control,如亂數選股)只是基準線,不參與「排行第一」的角逐
  const all = [{ label: '主帳戶', return_pct: ai.return_pct }, ...ai.variants]
    .filter(v => v.return_pct != null && !v.control)
    .sort((a, b) => b.return_pct - a.return_pct)
  const top = all[0]
  let adaptiveText = ''
  if (ai.adaptive) {
    const a = ai.adaptive
    const switchedToday = (a.switches || []).find(s => s.date === asOf)
    adaptiveText = switchedToday
      ? ` · 🎓 自學帳戶今日換規則:${switchedToday.from}→${switchedToday.to}`
      : ` · 🎓 自學帳戶跟隨「${a.follow_label}」(${pct(a.return_pct, 1)}${a.learning_active ? '' : ',樣本累積中'})`
  }
  lines.push(`🧪 規則排行第一:${top.label}(${pct(top.return_pct, 1)})${adaptiveText}`)
}

// 📅 本週總結:資料日是週五時(或 FORCE_WEEKLY=1 測試),附一段週回顧——
// 權益週變化 vs 基準、本週平倉戰績、本週預測命中、自學切換。全部由
// data.json 既有欄位算出,不需要新排程/新 workflow。
const isFriday = new Date(`${asOf}T00:00:00Z`).getUTCDay() === 5
if ((isFriday || process.env.FORCE_WEEKLY === '1') && Array.isArray(ai.equity_curve) && ai.equity_curve.length >= 2) {
  const weekAgo = new Date(new Date(`${asOf}T00:00:00Z`).getTime() - 6 * 86400000).toISOString().slice(0, 10)
  const curve = ai.equity_curve
  const inWeek = curve.filter(p => p.date >= weekAgo && p.date <= asOf)
  const prevPt = curve.filter(p => p.date < weekAgo).at(-1) || null
  if (inWeek.length && (prevPt || inWeek.length >= 2)) {
    const startEq = prevPt ? prevPt.equity : inWeek[0].equity
    const endEq = inWeek.at(-1).equity
    const wkRet = Math.round((endEq / startEq - 1) * 10000) / 100
    // 基準同窗週報酬(累計水位相除)
    let vsWk = ''
    if (benchCurve.length >= 2) {
      const bPrev = benchCurve.filter(p => p.date < weekAgo).at(-1)
      const bIn = benchCurve.filter(p => p.date >= weekAgo && p.date <= asOf)
      if (bIn.length) {
        const s = 1 + (bPrev ? bPrev.ret_pct : bIn[0].ret_pct) / 100
        const e = 1 + bIn.at(-1).ret_pct / 100
        const benchWk = Math.round((e / s - 1) * 10000) / 100
        const diff = Math.round((wkRet - benchWk) * 10) / 10
        vsWk = ` · 基準週 ${pct(benchWk)} → ${diff >= 0 ? '領先' : '落後'} ${Math.abs(diff).toFixed(1)}pp`
      }
    }
    const parts = [`本週 ${pct(wkRet)}${vsWk}`]
    const wkTrades = (ai.trades || []).filter(t => t.exit_date >= weekAgo && t.exit_date <= asOf)
    if (wkTrades.length) {
      const wins = wkTrades.filter(t => t.ret_pct > 0).length
      const pnl = wkTrades.reduce((a, t) => a + (t.pnl || 0), 0)
      parts.push(`平倉 ${wkTrades.length} 筆(勝 ${wins},NT$${nf(pnl)})`)
    }
    if (ph.length && benchCurve.length >= 2) {
      const dayRet = {}
      for (let i = 1; i < benchCurve.length; i++) {
        dayRet[benchCurve[i].date] = Math.round((benchCurve[i].ret_pct - benchCurve[i - 1].ret_pct) * 100) / 100
      }
      let wHits = 0, wTotal = 0
      for (const p of ph) {
        if (p.date < weekAgo || p.date > asOf) continue
        const r = dayRet[p.date]
        if (r == null || !p.xgb_label) continue
        wTotal++
        const bull = p.xgb_label.includes('多'), bear = p.xgb_label.includes('空')
        if (bull ? r > 0 : bear ? r < 0 : Math.abs(r) <= 0.4) wHits++
      }
      if (wTotal > 0) parts.push(`預測命中 ${wHits}/${wTotal}`)
    }
    const wkSwitches = (ai.adaptive?.switches || []).filter(s => s.date >= weekAgo && s.date <= asOf)
    if (wkSwitches.length) parts.push(`自學換規則 ${wkSwitches.length} 次(→${ai.adaptive.follow_label})`)
    lines.push(`📅 本週總結:${parts.join(' · ')}`)
  }
}

lines.push(`-# 虛擬帳戶紀錄,非投資建議;正式數據以網頁 AI操盤分頁為準`)

const content = lines.join('\n').slice(0, 1990) // Discord 2000 字上限
console.log('--- 日報內容 ---\n' + content)

// 存檔供網頁顯示(Pages):REPORT_FILE 存在時,把日報(去掉 Discord 專用
// 尾註)寫進滾動歷史檔,由 workflow commit 回 repo → build-data 收進
// data.json → AI操盤分頁的「📜 操盤日報」卡。保留最近 14 份。
const REPORT_FILE = process.env.REPORT_FILE || ''
if (REPORT_FILE) {
  try {
    let history = []
    try { history = JSON.parse(readFileSync(REPORT_FILE, 'utf8')) } catch { /* 首次 */ }
    if (!Array.isArray(history)) history = []
    const entry = {
      date: asOf,
      generated_at: new Date().toISOString(),
      lines: lines.filter(l => !l.startsWith('-#')),
    }
    history = [entry, ...history.filter(h => h.date !== asOf)].slice(0, 14)
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    mkdirSync(dirname(REPORT_FILE), { recursive: true })
    writeFileSync(REPORT_FILE, JSON.stringify(history, null, 1), 'utf8')
    console.log(`日報已寫入 ${REPORT_FILE}(歷史 ${history.length} 份)`)
  } catch (e) { console.warn(`日報存檔失敗:${e.message}`) }
}

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
