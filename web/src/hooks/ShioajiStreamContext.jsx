// ShioajiStreamContext — 全站共用的 Shioaji tick 串流層。
//
// 為什麼要有這一層：
//   useShioajiStream 原本只在 LiveMonitor 裡呼叫，所以「零延遲報價」只有盯盤
//   分頁吃得到；持倉 / AI操盤 / 績效 / 掃描 仍然走 useLivePrices 的輪詢層
//   （GitHub Actions 快取 → 典型 60–90 秒延遲）。這個 Provider 把串流連線
//   提到 App 之上，讓所有分頁共用「同一條 WebSocket」：
//
//     - 只開一條連線（各分頁各自 new WebSocket 會重複燒 Shioaji 訂閱額度）
//     - 各分頁登記自己關心的代號，Provider 取聯集後統一訂閱
//     - 設定（wsUrl / token）改一次，全站立即生效
//
// 對呼叫端而言是「加法」：useLivePricesPlus 回傳的物件形狀與 useLivePrices
// 完全相同（多附 streamConnected / streamError 兩個欄位），所以呼叫端只要換
// hook 名稱，下游邏輯一行都不用動。沒包 Provider、或沒設定 wsUrl 時，它就是
// 純粹的 useLivePrices，行為與改動前一致。

import {
  createContext, useContext, useState, useRef, useMemo, useEffect, useCallback, useId,
} from 'react'
import { useShioajiStream, loadStreamCfg, saveStreamCfg } from './useShioajiStream'
import { useLivePrices } from './useLivePrices'
import { mergeStreamIds, MAX_STREAM_IDS, STREAM_PRIORITY } from '../utils/streamIds.js'

// 超出訂閱上限的代號不會沒有價格 —— 它們由 useLivePrices 的輪詢層照常補上，
// 只是沒有零延遲。合併/截斷規則見 utils/streamIds.js（有單元測試釘住）。
export { STREAM_PRIORITY, MAX_STREAM_IDS }

// 兩個 context 刻意分開：
//   RegCtx  只裝 register/unregister，identity 永遠不變 → 呼叫端的登記 effect
//           不會因為報價更新而重跑（否則 register → setState → 新 ctx →
//           effect 重跑 → register … 會變成無限迴圈）。
//   DataCtx 裝會變動的報價與連線狀態。
const RegCtx  = createContext(null)
const DataCtx = createContext(null)

export function ShioajiStreamProvider({ children }) {
  const [cfg, setCfgState] = useState(loadStreamCfg)
  const regRef = useRef(new Map())      // consumerKey -> { ids: string[], priority: number }
  const [version, setVersion] = useState(0)

  const reg = useMemo(() => ({
    register(key, ids, priority) {
      const prev = regRef.current.get(key)
      // 內容沒變就不要 setState，避免 StrictMode 重複掛載時多跑一輪 render
      if (prev && prev.priority === priority && prev.ids.join(',') === ids.join(',')) return
      regRef.current.set(key, { ids, priority })
      setVersion(v => v + 1)
    },
    unregister(key) {
      if (!regRef.current.delete(key)) return
      setVersion(v => v + 1)
    },
  }), [])

  // 依 priority 攤平成單一訂閱清單（去重、保序、截斷到上限）
  const ids = useMemo(
    () => mergeStreamIds([...regRef.current.values()], MAX_STREAM_IDS),
    // version 是登記表的變更計數 —— regRef 本身是 ref，不會觸發 memo 重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  )

  const { prices, connected, error } = useShioajiStream(ids, { wsUrl: cfg.wsUrl, token: cfg.token })

  const setCfg = useCallback((next) => {
    const c = next || {}
    saveStreamCfg(c)
    setCfgState(c)
  }, [])

  const data = useMemo(
    () => ({ prices, connected, error, cfg, setCfg, streamIds: ids }),
    [prices, connected, error, cfg, setCfg, ids],
  )

  return (
    <RegCtx.Provider value={reg}>
      <DataCtx.Provider value={data}>{children}</DataCtx.Provider>
    </RegCtx.Provider>
  )
}

/** 串流連線狀態 + 設定（給 LiveMonitor 的設定面板用）。沒有 Provider 時回傳 null。 */
export function useStreamStatus() {
  return useContext(DataCtx)
}

/**
 * useLivePricesPlus(stockIds, opts, { priority })
 *
 * useLivePrices 的直接替代品：回傳形狀完全相同，另外附上
 * { streamConnected, streamError }。串流連上時，本呼叫端關心的代號會被 tick
 * 價覆蓋（零延遲）；沒連上就原封不動退回輪詢層的結果。
 */
export function useLivePricesPlus(stockIds, opts = {}, { priority = STREAM_PRIORITY.other } = {}) {
  const base = useLivePrices(stockIds, opts)
  const reg  = useContext(RegCtx)
  const data = useContext(DataCtx)
  const key  = useId()

  const idsKey = useMemo(
    () => [...new Set((stockIds || []).map(String).filter(Boolean))].sort().join(','),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [(stockIds || []).join(',')],
  )

  useEffect(() => {
    if (!reg) return
    const ids = idsKey.split(',').filter(Boolean)
    if (!ids.length) { reg.unregister(key); return }
    reg.register(key, ids, priority)
    return () => reg.unregister(key)
  }, [reg, key, idsKey, priority])

  const streamPrices = data?.prices
  const connected    = data?.connected

  const { prices, covered, wanted } = useMemo(() => {
    const want = [...new Set(idsKey.split(',').filter(Boolean))]
    if (!connected || !streamPrices) return { prices: base.prices, covered: 0, wanted: want.length }
    // 只覆蓋這個呼叫端要的代號：串流清單是全站聯集，直接整包 spread 會把別的
    // 分頁的股票也塞進來，下游的 Object.keys(prices) 走訪就會多出不相干的列。
    const overlay = {}
    for (const sid of want) {
      const p = streamPrices[sid]
      if (p) overlay[sid] = p
    }
    const n = Object.keys(overlay).length
    return {
      prices: n ? { ...base.prices, ...overlay } : base.prices,
      covered: n,
      wanted: want.length,
    }
  }, [base.prices, streamPrices, connected, idsKey])

  // base.error 描述的是「輪詢層」拿到的資料品質（例如盤中只剩 TWSE
  // STOCK_DAY_ALL 時的「前一交易日收盤」警告）。串流已經把這些代號的價格
  // 全部換成即時 tick 時，那句警告就不再成立 —— 照傳會變成畫面跳著即時價、
  // 底下卻掛一行紅字叫你去設富果金鑰。只有在串流「全覆蓋」時才清掉：
  // 部分覆蓋（超過 MAX_SUBSCRIPTIONS 被截斷）時，沒被覆蓋的那些仍走輪詢層，
  // 警告對它們依然是真的。
  const error = (connected && wanted > 0 && covered === wanted) ? null : base.error

  return {
    ...base,
    prices,
    error,
    streamConnected: !!connected,
    streamCovered: covered,
    streamError: data?.error || null,
  }
}
