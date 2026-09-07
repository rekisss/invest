// TradingView Advanced Chart —— 官方免費嵌入 widget
//
// 為什麼是 widget 而不是 API:
// TradingView 是「資料被授權方」,不是資料擁有者 —— 交易所的授權合約禁止它把
// 即時報價再轉授權出去。所以官方只開放兩種程式化介面:Charting Library / 嵌入
// widget(純顯示),以及 Broker REST API(給券商申請串接,沒有零售版)。
// 沒有任何零售訂閱方案(含月付方案)能買到報價 API —— 網路上那些「TradingView
// API / MCP」全是第三方打它未公開的內部端點,違反 ToS 且隨時會壞。
//
// 因此本專案的分工是:
//   即時報價「數字」 → 富果 / Shioaji(交易所正式授權,見 utils/fugleLive.js)
//   互動圖表 / 技術分析 → 這裡的 TradingView widget
//
// 注意 widget 的台股報價是「延遲」的(即時需另購台交所 realtime add-on,屬交易所
// 資料費,不含在一般訂閱裡)。所以本元件只當技術分析畫布用,價格數字一律以
// Dashboard 既有的富果/Shioaji 層為準。
//
// 載入策略:預設收合,使用者按下才注入 script。避免每次開個股 Modal 都去打
// 第三方(效能 + 不主動洩漏瀏覽行為給 TradingView)。

import { useEffect, useRef, useState, useLayoutEffect } from 'react'
import { animate } from 'animejs'

const WIDGET_SRC = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'

// 上櫃判定與 useLivePrices.isOTCStock 一致(TPEX vs TWSE 前綴會決定 widget 找不找得到標的)
function isOTCStock(stockId) {
  const n = parseInt(String(stockId), 10)
  return (n >= 4200 && n <= 4999) || (n >= 5000 && n <= 5999) ||
         (n >= 6000 && n <= 6999) || (n >= 7000 && n <= 7999) ||
         (n >= 8000 && n <= 8999) || (n >= 9200 && n <= 9999)
}

export function tvSymbol(stockId) {
  const id = String(stockId || '').trim()
  if (!/^\d{4,6}[A-Z]?$/.test(id)) return null   // 只接受台股代號格式,擋掉指數/奇怪輸入
  return `${isOTCStock(id) ? 'TPEX' : 'TWSE'}:${id}`
}

// 月票含分鐘線,所以把日內週期也開出來
const INTERVALS = [
  { id: '15', label: '15分' },
  { id: '60', label: '60分' },
  { id: 'D',  label: '日' },
  { id: 'W',  label: '週' },
  { id: 'M',  label: '月' },
]

