import { useState, useEffect, useCallback, useRef } from 'react'
import Dashboard from './components/Dashboard.jsx'
import NewsFeed from './components/NewsFeed.jsx'
import PredictionPanel from './components/PredictionPanel.jsx'
import ApiKeyInput from './components/ApiKeyInput.jsx'
import AgentPanel from './components/AgentPanel.jsx'
import QuotaPanel from './components/QuotaPanel.jsx'

const BASE = import.meta.env.BASE_URL || '/'

// Returns true if the touch target is inside a horizontally scrollable element
// that actually has overflowing content — skip page-swipe in that case
function startsOnHScrollable(target, root) {
  let el = target
  while (el && el !== root) {
    const { overflowX } = window.getComputedStyle(el)
    if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 4) return true
    el = el.parentElement
  }
  return false
}

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
  const [tabIdx, setTabIdx] = useState(0)
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('anthropic_key') || '')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [refreshCount, setRefreshCount] = useState(0)

  // Swipe state
  const [swipeOffset, setSwipeOffset] = useState(0)
  const [snapBack, setSnapBack] = useState(false)
  const [slideDir, setSlideDir] = useState(null) // 'left' | 'right'
  const touchRef = useRef(null)
  const contentRef = useRef(null)

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

  function goToTab(newIdx) {
    if (newIdx === tabIdx) return
    setSlideDir(newIdx > tabIdx ? 'right' : 'left')
    setTabIdx(newIdx)
  }

  function onTouchStart(e) {
    // Don't intercept touches that begin on a horizontally scrollable element
    if (startsOnHScrollable(e.target, contentRef.current)) {
      touchRef.current = null
      return
    }
    touchRef.current = {
      x0: e.touches[0].clientX,
      y0: e.touches[0].clientY,
      t0: Date.now(),
      horiz: null,
    }
    setSnapBack(false)
  }

  function onTouchMove(e) {
    if (!touchRef.current) return
    const dx = e.touches[0].clientX - touchRef.current.x0
    const dy = e.touches[0].clientY - touchRef.current.y0

    // Determine direction on first significant movement
    if (touchRef.current.horiz === null) {
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        touchRef.current.horiz = Math.abs(dx) >= Math.abs(dy)
      }
      return
    }

    if (!touchRef.current.horiz) return // vertical scroll — don't intercept

    e.preventDefault() // block page scroll during horizontal swipe

    // Rubber band at first/last tab
    let offset = dx
    if ((dx > 0 && tabIdx === 0) || (dx < 0 && tabIdx === TABS.length - 1)) {
      offset = dx * 0.15
    }
    setSwipeOffset(offset)
  }

  function onTouchEnd() {
    if (!touchRef.current) return
    if (!touchRef.current.horiz) {
      touchRef.current = null
      return
    }

    const W = contentRef.current?.offsetWidth || window.innerWidth
    const elapsed = Math.max(Date.now() - touchRef.current.t0, 1)
    const vel = swipeOffset / elapsed // px/ms

    const goNext = swipeOffset < -(W * 0.28) || vel < -0.4
    const goPrev = swipeOffset >  (W * 0.28) || vel >  0.4

    if (goNext && tabIdx < TABS.length - 1) {
      setSlideDir('right')
      setTabIdx(tabIdx + 1)
      setSwipeOffset(0) // instant reset; slide-in handles the visual
      setSnapBack(false)
    } else if (goPrev && tabIdx > 0) {
      setSlideDir('left')
      setTabIdx(tabIdx - 1)
      setSwipeOffset(0)
      setSnapBack(false)
    } else {
      setSnapBack(true)   // animate rubber-band back
      setSwipeOffset(0)
    }

    touchRef.current = null
  }

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
      case 'dashboard': return <Dashboard data={data} error={error} />
      case 'news':      return <NewsFeed staticNews={data?.news} refreshSignal={refreshCount} />
      case 'predict':   return <PredictionPanel prediction={data?.prediction} history={data?.predictionHistory || []} />
      case 'quota':     return <QuotaPanel quota={data?.quota} generatedAt={data?.generated_at} />
      case 'ai':        return apiKey
        ? <AgentPanel apiKey={apiKey} onClearKey={() => { sessionStorage.removeItem('anthropic_key'); setApiKey('') }} />
        : <ApiKeyInput onSave={key => { sessionStorage.setItem('anthropic_key', key); setApiKey(key) }} />
      default: return null
    }
  })()

  // Slide-in animation — iOS spring easing, 0.28s
  const panelAnim = slideDir === 'right'
    ? 'slideInFromRight 0.28s cubic-bezier(0.22,1,0.36,1) both'
    : slideDir === 'left'
    ? 'slideInFromLeft 0.28s cubic-bezier(0.22,1,0.36,1) both'
    : 'none'

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--ios-bg)' }}>
<style>{`
        @keyframes slideInFromRight {
          from { transform: translateX(60px); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
        @keyframes slideInFromLeft {
          from { transform: translateX(-60px); opacity: 0; }
          to   { transform: translateX(0);     opacity: 1; }
        }
      `}</style>

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

      {/* ── Content (swipeable) ──────────────────────────────────── */}
      <div
        ref={contentRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{
          flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column',
          transform: `translateX(${swipeOffset}px)`,
          transition: snapBack ? 'transform 0.32s cubic-bezier(0.22,1,0.36,1)' : 'none',
          willChange: 'transform',
        }}
      >
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12 }}>
            <div style={{ width: 32, height: 32, border: '3px solid var(--ios-fill3)', borderTop: '3px solid var(--ios-blue)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ color: 'var(--ios-label2)', fontSize: 15 }}>載入中⋯</div>
          </div>
        )}

        {/* Animated panel wrapper — re-mounts on tab change to trigger animation */}
        {!loading && (
          <div
            key={tab}
            style={{
              flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column',
              animation: panelAnim,
            }}
            onAnimationEnd={() => setSlideDir(null)}
          >
            {tabContent}
          </div>
        )}
      </div>

      {/* ── iOS Tab Bar ──────────────────────────────────────────── */}
      <div className="ios-tabbar">
        {TABS.map((t, i) => (
          <button
            key={t.key}
            className={`ios-tab-btn${tabIdx === i ? ' active' : ''}`}
            onClick={() => goToTab(i)}
          >
            <span style={{ fontSize: 22, lineHeight: 1, opacity: tabIdx === i ? 1 : 0.45 }}>
              {t.icon}
            </span>
            <span style={{ fontSize: 10, fontWeight: 500, color: tabIdx === i ? 'var(--ios-blue)' : 'var(--ios-label2)' }}>
              {t.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
