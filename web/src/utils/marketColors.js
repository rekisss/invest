// Taiwan stock market color convention: 漲=紅, 跌=綠
export const UP_COLOR   = '#FF3340'  // 漲 (positive)
export const DOWN_COLOR = '#16D67E'  // 跌 (negative)
export const FLAT_COLOR = 'var(--ios-label3)'

// Color for a price-change / return value by its sign (Taiwan convention)
export function priceColor(v) {
  if (v == null || Number.isNaN(v)) return FLAT_COLOR
  if (v > 0) return UP_COLOR
  if (v < 0) return DOWN_COLOR
  return FLAT_COLOR
}
