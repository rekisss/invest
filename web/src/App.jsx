import { useState, useEffect, useLayoutEffect, useRef, useCallback, lazy, Suspense } from 'react'
import Overview from './components/Overview.jsx'
import { animateTabIn } from './utils/animeUtils.js'

// Lazy-load non-landing tabs so the initial bundle only contains Overview
const Dashboard = lazy(() => import('./components/Dashboard.jsx'))
const NewsFeed = lazy(() => import('./components/NewsFeed.jsx'))
const PredictionPanel = lazy(() => import('./components/PredictionPanel.jsx'))
const AgentPanel = lazy(() => import('./components/AgentPanel.jsx'))
const QuotaPanel = lazy(() => import('./components/QuotaPanel.jsx'))
const Portfolio = lazy(() => import('./components/Portfolio.jsx'))
const GeminiStudio = lazy(() => import('./components/GeminiStudio.jsx'))
const LiveMonitor = lazy(() => import('./components/LiveMonitor.jsx'))
const ValidationPanel = lazy(() => import('./components/ValidationPanel.jsx'))

const BASE = import.meta.env.BASE_URL || '/'

const TABS = [
  { key: 'overview',   label: '總覽', icon: '⚡' },
  { key: 'dashboard',  label: '掃描', icon: '📊' },
  { key: 'validate',   label: '驗證', icon: '🔬' },
  { key: 'portfolio',  label: '持倉', icon: '💼' },
  { key: 'monitor',    label: '盯盤', icon: '📈' },
  { key: 'news',       label: '新聞', icon: '📰' },
  { key: 'predict',    label: '預測', icon: '🔮' },
  { key: 'studio',     label: '圓桌', icon: '🎯' },
  { key: 'quota',      label: '配額', icon: '📡' },
  { key: 'ai',         label: 'AI',   icon: '🤖' },
]

const TAB_TITLES = {
  overview:  '今日總覽',
  dashboard: '掃描結果',
  validate:  '選股驗證',
  portfolio: '持倉追蹤',
  monitor:   '即時盯盤',
  news:      '市場新聞',
  predict:   '盤前預測',
  studio:    'AI 圓桌研究室',
  quota:     '配額狀態',
  ai:        'AI 助手',
}

// Wrapper that spring-animates in from left/right using anime.js on every mount
function AnimatedTabPanel({ direction, onDone, style, children }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    animateTabIn(ref.current, direction, onDone)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div ref={ref} style={{ ...style, opacity: direction ? 0 : 1 }}>
      {children}
    </div>
  )
}

