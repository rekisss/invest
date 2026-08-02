// 「營收成長精選」— 較高勝率的候選子集(build 層,純函式)。
//
// 規則實驗室的回測一再顯示:在進場訊號之上再加「月營收年增為正」硬濾網,勝率明顯
// 高於主帳戶(rev_growth 變體)。這裡把今日精選中符合這條濾網的股票單獨挑出,讓使用者
// 優先看這個「基本面有撐」的較高勝率子集。**非保證獲利,樣本仍在累積**;不改任何選股決策。

// stocks:掃描精選列(需含 entry_signal / entry_score / revenue_yoy)。
// 回傳 { total, items:[{stock_id,name,entry_score,revenue_yoy}] };無符合則 total=0。
export function computeQualityPicks(stocks, opts = {}) {
  const limit = opts.limit ?? 8
  if (!Array.isArray(stocks)) return { total: 0, items: [] }
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null }
  const picks = stocks.filter(s => s && s.entry_signal && (num(s.revenue_yoy) ?? -1) > 0)
  picks.sort((a, b) => (num(b.entry_score) ?? -Infinity) - (num(a.entry_score) ?? -Infinity))
  return {
    total: picks.length,
    items: picks.slice(0, limit).map(s => ({
      stock_id: String(s.stock_id),
      name: s.name || '',
      entry_score: num(s.entry_score),
      revenue_yoy: num(s.revenue_yoy),
    })),
  }
}
