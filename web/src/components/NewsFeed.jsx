import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'

const CUSTOM_RULES_KEY = 'news_custom_rules'
const CUSTOM_COLORS = ['#58a6ff', '#3fb950', '#ffa657', '#f85149', '#bc8cff', '#f9c74f', '#79c0ff', '#56d364']
const CUSTOM_ICONS = ['📌', '⭐', '🏭', '💡', '🔥', '🏗️', '💰', '🎯', '🔋', '🚀', '🌐', '🏆']

const REFRESH_INTERVAL = 5 * 60 * 1000   // 5 min
const NEW_BADGE_MS     = 30 * 60 * 1000  // items < 30 min old get NEW badge

function loadCustomRules() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_RULES_KEY) || '[]') } catch { return [] }
}
function saveCustomRules(rules) {
  localStorage.setItem(CUSTOM_RULES_KEY, JSON.stringify(rules))
}

const KEYWORD_RULES = [
  { patterns: ['台積電', 'TSMC', '2330'], tag: '台積電', color: 'var(--accent)', icon: '🏭' },
  { patterns: ['半導體', 'IC', '晶片', '封測', '晶圓', 'CoWoS', '先進封裝'], tag: '半導體', color: 'var(--purple)', icon: '🔬' },
  { patterns: ['AI', '人工智慧', 'ChatGPT', 'GPU', '輝達', 'NVIDIA', 'AMD', '大模型'], tag: 'AI', color: 'var(--green)', icon: '🤖' },
  { patterns: ['外資', '三大法人', '投信', '自營', '法人'], tag: '外資法人', color: 'var(--yellow)', icon: '🏦' },
  { patterns: ['Fed', '聯準會', '升息', '降息', '利率', 'FOMC', '央行'], tag: '貨幣政策', color: 'var(--orange)', icon: '🏛️' },
  { patterns: ['期貨', '選擇權', '台指', 'PCR', '夜盤', '結算'], tag: '衍生品', color: '#8b8bff', icon: '📉' },
  { patterns: ['生技', '醫療', '新藥', 'FDA', '醫材', '解盲', '臨床'], tag: '生技醫療', color: 'var(--red)', icon: '💊' },
  { patterns: ['金融', '銀行', '保險', '壽險', '金控', '券商'], tag: '金融', color: '#f9c74f', icon: '💳' },
  { patterns: ['美股', '納指', '道瓊', '標普', '紐約', '費半', '那斯達克'], tag: '美股', color: 'var(--orange)', icon: '🌎' },
  { patterns: ['供應鏈', '缺貨', '庫存', '原物料', '拉貨', '去化'], tag: '供應鏈', color: '#a8a8a8', icon: '📦' },
  { patterns: ['電動車', 'EV', 'Tesla', '特斯拉', '電池', '充電'], tag: '電動車', color: 'var(--green)', icon: '🚗' },
  { patterns: ['匯率', '美元', '日圓', '新台幣', '外匯', '貶值', '升值'], tag: '匯率', color: '#a8a8a8', icon: '💱' },
  { patterns: ['法說會', '財報', 'EPS', '營收', '獲利', '毛利', '業績', '超預期', '符合預期', '下修財測'], tag: '基本面', color: 'var(--accent)', icon: '📊' },
  { patterns: ['大盤', '加權', '指數', '萬點', '封關', '開盤', '收盤'], tag: '大盤', color: 'var(--accent)', icon: '📈' },
  { patterns: ['砍單', '庫存壓力', '去化庫存', '需求疲軟', '利空出盡', '下修目標', '裁員'], tag: '利空風險', color: 'var(--ios-red)', icon: '⚠️' },
  { patterns: ['據傳', '消息人士', '傳言', '傳出'], tag: '未確認', color: '#8b8bff', icon: '🔍' },
]

const STOCK_CODE_RE = /\b([2-9]\d{3})\b/g

// ── Feature 6: News keyword highlight ────────────────────────────────────────
const HIGHLIGHT_RULES = [
  { pattern: /漲停/g,            color: 'var(--ios-red)' },
  { pattern: /跌停/g,            color: 'var(--ios-green)' },
  { pattern: /外資/g,            color: 'var(--ios-yellow)' },
  { pattern: /AI|NVIDIA|輝達/g,  color: 'var(--ios-purple)' },
]

function highlightTitle(title, tags = [], customRules = []) {
  if (!title) return title
  // Build a list of (start, end, color) spans
  const spans = []

  // Stock codes
  const scRe = /\b([2-9]\d{3})\b/g
  let m
  while ((m = scRe.exec(title)) !== null) {
    const n = parseInt(m[1], 10)
    if (n >= 2020 && n <= 2035) continue // skip years
    spans.push({ start: m.index, end: m.index + m[0].length, color: 'var(--ios-blue)', text: m[0] })
  }

  // Built-in keyword rules
  for (const { pattern, color } of HIGHLIGHT_RULES) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
    re.lastIndex = 0
    while ((m = re.exec(title)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, color, text: m[0] })
    }
  }

  // Tag-matched keyword rules from KEYWORD_RULES + customRules
  const allRules = [...KEYWORD_RULES, ...customRules]
  for (const rule of allRules) {
    if (!tags.includes(rule.tag)) continue
    for (const pat of rule.patterns) {
      const idx = title.indexOf(pat)
      if (idx !== -1) {
        spans.push({ start: idx, end: idx + pat.length, color: rule.color, text: pat })
      }
    }
  }

  if (spans.length === 0) return title

  // Sort spans by start, deduplicate (first wins)
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged = []
  let cursor = 0
  for (const sp of spans) {
    if (sp.start < cursor) continue // skip overlapping
    merged.push(sp)
    cursor = sp.end
  }

  // Build React nodes
  const nodes = []
  let pos = 0
  for (const sp of merged) {
    if (sp.start > pos) nodes.push(title.slice(pos, sp.start))
    nodes.push(
      <span key={sp.start} style={{ color: sp.color, fontWeight: 700 }}>{sp.text}</span>
    )
    pos = sp.end
  }
  if (pos < title.length) nodes.push(title.slice(pos))
  return nodes
}

const QUERIES = [
  { q: '台灣股市 大盤 指數 when:1d' },
  { q: '台積電 2330 TSMC when:1d' },
  { q: '外資 三大法人 台指期貨 when:1d' },
  { q: '美股 那斯達克 費半 道瓊 when:1d' },
  { q: 'AI 人工智慧 晶片 GPU NVIDIA when:1d' },
  { q: '半導體 CoWoS 先進封裝 when:1d' },
  { q: '生技 醫療 新藥 FDA when:1d' },
  { q: '聯準會 Fed 降息 升息 when:1d' },
]