export default function App() {
  const [tabIdx, setTabIdx] = useState(0)
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('anthropic_key') || '')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [refreshCount, setRefreshCount] = useState(0)
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme_pref') || 'dark' } catch { return 'dark' }
  })

  useEffect(() => {
    try {
      document.documentElement.dataset.theme = theme
      localStorage.setItem('theme_pref', theme)
    } catch { /* ignore */ }
  }, [theme])

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark')
  const themeIcon  = theme === 'dark' ? '🌙' : '☀️'

  // slideDir tracks the direction of the last tab switch; cleared once animation completes
  const [slideDir, setSlideDir] = useState(null)

  const tab = TABS[tabIdx].key

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

  useEffect(() => {
    const handler = () => setTabIdx(TABS.findIndex(t => t.key === 'studio'))
    window.addEventListener('navigate-to-studio', handler)
    return () => window.removeEventListener('navigate-to-studio', handler)
  }, [])

  function goToTab(newIdx) {
    if (newIdx === tabIdx) return
    setSlideDir(newIdx > tabIdx ? 'right' : 'left')
    setTabIdx(newIdx)
  }

  // ── Drag across the bottom tab bar to switch tabs (connected feel) ──
  const tabbarRef = useRef(null)
  const tabDragRef = useRef({ active: false, x0: 0, y0: 0, moved: false })

  const idxFromClientX = (clientX) => {
    const el = tabbarRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const idx = Math.floor(((clientX - r.left) / r.width) * TABS.length)
    return Math.max(0, Math.min(TABS.length - 1, idx))
  }

  const onTabTouchStart = (e) => {
    const t = e.touches[0]
    tabDragRef.current = { active: true, x0: t.clientX, y0: t.clientY, moved: false }
  }
  const onTabTouchMove = (e) => {
    const d = tabDragRef.current
    if (!d.active) return
    const t = e.touches[0]
    // Only treat as a horizontal drag once it's clearly sideways (lets vertical scroll pass)
    if (!d.moved && Math.abs(t.clientX - d.x0) < 12) return
    if (Math.abs(t.clientX - d.x0) < Math.abs(t.clientY - d.y0)) return
    d.moved = true
    const idx = idxFromClientX(t.clientX)
    if (idx != null && idx !== tabIdx) goToTab(idx)
  }
  const onTabTouchEnd = () => { tabDragRef.current.active = false }

  const formattedTime = (() => {
    if (!data?.generated_at) return null
    const d = new Date(data.generated_at)
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d)
  })()

  const tabContent = (() => {
    if (loading) return null
    switch (tab) {
      case 'overview':   return <Overview data={data} error={error} />
      case 'dashboard':  return <Dashboard data={data} error={error} />
      case 'validate':   return <ValidationPanel data={data} />
      case 'portfolio':  return <Portfolio data={data} />
      case 'monitor':    return <LiveMonitor data={data} />
      case 'news':       return <NewsFeed staticNews={data?.news} refreshSignal={refreshCount} />
      case 'predict':    return <PredictionPanel prediction={data?.prediction} history={data?.predictionHistory || []} />
      case 'studio':     return null
      case 'quota':      return <QuotaPanel quota={data?.quota} generatedAt={data?.generated_at} />
      case 'ai':         return <AgentPanel
        apiKey={apiKey}
        data={data}
        onSaveKey={key => { sessionStorage.setItem('anthropic_key', key); setApiKey(key) }}
        onClearKey={() => { sessionStorage.removeItem('anthropic_key'); setApiKey('') }}
      />
      default: return null
    }
  })()

  const panelStyle = { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'transparent' }}>
      <style>{`
        @keyframes titleReveal {
          from { opacity: 0; transform: translateY(8px); filter: blur(6px); letter-spacing: 0.5px; }
          to   { opacity: 1; transform: translateY(0);   filter: blur(0);   letter-spacing: -0.6px; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes titleReveal { from { opacity: 1; } to { opacity: 1; } }
        }
      `}</style>

      {/* ── iOS Navigation Bar ───────────────────────────────────── */}
      <div className="ios-nav">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 88 }}>
          <button
            onClick={toggleTheme}
            title={`切換至${theme === 'dark' ? '淺色' : '深色'}模式`}
            style={{
              background: 'var(--ios-fill2)', border: '0.5px solid var(--ios-sep)',
              borderRadius: 9999, width: 28, height: 28, fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', flexShrink: 0, lineHeight: 1,
            }}
          >{themeIcon}</button>
          <span style={{ fontSize: 11, color: 'var(--ios-label3)' }}>{formattedTime || ''}</span>
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
      <div style={{ padding: '12px 20px 16px', background: 'transparent', flexShrink: 0 }}>
        <div
          key={tab}
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 32, fontWeight: 700, letterSpacing: '-0.6px', lineHeight: 1.32, paddingBottom: 1,
            background: 'var(--title-gradient)',
            WebkitBackgroundClip: 'text', backgroundClip: 'text',
            WebkitTextFillColor: 'transparent', color: 'transparent',
            textShadow: '0 0 28px rgba(120,140,255,0.18)',
            animation: 'titleReveal 0.5s cubic-bezier(0.22,1,0.36,1) both',
          }}
        >
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

        {/* Animated panel — all tabs except studio */}
        {!loading && tab !== 'studio' && (
          <AnimatedTabPanel
            key={tab}
            direction={slideDir}
            onDone={() => setSlideDir(null)}
            style={panelStyle}
          >
            <Suspense fallback={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                <div style={{ width: 28, height: 28, border: '3px solid var(--ios-fill3)', borderTop: '3px solid var(--ios-blue)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              </div>
            }>
              {tabContent}
            </Suspense>
          </AnimatedTabPanel>
        )}

        {/* GeminiStudio — always mounted once data loads; hidden via display:none when inactive */}
        {!loading && (
          <div style={{ ...panelStyle, display: tab === 'studio' ? 'flex' : 'none' }}>
            {tab === 'studio' ? (
              <AnimatedTabPanel key="studio-visible" direction={slideDir} onDone={() => setSlideDir(null)} style={panelStyle}>
                <Suspense fallback={
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                    <div style={{ width: 28, height: 28, border: '3px solid var(--ios-fill3)', borderTop: '3px solid var(--ios-blue)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  </div>
                }>
                  <GeminiStudio data={data} />
                </Suspense>
              </AnimatedTabPanel>
            ) : (
              <Suspense fallback={null}>
                <GeminiStudio data={data} />
              </Suspense>
            )}
          </div>
        )}
      </div>

      {/* ── iOS Tab Bar (drag across to switch) ───────────────────── */}
      <div
        className="ios-tabbar"
        ref={tabbarRef}
        style={{ touchAction: 'pan-y' }}
        onTouchStart={onTabTouchStart}
        onTouchMove={onTabTouchMove}
        onTouchEnd={onTabTouchEnd}
      >
        {TABS.map((t, i) => {
          const active = tabIdx === i
          return (
            <button
              key={t.key}
              className={`ios-tab-btn${active ? ' active' : ''}`}
              onClick={() => goToTab(i)}
            >
              <span style={{
                fontSize: 21, lineHeight: 1,
                opacity: active ? 1 : 0.4,
                filter: active ? 'none' : 'grayscale(0.4)',
                transform: active ? 'scale(1.12) translateY(-1px)' : 'scale(1)',
                transition: 'transform 0.18s cubic-bezier(0.22,1,0.36,1), opacity 0.18s',
              }}>
                {t.icon}
              </span>
              <span style={{
                fontSize: 10, fontWeight: active ? 700 : 500,
                color: active ? 'var(--ios-blue)' : 'var(--ios-label3)',
                transition: 'color 0.18s',
              }}>
                {t.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
