import { useState, useEffect, useCallback } from 'react'

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
  { q: '台灣股市 大盤 指數 when:3d' },
  { q: '台積電 2330 半導體 when:3d' },
  { q: '外資 法人 台指期貨 when:3d' },
  { q: '美股 那斯達克 費半 when:3d' },
  { q: 'AI 人工智慧 科技股 GPU when:3d' },
  { q: '生技 新藥 醫療 FDA when:3d' },
  { q: '匯率 新台幣 美元 聯準會 when:3d' },
]

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

async function fetchRSS(rssUrl) {
  const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}&count=8`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 7000)
  try {
    const r = await fetch(apiUrl, { signal: ctrl.signal })
    if (r.ok) {
      const j = await r.json()
      if (j.status === 'ok' && j.items?.length) {
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
  const ctrl2 = new AbortController()
  const timer2 = setTimeout(() => ctrl2.abort(), 6000)
  try {
    const r2 = await fetch(`https://corsproxy.io/?${encodeURIComponent(rssUrl)}`, { signal: ctrl2.signal })
    if (r2.ok) {
      const xml = await r2.text()
      if (xml.includes('<item>')) return parseRSS(xml)
    }
  } catch (_) { /* give up */ } finally {
    clearTimeout(timer2)
  }
  return []
}
function detectTags(title, summary = '') {
  const text = title + ' ' + summary
  const matched = []
  for (const rule of KEYWORD_RULES) {
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
      const resp = await fetch(`https://corsproxy.io/?${encodeURIComponent(rssUrl)}`, {
        signal: AbortSignal.timeout(12000),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const xml = await resp.text()
      return parseRSS(xml).slice(0, 8)
    })
  )
  for (const r of results) {
    if (r.status === 'fulfilled') allNews.push(...r.value)
  }
  const cutoff = Date.now() - THREE_DAYS_MS
  const seen = new Set()
  return allNews
    .filter(item => {
      const key = item.title.slice(0, 30)
      if (seen.has(key)) return false
      seen.add(key)
      // filter out articles older than 3 days
      if (item.published) {
        const age = Date.now() - new Date(item.published).getTime()
        if (age > THREE_DAYS_MS) return false
      }
      return true
    })
    .map(item => {
      const tags = detectTags(item.title, item.summary)
      return { ...item, tags }
    })
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .slice(0, 60)
}

function buildDynamicTabs(news) {
  const freq = {}
  for (const item of news) {
    for (const tag of (item.tags || [])) {
      if (tag !== '其他') freq[tag] = (freq[tag] || 0) + 1
    }
  }
  const topTags = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([tag]) => tag)
  return [{ key: 'all', label: '全部', icon: '📋' }, ...topTags.map(tag => {
    const rule = KEYWORD_RULES.find(r => r.tag === tag)
    return { key: tag, label: tag, icon: rule?.icon || '📌', color: rule?.color }
  })]
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

function TagChip({ tag }) {
  const rule = KEYWORD_RULES.find(r => r.tag === tag)
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

function NewsItem({ item, isOpen, onToggle }) {
  const mainTag = item.tags?.[0]
  const rule = mainTag ? KEYWORD_RULES.find(r => r.tag === mainTag) : null
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
            {(item.tags || []).slice(0, 3).map(tag => <TagChip key={tag} tag={tag} />)}
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
              {item.tags.map(tag => <TagChip key={tag} tag={tag} />)}
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
        </div>
      )}
    </div>
  )
}

export default function NewsFeed({ staticNews }) {
  const [news, setNews] = useState(staticNews || [])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [openIdx, setOpenIdx] = useState(null)
  const [filter, setFilter] = useState('all')

  const doFetch = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const items = await loadLiveNews()
      if (items.length > 0) {
        setNews(items)
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
    const timer = setInterval(() => doFetch(true), 20 * 60 * 1000)
    return () => clearInterval(timer)
  }, [doFetch])

  const tabs = buildDynamicTabs(news)
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
          />
        ))}
        <div style={{ height: 32 }} />
      </div>
    </div>
  )
}