// Direct RSS sources — fetched in addition to Google News search
const DIRECT_RSS = [
  { url: 'https://money.udn.com/rssfeed/news/1001/5591', name: '經濟日報' },
  { url: 'https://www.moneydj.com/RSS/news.aspx',        name: 'MoneyDJ' },
  { url: 'https://news.cnyes.com/rss/category/tw_stock', name: '鉅亨網' },
]

async function fetchRSS(rssUrl) {
  // Primary: rss2json.com with cache-buster (changes every 5 min to force fresh fetch)
  const bust = Math.floor(Date.now() / 300000)
  const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}&count=10&_t=${bust}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 7000)
  try {
    const r = await fetch(apiUrl, { signal: ctrl.signal })
    if (r.ok) {
      const j = await r.json()
      if (j.status === 'ok' && j.items?.length) {
        // Convert rss2json format to our internal format
        return j.items.map(item => ({
          title: item.title || '',
          url: item.link || '',
          source: j.feed?.title || '',
          published: item.pubDate || '',
          summary: (item.description || '').replace(/<[^>]+>/g, '').slice(0, 300),
        }))
      }
    }
  } catch (_) { /* fall through to proxy */ } finally {
    clearTimeout(timer)
  }
  // Fallback: corsproxy.io with raw RSS
  const ctrl2 = new AbortController()
  const timer2 = setTimeout(() => ctrl2.abort(), 6000)
  try {
    const r2 = await fetch(`https://corsproxy.io/?${encodeURIComponent(rssUrl)}&_t=${Date.now()}`, { signal: ctrl2.signal })
    if (r2.ok) {
      const xml = await r2.text()
      if (xml.includes('<item>')) return parseRSS(xml)
    }
  } catch (_) { /* give up */ } finally {
    clearTimeout(timer2)
  }
  return []
}

function detectTags(title, summary = '', customRules = []) {
  const text = title + ' ' + summary
  const matched = []
  for (const rule of [...KEYWORD_RULES, ...customRules]) {
    if (rule.patterns.some(p => text.includes(p))) {
      matched.push(rule.tag)
    }
  }
  return matched.length ? matched : ['其他']
}