export default function TradingViewChart({ stockId, stockName }) {
  const symbol = tvSymbol(stockId)
  const [open, setOpen]         = useState(false)
  const [interval, setIntervalId] = useState('D')
  const [failed, setFailed]     = useState(false)
  // 手機上圖表要換配置(側邊繪圖工具列在窄screen 沒有可用性,只會吃掉寬度)。
  // 用 matchMedia 而非一次性 innerWidth:轉橫向時要跟著重建 widget。
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches
  )
  // iframe 會吃掉觸控手勢:在可捲動的 Modal 裡,手指劃過圖表會變成平移 K 線
  // 而不是捲頁面,使用者會卡住。手機預設鎖住互動,點一下才啟用。
  const [touchArmed, setTouchArmed] = useState(false)
  const hostRef  = useRef(null)   // script 注入的容器(TradingView 會把 iframe 塞進來)
  const panelRef = useRef(null)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)')
    const onChange = e => setNarrow(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // 收合後重開、或切換週期重建圖表時,重新鎖住觸控
  useEffect(() => { if (!open) setTouchArmed(false) }, [open])

  // 展開動畫(專案規則:新動畫一律 anime.js;動畫前先指令式設初始狀態避免首幀閃爍)
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!open || !el) return
    el.style.opacity = '0'
    el.style.transform = 'translateY(8px)'
    animate(el, { opacity: [0, 1], translateY: [8, 0], duration: 420, ease: 'out(3)' })
  }, [open])

  // widget 注入 / 重建。symbol 或 interval 變了就整個重來 —— 官方 embed widget
  // 沒有公開的「改參數」API,重建是唯一可靠做法。
  useEffect(() => {
    if (!open || !symbol) return
    const host = hostRef.current
    if (!host) return

    setFailed(false)
    host.innerHTML = ''

    const inner = document.createElement('div')
    inner.className = 'tradingview-widget-container__widget'
    inner.style.height = '100%'
    host.appendChild(inner)

    const script = document.createElement('script')
    script.src = WIDGET_SRC
    script.async = true
    script.type = 'text/javascript'
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval,
      timezone: 'Asia/Taipei',
      theme: 'dark',
      style: '1',                 // 1 = 蠟燭圖
      locale: 'zh_TW',
      enable_publishing: false,
      allow_symbol_change: false, // 標的由 Modal 決定,不讓 widget 自己換
      hide_side_toolbar: narrow,  // 手機沒空間放繪圖工具列
      withdateranges: !narrow,
      details: false,
      studies: ['MASimple@tv-basicstudies', 'Volume@tv-basicstudies'],
      support_host: 'https://www.tradingview.com',
      // 台股慣例紅漲綠跌(TradingView 預設是綠漲紅跌)。overrides 為 best-effort:
      // 免費 embed widget 不保證吃這組參數,吃不到就是維持它的預設配色,無害。
      overrides: {
        'mainSeriesProperties.candleStyle.upColor': '#FF3340',
        'mainSeriesProperties.candleStyle.downColor': '#16D67E',
        'mainSeriesProperties.candleStyle.borderUpColor': '#FF3340',
        'mainSeriesProperties.candleStyle.borderDownColor': '#16D67E',
        'mainSeriesProperties.candleStyle.wickUpColor': '#FF3340',
        'mainSeriesProperties.candleStyle.wickDownColor': '#16D67E',
      },
    })
    script.onerror = () => setFailed(true)
    host.appendChild(script)

    // 沒有 onerror 但也沒長出 iframe(被擋廣告/企業網路/CSP)→ 一樣顯示退路連結
    const probe = setTimeout(() => {
      if (host.querySelector('iframe')) return
      setFailed(true)
    }, 8000)

    return () => { clearTimeout(probe); host.innerHTML = '' }
  }, [open, symbol, interval, narrow])

  if (!symbol) return null

  const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          width: '100%', background: 'var(--ios-fill4)', border: '0.5px solid var(--ios-sep)',
          borderRadius: 10, padding: '10px 12px', color: 'var(--ios-blue)',
          fontSize: 13, fontWeight: 500, cursor: 'pointer',
        }}
      >
        載入 TradingView 圖表 · {symbol}
      </button>
    )
  }

  return (
    <div ref={panelRef}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {INTERVALS.map(iv => (
          <button
            key={iv.id}
            onClick={() => setIntervalId(iv.id)}
            style={{
              background: interval === iv.id ? 'var(--ios-blue)' : 'var(--ios-fill4)',
              border: '0.5px solid var(--ios-sep)', borderRadius: 7,
              padding: '4px 10px', fontSize: 11, cursor: 'pointer',
              color: interval === iv.id ? '#fff' : 'var(--ios-label2)',
              fontWeight: interval === iv.id ? 600 : 400,
            }}
          >
            {iv.label}
          </button>
        ))}
        {/* 啟用互動後圖表會吃掉觸控,給一個鎖回去的出口,否則手機使用者被卡在圖表上 */}
        {narrow && touchArmed && (
          <button
            onClick={() => setTouchArmed(false)}
            style={{
              marginLeft: 'auto', background: 'var(--ios-fill4)',
              border: '0.5px solid var(--ios-sep)', borderRadius: 7,
              padding: '4px 10px', fontSize: 11, cursor: 'pointer', color: 'var(--ios-label2)',
            }}
          >
            鎖定捲動
          </button>
        )}
        <button
          onClick={() => setOpen(false)}
          style={{
            marginLeft: (narrow && touchArmed) ? 0 : 'auto', background: 'transparent',
            border: 'none', color: 'var(--ios-label3)', fontSize: 11,
            cursor: 'pointer', padding: '4px 6px',
          }}
        >
          收合
        </button>
      </div>

      {failed ? (
        <div style={{
          padding: '16px 12px', textAlign: 'center', background: 'var(--ios-fill4)',
          border: '0.5px solid var(--ios-sep)', borderRadius: 10,
        }}>
          <div style={{ fontSize: 12, color: 'var(--ios-label2)', marginBottom: 8 }}>
            TradingView 圖表載入失敗（可能被廣告阻擋器或網路環境擋下）
          </div>
          <a
            href={tvUrl} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 13, color: 'var(--ios-blue)', textDecoration: 'none', fontWeight: 500 }}
          >
            在 TradingView 開啟 {stockName || stockId} ↗
          </a>
        </div>
      ) : (
        <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden' }}>
          <div
            ref={hostRef}
            className="tradingview-widget-container"
            style={{ height: narrow ? 320 : 420, width: '100%' }}
          />
          {/* 手機:未啟用前蓋一層透明罩,讓手指可以正常捲動 Modal 而不是平移 K 線 */}
          {narrow && !touchArmed && (
            <button
              onClick={() => setTouchArmed(true)}
              aria-label="啟用圖表互動"
              style={{
                position: 'absolute', inset: 0, width: '100%',
                background: 'transparent', border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
                padding: 0, paddingBottom: 10,
              }}
            >
              <span style={{
                background: 'rgba(0,0,0,0.62)', color: '#fff', fontSize: 11,
                padding: '5px 12px', borderRadius: 999, backdropFilter: 'blur(8px)',
                pointerEvents: 'none',
              }}>
                點一下啟用圖表操作
              </span>
            </button>
          )}
        </div>
      )}

      <div style={{ marginTop: 6, fontSize: 10, color: 'var(--ios-label3)', lineHeight: 1.5 }}>
        圖表由 TradingView 提供，台股報價可能為延遲資料；
        上方持股／盯盤的即時價格以富果／Shioaji 為準。
      </div>
    </div>
  )
}
