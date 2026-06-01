import { useState, useEffect, useCallback, useMemo } from 'react'

const CUSTOM_RULES_KEY = 'news_custom_rules'
const CUSTOM_COLORS = ['#58a6ff', '#3fb950', '#ffa657', '#f85149', '#bc8cff', '#f9c74f', '#79c0ff', '#56d364']
const CUSTOM_ICONS = ['📌', '⭐', '🏭', '💡', '🔥', '🏗️', '💰', '🎯', '🔋', '🚀', '🌐', '🏆']

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
  { patterns: ['法說會', '財報', 'EPS', '營收', '獲利', '毛利', '業績'], tag: '基本面', color: 'var(--accent)', icon: '📊' },
  { patterns: ['大盤', '加權', '指數', '萬點', '封關', '開盤', '收盤'], tag: '大盤', color: 'var(--accent)', icon: '📈' },
]

const STOCK_CODE_RE = /\b([2-9]\d{3})\b/g

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

function generateHint(title, tags) {
  if (/外資.*空單|外資.*放空|空單擴大/.test(title)) return '⚠️ 外資空頭部位增加，指數短線承壓'
  if (/外資.*買超|外資連買|外資買/.test(title)) return '💰 外資買盤進駐，籌碼面轉強'
  if (/外資.*賣超|外資賣/.test(title)) return '⚠️ 外資賣壓，短線謹慎觀望'
  if (/FDA|新藥.*過關|核准|解盲/.test(title)) return '💊 生技利多，相關族群留意追蹤'
  if (/接單|拿下|合約|訂單/.test(title)) return '📦 訂單利多，追蹤後續業績確認'
  if (/貶值|走貶/.test(title)) return '🌊 台幣走弱，出口族群相對受惠'
  if (/升值|走升/.test(title)) return '🌊 台幣走強，留意出口股匯損風險'
  if (/升息|利率上升/.test(title)) return '💸 資金成本上升，留意高本益比股承壓'
  if (/降息|寬鬆|暫停升息/.test(title)) return '✅ 資金面利多，科技成長股受惠'
  if (/法說會|財報|EPS|超預期|優於預期/.test(title)) return '📋 基本面事件，確認數字後再決策'
  if (/上漲|上揚|攀升|勁升|大漲|創高|走強|跳漲|聯袂漲/.test(title)) return '📈 正面消息，留意相關族群機會'
  if (/下跌|走低|下修|跌停|大跌|重挫|承壓|走弱/.test(title)) return '📉 留意風險，評估停損條件'
  if (tags.includes('台積電')) return '🏭 台積電動向影響整體半導體族群走勢'
  if (tags.includes('半導體') || tags.includes('AI')) return '💡 半導體／AI族群，關注本波動能持續性'
  if (tags.includes('美股')) return '🌎 留意美股走向對台股開盤情緒影響'
  if (tags.includes('貨幣政策')) return '🏛️ 貨幣政策動向牽動資金流向，密切追蹤'
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
  const results = await Promise.allSettled(
    QUERIES.map(async ({ q }) => {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`
      return (await fetchRSS(rssUrl)).slice(0, 8)
    })
  )
  for (const r of results) {
    if (r.status === 'fulfilled') allNews.push(...r.value)
  }
  const seen = new Set()
  return allNews
    .filter(item => {
      const key = item.title.slice(0, 30)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(item => {
      const tags = detectTags(item.title, item.summary)
      return { ...item, tags }
    })
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .slice(0, 60)
}

function buildTrending(news) {
  const tagCount = {}, stockCount = {}
  for (const item of news) {
    for (const tag of (item.tags || [])) {
      if (tag !== '其他') tagCount[tag] = (tagCount[tag] || 0) + 1
    }
    for (const [, code] of item.title.matchAll(STOCK_CODE_RE)) {
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
    <div style={{ padding: '8px 14px 10px', background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, marginBottom: 6, letterSpacing: 0.5 }}>🔥 熱門趨勢</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {topTags.map(([tag, count]) => {
          const rule = KEYWORD_RULES.find(r => r.tag === tag)
          const color = rule?.color || 'var(--muted)'
          return (
            <button key={tag} onClick={() => onFilter(tag)} style={{
              fontSize: 11, color, background: `${color}20`, border: `1px solid ${color}40`,
              borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontWeight: 600,
            }}>
              {rule?.icon} {tag} <span style={{ opacity: 0.65 }}>·{count}</span>
            </button>
          )
        })}
        {topStocks.map(([code, count]) => (
          <span key={code} style={{
            fontSize: 11, color: 'var(--accent)', background: 'var(--accent)18',
            border: '1px solid var(--accent)40', borderRadius: 4,
            padding: '2px 8px', fontWeight: 700,
          }}>
            {code} <span style={{ opacity: 0.65 }}>·{count}</span>
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
  const color = rule?.color || 'var(--muted)'
  return (
    <span style={{
      fontSize: 10, color, background: `${color}22`,
      padding: '1px 6px', borderRadius: 3, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {rule?.icon || '📌'} {tag}
    </span>
  )
}

function StockChip({ code }) {
  return (
    <span style={{
      fontSize: 10, color: 'var(--accent)', background: 'var(--accent)11',
      padding: '1px 6px', borderRadius: 3, fontWeight: 700, fontFamily: 'monospace',
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
      background: 'var(--surface)', borderBottom: '1px solid var(--border)',
      padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>⚙️ 自訂分類關鍵字</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }}>✕</button>
      </div>

      {customRules.length > 0 && (
        <div style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {customRules.map((rule, idx) => (
            <div key={idx} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
              background: 'var(--bg)', borderRadius: 5, border: '1px solid var(--border)',
            }}>
              <span style={{ color: rule.color, fontSize: 12 }}>{rule.icon}</span>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{rule.tag}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>
                {rule.patterns.join('、')}
              </span>
              <button onClick={() => deleteRule(idx)} style={{
                background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 12, padding: '0 2px',
              }}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>新增分類（多個關鍵字用逗號分隔）</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="關鍵字，如：鴻海,2317,FOXCONN"
            onKeyDown={e => e.key === 'Enter' && addRule()}
            style={{
              flex: '2 1 140px', padding: '5px 9px', fontSize: 12, borderRadius: 5,
              background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', outline: 'none',
            }}
          />
          <input
            value={tagName}
            onChange={e => setTagName(e.target.value)}
            placeholder="標籤名（可選）"
            onKeyDown={e => e.key === 'Enter' && addRule()}
            style={{
              flex: '1 1 80px', padding: '5px 9px', fontSize: 12, borderRadius: 5,
              background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', outline: 'none',
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>圖示：</span>
          {CUSTOM_ICONS.map(ic => (
            <button key={ic} onClick={() => setIcon(ic)} style={{
              background: icon === ic ? 'var(--accent)33' : 'none',
              border: icon === ic ? '1px solid var(--accent)' : '1px solid transparent',
              borderRadius: 4, cursor: 'pointer', fontSize: 14, padding: '1px 3px',
            }}>{ic}</button>
          ))}
          <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>顏色：</span>
          {CUSTOM_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)} style={{
              width: 18, height: 18, borderRadius: '50%', background: c,
              border: color === c ? '2px solid var(--text)' : '2px solid transparent',
              cursor: 'pointer', padding: 0,
            }} />
          ))}
          <button
            onClick={addRule}
            disabled={!keyword.trim()}
            style={{
              marginLeft: 'auto', padding: '5px 14px', fontSize: 12, fontWeight: 700,
              background: keyword.trim() ? 'var(--accent)' : 'var(--surface2)',
              color: keyword.trim() ? '#fff' : 'var(--muted)',
              border: 'none', borderRadius: 5, cursor: keyword.trim() ? 'pointer' : 'default',
            }}
          >+ 新增</button>
        </div>
      </div>
      <div style={{ marginTop: 8, fontSize: 10, color: 'var(--muted)', lineHeight: 1.6 }}>
        新分類會自動出現在 Tab 和熱門趨勢中（若有相符新聞）。儲存於本機，重整後保留。
      </div>
    </div>
  )
}

function NewsItem({ item, isOpen, onToggle, customRules = [] }) {
  const allRules = [...KEYWORD_RULES, ...customRules]
  const mainTag = item.tags?.[0]
  const rule = mainTag ? allRules.find(r => r.tag === mainTag) : null
  const hint = isOpen ? generateHint(item.title, item.tags || []) : null
  const stockCodes = isOpen ? [...new Set([...item.title.matchAll(STOCK_CODE_RE)].map(m => m[1]))] : []

  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      background: isOpen ? 'var(--surface)' : 'transparent',
      transition: 'background 0.15s',
    }}>
      <div
        onClick={onToggle}
        style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start' }}
      >
        <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{rule?.icon || '📰'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.5, color: 'var(--text)' }}>{item.title}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 5, alignItems: 'center', flexWrap: 'wrap' }}>
            {(item.tags || []).slice(0, 3).map(tag => <TagChip key={tag} tag={tag} customRules={customRules} />)}
            {item.source && <span style={{ fontSize: 10, color: 'var(--muted)' }}>{item.source}</span>}
            <span style={{ fontSize: 10, color: 'var(--muted)' }}>{timeAgo(item.published)}</span>
          </div>
        </div>
        <span style={{ color: 'var(--muted)', fontSize: 12, flexShrink: 0 }}>{isOpen ? '▲' : '▼'}</span>
      </div>

      {isOpen && (
        <div style={{ padding: '0 16px 14px 44px' }}>
          {item.summary && (
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 10 }}>
              {item.summary}
            </div>
          )}
          {(item.tags?.length > 0 || stockCodes.length > 0) && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: hint ? 8 : 0 }}>
              {item.tags.map(tag => <TagChip key={tag} tag={tag} customRules={customRules} />)}
              {stockCodes.map(c => <StockChip key={c} code={c} />)}
            </div>
          )}
          {hint && (
            <div style={{
              marginTop: 8, fontSize: 12, color: 'var(--text)',
              background: 'var(--surface2)', borderRadius: 6,
              padding: '7px 10px', borderLeft: '3px solid var(--accent)',
              lineHeight: 1.6,
            }}>
              {hint}
            </div>
          )}
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              style={{
                display: 'inline-block', marginTop: 10, fontSize: 11,
                color: 'var(--accent)', textDecoration: 'none',
                background: 'var(--accent)15', border: '1px solid var(--accent)40',
                borderRadius: 4, padding: '3px 10px',
              }}
            >
              閱讀原文 ↗
            </a>
          )}
        </div>
      )}
    </div>
  )
}

export default function NewsFeed({ staticNews }) {
  const [rawNews, setRawNews] = useState(staticNews || [])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [openIdx, setOpenIdx] = useState(null)
  const [filter, setFilter] = useState('all')
  const [customRules, setCustomRules] = useState(loadCustomRules)
  const [showCustomPanel, setShowCustomPanel] = useState(false)

  const doFetch = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const items = await loadLiveNews()
      if (items.length > 0) {
        setRawNews(items)
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
    const timer = setInterval(() => doFetch(true), 10 * 60 * 1000)
    return () => clearInterval(timer)
  }, [doFetch])

  // Re-tag news whenever customRules changes
  const news = useMemo(() =>
    rawNews.map(item => ({ ...item, tags: detectTags(item.title, item.summary, customRules) })),
    [rawNews, customRules]
  )

  const tabs = buildDynamicTabs(news, customRules)
  const filtered = filter === 'all' ? news : news.filter(n => (n.tags || []).includes(filter))

  if (loading && news.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted)', gap: 10 }}>
        <div style={{ fontSize: 28 }}>📡</div>
        <div style={{ fontSize: 14 }}>載入即時新聞中…</div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Trending bar */}
      {news.length > 0 && (
        <TrendingBar news={news} onFilter={tag => { setFilter(tag); setOpenIdx(null) }} />
      )}

      {/* Dynamic tab bar */}
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {tabs.map(cat => {
            const isActive = filter === cat.key
            const count = cat.key === 'all' ? news.length : news.filter(n => (n.tags || []).includes(cat.key)).length
            return (
              <button
                key={cat.key}
                onClick={() => { setFilter(cat.key); setOpenIdx(null) }}
                style={{
                  padding: '10px 12px', fontSize: 12, fontWeight: 600, border: 'none',
                  borderBottom: `2px solid ${isActive ? (cat.color || 'var(--accent)') : 'transparent'}`,
                  background: 'transparent',
                  color: isActive ? (cat.color || 'var(--accent)') : 'var(--muted)',
                  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                {cat.icon} {cat.label}
                <span style={{ marginLeft: 3, fontSize: 10, opacity: 0.7 }}>({count})</span>
              </button>
            )
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 12px 7px' }}>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>
            {lastUpdated
              ? `即時新聞 · 更新於 ${lastUpdated.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`
              : '即時新聞'}
            {refreshing && <span style={{ marginLeft: 6 }}>· 更新中…</span>}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => setShowCustomPanel(p => !p)}
              style={{
                fontSize: 11, padding: '3px 10px', background: showCustomPanel ? 'var(--accent)22' : 'var(--surface2)',
                border: `1px solid ${showCustomPanel ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 4, color: showCustomPanel ? 'var(--accent)' : 'var(--muted)', cursor: 'pointer',
              }}
            >
              ⚙️ 自訂分類{customRules.length > 0 ? ` (${customRules.length})` : ''}
            </button>
            <button
              onClick={() => doFetch(true)}
              disabled={refreshing}
              style={{
                fontSize: 11, padding: '3px 10px', background: 'var(--surface2)',
                border: '1px solid var(--border)', borderRadius: 4,
                color: refreshing ? 'var(--muted)' : 'var(--text)',
                cursor: refreshing ? 'default' : 'pointer',
              }}
            >
              {refreshing ? '更新中…' : '↻ 重新整理'}
            </button>
          </div>
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
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '8px 16px 4px', fontSize: 11, color: 'var(--muted)' }}>
          {filtered.length} 則新聞
        </div>
        {filtered.length === 0 && !loading && (
          <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
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
          />
        ))}
        <div style={{ height: 32 }} />
      </div>
    </div>
  )
}
