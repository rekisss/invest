// StockDetailModal 的「開/關 + 目前是哪一檔」決策 —— 抽成純函式以便單元測試。
//
// 為什麼要有這個檔案(2026-09-08 的當機修正):
// Dashboard 會同時傳 `stock`(目前選取)與 `stocks`(整份清單,供左右切換)。
// 關閉時它只清掉 `stock`,`stocks` 仍留著上一次開啟時設定的清單。舊的解析是
//
//     const stockList = stocks?.length ? stocks : (stock ? [stock] : [])
//     const s_nav = stockList[idx] ?? stockList[0] ?? stock
//     if (!s_nav && !stock) return null
//
// `stocks` 一旦非空,s_nav 就永遠有值 → 守衛失效 → modal 不卸載。它的根節點是
// position:fixed / inset:0 / zIndex:1000,整片蓋住 App:面板雖然停在
// `sheetOut ... both` 的最後一格(看不見),那層容器與 backdrop 還在吃掉所有點擊,
// 使用者按下關閉後整個 App 就沒反應了(只有掃描分頁會中,因為只有它傳 stocks)。
//
// 正解:`stock` 才是「開著沒」的唯一訊號。父層清掉它 = 關閉,`stocks` 只是
// 左右切換用的輔助清單,不得單獨把 modal 撐開。
export function resolveStockModalNav(stock, stocks, idx = 0) {
  // 父層已關閉 → 清單一律視為空,殘留的 stocks 不能讓 modal 活著
  const list = stock ? (stocks?.length ? stocks : [stock]) : []
  const i = Number.isInteger(idx) && idx >= 0 ? idx : 0
  const current = list[i] ?? list[0] ?? null
  return { open: current != null, list, current }
}
