// 自訂策略期貨預測 — 純函式策略引擎(無 React / 無 DOM / 無網路)。
//
// 目的:讓使用者「自己改策略」——把每天既有的盤前訊號(外資期貨未平倉、夜盤、
// 美股隔夜、技術面、模型機率、新聞情緒)當成可調權重的因子,即時算出台指期的
// 多空傾向,並用 output/prediction_history + 真實加權指數結果回測這組權重。
//
// 設計原則:
//   • 純函式、零副作用 —— 可被 node:test 直接單元測試(web/scripts/futures-strategy.test.mjs)
//   • 不動任何 Python、不呼叫任何下單/交易 API,只讀既有 data.json
//   • 缺資料的因子自動跳過(不塞 0 稀釋),並如實回報「用了幾個因子」
//   • 回測一律回報樣本數與覆蓋率;樣本少時由 UI 明示過擬合風險
//
// ⚠️ 這是規則式的傾向估計,不是投資建議、也不保證任何績效。

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d)
const pct1 = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`)

// ── 因子目錄 ────────────────────────────────────────────────────────────────
// signal = clamp((raw − center) / scale, −1, 1) × dir     (正 = 偏多)
// weight 為 0~100 的相對權重,最後對「有資料的因子」normalize。
export const FACTORS = [
  // 籌碼面
  { key: 'foreign_oi', label: '外資期貨淨部位', group: '籌碼', weight: 30, scale: 60000, center: 0, dir: 1,
    pick: (e) => num(e.market_data?.futures_net),
    fmt: (v) => `${v > 0 ? '淨多 +' : '淨空 '}${Math.round(v).toLocaleString()} 口`,
    hint: '淨空越重越偏空。想做「軋空反轉」就把方向切成逆向。' },
  { key: 'oi_trend', label: '外資部位趨勢(5日變化)', group: '籌碼', weight: 10, scale: 15000, center: 0, dir: 1,
    pick: (e) => num(e.derived?.oi_trend),
    fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString()} 口(${v > 0 ? '減空/加多' : '增空'})`,
    hint: '近 5 個交易日外資淨部位的變化量,看的是動能而非絕對值。' },
  { key: 'basis', label: '期現價差(基差)', group: '籌碼', weight: 10, scale: 80, center: 0, dir: 1,
    pick: (e) => num(e.derived?.basis),
    fmt: (v) => `${v >= 0 ? '正價差 +' : '逆價差 '}${Math.round(v)} 點`,
    hint: '只有今日有資料(歷史盤後基差未入庫),回測時此因子會自動略過。' },
  // 隔夜美股
  { key: 'sox_ret', label: '費城半導體 SOX 隔夜', group: '隔夜美股', weight: 15, scale: 0.015, center: 0, dir: 1,
    pick: (e) => num(e.market_data?.sox_ret), fmt: (v) => pct1(v),
    hint: '對台股權值股連動最直接的隔夜指標。' },
  { key: 'tsm_adr_ret', label: '台積電 ADR 隔夜', group: '隔夜美股', weight: 12, scale: 0.02, center: 0, dir: 1,
    pick: (e) => num(e.market_data?.tsm_adr_ret), fmt: (v) => pct1(v),
    hint: 'ADR 溢價/折價隔天常直接反映在台積電開盤。' },
  { key: 'nasdaq_ret', label: 'Nasdaq 隔夜', group: '隔夜美股', weight: 10, scale: 0.01, center: 0, dir: 1,
    pick: (e) => num(e.market_data?.nasdaq_ret), fmt: (v) => pct1(v) },
  { key: 'vix', label: 'VIX 恐慌指數', group: '隔夜美股', weight: 10, scale: 8, center: 18, dir: -1,
    pick: (e) => num(e.market_data?.vix), fmt: (v) => v.toFixed(1),
    hint: '以 18 為中心,越高越偏空(dir = 逆向)。' },
  { key: 'night_change', label: '台指夜盤點數', group: '隔夜美股', weight: 12, scale: 150, center: 0, dir: 1,
    pick: (e) => num(e.market_data?.night_change), fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} 點` },
  // 技術面
  { key: 'taiex_rsi', label: '加權指數 RSI', group: '技術面', weight: 5, scale: 25, center: 50, dir: 1,
    pick: (e) => num(e.market_data?.taiex_rsi), fmt: (v) => v.toFixed(1),
    hint: '順向 = 追動能;逆向 = 超買放空、超賣做多的逆勢派。' },
  { key: 'macd_hist', label: 'MACD 柱狀體', group: '技術面', weight: 5, scale: 300, center: 0, dir: 1,
    pick: (e) => num(e.market_data?.macd_hist), fmt: (v) => v.toFixed(0) },
  { key: 'dist_ma20', label: '距 20 日均線', group: '技術面', weight: 5, scale: 5, center: 0, dir: 1,
    pick: (e) => num(e.market_data?.dist_ma20), fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%` },
  { key: 'dist_ma60', label: '距 60 日均線', group: '技術面', weight: 0, scale: 10, center: 0, dir: 1,
    pick: (e) => num(e.market_data?.dist_ma60), fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%` },
  { key: 'taiex_ret_5d', label: '加權近 5 日報酬', group: '技術面', weight: 0, scale: 5, center: 0, dir: 1,
    pick: (e) => num(e.market_data?.taiex_ret_5d), fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%` },
  // 模型 / 情緒
  { key: 'xgb_prob', label: 'XGBoost 模型機率', group: '模型與情緒', weight: 20, scale: 0.2, center: 0.5, dir: 1,
    pick: (e) => num(e.xgb_prob_up), fmt: (v) => `${(v * 100).toFixed(1)}%`,
    hint: '既有模型的看多機率。權重調 0 就是完全不看模型的純籌碼策略。' },
  { key: 'news_impact', label: '新聞情緒衝擊', group: '模型與情緒', weight: 5, scale: 0.5, center: 0, dir: 1,
    pick: (e) => num(e.news_sentiment?.market_impact), fmt: (v) => v.toFixed(2) },
  { key: 'disposition', label: '處置股家數', group: '模型與情緒', weight: 0, scale: 40, center: 0, dir: -1,
    pick: (e) => num(e.market_data?.disposition_count), fmt: (v) => `${Math.round(v)} 檔`,
    hint: '過熱指標,家數越多代表投機情緒越滿(預設逆向)。' },
]

