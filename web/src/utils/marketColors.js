// Taiwan stock market color convention: 漲=紅, 跌=綠
export const UP_COLOR   = '#FF453A'  // 漲 (positive)
export const DOWN_COLOR = '#30D158'  // 跌 (negative)
export const FLAT_COLOR = 'var(--ios-label3)'

// Color for a price-change / return value by its sign (Taiwan convention)
export function priceColor(v) {
  if (v == null || Number.isNaN(v)) return FLAT_COLOR
  if (v > 0) return UP_COLOR
  if (v < 0) return DOWN_COLOR
  return FLAT_COLOR
}
