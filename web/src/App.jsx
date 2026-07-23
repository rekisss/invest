import { useState, useEffect, useLayoutEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { animate } from 'animejs'
import Overview from './components/Overview.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { animateTabIn, installPressFeedback } from './utils/animeUtils.js'
import { getStockHistories } from './utils/histCache.js'

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
const Performance = lazy(() => import('./components/Performance.jsx'))
const AITrader = lazy(() => import('./components/AITrader.jsx'))
const StockDetailModal = lazy(() => import('./components/StockDetailModal.jsx'))

const BASE = import.meta.env.BASE_URL || '/'

const TABS = [
  { key: 'overview',   label: '總覽', icon: '⚡' },
  { key: 'dashboard',  label: '掃描', icon: '📊' },
  { key: 'validate',   label: '驗證', icon: '🔬' },
  { key: 'portfolio',  label: '持倉', icon: '💼' },
  { key: 'aitrader',   label: 'AI操盤', icon: '🤖' },
  { key: 'perf',       label: '績效', icon: '💰' },
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
  aitrader:  'AI 系統交易員',
  perf:      '績效驗證與持倉建議',
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

// Like AnimatedTabPanel, but for the Studio tab specifically: GeminiStudio owns
// long-running AI roundtable state (in-flight streaming, autoRun timers), so it
// must stay mounted across tab switches rather than being torn down/recreated.
// Toggles visibility via display:none and re-plays the entry animation each
// time it becomes active, without ever unmounting `children`.
function StudioPanel({ active, direction, onDone, style, children }) {
  const ref = useRef(null)
  const wasActive = useRef(active)
  useLayoutEffect(() => {
    if (active && !wasActive.current) animateTabIn(ref.current, direction, onDone)
    wasActive.current = active
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  return (
    <div ref={ref} style={{ ...style, display: active ? 'flex' : 'none' }}>
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

  // ── Scan update toast ─────────────────────────────────────────────────────
  const [toast, setToast] = useState(null)
  const toastRef = useRef(null)
  const prevScanDateRef = useRef(null)

  // ── Global stock detail modal (opened via 'openStockDetail' event from
  //    news stock-tag chips and in-modal sector-peer clicks) ─────────────────
  const [globalStock, setGlobalStock] = useState(null)
  const [globalCompare, setGlobalCompare] = useState(null)
  const [globalDates, setGlobalDates] = useState(null)
  const globalHistRef = useRef(null)
  // Timestamp of the data.json currently in state, used to skip redundant
  // re-downloads/re-parses of the (multi-MB) file on periodic auto-refresh.
  const lastGeneratedAtRef = useRef(null)

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

    // bypassSwCache(fresh=1):meta.json 已確認伺服器有新版時使用——SW 對
    // data.json 是 stale-while-revalidate,一般請求會先拿到舊快取;fresh=1
    // 讓 SW 走網路優先,保證這次抓回來的就是新版。
    const doFullLoad = (bypassSwCache = false) => fetch(`${BASE}data.json?t=${Date.now()}${bypassSwCache ? '&fresh=1' : ''}`)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json() })
      .then(d => {
        setData(d)
        lastGeneratedAtRef.current = d?.generated_at || null
        setLoading(false)
        setRefreshing(false)
        if (isRefresh) setRefreshCount(c => c + 1)
        // 首次載入拿到的可能是 SW 舊快取(先秒開再說)。立刻用 meta.json
        // (network-first、幾百 bytes)驗證版本,發現伺服器已有新版就以
        // fresh=1 重抓換上——把「開頁看到舊資料」的窗口從等 5 分鐘定時
        // 刷新縮到幾秒,解決「資料明明部署了、手機卻一直是舊的」。
        if (!isRefresh && !bypassSwCache) {
          fetch(`${BASE}meta.json?t=${Date.now()}`)
            .then(r => (r.ok ? r.json() : null))
            .then(meta => {
              if (meta?.data_generated_at && meta.data_generated_at !== lastGeneratedAtRef.current) {
                setRefreshing(true)
                doFullLoad(true)
              }
            })
            .catch(() => {})
        }
      })
      .catch(e => { setError(e.message); setLoading(false); setRefreshing(false) })

    // On the initial load (or if we've never recorded a version) there's
    // nothing to compare against — just load the full file.
    if (!isRefresh || !lastGeneratedAtRef.current) {
      doFullLoad()
      return
    }

    // Periodic/manual refresh: meta.json is a few hundred bytes. Only pay
    // the cost of re-downloading and re-parsing the multi-MB data.json when
    // it actually changed, instead of doing that on every 5-minute tick.
    fetch(`${BASE}meta.json?t=${Date.now()}`)
      .then(r => (r.ok ? r.json() : null))
      .then(meta => {
        if (meta && meta.data_generated_at === lastGeneratedAtRef.current) {
          setRefreshing(false)
          setRefreshCount(c => c + 1)
          return
        }
        // meta 已確認有新版 → fresh=1 繞過 SW 舊快取,保證抓到新資料
        return doFullLoad(true)
      })
      .catch(() => doFullLoad())
  }, [])

  useEffect(() => { loadData(false) }, [loadData])

  // 強制更新:清掉所有快取 + 反註冊 Service Worker 後硬重載。給「手機卡在
  // 舊版、連自動更新邏輯都拿不到」的最後手段——一鍵保證抓到最新部署。
  const [hardBusy, setHardBusy] = useState(false)
  const hardRefresh = useCallback(async () => {
    setHardBusy(true)
    try {
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map(k => caches.delete(k)))
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map(r => r.unregister()))
      }
    } catch { /* 清不掉就直接硬重載 */ }
    // 帶時間戳繞過 HTTP 快取,確保連 index.html 都重抓
    const u = new URL(window.location.href)
    u.searchParams.set('_fresh', Date.now())
    window.location.replace(u.toString())
  }, [])

  useEffect(() => {
    const handler = () => setTabIdx(TABS.findIndex(t => t.key === 'studio'))
    window.addEventListener('navigate-to-studio', handler)
    // 通用分頁跳轉(首頁摘要卡等用):detail 為 tab key
    const navTo = (e) => {
      const i = TABS.findIndex(t => t.key === e.detail)
      if (i >= 0) setTabIdx(i)
    }
    window.addEventListener('navigate-to-tab', navTo)
    return () => {
      window.removeEventListener('navigate-to-studio', handler)
      window.removeEventListener('navigate-to-tab', navTo)
    }
  }, [])

  // Resolve a (possibly partial) {stock_id} into a full scan stock object
  const resolveStock = useCallback((detail) => {
    if (!detail?.stock_id) return null
    const id = String(detail.stock_id)
    // A peer object from the modal already carries full fields — use directly
    if (detail.close != null || detail.entry_score != null) return { ...detail, stock_id: id }
    const scans = data?.scans || {}
    for (const date of Object.keys(scans).sort().reverse()) {
      const sc = scans[date]
      const found = [...(sc?.top_stocks || []), ...(sc?.filter_stocks || [])]
        .find(x => String(x.stock_id) === id)
      if (found) return { ...found, stock_id: id }
    }
    return { stock_id: id, name: detail.name || '' }
  }, [data])

  // Listen for global open-stock-detail requests (news tags, sector peers)
  useEffect(() => {
    const handler = async (e) => {
      const stock = resolveStock(e.detail)
      if (!stock) return
      setGlobalStock(stock)
      // Lazy-load price histories once, then enrich the open stock with its k-line
      if (!globalHistRef.current) {
        try {
          const h = await getStockHistories(BASE)
          globalHistRef.current = h || {}
          if (h?.stocks) setGlobalCompare(h.stocks)
          if (Array.isArray(h?.dates)) setGlobalDates(h.dates)
        } catch { globalHistRef.current = {} }
      }
      const h = globalHistRef.current
      const id = String(stock.stock_id)
      const kline = h?.stocks?.[id]
      const scanHist = h?.scan_stocks?.[id]
      const dates = h?.dates || []
      let priceHistory = null
      if (kline?.c) {
        priceHistory = dates.map((t, i) => kline.c[i] == null ? null : {
          time: t, open: kline.o?.[i] ?? kline.c[i], high: kline.h?.[i] ?? kline.c[i],
          low: kline.l?.[i] ?? kline.c[i], close: kline.c[i], volume: kline.v?.[i] ?? 0,
        }).filter(Boolean)
      } else if (Array.isArray(scanHist) && scanHist.length >= 2) {
        priceHistory = scanHist.map(b => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] }))
      }
      if (priceHistory) {
        setGlobalStock(prev => prev?.stock_id === id ? { ...prev, price_history: priceHistory } : prev)
      }
    }
    document.addEventListener('openStockDetail', handler)
    return () => document.removeEventListener('openStockDetail', handler)
  }, [resolveStock])

  // ── Toast helper ──────────────────────────────────────────────────────────
  function showScanToast(message) {
    setToast(message)
    setTimeout(() => setToast(null), 4000)
  }

  // Detect when data refreshes to a newer scan date and show a toast
  useEffect(() => {
    if (!data?.dates?.length) return
    const latestDate = data.dates[0] // dates sorted desc, first = latest
    if (prevScanDateRef.current && prevScanDateRef.current !== latestDate) {
      const scan = data.scans?.[latestDate]
      const entryCount = scan?.entry_count || 0
      showScanToast(`掃描更新 ${latestDate}，${entryCount} 支進場信號`)
    }
    prevScanDateRef.current = latestDate
  }, [data])

  // Auto-refresh every 5 min when data is stale (days_behind > 1) or scan count is low
  useEffect(() => {
    if (!data?.dataQuality) return
    const dq = data.dataQuality
    const needsRefresh = (dq.days_behind != null && dq.days_behind > 1) || (dq.total_stocks > 0 && dq.total_stocks < 500)
    if (!needsRefresh) return
    const id = setInterval(() => loadData(true), 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [data, loadData])

  // Animate toast in whenever it appears
  useEffect(() => {
    if (toast && toastRef.current) {
      animate(toastRef.current, {
        opacity: [0, 1],
        translateY: ['-20px', '0px'],
        duration: 300,
        easing: 'easeOutCubic',
      })
    }
  }, [toast])

  function goToTab(newIdx) {
    if (newIdx === tabIdx) return
    setSlideDir(newIdx > tabIdx ? 'right' : 'left')
    setTabIdx(newIdx)
  }

  // ── 全域按鈕按壓回饋(anime.js spring,事件委派一次安裝)──
  // 內容區「滑動切換分頁」已依使用者回饋移除(容易誤觸);切換分頁請用
  // 底部 tab bar(點擊或在 bar 上拖曳)。
  useEffect(() => installPressFeedback(), [])

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
      case 'validate':   return <ValidationPanel data={data} onRefresh={() => loadData(true)} />
      case 'portfolio':  return <Portfolio data={data} />
      case 'aitrader':   return <AITrader data={data} />
      case 'perf':       return <Performance data={data} />
      case 'monitor':    return <LiveMonitor data={data} />
      case 'news':       return <NewsFeed staticNews={data?.news} refreshSignal={refreshCount} data={data} />
      case 'predict':    return <PredictionPanel prediction={data?.prediction} history={data?.predictionHistory || []} benchCurve={data?.aiTrader?.benchmark?.curve || []} realOutcomes={data?.realOutcomes || null} />
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
      {/* ── Scan update toast ────────────────────────────────────────── */}
      {toast && (
        <div ref={toastRef} style={{
          position: 'fixed', top: 'calc(env(safe-area-inset-top) + 12px)',
          left: '50%', transform: 'translateX(-50%)',
          background: 'var(--ios-green)', color: '#fff',
          padding: '8px 18px', borderRadius: 20,
          fontSize: 13, fontWeight: 600,
          zIndex: 9999, pointerEvents: 'none',
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
          whiteSpace: 'nowrap',
        }}>
          📊 {toast}
        </div>
      )}

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
          onContextMenu={(e) => { e.preventDefault(); hardRefresh() }}
          disabled={refreshing}
          title="點一下：刷新資料　·　長按/右鍵:強制更新(清快取)"
        >
          <span style={{ display: 'inline-block', animation: (refreshing || hardBusy) ? 'spin 0.8s linear infinite' : 'none', fontSize: 14 }}>↻</span>
          {hardBusy ? '清快取' : refreshing ? '更新中' : '刷新'}
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
        {/* 資料日期 + 強制更新:讓使用者一眼看到載入的是哪天的資料,舊了可一鍵
            清快取重載(手機卡舊版的最後手段) */}
        {data?.dates?.[0] && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 10.5, color: 'var(--ios-label4)' }}>
            <span>資料日期 {data.dates[0]}</span>
            <button
              onClick={hardRefresh}
              disabled={hardBusy}
              style={{ background: 'none', border: '0.5px solid var(--ios-sep)', borderRadius: 6, padding: '1px 7px', fontSize: 10, color: 'var(--ios-blue)', cursor: 'pointer' }}
            >{hardBusy ? '清快取中…' : '強制更新'}</button>
          </div>
        )}
      </div>

      {/* ── Content ──────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12 }}>
            <div style={{ width: 32, height: 32, border: '3px solid var(--ios-fill3)', borderTop: '3px solid var(--ios-blue)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ color: 'var(--ios-label2)', fontSize: 15 }}>載入中⋯</div>
          </div>
        )}

        {/* Full error screen — initial load failed */}
        {!loading && !data && error && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, padding: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 44 }}>📡</div>
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ios-label)' }}>無法載入資料</div>
            <div style={{ fontSize: 14, color: 'var(--ios-label2)', maxWidth: 260, lineHeight: 1.5 }}>請確認網路連線後重試</div>
            <div style={{ fontSize: 11, color: 'var(--ios-red)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>{error}</div>
            <button
              onClick={() => loadData(false)}
              style={{ marginTop: 8, fontSize: 14, color: '#fff', background: 'var(--ios-blue)', border: 'none', borderRadius: 10, padding: '8px 24px', cursor: 'pointer', fontWeight: 600 }}
            >重試</button>
          </div>
        )}

        {/* Refresh-failed banner — data available but latest refresh errored */}
        {!loading && data && error && (
          <div style={{ background: 'rgba(255,51,64,0.1)', borderBottom: '0.5px solid rgba(255,51,64,0.2)', padding: '5px 16px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: '#FF3340', flex: 1 }}>⚠️ 刷新失敗：{error}</span>
            <button onClick={() => loadData(false)} style={{ fontSize: 10, color: '#FF3340', background: 'none', border: '0.5px solid rgba(255,51,64,0.35)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', flexShrink: 0 }}>重試</button>
          </div>
        )}

        {/* Animated panel — all tabs except studio */}
        {!loading && !!data && tab !== 'studio' && (
          <AnimatedTabPanel
            key={tab}
            direction={slideDir}
            onDone={() => setSlideDir(null)}
            style={panelStyle}
          >
            <ErrorBoundary resetKey={tab}>
              <Suspense fallback={
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                  <div style={{ width: 28, height: 28, border: '3px solid var(--ios-fill3)', borderTop: '3px solid var(--ios-blue)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                </div>
              }>
                {tabContent}
              </Suspense>
            </ErrorBoundary>
          </AnimatedTabPanel>
        )}

        {/* GeminiStudio — always mounted once data loads; hidden via display:none when inactive.
            Uses StudioPanel (not AnimatedTabPanel) so switching tabs never unmounts it: it owns
            in-flight AI roundtable state (streaming, autoRun timers) that a remount would drop. */}
        {!loading && !!data && (
          <StudioPanel active={tab === 'studio'} direction={slideDir} onDone={() => setSlideDir(null)} style={panelStyle}>
            <ErrorBoundary>
              <Suspense fallback={
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                  <div style={{ width: 28, height: 28, border: '3px solid var(--ios-fill3)', borderTop: '3px solid var(--ios-blue)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                </div>
              }>
                <GeminiStudio data={data} />
              </Suspense>
            </ErrorBoundary>
          </StudioPanel>
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

      {/* ── Global stock detail modal (news tags / sector peers) ──────── */}
      {globalStock && (
        <ErrorBoundary resetKey={globalStock?.stock_id} fallback={null}>
          <Suspense fallback={null}>
            <StockDetailModal
              stock={globalStock}
              onClose={() => setGlobalStock(null)}
              allScans={data?.scans}
              compareHistories={globalCompare}
              historyDates={globalDates}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  )
}