export const FACTOR_MAP = Object.fromEntries(FACTORS.map(f => [f.key, f]))
export const FACTOR_GROUPS = [...new Set(FACTORS.map(f => f.group))]

// ── 策略物件 ────────────────────────────────────────────────────────────────
export function makeDefaultStrategy(name = '我的策略') {
  return normalizeStrategy({
    name,
    horizon: 1,
    longThreshold: 20,
    shortThreshold: -20,
    minFactors: 3,
    costBps: 0,
    factors: Object.fromEntries(FACTORS.map(f => [f.key, {
      weight: f.weight, scale: f.scale, center: f.center, dir: f.dir, enabled: f.weight > 0,
    }])),
  })
}

// 補齊/夾限所有欄位 —— 讀 localStorage 或匯入 JSON 時一律先過這關。
export function normalizeStrategy(s) {
  const base = s && typeof s === 'object' ? s : {}
  const factors = {}
  for (const f of FACTORS) {
    const c = (base.factors || {})[f.key] || {}
    const scale = num(c.scale)
    factors[f.key] = {
      weight:  clamp(num(c.weight) ?? f.weight, 0, 100),
      scale:   scale && scale !== 0 ? Math.abs(scale) : f.scale,
      center:  num(c.center) ?? f.center,
      dir:     num(c.dir) === -1 ? -1 : 1,
      enabled: c.enabled == null ? f.weight > 0 : !!c.enabled,
    }
  }
  const long = clamp(num(base.longThreshold) ?? 20, 0, 100)
  const short = clamp(num(base.shortThreshold) ?? -20, -100, 0)
  // 「最少因子數」不能超過實際啟用的因子數,否則策略永遠判「資料不足」而全無訊號。
  const enabledCount = FACTORS.filter(f => factors[f.key].enabled && factors[f.key].weight > 0).length
  return {
    name: typeof base.name === 'string' && base.name.trim() ? base.name.trim().slice(0, 40) : '我的策略',
    horizon: clamp(Math.round(num(base.horizon) ?? 1), 1, 20),
    longThreshold: long,
    shortThreshold: short,
    minFactors: clamp(Math.round(num(base.minFactors) ?? 3), 1, Math.max(1, enabledCount)),
    costBps: clamp(num(base.costBps) ?? 0, 0, 100),
    factors,
  }
}

