import { useState, useEffect } from 'react'
import Dashboard from './components/Dashboard.jsx'
import NewsFeed from './components/NewsFeed.jsx'
import PredictionPanel from './components/PredictionPanel.jsx'
import ApiKeyInput from './components/ApiKeyInput.jsx'
import AgentPanel from './components/AgentPanel.jsx'

const BASE = import.meta.env.BASE_URL || '/'

const TABS = [
  { key: 'dashboard', label: '📊 掃描結果' },
  { key: 'news',      label: '📰 市場新聞' },
  { key: 'predict',   label: '🔮 盤前預測' },
  { key: 'ai',        label: '🤖 AI 助手' },
]

const TAB_BASE = {
  padding: '10px 14px',
  fontSize: 13,
  fontWeight: 600,
  border: 'none',
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--muted)',
  cursor: 'pointer',
  transition: 'color 0.15s',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}
const TAB_ACTIVE = { ...TAB_BASE, color: 'var(--accent)', borderBottom: '2px solid var(--accent)' }

export default function App() {
  const [tab, setTab] = useState('dashboard')
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('anthropic_key') || '')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch(`${BASE}data.json?t=${Date.now()}`)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json() })
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '0 16px',
        background: 'var(--bg)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10, paddingBottom: 2 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', letterSpacing: 0.5 }}>
            台股 AI 助手
          </div>
          {data?.generated_at && (
            <div style={{ fontSize: 10, color: 'var(--muted)' }}>
              更新 {data.generated_at.slice(0, 10)} {data.generated_at.slice(11, 16)} UTC
            </div>
          )}
        </div>
        {/* Tab bar */}
        <div style={{ display: 'flex', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {TABS.map(t => (
            <button key={t.key} style={tab === t.key ? TAB_ACTIVE : TAB_BASE} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted)' }}>
            載入中…
          </div>
        )}
        {!loading && tab === 'dashboard' && <Dashboard data={data} error={error} />}
        {!loading && tab === 'news' && <NewsFeed staticNews={data?.news} />}
        {!loading && tab === 'predict' && <PredictionPanel prediction={data?.prediction} />}
        {!loading && tab === 'ai' && (
          apiKey
            ? <AgentPanel apiKey={apiKey} onClearKey={() => { sessionStorage.removeItem('anthropic_key'); setApiKey('') }} />
            : <ApiKeyInput onSave={key => { sessionStorage.setItem('anthropic_key', key); setApiKey(key) }} />
        )}
      </div>
    </div>
  )
}
