// 選股產業集中度(build 層,純函式)。
//
// 掃描常把動能股集中在當紅族群(如 AI/半導體)——若今日進場候選高度集中在單一
// 產業,等於沒有分散:該族群一回檔,手上的股票會一起跌。這裡量化集中度並在過高時
// 示警,提醒使用者控管產業風險。純規則、確定性、可測試;不改任何選股決策。

// Taiwan 股號區間 → 類股(鏡射 Overview.jsx 的 inferSector,讓集中度與網頁族群熱度
// 一致)。掃描資料的 industry_category 目前多為空,靠股號推斷才有分類可用。
function inferSector(stockId) {
  const n = parseInt(String(stockId), 10)
  if (!Number.isFinite(n)) return null
  if (n >= 2300 && n <= 2399) return '半導體'
  if (n >= 2400 && n <= 2499) return '電子'
  if (n >= 2600 && n <= 2699) return '航運'
  if (n >= 2800 && n <= 2899) return '金融'
  if (n >= 3000 && n <= 3099) return 'IC設計'
  if (n >= 3600 && n <= 3699) return '光電'
  if (n >= 4900 && n <= 4999) return '電信'
  if (n >= 5800 && n <= 5899) return '建設'
  if (n >= 6000 && n <= 6099) return '光電'
  if (n >= 6100 && n <= 6299) return '電子'
  if (n >= 6600 && n <= 6699) return '生技'
  if (n >= 8000 && n <= 8099) return '電子'
  if (n >= 9200 && n <= 9299) return '其他'
  if (n >= 1000 && n <= 2299) return '傳產'
  if (n >= 2500 && n <= 2599) return '食品'
  if (n >= 2700 && n <= 2799) return '貿易'
  return '其他'
}

// 取一支股票的類股:優先 industry_category,空則用股號推斷(與 Overview 一致)。
function sectorOf(s) {
  const ind = (s && typeof s.industry_category === 'string') ? s.industry_category.trim() : ''
  if (ind) return ind
  return s ? inferSector(s.stock_id) : null
}

// stocks:掃描列陣列(industry_category 空時以股號推斷類股)。opts.minStocks 樣本門檻、
// opts.warnShare 單一產業占比示警線。回 null 若可歸類樣本不足。
export function computeSectorConcentration(stocks, opts = {}) {
  const minStocks = opts.minStocks ?? 5
  const warnShare = opts.warnShare ?? 0.4
  if (!Array.isArray(stocks) || stocks.length === 0) return null

  const counts = new Map()
  let total = 0
  for (const s of stocks) {
    const sec = sectorOf(s)
    if (!sec) continue
    counts.set(sec, (counts.get(sec) || 0) + 1)
    total++
  }
  if (total < minStocks) return null

  let topSector = null, topCount = 0
  let hhi = 0
  for (const [sec, c] of counts) {
    const share = c / total
    hhi += share * share
    if (c > topCount) { topCount = c; topSector = sec }
  }
  const topShare = topCount / total
  return {
    total,
    sectors: counts.size,
    top_sector: topSector,
    top_count: topCount,
    top_share_pct: Math.round(topShare * 1000) / 10,
    hhi: Math.round(hhi * 1000) / 1000,            // 0~1,越高越集中
    warn: topShare >= warnShare,
  }
}