// 預設策略範本 —— 每個都只是「權重組合」,使用者可再自行微調。
export const PRESETS = [
  { id: 'balanced', name: '均衡型', desc: '籌碼 / 隔夜 / 技術 / 模型 各佔一角,接近系統原本的偏向分數',
    patch: {} },
  { id: 'chips', name: '籌碼派', desc: '只看外資期貨未平倉、部位趨勢與基差,完全不看模型',
    patch: { factors: { foreign_oi: 55, oi_trend: 25, basis: 20 }, only: true, minFactors: 2, longThreshold: 15, shortThreshold: -15 } },
  { id: 'overnight', name: '隔夜動能派', desc: '費半 / ADR / Nasdaq / 夜盤主導,做隔日開盤延續',
    patch: { factors: { sox_ret: 30, tsm_adr_ret: 25, nasdaq_ret: 15, night_change: 20, vix: 10 }, only: true, horizon: 1 } },
  { id: 'contrarian', name: '逆勢派', desc: 'RSI、距均線、外資極端部位全部逆向 —— 賭均值回歸',
    patch: { factors: { taiex_rsi: 30, dist_ma20: 25, foreign_oi: 30, vix: 15 }, only: true,
      dirs: { taiex_rsi: -1, dist_ma20: -1, foreign_oi: -1, vix: 1 }, horizon: 5, longThreshold: 25, shortThreshold: -25 } },
  { id: 'model', name: '模型優先', desc: '以既有 XGBoost 機率為主,籌碼與夜盤只做輔助確認',
    patch: { factors: { xgb_prob: 60, foreign_oi: 15, night_change: 15, sox_ret: 10 }, only: true } },
]

export function applyPreset(presetId, current) {
  const p = PRESETS.find(x => x.id === presetId)
  const base = makeDefaultStrategy(current?.name || '我的策略')
  if (!p) return base
  const patch = p.patch || {}
  const out = { ...base, name: p.name }
  if (patch.horizon) out.horizon = patch.horizon
  if (patch.longThreshold != null) out.longThreshold = patch.longThreshold
  if (patch.shortThreshold != null) out.shortThreshold = patch.shortThreshold
  if (patch.minFactors != null) out.minFactors = patch.minFactors
  if (patch.factors) {
    for (const f of FACTORS) {
      const w = patch.factors[f.key]
      if (w != null) out.factors[f.key] = { ...out.factors[f.key], weight: w, enabled: true }
      else if (patch.only) out.factors[f.key] = { ...out.factors[f.key], weight: 0, enabled: false }
    }
  }
  for (const [k, d] of Object.entries(patch.dirs || {})) {
    if (out.factors[k]) out.factors[k] = { ...out.factors[k], dir: d }
  }
  return normalizeStrategy(out)
}

