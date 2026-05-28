import { useState, useEffect, useCallback } from 'react'

const CAT_COLOR = {
  market: 'var(--accent)',
  tsmc: 'var(--purple)',
  institutional: 'var(--yellow)',
  us: 'var(--orange)',
  tech: 'var(--green)',
}
const CAT_ICON = { market: '📊', tsmc: '🏭', institutional: '🏦', us: '🌎', tech: '💻' }

const CATS = [
  { key: 'all', label: '全部' },
  { key: 'market', label: '📊 大盤' },
  { key: 'tsmc', label: '🏭 台積電' },
  { key: 'institutional', label: '🏦 外資' },
  { key: 'us', label: '🌎 美股' },
  { key: 'tech', label: '💻 科技' },
]

const QUERIES = [
  { q: '台灣股市 大盤', category: 'market', label: '大盤' },
  { q: '台積電 2330', category: 'tsmc', label: '台積電' },
  { q: '外資 期貨 台指', category: 'institutional', label: '外資法人' },
  { q: '美股 那斯達克 費半', category: 'us', label: '美股' },
  { q: '半導體 AI 科技股', category: 'tech', label: '科技半導體' },
]

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
    QUERIES.map(async ({ q, category, label }) => {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`
      const resp = await fetch(`https://corsproxy.io/?${encodeURIComponent(rssUrl)}`, {
        signal: AbortSignal.timeout(12000),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const xml = await resp.text()
      return parseRSS(xml).slice(0, 7).map(item => ({ ...item, category, label }))
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
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .slice(0, 50)
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

function NewsItem({ item, isOpen, onToggle }) {
  const color = CAT_COLOR[item.category] || 'var(--muted)'
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
        <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{CAT_ICON[item.category] || '📰'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.5, color: 'var(--text)' }}>{item.title}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color, background: `${color}22`, padding: '1px 6px', borderRadius: 3, fontWeight: 600 }}>
              {item.label || item.category}
            </span>
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
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block', fontSize: 12, color: 'var(--accent)',
              border: '1px solid var(--accent)', borderRadius: 4, padding: '4px 10px',
              textDecoration: 'none', fontWeight: 600,
            }}
          >
            閱讀全文 ↗
          </a>
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

  const filtered = filter === 'all' ? news : news.filter(n => n.category === filter)

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
      {/* Category tabs + status bar */}
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {CATS.map(cat => (
            <button
              key={cat.key}
              onClick={() => { setFilter(cat.key); setOpenIdx(null) }}
              style={{
                padding: '10px 14px', fontSize: 12, fontWeight: 600, border: 'none',
                borderBottom: `2px solid ${filter === cat.key ? 'var(--accent)' : 'transparent'}`,
                background: 'transparent', color: filter === cat.key ? 'var(--accent)' : 'var(--muted)',
                cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
              }}
            >
              {cat.label}
              {cat.key !== 'all' && (
                <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>
                  ({news.filter(n => n.category === cat.key).length})
                </span>
              )}
            </button>
          ))}
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
