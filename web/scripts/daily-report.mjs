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
import { scoreProxyPredictions, summarizeProxy, PROXY_HORIZON } from '../src/utils/proxyScore.js'

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
  // 模型預測的是 5 個交易日後 → 代理命中率也必須用同期距的累積報酬打分
  // (與前端共用 scoreProxyPredictions,數字保證一致)
  const proxyRows = scoreProxyPredictions(ph, benchCurve, { limit: 60 })
  const summary = summarizeProxy(proxyRows)
  const hits = summary?.hits ?? 0
  const total = summary?.total ?? 0
  const todayRow = proxyRows.find(r => r.date === asOf)
  const todayLine = todayRow
    ? `今日 ${todayRow.label} → ${PROXY_HORIZON}日 ${pct(todayRow.ret)} ${todayRow.hit ? '✅' : '❌'}`
    : null
  if (total > 0) {
    // 真實收盤打分(outcome_tracker → realOutcomes.prediction_hit)比代理更準,
    // 樣本足夠(≥5 日)才附上;不足時只用代理(避免 1/1 這種誤導數字)。
    // 模型預測的是 5 個交易日後(MarketPredictor horizon=5),期距正確的打分優先
    const rhH = data.realOutcomes?.prediction_hit_h5
    const rh = rhH || data.realOutcomes?.prediction_hit
    const hz = rhH ? `${rhH.horizon || 5}日期距` : '隔日'
    const realStr = (rh && rh.total >= 5)
      ? ` · 真實收盤${hz} ${rh.hits}/${rh.total}(${Math.round(rh.hits / rh.total * 100)}%)`
      : ''
    lines.push(`🔮 預測回顧:${todayLine ? todayLine + ' · ' : ''}代理估算(${PROXY_HORIZON}日期距)${hits}/${total}(${Math.round(hits / total * 100)}%)${realStr}`)
  }
}

// 輸入完整度提示:最新預測若「美股隔夜」關鍵群組缺料,模型跑在降級輸入上,
// 方向判讀該保守看待——只在關鍵群組不完整時提示(好日子不洗版)。
{
  const ic = data.prediction?.input_completeness
  if (ic && ic.critical_total > 0 && ic.critical_present < ic.critical_total) {
    const usg = (ic.groups || []).find(g => g.key === 'us_overnight')
    const missStr = usg && usg.missing?.length ? `(缺 ${usg.missing.join('、')})` : ''
    const sev = ic.critical_present === 0 ? '🚨 美股隔夜訊號全缺' : '⚠️ 美股隔夜訊號部分缺'
    lines.push(`${sev}${missStr} — 本次預測輸入僅 ${ic.present}/${ic.total},方向判讀宜保守`)
  }
}

// 台指期籌碼面偏向(純規則、僅供參考)——有資料才顯示,附主要因子與軋空警語。
{
  const bias = data.futuresChips?.bias
  if (bias && typeof bias.score === 'number') {
    const emoji = bias.score >= 20 ? '🔴' : bias.score <= -20 ? '🟢' : '⚪'
    // 取貢獻絕對值最大的兩個因子做「主因」摘要
    const top = [...(bias.components || [])]
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 2)
      .map(c => `${c.label} ${c.detail}`)
      .join('、')
    const cautionStr = bias.caution ? ` ⚠️${bias.caution}` : ''
    lines.push(`⚙️ 台指期籌碼偏向:${emoji}${bias.label}(${bias.score > 0 ? '+' : ''}${bias.score})${top ? ` · ${top}` : ''}${cautionStr} — 僅供參考`)
  }
}

// 雙訊號一致性:模型 vs 期貨籌碼(兩個獨立方向估計)。只在「一致」或「分歧」時提示,
// 一致=高信心、分歧=方向不明該保守;單邊(mixed)不洗版。
{
  const ag = data.prediction?.signal_agreement
  if (ag && (ag.state === 'agree' || ag.state === 'diverge')) {
    const icon = ag.state === 'agree' ? '✅' : '⚠️'
    lines.push(`${icon} 雙訊號${ag.state === 'agree' ? '一致' : '分歧'}:${ag.label} — ${ag.note}`)
  }
}