// ── 打分 ────────────────────────────────────────────────────────────────────
// 回 { score(−100~100), label, direction(1/0/-1), components[], used, insufficient }
export function scoreEntry(entry, strategy) {
  const st = normalizeStrategy(strategy)
  const components = []
  let weighted = 0, wSum = 0
  for (const f of FACTORS) {
    const cfg = st.factors[f.key]
    if (!cfg.enabled || cfg.weight <= 0) continue
    const raw = entry ? f.pick(entry) : null
    if (raw == null) { components.push({ key: f.key, label: f.label, group: f.group, missing: true }); continue }
    const signal = clamp((raw - cfg.center) / cfg.scale, -1, 1) * cfg.dir
    const w = cfg.weight / 100
    weighted += signal * w
    wSum += w
    components.push({
      key: f.key, label: f.label, group: f.group, missing: false,
      raw: round(raw, 4), signal: round(signal, 3), weight: cfg.weight,
      contribution: round(signal * w, 4), detail: f.fmt(raw), dir: cfg.dir,
    })
  }
  const used = components.filter(c => !c.missing).length
  if (wSum === 0) return { score: null, label: '資料不足', direction: 0, components, used, insufficient: true }
  const score = Math.round((weighted / wSum) * 100)
  // 每個因子對「最終分數」的實際貢獻(已 normalize),讓長條圖加總 = score。
  for (const c of components) {
    if (!c.missing) c.share = round((c.contribution / wSum) * 100, 1)
  }
  const insufficient = used < st.minFactors
  const direction = insufficient ? 0 : score >= st.longThreshold ? 1 : score <= st.shortThreshold ? -1 : 0
  const label = insufficient ? '資料不足' : direction === 1 ? '偏多' : direction === -1 ? '偏空' : '中性'
  return { score, label, direction, components, used, insufficient }
}

// ── 樣本組裝 ────────────────────────────────────────────────────────────────
// history: data.json.predictionHistory(新→舊或舊→新皆可)
// outcomes: data.json.realOutcomes.prediction(含 taiex_close / taiex_pct)
// 回傳「日期升冪」的樣本陣列,並補上 derived.oi_trend 與實際報酬 pct。
export function buildSamples({ history = [], prediction = null, futuresChips = null, outcomes = [] } = {}) {
  const byDate = new Map()
  const add = (e) => {
    if (!e || !e.date) return
    const prev = byDate.get(e.date)
    byDate.set(e.date, prev ? { ...prev, ...e } : { ...e })
  }
  for (const h of history) add(h)
  if (prediction) add(prediction)     // 今日盤前(可能還沒進 history)

  const outMap = new Map()
  for (const o of outcomes || []) if (o?.date) outMap.set(o.date, o)

  const samples = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const oiSeries = []
  for (const s of samples) {
    s.derived = s.derived || {}
    const oi = num(s.market_data?.futures_net)
    oiSeries.push(oi)
    if (oi != null) {
      // 往回找最近一個「約 5 個交易日前」的有效值
      const back = oiSeries.slice(0, -1).filter(v => v != null)
      const ref = back.length >= 5 ? back[back.length - 5] : back.length ? back[0] : null
      s.derived.oi_trend = ref == null ? null : oi - ref
    }
    const o = outMap.get(s.date)
    s.pct = o ? num(o.taiex_pct) : null
    s.close = o ? num(o.taiex_close) : null
    s.actual_up = o ? (typeof o.actual_up === 'boolean' ? o.actual_up : null) : null
  }
  // 今日的基差只有 futuresChips 有(歷史沒有),掛到最後一筆。
  const basis = num(futuresChips?.basis?.basis)
  if (basis != null && samples.length) {
    const last = samples[samples.length - 1]
    last.derived = { ...last.derived, basis }
  }
  return samples
}

// h 個交易日的前瞻報酬(含當日):samples[i..i+h-1] 的 pct 連乘。
function forwardReturn(samples, i, h) {
  let acc = 1
  for (let k = i; k < i + h; k++) {
    const p = samples[k]?.pct
    if (p == null) return null
    acc *= 1 + p
  }
  return acc - 1
}

function maxDrawdown(curve) {
  let peak = -Infinity, dd = 0
  for (const p of curve) {
    peak = Math.max(peak, p.equity)
    dd = Math.min(dd, p.equity / peak - 1)
  }
  return dd
}

// ── 回測 ────────────────────────────────────────────────────────────────────
// 部位模型:訊號當天進場,持有 horizon 個交易日 → 任一天的實際部位是最近
// horizon 天訊號的平均(重疊視窗),日報酬 = 部位 × 當日漲跌 − 換倉成本。
export function backtest(samples, strategy) {
  const st = normalizeStrategy(strategy)
  const h = st.horizon
  const rows = []
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    const sc = scoreEntry(s, st)
    const fwd = forwardReturn(samples, i, h)
    rows.push({
      date: s.date, score: sc.score, direction: sc.direction, label: sc.label,
      used: sc.used, pct: s.pct, fwd,
      modelDir: num(s.xgb_prob_up) == null ? 0 : (s.xgb_prob_up >= 0.5 ? 1 : -1),
    })
  }
  return summarize(rows, st)
}