function generateOutline(title, summary) {
  if (!summary || summary.length < 30) return null
  // Split into sentences by Chinese/English punctuation
  const sentences = summary
    .split(/[。！？；…\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 8)
  if (sentences.length === 0) return null

  // Tag key sentences with type indicators
  const tagged = sentences.map(s => {
    if (/漲[停幅]|上漲|大漲|創高|突破|走強|攀升/.test(s)) return { type: 'up', text: s }
    if (/跌[停幅]|下跌|大跌|重挫|走弱|承壓|下修/.test(s)) return { type: 'down', text: s }
    if (/外資|投信|自營|法人|機構/.test(s)) return { type: 'inst', text: s }
    if (/\d+[\.,]?\d*\s*億|兆|億元|萬張/.test(s)) return { type: 'num', text: s }
    if (/預估|預期|目標|看好|展望|樂觀|保守/.test(s)) return { type: 'fwd', text: s }
    return { type: 'info', text: s }
  })

  return tagged.slice(0, 5)
}

// Negation check: does a word appear right before the target within 6 chars?
function _hasNegation(title, pattern) {
  const m = title.match(pattern)
  if (!m) return false
  const idx = title.indexOf(m[0])
  const before = title.slice(Math.max(0, idx - 6), idx)
  return /不|未|沒有|並非|無法|非|否|未能/.test(before)
}

function generateHint(title, tags, summary = '') {
  const text = title + ' ' + (summary || '')

  // ── 🚨 高風險陷阱優先判斷 ─────────────────────────────────────────
  // 未確認消息：「據傳」「傳出」可能是誘多
  if (/據傳|傳出|傳言|消息人士|據悉|疑似/.test(title))
    return '🔍 消息來源未經官方確認，謹防「傳言利多、事實利空」操作，等官方公告再行動'

  // 符合預期 → 利多出盡
  if (/法說會|財報|EPS|獲利/.test(title) && /符合預期|如預期|達預期|達成共識|持平/.test(text))
    return '⚠️ 業績「符合預期」＝利多已定價。法人慣用模式：法說前拉高→符合預期→出貨，謹防追高'

  // 外資/法人高位調節
  if (/外資.*(?:獲利回吐|調節|減持|逢高)|法人.*逢高/.test(title))
    return '⚠️ 法人高位調節，籌碼面壓力浮現，漲多後的調節往往早於散戶感知'

  // 砍單/庫存惡化
  if (/砍單|庫存壓力|去化.*庫存|存貨(?:增加|激增)|需求疲軟|客戶去化/.test(title))
    return '📉 砍單或庫存惡化訊號，景氣能見度下降，ASP（平均售價）跟著承壓，謹慎現有部位'

  // 利多連發（可能出貨配合）
  if (/再度|再次|持續(?:買超|利多|創高)|連日創高|接連利多/.test(title))
    return '🔍 利多訊息連發，反而需警惕：主力出貨前常製造噪音。確認法人持倉是否同步增加'

  // ── 🚀 高可信度利多 ───────────────────────────────────────────────
  // 業績超預期（最強信號）
  if (/EPS.*超預期|獲利.*超預期|超越.*預期|遠超|法說.*上調|目標價.*上調|大幅上修/.test(title))
    return '🚀 業績超乎市場預期（預期差為正），追蹤後續法人是否同步上調評等，量能確認後可持股'

  // 三大法人共識買超（最可信的籌碼面訊號）
  if (/三大法人.*買超|外資投信.*同買|外資投信自營.*同向|法人同步/.test(title))
    return '💰 三大法人共識買超：外資+投信+自營方向一致，歷史勝率最高（約92%），可跟進'

  // 外資連買多日（有延續性）
  if (/外資連買.*[5-9]\d*日|外資.*連續買超.*[5-9]|外資.*連[5-9]/.test(title))
    return '💰 外資連買5日以上，屬結構性佈局而非短線戰術，籌碼面支撐較穩定'

  // 外資空單大幅縮減
  if (/外資.*空單.*(?:大幅縮減|大減|回補|顯著縮)|空單.*大減/.test(title))
    return '✅ 外資空頭大幅縮倉，軋空行情可能展開，但確認是否為真正轉向而非短暫回補'

  // 結構性大訂單
  if (/多年.*合約|(?:百億|千億).*訂單|長期.*供應|大客戶.*供應鏈|入選.*供應商/.test(title))
    return '💰 結構性長期訂單，確定性高，屬業績驅動題材（非短期情緒），可中期持股'

  // FDA正式核准
  if (/FDA.*正式核准|獲FDA.*批准|取得.*藥證/.test(title))
    return '💊 FDA正式核准落地，確認適應症範圍是否完整（受限 vs 全適應症），範圍越廣持股越安心'

  // ── 📊 需要判讀的事件性新聞 ────────────────────────────────────────
  // 外資買超（一般，確認延續性）
  if (/外資.*買超|外資連買/.test(title) && !_hasNegation(title, /買超|連買/)) {
    const streakMatch = title.match(/連買.*?(\d+)/)
    const days = streakMatch ? parseInt(streakMatch[1]) : 0
    if (days >= 3) return '💰 外資連買3日以上，信號可信度升高；連買越久（5+日）結構性越強'
    return '🔍 外資單日買超：需觀察是否延續（1-2日買超為戰術性，不宜過度解讀）'
  }

  // 外資賣超
  if (/外資.*賣超|外資連賣/.test(title))
    return '⚠️ 外資賣壓出現，觀察是否連續多日——連賣3日以上才代表趨勢性撤退'

  // 外資空單增加
  if (/外資.*空單.*增加|空單.*擴大|外資.*放空/.test(title))
    return '⚠️ 外資空頭部位擴張，指數短線承壓，注意「軋空反彈」和「趨勢做空」的不同'

  // 法說會（尚未落幕）
  if (/法說會/.test(title) && !/結束|落幕|閉幕/.test(title))
    return '📋 法說前：業績預期正在形成。專業做法是法說前輕倉，等指引確認後再加碼'

  // 法說會結束 → 指引方向關鍵
  if (/法說會.*(?:結束|落幕)|法說.*指引/.test(title)) {
    if (/上調|上修|樂觀|看好|超越/.test(text)) return '📋 法說指引正面、優於預期，可持股等待法人評等跟進'
    if (/保守|下調|謹慎|低於|下修/.test(text)) return '⚠️ 法說指引保守，低於市場預期=利多出盡，建議減倉或出場'
    return '📋 法說結束，觀察隔日成交量：放量上漲=延續；爆量不漲=出貨訊號'
  }

  // 財報超預期
  if (/財報|EPS/.test(title) && /超預期|優於|驚喜|大幅成長/.test(text))
    return '📊 業績驚喜，先確認股價是否已提前上漲——「先漲再公告」代表已被提前消化，追高風險高'

  // 解盲
  if (/解盲|臨床.*成功|試驗.*通過/.test(title))
    return '💊 解盲消息：股價在試驗結果公開前是否已大漲？先漲=主力提前知悉=追高陷阱。觀察3日再行動'

  // 一般訂單
  if (/接單|拿下.*訂單|獲得.*訂單/.test(title))
    return '📦 訂單消息：一次性訂單（短線炒1-2周）vs 多年期合約（結構性利多）——確認訂單性質再決策'

  // 轉盈
  if (/由虧轉盈|轉虧為盈|轉盈/.test(title))
    return '📈 損益改善，確認是否為本業結構性轉變，而非匯兌/處分資產等一次性收益'

  // 台幣
  if (/台幣.*(?:貶|走弱)|匯率.*貶/.test(title))
    return '💱 台幣走弱，出口業者帳面受惠，但需看企業避險比例——未避險才是真正受惠'
  if (/台幣.*(?:升|走強)|匯率.*升/.test(title))
    return '💱 台幣走強，注意美元收入佔比高的出口企業（台積電、鴻海等）匯損影響下季財報'

  // 降息
  if (/(?:Fed|聯準會|央行).*降息|降息.*(?:確定|宣布|落地|碼)/.test(title))
    return '✅ 降息落地，資金成本下降，科技成長股、高股息股受惠，但傳導至實體經濟需3-6個月'

  // 升息/鷹派
  if (/升息|利率上升|鷹派|higher for longer/i.test(title))
    return '💸 鷹派立場，資金成本上升，高本益比科技股估值承壓，注意評估修正幅度'

  // 漲幅（最後才判，需排除否定）
  if (/上漲|大漲|創高|走強/.test(title) && !_hasNegation(title, /上漲|大漲|創高|走強/))
    return '📈 市場正面反應，追蹤是否有實質基本面驅動，避免純情緒追高（無業績支撐的漲通常1-2周見頂）'

  // 下跌/跌停
  if (/下跌|大跌|跌停|重挫|承壓/.test(title))
    return '📉 留意風險，評估「利空出盡」機會：連跌後首次量縮守穩往往是最佳買點'

  // ── 📌 族群/市場提示 ──────────────────────────────────────────────
  if (tags.includes('台積電')) return '🏭 台積電動向牽動費半指數及台股整體，外資是否跟進加碼是後市關鍵觀察點'
  if (tags.includes('AI')) return '🤖 AI題材：區分「真實訂單驅動（可中期持股）」vs「情緒炒作（快進快出）」，看訂單能見度'
  if (tags.includes('半導體')) return '🔬 半導體：三角驗證——產能利用率、訂單能見度、ASP走向，三項共同確認才是真正啟動'
  if (tags.includes('生技醫療')) return '💊 生技消息波動極大：確認臨床期別（III期 > II期 >> I期），期別越早不確定性越高'
  if (tags.includes('美股')) return '🌎 美股訊號：費半直接影響台積電族群，納指影響台股次日開盤情緒，注意時差效應'
  if (tags.includes('貨幣政策')) return '🏛️ 貨幣政策：科技成長股、房地產、金融股反應最敏感，影響通常在1-2季後才完全反映'
  if (tags.includes('外資法人')) return '🏦 法人動向：三大法人同向可信度最高；單一外資買超需觀察延續性，確認是「戰略」還是「戰術」'
  if (tags.includes('供應鏈')) return '📦 供應鏈動態：分清拉貨（1-3個月短期需求）vs 結構性改善（6個月+），前者快進快出'

  return null
}

function parseRSS(xml) {
  const items = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1]
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`)
      const match = r.exec(block)
      return match ? match[1].trim() : ''
    }
    const title = get('title')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    const link = get('link') || get('guid')
    const pubDate = get('pubDate')
    const source = (() => { const s = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block); return s ? s[1].trim() : '' })()
    const description = get('description').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").slice(0, 300)
    if (title && link) items.push({ title, url: link, source, published: pubDate, summary: description })
  }
  return items
}

async function loadLiveNews() {
  const allNews = []

  // Fetch Google News queries + direct RSS sources in parallel
  const googleFetches = QUERIES.map(async ({ q }) => {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`
    return (await fetchRSS(rssUrl)).slice(0, 8)
  })
  const directFetches = DIRECT_RSS.map(async ({ url, name }) => {
    const items = await fetchRSS(url)
    return items.slice(0, 10).map(i => ({ ...i, source: i.source || name }))
  })

  const results = await Promise.allSettled([...googleFetches, ...directFetches])
  for (const r of results) {
    if (r.status === 'fulfilled') allNews.push(...r.value)
  }

  const seen = new Set()
  const now = Date.now()
  return allNews
    .filter(item => {
      const key = item.title.slice(0, 30)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(item => {
      const tags = detectTags(item.title, item.summary)
      const ts = item.published ? new Date(item.published).getTime() : 0
      const isNew = ts > 0 && (now - ts) < NEW_BADGE_MS
      return { ...item, tags, _ts: ts, isNew }
    })
    // Items with no date go to bottom; otherwise newest first
    .sort((a, b) => {
      if (!a._ts && !b._ts) return 0
      if (!a._ts) return 1
      if (!b._ts) return -1
      return b._ts - a._ts
    })
    .slice(0, 300)
}

function buildTrending(news) {
  const tagCount = {}, stockCount = {}
  for (const item of news) {
    for (const tag of (item.tags || [])) {
      if (tag !== '其他') tagCount[tag] = (tagCount[tag] || 0) + 1
    }
    for (const [, code] of item.title.matchAll(STOCK_CODE_RE)) {
      const n = parseInt(code, 10)
      if (n >= 2020 && n <= 2035) continue  // skip years
      stockCount[code] = (stockCount[code] || 0) + 1
    }
  }
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const topStocks = Object.entries(stockCount).sort((a, b) => b[1] - a[1]).slice(0, 4)
  return { topTags, topStocks }
}

function TrendingBar({ news, onFilter }) {
  const { topTags, topStocks } = buildTrending(news)
  if (topTags.length === 0 && topStocks.length === 0) return null
  return (
    <div className="ios-category-bar" style={{ padding: '10px 14px 12px' }}>
      <div style={{ fontSize: 10, color: 'var(--ios-label3)', fontWeight: 700, marginBottom: 8, letterSpacing: 0.7, textTransform: 'uppercase' }}>🔥 熱門趨勢</div>
      <div style={{ display: 'flex', gap: 7, overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 2 }}>
        {topTags.map(([tag, count]) => {
          const rule = KEYWORD_RULES.find(r => r.tag === tag)
          const color = rule?.color || 'var(--ios-label3)'
          return (
            <button key={tag} onClick={() => onFilter(tag)} style={{
              fontSize: 11, color, background: `${color}1e`,
              border: `1px solid ${color}45`,
              borderRadius: 9999, padding: '5px 13px', cursor: 'pointer',
              fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, letterSpacing: 0.2,
            }}>
              {rule?.icon} {tag}<span style={{ opacity: 0.55, fontWeight: 400, marginLeft: 4 }}>{count}</span>
            </button>
          )
        })}
        {topStocks.length > 0 && (
          <div style={{ width: 1, background: 'var(--ios-sep)', flexShrink: 0, margin: '3px 2px' }} />
        )}
        {topStocks.map(([code, count]) => (
          <span key={code} style={{
            fontSize: 11, color: 'var(--ios-blue)', background: 'rgba(10,132,255,0.14)',
            border: '1px solid rgba(10,132,255,0.32)', borderRadius: 9999,
            padding: '5px 13px', fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0,
            fontFamily: 'monospace',
          }}>
            {code}<span style={{ opacity: 0.55, fontWeight: 400, marginLeft: 4 }}>{count}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function buildDynamicTabs(news, customRules = []) {
  const allRules = [...KEYWORD_RULES, ...customRules]
  const customTagSet = new Set(customRules.map(r => r.tag))
  const freq = {}
  for (const item of news) {
    for (const tag of (item.tags || [])) {
      if (tag !== '其他') freq[tag] = (freq[tag] || 0) + 1
    }
  }
  // Top 7 built-in tags by frequency (exclude custom tags to avoid duplicates)
  const topTags = Object.entries(freq)
    .filter(([tag]) => !customTagSet.has(tag))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([tag]) => tag)

  const tabs = [{ key: 'all', label: '全部', icon: '📋' }]
  for (const tag of topTags) {
    const rule = allRules.find(r => r.tag === tag)
    tabs.push({ key: tag, label: tag, icon: rule?.icon || '📌', color: rule?.color })
  }
  // Always show custom rule tabs (even if 0 matches, so user knows they were added)
  for (const rule of customRules) {
    tabs.push({ key: rule.tag, label: rule.tag, icon: rule.icon || '📌', color: rule.color })
  }
  return tabs
}

function getSentiment(title, hint) {
  const t = (title || '') + ' ' + (hint || '')
  if (/買超|利多|看好|創高|突破|拿下|接單|升值|降息|解盲.*過關|FDA.*核准/.test(t) && !/賣超|利空|看壞|跌停|重挫|暴跌/.test(t)) return 'bull'
  if (/賣超|利空|看壞|跌停|重挫|暴跌|空單增|賣壓|放空/.test(t)) return 'bear'
  if (hint?.match(/^(📈|✅|💰|💊|📦|🌊.*走強)/)) return 'bull'
  if (hint?.match(/^(📉|⚠️|💸)/)) return 'bear'
  return 'neutral'
}

// Returns the specific keywords that triggered bull/bear classification
function getSentimentReason(title, summary = '') {
  const text = (title || '') + ' ' + (summary || '')
  const bullKw = ['買超','外資買','外資連買','利多','看好','創高','突破','拿下','接單','升值','降息','解盲','FDA核准','漲停','大漲','上漲','攀升','勁揚','走強','看俏','樂觀','回升']
  const bearKw = ['賣超','外資賣','外資空','利空','看壞','跌停','重挫','暴跌','崩跌','空單增','賣壓','放空','大跌','下跌','走低','下修','承壓','走弱','示警','疑慮']
  const matched = { bull: bullKw.filter(k => text.includes(k)), bear: bearKw.filter(k => text.includes(k)) }
  return matched
}

function getImportance(title, summary, tags) {
  let s = 1
  if (/台積電|TSMC|Fed|聯準會|FOMC/.test(title)) s += 2
  if (/外資|三大法人|升息|降息/.test(title)) s += 1
  if (/法說會|財報|EPS|超預期/.test(title)) s += 1
  if (/跌停|漲停|暴跌|暴漲|崩跌/.test(title)) s += 2
  if ((tags || []).includes('台積電') || (tags || []).includes('貨幣政策')) s += 1
  if ((summary?.length || 0) > 120) s += 1
  return Math.min(s, 5)
}

function Stars({ n }) {
  return (
    <span style={{ fontSize: 10, letterSpacing: 0.5, lineHeight: 1 }}>
      <span style={{ color: '#F59E0B' }}>{'★'.repeat(n)}</span>
      <span style={{ color: '#334155' }}>{'★'.repeat(5 - n)}</span>
    </span>
  )
}

function SentimentBadge({ sentiment }) {
  const cfg = {
    bull:    { label: '利多', color: '#22C55E', bg: 'rgba(34,197,94,0.12)' },
    bear:    { label: '利空', color: '#EF4444', bg: 'rgba(239,68,68,0.12)' },
    neutral: { label: '中性', color: '#94A3B8', bg: 'transparent' },
  }[sentiment] || { label: '中性', color: '#94A3B8', bg: 'transparent' }
  return (
    <span style={{ fontSize: 10, color: cfg.color, background: cfg.bg, borderRadius: 4, padding: '1px 6px', fontWeight: 700 }}>{cfg.label}</span>
  )
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    const diff = (Date.now() - d) / 1000
    if (diff < 60) return '剛剛'
    if (diff < 3600) return `${Math.round(diff / 60)} 分鐘前`
    if (diff < 86400) return `${Math.round(diff / 3600)} 小時前`
    return `${Math.round(diff / 86400)} 天前`
  } catch { return '' }
}

function TagChip({ tag, customRules = [] }) {
  const allRules = [...KEYWORD_RULES, ...customRules]
  const rule = allRules.find(r => r.tag === tag)
  const color = rule?.color || 'var(--ios-label3)'
  return (
    <span style={{
      fontSize: 10, color, background: `${color}22`,
      padding: '2px 8px', borderRadius: 9999, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {rule?.icon || '📌'} {tag}
    </span>
  )
}

function StockChip({ code }) {
  return (
    <span style={{
      fontSize: 10, color: 'var(--ios-blue)', background: 'rgba(10,132,255,0.12)',
      padding: '2px 8px', borderRadius: 9999, fontWeight: 700, fontFamily: 'monospace',
      border: '1px solid rgba(10,132,255,0.25)',
    }}>
      {code}
    </span>
  )
}

function CustomRulePanel({ customRules, onRulesChange, onClose }) {
  const [keyword, setKeyword] = useState('')
  const [tagName, setTagName] = useState('')
  const [icon, setIcon] = useState('📌')
  const [color, setColor] = useState('#58a6ff')

  function addRule() {
    const kw = keyword.trim()
    if (!kw) return
    const tag = tagName.trim() || kw
    const patterns = kw.split(/[,，\s]+/).filter(Boolean)
    const newRule = { patterns, tag, color, icon, custom: true }
    const updated = [...customRules, newRule]
    saveCustomRules(updated)
    onRulesChange(updated)
    setKeyword('')
    setTagName('')
  }

  function deleteRule(idx) {
    const updated = customRules.filter((_, i) => i !== idx)
    saveCustomRules(updated)
    onRulesChange(updated)
  }

  return (
    <div style={{
      background: 'var(--ios-bg2)', borderBottom: '0.5px solid var(--ios-sep)',
      padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ios-label)' }}>⚙️ 自訂分類關鍵字</span>
        <button onClick={onClose} style={{ background: 'var(--ios-fill3)', border: 'none', color: 'var(--ios-label2)', cursor: 'pointer', fontSize: 12, width: 24, height: 24, borderRadius: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
      </div>

      {customRules.length > 0 && (
        <div style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {customRules.map((rule, idx) => (
            <div key={idx} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
              background: 'var(--ios-bg3)', borderRadius: 10, border: '0.5px solid var(--ios-sep)',
            }}>
              <span style={{ color: rule.color, fontSize: 12 }}>{rule.icon}</span>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--ios-label)', fontWeight: 600 }}>{rule.tag}</span>
              <span style={{ fontSize: 11, color: 'var(--ios-label3)', fontFamily: 'monospace' }}>
                {rule.patterns.join('、')}
              </span>
              <button onClick={() => deleteRule(idx)} style={{
                background: 'none', border: 'none', color: 'var(--ios-red)', cursor: 'pointer', fontSize: 12, padding: '0 2px',
              }}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, color: 'var(--ios-label3)' }}>新增分類（多個關鍵字用逗號分隔）</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="關鍵字，如：鴻海,2317,FOXCONN"
            onKeyDown={e => e.key === 'Enter' && addRule()}
            style={{
              flex: '2 1 140px', padding: '7px 10px', fontSize: 12, borderRadius: 9,
              background: 'var(--ios-bg)', border: '0.5px solid var(--ios-sep)', color: 'var(--ios-label)', outline: 'none',
            }}
          />
          <input
            value={tagName}
            onChange={e => setTagName(e.target.value)}
            placeholder="標籤名（可選）"
            onKeyDown={e => e.key === 'Enter' && addRule()}
            style={{
              flex: '1 1 80px', padding: '7px 10px', fontSize: 12, borderRadius: 9,
              background: 'var(--ios-bg)', border: '0.5px solid var(--ios-sep)', color: 'var(--ios-label)', outline: 'none',
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--ios-label3)' }}>圖示：</span>
          {CUSTOM_ICONS.map(ic => (
            <button key={ic} onClick={() => setIcon(ic)} style={{
              background: icon === ic ? 'rgba(10,132,255,0.2)' : 'none',
              border: icon === ic ? '1px solid var(--ios-blue)' : '1px solid transparent',
              borderRadius: 6, cursor: 'pointer', fontSize: 14, padding: '1px 3px',
            }}>{ic}</button>
          ))}
          <span style={{ fontSize: 11, color: 'var(--ios-label3)', marginLeft: 8 }}>顏色：</span>
          {CUSTOM_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)} style={{
              width: 18, height: 18, borderRadius: '50%', background: c,
              border: color === c ? '2px solid var(--ios-label)' : '2px solid transparent',
              cursor: 'pointer', padding: 0,
            }} />
          ))}
          <button
            onClick={addRule}
            disabled={!keyword.trim()}
            style={{
              marginLeft: 'auto', padding: '6px 14px', fontSize: 12, fontWeight: 700,
              background: keyword.trim() ? 'var(--ios-blue)' : 'var(--ios-fill3)',
              color: keyword.trim() ? '#fff' : 'var(--ios-label3)',
              border: 'none', borderRadius: 9999, cursor: keyword.trim() ? 'pointer' : 'default',
            }}
          >+ 新增</button>
        </div>
      </div>
      <div style={{ marginTop: 8, fontSize: 10, color: 'var(--ios-label3)', lineHeight: 1.6 }}>
        新分類會自動出現在 Tab 和熱門趨勢中（若有相符新聞）。儲存於本機，重整後保留。
      </div>
    </div>
  )
}

function NewsItem({ item, isOpen, onToggle, customRules = [], nameMap = {} }) {
  const allRules = [...KEYWORD_RULES, ...customRules]
  const mainTag = item.tags?.[0]
  const rule = mainTag ? allRules.find(r => r.tag === mainTag) : null
  const hint = generateHint(item.title, item.tags || [])
  const sentiment = getSentiment(item.title, hint)
  const importance = getImportance(item.title, item.summary, item.tags)
  const stockCodes = isOpen ? [...new Set([...item.title.matchAll(STOCK_CODE_RE)].map(m => m[1]))] : []

  const borderColor = rule?.color || 'transparent'
  return (
    <div style={{
      borderBottom: '0.5px solid var(--ios-sep)',
      background: isOpen ? `linear-gradient(90deg, ${borderColor}08 0%, var(--ios-bg2) 40%)` : 'transparent',
      transition: 'background 0.18s',
      borderLeft: `2.5px solid ${isOpen ? borderColor : sentiment === 'bull' ? 'rgba(34,197,94,0.4)' : sentiment === 'bear' ? 'rgba(239,68,68,0.4)' : 'transparent'}`,
    }}>
      <div
        onClick={onToggle}
        style={{ padding: '12px 14px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start' }}
      >
        <div style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          background: `${borderColor}18`, border: `1px solid ${borderColor}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16,
        }}>{rule?.icon || '📰'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            {item.isNew && (
              <span style={{
                flexShrink: 0, fontSize: 9, fontWeight: 800, color: '#fff',
                background: 'var(--ios-red)', borderRadius: 4, padding: '2px 5px',
                letterSpacing: 0.3, lineHeight: 1.4, marginTop: 2,
                animation: 'newBlink 1.5s ease-in-out 3',
              }}>NEW</span>
            )}
            <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5, color: 'var(--ios-label)', letterSpacing: '-0.1px' }}>{highlightTitle(item.title, item.tags || [], customRules)}</div>
          </div>
          <div style={{ display: 'flex', gap: 5, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <SentimentBadge sentiment={sentiment} />
            <Stars n={importance} />
            {(item.tags || []).slice(0, 2).map(tag => <TagChip key={tag} tag={tag} customRules={customRules} />)}
            <span style={{ fontSize: 10, color: 'var(--ios-label4)', marginLeft: 1 }}>
              {item.source && `${item.source} · `}{timeAgo(item.published)}
            </span>
          </div>
          <StockTagChips title={item.title} summary={item.summary} nameMap={nameMap} />
        </div>
        <span style={{ color: 'var(--ios-label4)', fontSize: 11, flexShrink: 0, marginTop: 2 }}>{isOpen ? '▲' : '▼'}</span>
      </div>

      {isOpen && (
        <div style={{ padding: '0 16px 14px 44px' }}>
          {/* Tags + stock chips */}
          {(item.tags?.length > 0 || stockCodes.length > 0) && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
              {item.tags.map(tag => <TagChip key={tag} tag={tag} customRules={customRules} />)}
              {stockCodes.map(c => <StockChip key={c} code={c} />)}
            </div>
          )}
          {/* Sentiment reason — show matched keywords */}
          {sentiment !== 'neutral' && (() => {
            const { bull, bear } = getSentimentReason(item.title, item.summary)
            const keys = sentiment === 'bull' ? bull : bear
            if (!keys.length) return null
            const col = sentiment === 'bull' ? '#22C55E' : '#EF4444'
            const bg = sentiment === 'bull' ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)'
            const border = sentiment === 'bull' ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'
            const icon = sentiment === 'bull' ? '📈 利多依據' : '📉 利空依據'
            return (
              <div style={{ marginBottom: 10, padding: '8px 11px', background: bg, borderRadius: 10, border: `0.5px solid ${border}` }}>
                <div style={{ fontSize: 10, color: col, fontWeight: 700, marginBottom: 6, letterSpacing: 0.3 }}>{icon}</div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {keys.map((k, i) => (
                    <span key={i} style={{
                      fontSize: 11, fontWeight: 700, color: col,
                      background: sentiment === 'bull' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                      borderRadius: 6, padding: '2px 8px',
                    }}>{k}</span>
                  ))}
                </div>
              </div>
            )
          })()}
          {/* 大綱 outline */}
          {(() => {
            const outline = generateOutline(item.title, item.summary)
            if (!outline) return null
            const typeIcon = { up: '📈', down: '📉', inst: '🏦', num: '💰', fwd: '🔭', info: '·' }
            const typeColor = { up: 'var(--ios-green)', down: 'var(--ios-red)', inst: 'var(--ios-yellow)', num: 'var(--ios-blue)', fwd: 'var(--ios-purple)', info: 'var(--ios-label)' }
            return (
              <div style={{
                marginBottom: 10,
                background: 'var(--ios-bg3)',
                border: '0.5px solid var(--ios-sep)',
                borderRadius: 10,
                padding: '9px 12px',
              }}>
                <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginBottom: 6, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>📋 大綱</div>
                {outline.map((item, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: i < outline.length - 1 ? 6 : 0, alignItems: 'flex-start' }}>
                    <span style={{ fontSize: 12, flexShrink: 0, minWidth: 16, color: typeColor[item.type] }}>{typeIcon[item.type]}</span>
                    <span style={{ fontSize: 12, color: item.type === 'info' ? 'var(--ios-label2)' : 'var(--ios-label)', lineHeight: 1.6 }}>{item.text}</span>
                  </div>
                ))}
              </div>
            )
          })()}
          {/* Investment hint */}
          {hint && (
            <div style={{
              marginBottom: 10, fontSize: 13, color: 'var(--ios-label)',
              background: 'var(--ios-bg3)', borderRadius: 10,
              padding: '9px 12px', borderLeft: '3px solid var(--ios-blue)',
              lineHeight: 1.6,
            }}>
              {hint}
            </div>
          )}
          {/* Link to full article */}
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 12, color: 'var(--ios-blue)', fontWeight: 500,
                textDecoration: 'none',
                padding: '5px 12px',
                background: 'rgba(10,132,255,0.10)',
                border: '0.5px solid rgba(10,132,255,0.28)',
                borderRadius: 9999,
              }}
            >
              閱讀全文 ↗
            </a>
          )}
        </div>
      )}
    </div>
  )
}

// ── Feature 17: Stock tag chips ──────────────────────────────────────────────
function StockTagChips({ title, summary, nameMap }) {
  const text = (title || '') + ' ' + (summary || '')
  const codes = []
  const seen = new Set()
  const re = /\b([2-9]\d{3})\b/g
  let m
  while ((m = re.exec(text)) !== null) {
    const code = m[1]
    const n = parseInt(code, 10)
    if (n >= 2020 && n <= 2035) continue // skip years
    if (!nameMap[code]) continue // only show codes that exist in scan data
    if (seen.has(code)) continue
    seen.add(code)
    codes.push(code)
  }
  if (codes.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
      {codes.map(stockId => (
        <span
          key={stockId}
          onClick={e => {
            e.stopPropagation()
            document.dispatchEvent(new CustomEvent('openStockDetail', { detail: { stock_id: stockId } }))
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '1px 6px',
            background: 'rgba(10,132,255,0.12)',
            color: 'var(--ios-blue)',
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            margin: '0 2px',
            border: '1px solid rgba(10,132,255,0.25)',
            fontFamily: 'monospace',
          }}
        >
          {stockId}{nameMap[stockId] ? ` ${nameMap[stockId]}` : ''}
        </span>
      ))}
    </div>
  )
}

export default function NewsFeed({ staticNews, refreshSignal, data }) {
  const [rawNews, setRawNews] = useState(staticNews || [])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [openIdx, setOpenIdx] = useState(null)
  const [filter, setFilter] = useState('all')
  const [sentimentFilter, setSentimentFilter] = useState('all') // 'all' | 'bull' | 'bear'
  const [tagsExpanded, setTagsExpanded] = useState(false)
  const [customRules, setCustomRules] = useState(loadCustomRules)
  const [showCustomPanel, setShowCustomPanel] = useState(false)
  const [nowTs, setNowTs] = useState(Date.now())
  const clockRef = useRef(null)

  // Feature 17: Build stock name lookup from scan data
  const nameMap = useMemo(() => {
    if (!data?.scans) return {}
    const map = {}
    for (const scan of Object.values(data.scans)) {
      for (const s of [...(scan.top_stocks || []), ...(scan.filter_stocks || [])]) {
        if (s.stock_id && s.name) map[s.stock_id] = s.name
      }
    }
    return map
  }, [data?.scans])

  // Scroll-collapse refs (same pattern as Dashboard.jsx)
  const newsHeaderInnerRef = useRef(null)
  const newsMaxCollapseHeightRef = useRef(null)
  const newsScrollRafRef = useRef(null)
  const newsListRef = useRef(null)
  const NEWS_COLLAPSE_RANGE = 55

  // Tick every 30 s so "N 分前更新" label stays current
  useEffect(() => {
    clockRef.current = setInterval(() => setNowTs(Date.now()), 30_000)
    return () => clearInterval(clockRef.current)
  }, [])

  const doFetch = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const items = await loadLiveNews()
      if (items.length > 0) {
        setRawNews(prev => {
          // Merge: keep live items at top, append old items not in new set
          const seen = new Set(items.map(i => i.title.slice(0, 30)))
          const kept = prev.filter(i => !seen.has(i.title.slice(0, 30)))
          return [...items, ...kept].slice(0, 300)
        })
        setLastUpdated(new Date())
      }
    } catch (e) {
      console.warn('Live news fetch failed:', e)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    doFetch(false)
    const timer = setInterval(() => doFetch(true), REFRESH_INTERVAL)
    return () => clearInterval(timer)
  }, [doFetch])

  // When App refresh button is clicked, re-fetch live news too
  useEffect(() => {
    if (refreshSignal > 0) doFetch(true)
  }, [refreshSignal, doFetch])

  // Merge updated staticNews (from App reload) into rawNews
  useEffect(() => {
    if (!staticNews?.length) return
    setRawNews(prev => {
      const seen = new Set(prev.map(i => i.title.slice(0, 30)))
      const fresh = staticNews.filter(i => !seen.has(i.title.slice(0, 30)))
      return fresh.length ? [...prev, ...fresh].slice(0, 300) : prev
    })
  }, [staticNews])

  // Measure header height on mount and when filter/tags change
  useLayoutEffect(() => {
    const el = newsHeaderInnerRef.current
    if (!el) return
    el.style.height = 'auto'
    const h = el.scrollHeight
    newsMaxCollapseHeightRef.current = h
    el.style.height = h + 'px'
  }, [filter, tagsExpanded, showCustomPanel])

  // RAF cleanup
  useEffect(() => () => { if (newsScrollRafRef.current) cancelAnimationFrame(newsScrollRafRef.current) }, [])

  const handleNewsScroll = (e) => {
    const scrollTop = e.currentTarget.scrollTop
    if (newsScrollRafRef.current) cancelAnimationFrame(newsScrollRafRef.current)
    newsScrollRafRef.current = requestAnimationFrame(() => {
      const el = newsHeaderInnerRef.current
      if (!el) return
      const outer = el.parentElement
      if (scrollTop <= 2) {
        el.style.height = 'auto'
        const h = el.scrollHeight
        newsMaxCollapseHeightRef.current = h
        el.style.height = h + 'px'
        el.style.opacity = '1'
        el.style.pointerEvents = 'auto'
        if (outer) outer.style.paddingBottom = '0px'
        return
      }
      if (newsMaxCollapseHeightRef.current == null) {
        newsMaxCollapseHeightRef.current = el.scrollHeight
      }
      const progress = Math.min(1, scrollTop / NEWS_COLLAPSE_RANGE)
      el.style.height = `${newsMaxCollapseHeightRef.current * (1 - progress)}px`
      el.style.opacity = `${Math.max(0, 1 - progress * 1.8)}`
      el.style.pointerEvents = progress > 0.9 ? 'none' : 'auto'
      if (outer) outer.style.paddingBottom = `${Math.round(8 * (1 - progress))}px`
    })
  }

  // Re-tag news whenever customRules changes
  const news = useMemo(() =>
    rawNews.map(item => ({ ...item, tags: detectTags(item.title, item.summary, customRules) })),
    [rawNews, customRules]
  )

  const tabs = buildDynamicTabs(news, customRules)
  const tagFiltered = filter === 'all' ? news : news.filter(n => (n.tags || []).includes(filter))
  const filtered = sentimentFilter === 'all' ? tagFiltered : tagFiltered.filter(n => {
    const hint = generateHint(n.title, n.tags || [])
    return getSentiment(n.title, hint) === sentimentFilter
  })

  // Counts for sentiment badges
  const bullCount = tagFiltered.filter(n => {
    const hint = generateHint(n.title, n.tags || [])
    return getSentiment(n.title, hint) === 'bull'
  }).length
  const bearCount = tagFiltered.filter(n => {
    const hint = generateHint(n.title, n.tags || [])
    return getSentiment(n.title, hint) === 'bear'
  }).length

  if (loading && news.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ios-label2)', gap: 10 }}>
        <div style={{ fontSize: 28 }}>📡</div>
        <div style={{ fontSize: 15 }}>載入即時新聞中…</div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{`@keyframes newBlink{0%,100%{opacity:1}50%{opacity:0.35}}`}</style>

      {/* Collapsible header area — collapses as user scrolls down */}
      <div style={{ flexShrink: 0 }}>
        {/* Collapsible body — height animated by handleNewsScroll */}
        <div ref={newsHeaderInnerRef} style={{ overflow: 'hidden' }}>
          <>
            {/* Trending bar */}
            {news.length > 0 && (
              <TrendingBar news={news} onFilter={tag => { setFilter(tag); setOpenIdx(null) }} />
            )}

            {/* Dynamic tab bar — top 4 always visible, rest collapsible */}
            <div className="ios-category-bar">
        {(() => {
          const ALWAYS_VISIBLE = 4 // 全部 + top 3
          const visibleTabs = tagsExpanded ? tabs : tabs.slice(0, ALWAYS_VISIBLE)
          const hiddenCount = tabs.length - ALWAYS_VISIBLE
          const TabBtn = (cat) => {
            const isActive = filter === cat.key
            const count = cat.key === 'all' ? news.length : news.filter(n => (n.tags || []).includes(cat.key)).length
            return (
              <button
                key={cat.key}
                onClick={() => { setFilter(cat.key); setOpenIdx(null) }}
                style={{
                  padding: '8px 11px', fontSize: 12, fontWeight: isActive ? 700 : 400, border: 'none',
                  borderBottom: `2px solid ${isActive ? (cat.color || 'var(--ios-blue)') : 'transparent'}`,
                  background: 'transparent',
                  color: isActive ? (cat.color || 'var(--ios-blue)') : 'var(--ios-label2)',
                  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0, letterSpacing: '-0.1px',
                  transition: 'color 0.15s, border-color 0.15s',
                }}
              >
                {cat.icon} {cat.label}
                <span style={{ marginLeft: 3, fontSize: 10, opacity: 0.55 }}>{count}</span>
              </button>
            )
          }
          return (
            <div style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', WebkitOverflowScrolling: 'touch', touchAction: 'pan-x' }}>
              {visibleTabs.map(cat => TabBtn(cat))}
              {hiddenCount > 0 && (
                <button
                  onClick={() => setTagsExpanded(x => !x)}
                  style={{
                    flexShrink: 0, padding: '6px 10px', fontSize: 11, fontWeight: 600,
                    border: '1px solid var(--ios-sep)', borderRadius: 9999,
                    background: tagsExpanded ? 'rgba(10,132,255,0.12)' : 'var(--ios-fill4)',
                    color: tagsExpanded ? 'var(--ios-blue)' : 'var(--ios-label3)',
                    cursor: 'pointer', margin: '0 4px',
                    transition: 'background 0.15s, color 0.15s',
                  }}
                >
                  {tagsExpanded ? '收起 ▲' : `⋯ ${hiddenCount}個 ▼`}
                </button>
              )}
            </div>
          )
        })()}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 12px 5px' }}>
          <div style={{ fontSize: 10, color: 'var(--ios-label3)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>
              {lastUpdated ? (() => {
                const diffMin = Math.round((nowTs - lastUpdated.getTime()) / 60_000)
                const label = diffMin <= 0 ? '剛剛' : diffMin < 60 ? `${diffMin} 分前` : `${Math.round(diffMin / 60)} 小時前`
                return `即時新聞 · ${label}更新`
              })() : '即時新聞'}
              {refreshing && <span style={{ marginLeft: 4 }}>· 更新中…</span>}
            </span>
            <span style={{
              background: 'var(--ios-fill3)', borderRadius: 8,
              padding: '1px 6px', fontWeight: 600, color: 'var(--ios-label3)',
            }}>{news.length} 則</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => setShowCustomPanel(p => !p)}
              style={{
                fontSize: 11, padding: '4px 11px',
                background: showCustomPanel ? 'rgba(10,132,255,0.15)' : 'var(--ios-fill4)',
                border: `0.5px solid ${showCustomPanel ? 'var(--ios-blue)' : 'var(--ios-sep)'}`,
                borderRadius: 9999, color: showCustomPanel ? 'var(--ios-blue)' : 'var(--ios-label2)', cursor: 'pointer',
              }}
            >
              ⚙️ 自訂分類{customRules.length > 0 ? ` (${customRules.length})` : ''}
            </button>
            <button
              onClick={() => doFetch(true)}
              disabled={refreshing}
              style={{
                fontSize: 11, padding: '4px 11px', background: 'var(--ios-fill4)',
                border: '0.5px solid var(--ios-sep)', borderRadius: 9999,
                color: refreshing ? 'var(--ios-label3)' : 'var(--ios-label2)',
                cursor: refreshing ? 'default' : 'pointer',
              }}
            >
              {refreshing ? '更新中…' : '↻ 重新整理'}
            </button>
          </div>
        </div>

        {/* Sentiment filter row */}
        <div style={{ display: 'flex', gap: 6, padding: '0 12px 8px', alignItems: 'center' }}>
          {[
            { key: 'all',  label: '全部',  color: 'var(--ios-label2)',  bg: 'var(--ios-fill4)',               count: tagFiltered.length },
            { key: 'bull', label: '利多',  color: '#22C55E', bg: 'rgba(34,197,94,0.13)',  count: bullCount },
            { key: 'bear', label: '利空',  color: '#EF4444', bg: 'rgba(239,68,68,0.13)',  count: bearCount },
          ].map(({ key, label, color, bg, count }) => {
            const isActive = sentimentFilter === key
            return (
              <button key={key} onClick={() => { setSentimentFilter(key); setOpenIdx(null) }} style={{
                flex: key === 'all' ? 0 : 1, padding: '6px 10px', fontSize: 12, fontWeight: isActive ? 700 : 500,
                borderRadius: 10, cursor: 'pointer',
                border: `1px solid ${isActive ? color : 'var(--ios-sep)'}`,
                background: isActive ? bg : 'var(--ios-bg3)',
                color: isActive ? color : 'var(--ios-label3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                transition: 'all 0.15s',
              }}>
                {key === 'bull' ? '📈' : key === 'bear' ? '📉' : null}
                {label}
                <span style={{ fontSize: 11, opacity: isActive ? 1 : 0.6, fontWeight: 600, fontFamily: 'monospace' }}>{count}</span>
              </button>
            )
          })}
        </div>
        </div>
          </>
        </div>
      </div>

      {/* Custom category panel */}
      {showCustomPanel && (
        <CustomRulePanel
          customRules={customRules}
          onRulesChange={rules => { setCustomRules(rules); setOpenIdx(null) }}
          onClose={() => setShowCustomPanel(false)}
        />
      )}

      {/* News list */}
      <div ref={newsListRef} onScroll={handleNewsScroll} style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {filter !== 'all' && (
          <div style={{ padding: '6px 16px 2px', fontSize: 11, color: 'var(--ios-label3)' }}>
            篩選中 · {filtered.length} 則
          </div>
        )}
        {filtered.length === 0 && !loading && (
          <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--ios-label2)' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
            <div>此分類暫無新聞</div>
          </div>
        )}
        {filtered.map((item, i) => (
          <NewsItem
            key={i}
            item={item}
            isOpen={openIdx === i}
            onToggle={() => setOpenIdx(openIdx === i ? null : i)}
            customRules={customRules}
            nameMap={nameMap}
          />
        ))}
        <div style={{ height: 32 }} />
      </div>
    </div>
  )
}
