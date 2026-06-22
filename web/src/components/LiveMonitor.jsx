import { useState, useMemo, useRef } from 'react'
import { useLivePrices } from '../hooks/useLivePrices'
import StockDetailModal from './StockDetailModal'

const PORTFOLIO_KEY = 'tw_portfolio_positions'

function loadPortfolio() {
  try { return JSON.parse(localStorage.getItem(PORTFOLIO_KEY) || '{}') } catch { return {} }
}

function getLatestEntryStocks(data) {
  if (!data?.scans || !data?.dates?.length) return []
  const latestDate = [...data.dates].sort((a, b) => b.localeCompare(a))[0]
  const s = data.scans[latestDate] || {}
  return (s.top_stocks || []).filter(s => s.entry_signal)
}

function fmt2(v) { return v == null ? '—' : v >= 100 ? v.toFixed(0) : v.toFixed(2) }

export default function LiveMonitor({ data }) {
  const [positions] = useState(() => loadPortfolio())
  const [selectedStock, setSelectedStock] = useState(null)
  const [historyData, setHistoryData] = useState(null)
  const historiesRef = useRef(null)

  const entryStocks = useMemo(() => getLatestEntryStocks(data), [data])

  const allIds = useMemo(() => {
    const ids = new Set([
      ...entryStocks.map(s => String(s.stock_id)),
      ...Object.keys(positions),
    ])
    return [...ids]
  }, [entryStocks, positions])

  const { prices: liveData, isOpen: mktOpen, session: mktSession, lastUpdate: liveTime, loading: liveLoading } = useLivePrices(allIds)

  const liveEntries = useMemo(() => entryStocks
    .map(s => ({ ...s, _live: liveData[String(s.stock_id)] || null }))
    .filter(s => s._live)
    .sort((a, b) => (b._live.pct || 0) - (a._live.pct || 0))
  , [entryStocks, liveData])

  const livePortfolio = useMemo(() => Object.entries(positions).map(([id, p]) => {
    const live = liveData[id]
    if (!live) return null
    const curPrice = live.price
    const pnlPct = (curPrice - p.buyPrice) / p.buyPrice * 100
    const pnlAmt = (curPrice - p.buyPrice) * p.qty
    return { id, p, live, curPrice, pnlPct, pnlAmt }
  }).filter(Boolean), [positions, liveData])

  const openDetail = async (stock) => {
    setSelectedStock(stock)
    if (!historiesRef.current) {
      try {
        const base = import.meta.env.BASE_URL || '/'
        const h = await fetch(`${base}stock_histories.json`).then(r => r.ok ? r.json() : null)
        historiesRef.current = h || {}
        if (h) setHistoryData(h)
      } catch { historiesRef.current = {} }
    }
    const h = historiesRef.current
    if (!h) return
    const kline = h?.stocks?.[stock.stock_id]
    const dates = h?.dates || []
    let priceHistory = null
    if (kline?.c) {
      priceHistory = dates.map((t, i) => kline.c[i] == null ? null : {
        time: t, open: kline.o?.[i] ?? kline.c[i], high: kline.h?.[i] ?? kline.c[i],
        low: kline.l?.[i] ?? kline.c[i], close: kline.c[i], volume: kline.v?.[i] ?? 0,
      }).filter(Boolean)
    }
    setSelectedStock(prev => prev?.stock_id === stock.stock_id
      ? { ...prev, price_history: priceHistory || undefined }
      : prev)
  }

  const SESSION_LABEL = {
    open:    '🟢 盤中',
    pre:     '⏰ 開盤前',
    closed:  '⚫ 已收盤',
    weekend: '📆 假日',
  }
  const sessionColor = mktSession === 'open' ? '#30D158' : 'var(--ios-label3)'

  return (
    <>
    <style>{`@keyframes monSpin { to { transform: rotate(360deg) } }`}</style>
    <div style={{ padding: '0 16px 80px', overflowY: 'auto', height: '100%', WebkitOverflowScrolling: 'touch' }}>

      {/* ── Market status header ─────────────────────────────────── */}
      <div style={{
        background: mktOpen
          ? 'linear-gradient(135deg, rgba(48,209,88,0.08) 0%, var(--ios-bg2) 65%)'
          : 'var(--ios-bg2)',
        borderRadius: 16, padding: '14px 16px', marginBottom: 14,
        boxShadow: 'var(--shadow-card)',
        borderLeft: `3px solid ${sessionColor}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: sessionColor, letterSpacing: '-0.3px' }}>
            {SESSION_LABEL[mktSession] || '—'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 3 }}>
            台股 09:00–13:30 週一至週五
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {liveTime && (
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ios-label)', fontFamily: 'var(--font-mono)' }}>
              {liveTime.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </div>
          )}
          <div style={{ fontSize: 10, marginTop: 2, color: liveLoading ? 'var(--ios-blue)' : 'var(--ios-label4)' }}>
            {liveLoading ? '更新中…' : mktOpen ? '每 30 秒自動更新' : '收盤停止更新'}
          </div>
        </div>
      </div>

      {/* ── 進場訊號即時追蹤 ─────────────────────────────────────── */}
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 8 }}>
        進場訊號即時追蹤 · {entryStocks.length} 支
      </div>

      {!mktOpen ? (
        <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '28px 16px', textAlign: 'center', marginBottom: 14, boxShadow: 'var(--shadow-card)' }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>📴</div>
          <div style={{ fontSize: 13, color: 'var(--ios-label2)', fontWeight: 600 }}>
            {mktSession === 'pre' ? '等待開盤（09:00 開始更新）' : '盤後停止更新'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ios-label3)', marginTop: 4 }}>明日 09:00 自動恢復即時行情</div>
        </div>
      ) : entryStocks.length === 0 ? (
        <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '24px 16px', textAlign: 'center', marginBottom: 14, boxShadow: 'var(--shadow-card)' }}>
          <div style={{ color: 'var(--ios-label3)', fontSize: 13 }}>今日尚無進場訊號</div>
        </div>
      ) : liveEntries.length === 0 ? (
        <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '28px 16px', textAlign: 'center', marginBottom: 14, boxShadow: 'var(--shadow-card)' }}>
          <div style={{ width: 24, height: 24, border: '2.5px solid var(--ios-fill3)', borderTop: '2.5px solid var(--ios-blue)', borderRadius: '50%', animation: 'monSpin 0.8s linear infinite', margin: '0 auto 10px' }} />
          <div style={{ fontSize: 12, color: 'var(--ios-label3)' }}>等待成交報價（剛開盤時需要幾分鐘）</div>
        </div>
      ) : (
        <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-card)', marginBottom: 14 }}>
          {liveEntries.map((s, i) => {
            const pct = s._live.pct || 0
            const isUp = pct >= 0
            const color = isUp ? '#FF453A' : '#30D158'
            const bg = isUp ? 'rgba(255,69,58,0.04)' : 'rgba(48,209,88,0.04)'
            return (
              <div key={s.stock_id} onClick={() => openDetail(s)} style={{
                display: 'flex', alignItems: 'center', padding: '12px 14px', cursor: 'pointer',
                borderBottom: i < liveEntries.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
                background: bg,
              }}>
                {/* Rank + info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                    <span style={{ fontSize: 10, color: 'var(--ios-label4)', fontFamily: 'var(--font-mono)', width: 18 }}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--ios-blue)', fontFamily: 'var(--font-mono)' }}>{s.stock_id}</span>
                    <span style={{ fontSize: 13, color: 'var(--ios-label)' }}>{s.name}</span>
                    {s.grade && (
                      <span style={{
                        fontSize: 10, fontWeight: 800, borderRadius: 4, padding: '1px 5px',
                        color: s.grade === 'A' ? '#FFD60A' : s.grade === 'B' ? '#30D158' : '#94A3B8',
                        background: s.grade === 'A' ? 'rgba(255,214,10,0.12)' : s.grade === 'B' ? 'rgba(48,209,88,0.12)' : 'var(--ios-fill4)',
                      }}>{s.grade}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginLeft: 25, fontSize: 10, color: 'var(--ios-label4)' }}>
                    {s._live.open && <span>開 {fmt2(s._live.open)}</span>}
                    {s._live.high && <span>高 {fmt2(s._live.high)}</span>}
                    {s._live.low  && <span>低 {fmt2(s._live.low)}</span>}
                    {s._live.volume > 0 && <span>量 {(s._live.volume / 1000).toFixed(0)}張</span>}
                    {s._live.time && <span>{s._live.time}</span>}
                  </div>
                </div>
                {/* Price + pct */}
                <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 80 }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: 'var(--font-mono)', lineHeight: 1.1 }}>
                    {fmt2(s._live.price)}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color, marginTop: 1 }}>
                    {pct >= 0 ? '+' : ''}{(pct * 100).toFixed(2)}%
                  </div>
                  {s._live.prevClose && (
                    <div style={{ fontSize: 9, color: 'var(--ios-label4)', marginTop: 1 }}>
                      昨 {fmt2(s._live.prevClose)}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── 持倉即時損益 ─────────────────────────────────────────── */}
      {Object.keys(positions).length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ios-label3)', letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 8 }}>
            持倉即時損益 · {Object.keys(positions).length} 檔
          </div>

          {!mktOpen ? (
            <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '16px', textAlign: 'center', color: 'var(--ios-label3)', fontSize: 12, boxShadow: 'var(--shadow-card)' }}>
              盤後無即時報價，請至「持倉」頁查看收盤損益
            </div>
          ) : livePortfolio.length === 0 ? (
            <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, padding: '20px 16px', textAlign: 'center', boxShadow: 'var(--shadow-card)' }}>
              <div style={{ width: 20, height: 20, border: '2px solid var(--ios-fill3)', borderTop: '2px solid var(--ios-blue)', borderRadius: '50%', animation: 'monSpin 0.8s linear infinite', margin: '0 auto 8px' }} />
              <div style={{ fontSize: 11, color: 'var(--ios-label3)' }}>等待持倉報價…</div>
            </div>
          ) : (
            <div style={{ background: 'var(--ios-bg2)', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-card)' }}>
              {/* Summary bar */}
              {(() => {
                const totalPnl = livePortfolio.reduce((s, e) => s + e.pnlAmt, 0)
                const totalCost = livePortfolio.reduce((s, e) => s + e.p.buyPrice * e.p.qty, 0)
                const totalPct = totalCost > 0 ? totalPnl / totalCost * 100 : 0
                const color = totalPnl >= 0 ? '#FF453A' : '#30D158'
                return (
                  <div style={{ padding: '10px 14px', background: 'var(--ios-fill4)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: 'var(--ios-label3)', fontWeight: 700 }}>今日持倉浮動損益</span>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: 16, fontWeight: 700, color, fontFamily: 'var(--font-mono)' }}>
                        {totalPnl >= 0 ? '+' : ''}{Math.round(totalPnl).toLocaleString()} 元
                      </span>
                      <span style={{ fontSize: 11, color, marginLeft: 6, fontFamily: 'var(--font-mono)' }}>
                        ({totalPct >= 0 ? '+' : ''}{totalPct.toFixed(2)}%)
                      </span>
                    </div>
                  </div>
                )
              })()}
              {livePortfolio.map((e, i) => {
                const pnlColor = e.pnlPct >= 0 ? '#FF453A' : '#30D158'
                const todayColor = (e.live?.pct || 0) >= 0 ? '#FF453A' : '#30D158'
                return (
                  <div key={e.id} style={{
                    display: 'flex', alignItems: 'center', padding: '12px 14px',
                    borderBottom: i < livePortfolio.length - 1 ? '0.5px solid var(--ios-sep)' : 'none',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ios-blue)', fontFamily: 'var(--font-mono)' }}>{e.id}</div>
                      <div style={{ fontSize: 12, color: 'var(--ios-label2)' }}>{e.p.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--ios-label3)', marginTop: 2 }}>
                        買 {e.p.buyPrice} · {(e.p.qty / 1000).toFixed(e.p.qty % 1000 === 0 ? 0 : 2)} 張
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 100 }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ios-label)', fontFamily: 'var(--font-mono)', lineHeight: 1.1 }}>
                        {fmt2(e.curPrice)}
                      </div>
                      {e.live?.pct != null && (
                        <div style={{ fontSize: 12, fontWeight: 700, color: todayColor, marginTop: 1 }}>
                          今 {e.live.pct >= 0 ? '+' : ''}{(e.live.pct * 100).toFixed(2)}%
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: pnlColor, marginTop: 1 }}>
                        持倉 {e.pnlPct >= 0 ? '+' : ''}{e.pnlPct.toFixed(2)}%
                        <span style={{ marginLeft: 3, fontSize: 10 }}>
                          ({e.pnlAmt >= 0 ? '+' : ''}{Math.round(e.pnlAmt).toLocaleString()})
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {!mktOpen && Object.keys(positions).length === 0 && (
        <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--ios-label3)', fontSize: 12 }}>
          開盤中可在此即時追蹤進場訊號與持倉損益
        </div>
      )}
    </div>

    {selectedStock && (
      <StockDetailModal
        stock={selectedStock}
        notionInfo={null}
        onClose={() => setSelectedStock(null)}
        allScans={data?.scans}
        compareHistories={historyData?.stocks || null}
        historyDates={historyData?.dates || null}
      />
    )}
    </>
  )
}