function summarize(rows, st) {
  const h = st.horizon
  const scored = rows.filter(r => r.direction !== 0 && r.fwd != null)
  const hits = scored.filter(r => (r.fwd > 0 ? 1 : -1) === r.direction)
  const longs = scored.filter(r => r.direction === 1)
  const shorts = scored.filter(r => r.direction === -1)
  const dirRets = scored.map(r => r.direction * r.fwd)
  const wins = dirRets.filter(v => v > 0), losses = dirRets.filter(v => v <= 0)

  // 逐日部位曲線(重疊視窗)
  const curve = []
  let equity = 1, prevPos = 0
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].pct == null) continue
    let sum = 0, cnt = 0
    for (let k = Math.max(0, i - h + 1); k <= i; k++) { sum += rows[k].direction; cnt++ }
    const pos = cnt ? sum / cnt : 0
    const cost = Math.abs(pos - prevPos) * (st.costBps / 10000)
    const ret = pos * rows[i].pct - cost
    equity *= 1 + ret
    prevPos = pos
    curve.push({ date: rows[i].date, equity: round(equity, 6), pos: round(pos, 3), ret: round(ret, 6) })
  }

  const modelScored = rows.filter(r => r.modelDir !== 0 && r.fwd != null)
  const modelHits = modelScored.filter(r => (r.fwd > 0 ? 1 : -1) === r.modelDir)
  const withPct = rows.filter(r => r.pct != null)
  const hold = withPct.reduce((acc, r) => acc * (1 + r.pct), 1) - 1

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
  const dailyRets = curve.map(c => c.ret)
  const mu = mean(dailyRets)
  const sd = dailyRets.length > 1
    ? Math.sqrt(dailyRets.reduce((a, r) => a + (r - mu) ** 2, 0) / (dailyRets.length - 1))
    : null

  const tradableDays = rows.filter(r => r.fwd != null).length
  return {
    horizon: h,
    days: rows.length,
    tradableDays,                                   // 有實際結果、真的能評分的天數
    scorable: rows.filter(r => r.direction !== 0).length,
    samples: scored.length,
    coverage: tradableDays ? round(scored.length / tradableDays, 3) : null,
    hits: hits.length,
    hitRate: scored.length ? round(hits.length / scored.length, 4) : null,
    long: { n: longs.length, hits: longs.filter(r => r.fwd > 0).length },
    short: { n: shorts.length, hits: shorts.filter(r => r.fwd <= 0).length },
    avgDirRet: round(mean(dirRets), 5),
    avgWin: round(mean(wins), 5),
    avgLoss: round(mean(losses), 5),
    totalRet: curve.length ? round(equity - 1, 5) : null,
    maxDrawdown: curve.length ? round(maxDrawdown(curve), 4) : null,
    volatility: sd == null ? null : round(sd * Math.sqrt(252), 4),
    sharpe: sd ? round((mu * 252) / (sd * Math.sqrt(252)), 2) : null,
    curve,
    hold: round(hold, 5),
    model: { n: modelScored.length, hits: modelHits.length, hitRate: modelScored.length ? round(modelHits.length / modelScored.length, 4) : null },
    rows,
  }
}

// 走勢外樣本檢查:前 ratio 當訓練、後段當驗證。命中率若只在訓練段好 = 過擬合。
export function walkForward(samples, strategy, ratio = 0.7) {
  const n = samples.length
  if (n < 12) return null
  const cut = Math.max(6, Math.floor(n * ratio))
  const train = backtest(samples.slice(0, cut), strategy)
  const test = backtest(samples.slice(cut), strategy)
  return {
    cutDate: samples[cut]?.date || null,
    train: { n: train.samples, hitRate: train.hitRate, totalRet: train.totalRet },
    test:  { n: test.samples,  hitRate: test.hitRate,  totalRet: test.totalRet },
  }
}

