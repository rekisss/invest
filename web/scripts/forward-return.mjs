// 前瞻報酬(forward return)查表 —— 勝率/均報統計的地基,單獨成檔以便單元測試。
//
// ── 前瞻報酬查表:一定要走「真實交易日曆」─────────────────────────────────
// priceHistoryMap[sid] 是「這檔股票出現過的掃描日」組成的密集陣列,中間沒有
// 補洞。掃描本身常常是部分完成的(實測近 30 個掃描日裡就有 544 / 1062 / 1065 /
// 1148 / 1158 / 1355 檔這幾天,正常是 ~1510 檔),那些天缺席的股票會在陣列裡
// 少一格,於是 `history[entryIdx + 5]` 拿到的其實是「第 5 次出現在掃描裡」,
// 不是「5 個交易日後」。實測:5 格視窗有 30.9% 對不上真實日數,平均期距被拉到
// 5.445 個交易日;1 格視窗也有 7.3% 對不上。勝率/均報統計因此系統性失真。
//
// 正解是用 kline_cache.json 的日 K(每檔連續、無洞)當主要來源;沒有 K 線的
// 股票才退回掃描收盤,而且退回時「以全域掃描日清單對齊」——目標日缺價就整筆
// 跳過,寧可少一筆樣本,也不要把期距悄悄拉長。
export function buildForwardReturn(dates, priceHistoryMap, klineMap, getBars) {
  const scanDatesAsc = [...dates].sort()
  const scanIdx = new Map(scanDatesAsc.map((d, i) => [d, i]))

  // 掃描收盤(fallback):date → close
  const scanClose = {}
  for (const [sid, hist] of Object.entries(priceHistoryMap || {})) {
    const m = new Map()
    for (const b of hist) if (b.close > 0) m.set(b.time, b.close)
    scanClose[sid] = m
  }

  // 日 K(主要來源):bars + date → index。lazy 建 index,避免一開場就對
  // 1500 檔全部建表。
  const klineIdxCache = {}
  const klineFor = (sid) => {
    if (sid in klineIdxCache) return klineIdxCache[sid]
    const bars = getBars(klineMap?.[sid], '1d')
    let entry = null
    if (bars && bars.length >= 2) {
      const idx = new Map()
      for (let i = 0; i < bars.length; i++) if (bars[i]?.time) idx.set(bars[i].time, i)
      entry = { bars, idx }
    }
    klineIdxCache[sid] = entry
    return entry
  }

  // 回傳 entryDate 起算 h 個交易日的報酬(小數);資料不足/期距未到期回 null。
  return function forwardReturn(sid, entryDate, h) {
    const k = klineFor(sid)
    if (k) {
      const i = k.idx.get(entryDate)
      if (i != null) {
        const j = i + h
        if (j >= k.bars.length) return null            // 期距未到期
        const e = k.bars[i].close, x = k.bars[j].close
        if (!(e > 0) || !(x > 0)) return null
        return (x - e) / e
      }
      // entryDate 不在日 K 裡(停牌/新上市),往下走掃描收盤
    }
    const gi = scanIdx.get(entryDate)
    if (gi == null) return null
    const exitDate = scanDatesAsc[gi + h]
    if (!exitDate) return null                          // 期距未到期
    const m = scanClose[sid]
    if (!m) return null
    const e = m.get(entryDate), x = m.get(exitDate)
    if (!(e > 0) || !(x > 0)) return null                // 目標日缺價 → 跳過,不拉長期距
    return (x - e) / e
  }
}
