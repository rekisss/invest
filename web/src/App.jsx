import { useState, useEffect, useCallback } from 'react'
import Dashboard from './components/Dashboard.jsx'
import NewsFeed from './components/NewsFeed.jsx'
import PredictionPanel from './components/PredictionPanel.jsx'
import ApiKeyInput from './components/ApiKeyInput.jsx'
import AgentPanel from './components/AgentPanel.jsx'
import QuotaPanel from './components/QuotaPanel.jsx'

const BASE = import.meta.env.BASE_URL || '/'

const TABS = [
  { key: 'dashboard', label: '掃描', icon: '📊' },
  { key: 'news',      label: '新聞', icon: '📰' },
  { key: 'predict',   label: '預測', icon: '🔮' },
  { key: 'quota',     label: '配額', icon: '📡' },
  { key: 'ai',        label: 'AI',   icon: '🤖' },
]

const TAB_TITLES = {
  dashboard: '掃描結果',
  news:      '市場新聞',
  predict:   '盤前預測',
  quota:     '配額狀態',
  ai:        'AI 助手',
}

export default function App() {
  const [tab, setTab] = useState('dashboard')
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('anthropic_key') || '')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [refreshCount, setRefreshCount] = useState(0)

  const loadData = useCallback((isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    fetch(`${BASE}data.json?t=${Date.now()}`)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json() })
      .then(d => {
        setData(d)
        setLoading(false)
        setRefreshing(false)
        if (isRefresh) setRefreshCount(c => c + 1)
      })
      .catch(e => { setError(e.message); setLoading(false); setRefreshing(false) })
  }, [])

  useEffect(() => { loadData(false) }, [loadData])

  const formattedTime = (() => {
    if (!data?.generated_at) return null
    const d = new Date(data.generated_at)
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d)
  })()

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--ios-bg)' }}>

      {/* ── iOS Navigation Bar ───────────────────────────────────── */}
      <div className="ios-nav">
        <div style={{ fontSize: 12, color: 'var(--ios-label2)', minWidth: 80 }}>
          {formattedTime || ''}
        </div>
        <div className="ios-nav-title">台股 AI 助手</div>
        <button
          className="ios-refresh-btn"
          onClick={() => loadData(true)}
          disabled={refreshing}
        >
          <span style={{ display: 'inline-block', animation: refreshing ? 'spin 0.8s linear infinite' : 'none', fontSize: 14 }}>↻</span>
          {refreshing ? '更新中' : '刷新'}
        </button>
      </div>

      {/* ── Large Title ──────────────────────────────────────────── */}
      <div style={{ padding: '8px 20px 4px', background: 'var(--ios-bg)', flexShrink: 0 }}>
        <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-0.3px', color: 'var(--ios-label)', lineHeight: 1.2 }}>
          {TAB_TITLES[tab]}
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12 }}>
            <div style={{ width: 32, height: 32, border: '3px solid var(--ios-fill3)', borderTop: '3px solid var(--ios-blue)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ color: 'var(--ios-label2)', fontSize: 15 }}>載入中⋯</div>
          </div>
        )}
        {!loading && tab === 'dashboard' && <Dashboard data={data} error={error} />}
        {!loading && tab === 'news' && <NewsFeed staticNews={data?.news} refreshSignal={refreshCount} />}
        {!loading && tab === 'predict' && <PredictionPanel prediction={data?.prediction} history={data?.predictionHistory || []} />}
        {!loading && tab === 'quota' && <QuotaPanel quota={data?.quota} generatedAt={data?.generated_at} />}
        {!loading && tab === 'ai' && (
          apiKey
            ? <AgentPanel apiKey={apiKey} onClearKey={() => { sessionStorage.removeItem('anthropic_key'); setApiKey('') }} />
            : <ApiKeyInput onSave={key => { sessionStorage.setItem('anthropic_key', key); setApiKey(key) }} />
        )}
      </div>

      {/* ── iOS Tab Bar ──────────────────────────────────────────── */}
      <div className="ios-tabbar">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`ios-tab-btn${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <span style={{ fontSize: 22, lineHeight: 1, opacity: tab === t.key ? 1 : 0.45 }}>
              {t.icon}
            </span>
            <span style={{ fontSize: 10, fontWeight: 500, color: tab === t.key ? 'var(--ios-blue)' : 'var(--ios-label2)' }}>
              {t.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
