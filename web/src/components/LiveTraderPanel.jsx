import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { isTWSEOpen } from '../hooks/useLivePrices'
import {
  createFugleClient, fetchFugleQuote,
  getFugleKey, setFugleKey, getDiscordWebhook, setDiscordWebhook,
  alreadyFired, markFired, notifyDiscord,
} from '../utils/fugleLive'

const UP = 'var(--ios-red)'      // Taiwan: red = up/gain
const DOWN = 'var(--ios-green)'  // green = down/loss
const pctStr = (v, d = 2) => v == null || isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`
const colorOf = (v) => v == null ? 'var(--ios-label3)' : v >= 0 ? UP : DOWN

// 20-day high from embedded daily bars; falls back to close × (1 + gap%) from the scan row.
function high20Of(s) {
  const bars = s.price_history
  if (Array.isArray(bars) && bars.length >= 5) {
    let h = 0
    for (const b of bars.slice(-20)) if ((b.high ?? b.close ?? 0) > h) h = b.high ?? b.close
    if (h > 0) return Math.round(h * 100) / 100
  }
  if (s.close > 0 && s.gap_to_20d_high_pct != null && s.gap_to_20d_high_pct >= 0) {
    return Math.round(s.close * (1 + s.gap_to_20d_high_pct / 100) * 100) / 100
  }
  return null
}

const STATUS_LABEL = {
  no_key: { t: '未設定金鑰', c: 'var(--ios-label3)' },
  connecting: { t: '連線中…', c: 'var(--ios-orange)' },
  live: { t: '● 即時', c: 'var(--ios-green)' },
  reconnecting: { t: '重新連線…', c: 'var(--ios-orange)' },
  limited: { t: '頻道數受限', c: 'var(--ios-orange)' },
  auth_failed: { t: '金鑰無效', c: 'var(--ios-red)' },
  error: { t: '連線失敗', c: 'var(--ios-red)' },
  closed: { t: '已斷線', c: 'var(--ios-label3)' },
  market_closed: { t: '已收盤', c: 'var(--ios-label3)' },
}

function SettingsBox({ onClose }) {
  const [key, setKey] = useState(getFugleKey())
  const [hook, setHook] = useState(getDiscordWebhook())
  const save = () => { setFugleKey(key); setDiscordWebhook(hook); onClose(true) }
  const inputStyle = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
    border: '0.5px solid var(--ios-sep)', background: 'var(--ios-fill4)',
    color: 'var(--ios-label)', fontSize: 12, fontFamily: 'var(--font-mono)',
  }
  return (
    <div style={{ padding: '10px 2px 4px', display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 10.5, color: 'var(--ios-label3)', lineHeight: 1.6 }}>
        金鑰只存在<b>這台裝置的瀏覽器</b>裡(localStorage),不會上傳到網站或程式碼。
        富果金鑰:developer.fugle.tw → 專案 → API 金鑰。
      </div>
      <input style={inputStyle} type="password" placeholder="Fugle MarketData API 金鑰" value={key} onChange={e => setKey(e.target.value)} />
      <input style={inputStyle} type="text" placeholder="Discord Webhook URL(選填,觸發時通知)" value={hook} onChange={e => setHook(e.target.value)} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={save} style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', background: 'var(--ios-blue)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>儲存</button>
        <button
          onClick={() => { setDiscordWebhook(hook); notifyDiscord(`✅ 測試通知|AI 操盤盤中警示已連通(${new Date().toLocaleTimeString('zh-TW')})`) }}
          style={{ padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--ios-sep)', background: 'var(--ios-fill4)', color: 'var(--ios-label)', fontSize: 12, cursor: 'pointer' }}
        >測試通知</button>
        <button onClick={() => onClose(false)} style={{ padding: '8px 12px', borderRadius: 8, border: '0.5px solid var(--ios-sep)', background: 'var(--ios-fill4)', color: 'var(--ios-label3)', fontSize: 12, cursor: 'pointer' }}>關閉</button>
      </div>
    </div>
  )
}

export default function LiveTraderPanel({ ai, scan }) {
  const [quotes, setQuotes] = useState({})          // sym -> {price, changePct, time}
  const [wsStatus, setWsStatus] = useState(getFugleKey() ? 'connecting' : 'no_key')
  const [events, setEvents] = useState([])           // today's triggered alerts (this session)
  const [showSettings, setShowSettings] = useState(false)
  const [marketOpen, setMarketOpen] = useState(isTWSEOpen())
  const clientRef = useRef(null)
  const watchRef = useRef({ positions: [], candidates: [] })

  // Watchlist: AI open positions first (they carry TP/SL triggers), then top entry candidates.
  const { positions, candidates } = useMemo(() => {
    const positions = (ai?.positions || []).map(p => ({
      sym: String(p.stock_id), name: p.name, entry: p.entry,
      tp: p.tp_price, sl: p.sl_price, prevPrice: p.price,
    }))
    const held = new Set(positions.map(p => p.sym))
    const candidates = (scan?.top_stocks || [])
      .filter(s => s.entry_signal && !held.has(String(s.stock_id)))
      .sort((a, b) => (b.entry_score || 0) - (a.entry_score || 0))
      .slice(0, 4)
      .map(s => ({ sym: String(s.stock_id), name: s.name, close: s.close, high20: high20Of(s) }))
    return { positions, candidates }
  }, [ai, scan])
  watchRef.current = { positions, candidates }

  // Alert engine — deterministic rules mirroring the nightly replay, evaluated on live prices.
  const evaluate = useCallback((sym, price) => {
    const { positions, candidates } = watchRef.current
    const fire = (key, uiText, discordText, color) => {
      if (alreadyFired(key)) return
      markFired(key)
      setEvents(ev => [{ time: new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }), text: uiText, color }, ...ev].slice(0, 12))
      notifyDiscord(discordText)
    }
    const pos = positions.find(p => p.sym === sym)
    if (pos) {
      if (pos.tp != null && price >= pos.tp) {
        fire(`tp:${sym}`, `🤖 ${sym} ${pos.name} 觸發虛擬停利 @${price}(目標 ${pos.tp})`,
          `🤖 **AI虛擬停利觸發**|${sym} ${pos.name} 即時價 ${price} ≥ 停利價 ${pos.tp}(+8%)。正式紀錄於今晚資料更新入帳;若有跟單可自行決定是否獲利了結。`, UP)
      } else if (pos.sl != null && price <= pos.sl) {
        fire(`sl:${sym}`, `⚠️ ${sym} ${pos.name} 觸發虛擬停損 @${price}(防守 ${pos.sl})`,
          `⚠️ **AI虛擬停損觸發**|${sym} ${pos.name} 即時價 ${price} ≤ 停損價 ${pos.sl}(−12%)。正式紀錄於今晚資料更新入帳。`, DOWN)
      } else if (pos.tp != null && price >= pos.tp * 0.99) {
        fire(`near_tp:${sym}`, `📈 ${sym} ${pos.name} 接近停利(${price} / 目標 ${pos.tp})`,
          `📈 **接近停利**|${sym} ${pos.name} 即時價 ${price},距停利價 ${pos.tp} 不到 1%。`, UP)
      }
    }
    const cand = candidates.find(c => c.sym === sym)
    if (cand?.high20 != null && price >= cand.high20) {
      fire(`bo:${sym}`, `🚀 ${sym} ${cand.name} 突破 20 日高 ${cand.high20}(現價 ${price})`,
        `🚀 **突破警示**|${sym} ${cand.name} 即時價 ${price} 越過 20 日高點 ${cand.high20}(AI 進場候選第一線)。`, 'var(--ios-orange)')
    }
  }, [])

  const quotesRef = useRef({})
  const onQuote = useCallback((sym, q) => {
    quotesRef.current = { ...quotesRef.current, [sym]: q }
    setQuotes(quotesRef.current)
    evaluate(sym, q.price)
  }, [evaluate])

  // Connect / disconnect with market hours; re-check every 30s so the panel
  // self-starts at 09:00 and stops after close without a reload.
  useEffect(() => {
    const tick = () => setMarketOpen(isTWSEOpen())
    const id = setInterval(tick, 30000)
    return () => clearInterval(id)
  }, [])

  const allSyms = useMemo(() => [
    ...positions.map(p => p.sym), ...candidates.map(c => c.sym),
  ], [positions, candidates])

  useEffect(() => {
    if (!marketOpen || !getFugleKey() || allSyms.length === 0) {
      clientRef.current?.close()
      clientRef.current = null
      if (!getFugleKey()) setWsStatus('no_key')
      else if (!marketOpen) setWsStatus('market_closed')
      return
    }
    if (!clientRef.current) {
      clientRef.current = createFugleClient({ onQuote, onStatus: setWsStatus })
    }
    clientRef.current.watch(allSyms)
    return () => { clientRef.current?.close(); clientRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketOpen, allSyms.join(','), showSettings])

  // REST fallback poll (20s) for symbols the WS hasn't covered (channel limits).
  useEffect(() => {
    if (!marketOpen || !getFugleKey()) return
    const id = setInterval(async () => {
      const stale = allSyms.filter(sym => {
        const q = quotesRef.current[sym]
        return !q || Date.now() - q.time > 45000
      }).slice(0, 3) // stay well under free-tier rate limits
      for (const sym of stale) {
        const q = await fetchFugleQuote(sym)
        if (q) onQuote(sym, q)
      }
    }, 20000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketOpen, allSyms.join(',')])

  const st = STATUS_LABEL[marketOpen ? wsStatus : 'market_closed'] || STATUS_LABEL.error
  const hasKey = !!getFugleKey()

  const row = (sym, name, right, sub) => (
    <div key={sym} style={{ borderTop: '0.5px solid var(--ios-sep)', padding: '7px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--ios-blue)' }}>{sym}</span>
      <span style={{ fontSize: 11.5, color: 'var(--ios-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      <span style={{ marginLeft: 'auto', textAlign: 'right' }}>
        {right}
        {sub && <div style={{ fontSize: 9, color: 'var(--ios-label4)' }}>{sub}</div>}
      </span>
    </div>
  )

  return (
    <div style={{ background: 'var(--ios-bg2)', borderRadius: 16, padding: '12px 14px', marginBottom: 12, boxShadow: 'var(--shadow-card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--ios-label)' }}>📡 盤中即時(富果)</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: st.c }}>{st.t}</span>
        <button onClick={() => setShowSettings(v => !v)} style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 14, cursor: 'pointer', color: 'var(--ios-label3)', padding: 2 }} aria-label="設定">⚙︎</button>
      </div>

      {showSettings && <SettingsBox onClose={() => setShowSettings(false)} />}

      {!hasKey && !showSettings && (
        <div style={{ fontSize: 11.5, color: 'var(--ios-label3)', lineHeight: 1.7, padding: '8px 0 2px' }}>
          設定你的富果 MarketData 金鑰後,開盤時間這裡會變成即時報價:AI 持倉觸及停利/停損、候選股突破 20 日高都會即時亮出來,也可以接 Discord 通知。點右上 ⚙︎ 設定。
        </div>
      )}

      {hasKey && (
        <>
          {events.length > 0 && (
            <div style={{ margin: '8px 0 2px', display: 'grid', gap: 4 }}>
              {events.map((e, i) => (
                <div key={i} style={{ fontSize: 11, fontWeight: 600, color: e.color, background: 'var(--ios-fill4)', borderRadius: 8, padding: '6px 9px' }}>
                  <span style={{ color: 'var(--ios-label4)', fontWeight: 400, marginRight: 6, fontFamily: 'var(--font-mono)' }}>{e.time}</span>{e.text}
                </div>
              ))}
            </div>
          )}

          {positions.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', margin: '6px 0 2px' }}>AI 持倉(觸價警示中)</div>
              {positions.map(p => {
                const q = quotes[p.sym]
                const live = q?.price ?? p.prevPrice
                const chg = live != null && p.entry ? (live / p.entry - 1) * 100 : null
                const toTp = live != null && p.tp ? (p.tp / live - 1) * 100 : null
                return row(p.sym, p.name,
                  <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'var(--font-mono)', color: colorOf(chg) }}>
                    {live ?? '—'}<span style={{ fontSize: 10, marginLeft: 5 }}>{pctStr(chg, 1)}</span>
                  </span>,
                  q ? `停利 ${p.tp ?? '—'}(差${toTp != null ? pctStr(toTp, 1) : '—'})· 停損 ${p.sl ?? '—'}` : '等待即時報價…')
              })}
            </div>
          )}

          {candidates.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ios-label3)', margin: '6px 0 2px' }}>進場候選(突破警示中)</div>
              {candidates.map(c => {
                const q = quotes[c.sym]
                const live = q?.price
                const toBo = live != null && c.high20 ? (c.high20 / live - 1) * 100 : null
                return row(c.sym, c.name,
                  <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'var(--font-mono)', color: live != null && c.close ? colorOf(live - c.close) : 'var(--ios-label3)' }}>
                    {live ?? c.close ?? '—'}
                  </span>,
                  c.high20 ? `20日高 ${c.high20}${toBo != null ? `(差${pctStr(toBo, 1)})` : ''}` : '無突破目標價')
              })}
            </div>
          )}

          <div style={{ fontSize: 9, color: 'var(--ios-label4)', lineHeight: 1.6, marginTop: 8 }}>
            觸價僅發<b>虛擬單通知</b>(每檔每日一次),正式戰績仍以每晚的確定性回放為準——兩者用同一套價位規則,結果一致。本系統不會自動下真實委託單。
          </div>
        </>
      )}
    </div>
  )
}