// 選股準確度:精選前10名 vs 全體(baseline)近N日勝率 —— 直接回答「選股準不準」。
// win_rate 在樣本 <10 時為 null(不顯示誤導數字);取最有資料的水平(5日優先)。
{
  const sa = data.strategyAccuracy
  const pick = g => {
    if (!g) return null
    for (const h of ['d5', 'd1', 'd10']) if (g[h]?.win_rate != null) return { h, ...g[h] }
    return null
  }
  const t = pick(sa?.top10)
  if (t) {
    const hLabel = { d1: '1日', d5: '5日', d10: '10日' }[t.h]
    const bw = sa?.baseline?.[t.h]?.win_rate
    const edge = bw != null
      ? ` · 全體 ${bw}%(前10名 ${t.win_rate - bw >= 0 ? '+' : ''}${Math.round((t.win_rate - bw) * 10) / 10}pp)`
      : ''
    const avg = t.avg_return_pct != null ? `、均報 ${t.avg_return_pct >= 0 ? '+' : ''}${t.avg_return_pct}%` : ''
    lines.push(`🎯 選股準確度(近${hLabel} ${t.total} 筆):前10名 勝率 ${t.win_rate}%${avg}${edge} — 追蹤中,樣本越多越準`)
  }
}

// 模型健檢:模型機率與它自己的輸入呈反向時示警(方向判讀先別採信)。正常則不洗版。
{
  const mh = data.modelHealth
  if (mh && mh.verdict === 'suspect_inverted') {
    const worst = (mh.features || []).filter(f => f.inverted).slice(0, 3)
      .map(f => `${f.label} ${f.corr > 0 ? '+' : ''}${f.corr}`).join('、')
    lines.push(`🩺 模型健檢:機率與美股隔夜訊號呈反向(${worst})— 部分可由「模型預測 5 日後、美股影響多在隔天」解釋,短線方向仍宜保守(樣本 ${mh.verdict_sample} 日${mh.low_sample ? ',仍在累積' : ''})`)
  }
}

// 今日精選評級品質:A/B/C/D 分佈 +(有資料時)各評級真實歷史勝率。只在有可操作精選時顯示。
{
  const gd = data.gradeDigest
  if (gd && gd.actionable > 0) {
    const c = gd.counts
    const realStr = gd.real
      ? ' · 真實勝率 ' + ['A', 'B', 'C'].filter(g => gd.real[g]).map(g => `${g}${gd.real[g].win_rate}%`).join('/')
      : ''
    lines.push(`🏅 精選品質:A${c.A}/B${c.B}/C${c.C}（可操作 ${gd.actionable} 檔、D${c.D} 只追蹤）${realStr}`)
  }
}

// 營收成長精選:進場訊號 + 月營收年增為正的較高勝率子集(rev_growth 濾網)。
// 附實測勝率對比,誠實標「樣本累積中、非保證」。
{
  const rg = data.revGrowthPicks
  if (rg && rg.total > 0) {
    const names = rg.items.slice(0, 5).map(i => `${i.stock_id}${i.name ? ' ' + i.name : ''}`).join('、')
    const edge = rg.edge
      ? `(此濾網回測勝率 ${rg.edge.filter_win}% vs 主帳戶 ${rg.edge.main_win}%,樣本 ${rg.edge.filter_trades}/${rg.edge.main_trades} 筆仍少)`
      : ''
    lines.push(`🎯 營收成長精選 ${rg.total} 檔${edge}:${names}${rg.total > 5 ? ' …' : ''} — 基本面有撐、回測勝率較高,可優先觀察(非保證)`)
  }
}

// 選股產業集中度:今日進場候選若高度集中單一產業 → 分散不足,只在示警時提醒。
{
  const pc = data.pickConcentration
  if (pc && pc.warn) {
    lines.push(`🧯 選股集中:今日精選 ${pc.total} 檔有 ${pc.top_count} 檔在【${pc.top_sector}】(${pc.top_share_pct}%)— 分散不足,該族群回檔會一起跌,留意產業風險`)
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