// ── 權重最佳化(隨機搜尋) ────────────────────────────────────────────────────
// 固定種子的 mulberry32 → 同樣輸入必得同樣結果(可測、可重現)。
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 每個目標都先要求最低樣本數 —— 否則隨機搜尋會挑出「只出 3 次訊號、剛好全中」
// 這種毫無統計意義的權重組合。不足門檻一律給最差分。
const OBJECTIVES = {
  hit:    (r, min) => (r.samples >= min && r.hitRate != null ? r.hitRate : -1),
  ret:    (r, min) => (r.samples >= min && r.totalRet != null ? r.totalRet : -Infinity),
  sharpe: (r, min) => (r.samples >= min && r.sharpe != null ? r.sharpe : -Infinity),
}

// 樣本數低於此值的最佳化結果,一律標記為高過擬合風險(由 UI 明示警告)。
export const OVERFIT_SAMPLE_FLOOR = 40

// 只搜尋「已啟用因子」的權重(scale / center / dir / 門檻維持使用者設定)。
export function optimize(samples, strategy, { iterations = 400, objective = 'hit', seed = 42, minSamples } = {}) {
  const st = normalizeStrategy(strategy)
  const keys = FACTORS.filter(f => st.factors[f.key].enabled).map(f => f.key)
  if (!keys.length) return null
  // 至少要在「可評分天數」的一半出訊號,且不少於 10 天 —— 逼最佳化去找「常出
  // 訊號且會贏」的權重,而不是靠極少數幸運樣本沖高命中率。
  const baseResult = backtest(samples, st)
  const tradable = baseResult.rows.filter(r => r.fwd != null).length
  const minN = minSamples ?? Math.max(10, Math.round(tradable * 0.5))
  const obj = (r) => (OBJECTIVES[objective] || OBJECTIVES.hit)(r, minN)
  const rnd = mulberry32(seed)
  let best = { strategy: st, result: baseResult }
  best.value = obj(best.result)
  const baseValue = best.value
  for (let i = 0; i < iterations; i++) {
    const factors = { ...st.factors }
    for (const k of keys) factors[k] = { ...factors[k], weight: Math.round(rnd() * 100) }
    if (keys.every(k => factors[k].weight === 0)) continue
    const cand = normalizeStrategy({ ...st, factors })
    const result = backtest(samples, cand)
    const value = obj(result)
    if (value > best.value) best = { strategy: cand, result, value }
  }
  return {
    ...best, iterations, objective, minSamples: minN,
    improved: best.value > baseValue,
    overfitRisk: (best.result?.samples ?? 0) < OVERFIT_SAMPLE_FLOOR,
  }
}

// ── 儲存 / 匯出 ─────────────────────────────────────────────────────────────
export const STORAGE_KEY = 'futures_strategy_lab_v1'

export function exportStrategy(strategy) {
  const st = normalizeStrategy(strategy)
  const slim = { name: st.name, horizon: st.horizon, longThreshold: st.longThreshold, shortThreshold: st.shortThreshold, minFactors: st.minFactors, costBps: st.costBps, factors: {} }
  for (const f of FACTORS) {
    const c = st.factors[f.key]
    if (c.enabled && c.weight > 0) slim.factors[f.key] = { weight: c.weight, scale: c.scale, center: c.center, dir: c.dir, enabled: true }
  }
  return JSON.stringify(slim, null, 2)
}

export function importStrategy(text) {
  try {
    const parsed = JSON.parse(String(text))
    const st = normalizeStrategy(parsed)
    // 匯入時只保留檔案裡明確列出的因子,其餘關閉(避免預設權重悄悄混進來)
    const listed = new Set(Object.keys(parsed?.factors || {}))
    for (const f of FACTORS) {
      if (!listed.has(f.key)) st.factors[f.key] = { ...st.factors[f.key], enabled: false, weight: 0 }
    }
    return { ok: true, strategy: st }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
