import { useState } from 'react'

const CAT_COLOR = {
  market: 'var(--accent)',
  tsmc: 'var(--purple)',
  institutional: 'var(--yellow)',
  us: 'var(--orange)',
  tech: 'var(--green)',
}
const CAT_ICON = { market: '📊', tsmc: '🏭', institutional: '🏦', us: '🌎', tech: '💻' }

function timeAgo(dateStr) {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    const diff = (Date.now() - d) / 1000
    if (diff < 3600) return `${Math.round(diff / 60)} 分鐘前`
    if (diff < 86400) return `${Math.round(diff / 3600)} 小時前`
    return `${Math.round(diff / 86400)} 天前`
  } catch { return '' }
}

function NewsItem({ item, isOpen, onToggle }) {
  const color = CAT_COLOR[item.category] || 'var(--muted)'
  return (
    <div
      style={{
        borderBottom: '1px solid var(--border)',
        background: isOpen ? 'var(--surface)' : 'transparent',
        transition: 'background 0.15s',
      }}
    >
      <div
        onClick={onToggle}
        style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start' }}
      >
        <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{CAT_ICON[item.category] || '📰'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.5, color: 'var(--text)' }}>
            {item.title}
          </div>
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

const CATS = [
  { key: 'all', label: '全部' },
  { key: 'market', label: '📊 大盤' },
  { key: 'tsmc', label: '🏭 台積電' },
  { key: 'institutional', label: '🏦 外資' },
  { key: 'us', label: '🌎 美股' },
  { key: 'tech', label: '💻 科技' },
]

export default function NewsFeed({ news }) {
  const [openIdx, setOpenIdx] = useState(null)
  const [filter, setFilter] = useState('all')

  if (!news || news.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted)', gap: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 40 }}>📰</div>
        <div style={{ fontSize: 15, color: 'var(--text)' }}>新聞資料尚未載入</div>
        <div style={{ fontSize: 12 }}>下次部署後自動更新</div>
      </div>
    )
  }

  const filtered = filter === 'all' ? news : news.filter(n => n.category === filter)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Category filter */}
      <div style={{
        display: 'flex', gap: 0, borderBottom: '1px solid var(--border)',
        background: 'var(--surface)', overflowX: 'auto', flexShrink: 0,
        WebkitOverflowScrolling: 'touch',
      }}>
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
            {cat.key !== 'all' && <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>({news.filter(n => n.category === cat.key).length})</span>}
          </button>
        ))}
      </div>

      {/* News list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '8px 16px 4px', fontSize: 11, color: 'var(--muted)' }}>
          {filtered.length} 則新聞
        </div>
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
