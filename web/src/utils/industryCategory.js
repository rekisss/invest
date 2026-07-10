// TWSE/TPEX industry-category code labels used by Taiwan market data feeds.
// Some APIs return the display name (e.g. "航運業"), while others return only
// numeric category codes (e.g. "15"). Keep the raw code for filtering but show
// this human-readable label in UI.
export const INDUSTRY_CATEGORY_LABELS = {
  '01': '水泥工業',
  '02': '食品工業',
  '03': '塑膠工業',
  '04': '紡織纖維',
  '05': '電機機械',
  '06': '電器電纜',
  '08': '玻璃陶瓷',
  '09': '造紙工業',
  '10': '鋼鐵工業',
  '11': '橡膠工業',
  '12': '汽車工業',
  '13': '電子工業',
  '14': '建材營造',
  '15': '航運業',
  '16': '觀光餐旅',
  '17': '金融保險',
  '18': '貿易百貨',
  '19': '綜合',
  '20': '其他業',
  '21': '化學工業',
  '22': '生技醫療',
  '23': '油電燃氣',
  '24': '半導體業',
  '25': '電腦週邊',
  '26': '光電業',
  '27': '通信網路',
  '28': '電子零組件',
  '29': '電子通路',
  '30': '資訊服務',
  '31': '其他電子',
  '32': '文化創意',
  '33': '農業科技',
  '35': '綠能環保',
  '36': '數位雲端',
  '37': '運動休閒',
  '38': '居家生活',
  '80': '管理股票',
}

export function industryCategoryLabel(value, fallback = '其他') {
  const raw = String(value ?? '').trim()
  if (!raw || raw === 'nan' || raw === 'NaN' || raw === 'None') return fallback
  const code = /^\d{1,2}$/.test(raw) ? raw.padStart(2, '0') : null
  if (code && INDUSTRY_CATEGORY_LABELS[code]) return INDUSTRY_CATEGORY_LABELS[code]
  return raw
}
