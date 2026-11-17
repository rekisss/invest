// 主題顏色的對比度回歸測試。
//
// 背景——淺色主題曾經整組語意色都達不到 WCAG AA(4.5:1)。Apple 的那組原值
// (#ffcc00 / #ff9500 / #34c759 …)是設計給「色塊配白字」的,但本專案把它們
// 大量當**文字色**用(光 --ios-yellow 就 61 處),放在淺色背景上就變成:
//     yellow 1.33:1   orange 1.94:1   green 1.95:1
//     red    3.12:1   blue   3.54:1   purple 3.64:1
// 其中 green 是「虧損」的顏色 —— 淺色模式下使用者幾乎看不見自己賠多少。
//
// 這支測試直接讀 global.css,把修好的值鎖住。顏色很容易在之後的調整裡被
// 改回「比較好看」的鮮豔版,而對比度不足是看不出來的(改的人自己的螢幕
// 可能很亮),所以用測試擋,不靠記性。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/styles/global.css'),
  'utf-8',
)

/** WCAG AA:一般文字的最低對比度。 */
const AA = 4.5

// ── 顏色計算 ────────────────────────────────────────────────────────────────

/** '#rrggbb' → [r,g,b];支援 #rgb 短寫。 */
function parseHex(s) {
  const m = s.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return null
  const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1]
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
}

/** 'rgba(r,g,b,a)' / 'rgb(r,g,b)' → { rgb, alpha }。 */
function parseRgba(s) {
  const m = s.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i)
  if (!m) return null
  return { rgb: [+m[1], +m[2], +m[3]], alpha: m[4] === undefined ? 1 : +m[4] }
}

/** 任何支援的顏色字串 → { rgb, alpha };不認得回 null。 */
export function parseColor(s) {
  const hex = parseHex(s)
  if (hex) return { rgb: hex, alpha: 1 }
  return parseRgba(s)
}

/** 半透明前景疊在背景上的實際顏色。 */
function composite({ rgb, alpha }, bg) {
  if (alpha >= 1) return rgb
  return rgb.map((f, i) => Math.round(alpha * f + (1 - alpha) * bg[i]))
}

/** WCAG 相對亮度。 */
function luminance([r, g, b]) {
  const f = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** 對比度;前景可半透明,會先疊到背景上再算。 */
export function contrast(fg, bgHex) {
  const bg = parseHex(bgHex)
  const a = luminance(composite(fg, bg))
  const b = luminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

// ── CSS 區塊解析 ────────────────────────────────────────────────────────────

/**
 * 從 selector 之後抓出整個 `{ ... }`(會數括號,所以巢狀也不會錯),
 * 再把裡面的 `--var: value;` 收成物件。
 */
function varsOf(selector) {
  const at = CSS.indexOf(selector)
  assert.notEqual(at, -1, `global.css 找不到選擇器:${selector}`)
  const open = CSS.indexOf('{', at + selector.length - 1)
  assert.notEqual(open, -1, `${selector} 後面找不到 {`)
  let depth = 0, end = -1
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++
    else if (CSS[i] === '}' && --depth === 0) { end = i; break }
  }
  assert.notEqual(end, -1, `${selector} 的區塊沒有收尾 }`)
  const body = CSS.slice(open + 1, end)
  const out = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}

const DARK        = ':root[data-theme="dark"]'
const LIGHT_AUTO  = ':root:not([data-theme]) {'     // @media (prefers-color-scheme: light) 裡的那個
const LIGHT_FORCE = ':root[data-theme="light"] {'

/** 這六個會被當文字色用,所以必須達 AA。 */
const SEMANTIC = ['--ios-blue', '--ios-green', '--ios-red', '--ios-orange', '--ios-yellow', '--ios-purple']
/** 量對比度的基準背景:卡片底(bg2)與次層底(bg3)。bg3 較暗,是較嚴格的那個。 */
const SURFACES = ['--ios-bg2', '--ios-bg3']

function checkTheme(name, selector) {
  const vars = varsOf(selector)
  for (const surface of SURFACES) {
    const bg = vars[surface]
    assert.ok(parseHex(bg), `${name} 的 ${surface} 不是 hex:${bg}`)
    for (const key of [...SEMANTIC, '--ios-label']) {
      const raw = vars[key]
      assert.ok(raw, `${name} 缺少 ${key}`)
      const col = parseColor(raw)
      assert.ok(col, `${name} 的 ${key} 解析不出顏色:${raw}`)
      const r = contrast(col, bg)
      assert.ok(
        r >= AA,
        `${name}:${key}(${raw}) 在 ${surface}(${bg}) 上只有 ${r.toFixed(2)}:1,` +
        `低於 WCAG AA 的 ${AA}:1。這六個語意色在本專案是當文字色用的,` +
        `不能只看色塊好不好看。`,
      )
    }
  }
}

test('深色主題:語意色與主要文字達 WCAG AA', () => {
  checkTheme('深色主題', DARK)
})

test('淺色主題(自動偵測):語意色與主要文字達 WCAG AA', () => {
  checkTheme('淺色主題(自動)', LIGHT_AUTO)
})

test('淺色主題(手動切換):語意色與主要文字達 WCAG AA', () => {
  checkTheme('淺色主題(手動)', LIGHT_FORCE)
})

test('兩個淺色區塊的值必須一致 —— 只改一邊會讓自動與手動切換長得不一樣', () => {
  // global.css 自己寫著「shared between auto-detect and forced」,但那是兩段
  // 各自獨立的宣告,複製貼上的東西遲早會漂移。這裡把那個 invariant 鎖住。
  const auto = varsOf(LIGHT_AUTO)
  const forced = varsOf(LIGHT_FORCE)
  for (const key of [...SEMANTIC, '--ios-label', ...SURFACES]) {
    assert.equal(
      forced[key], auto[key],
      `${key} 在自動淺色(${auto[key]})與手動淺色(${forced[key]})不一致`,
    )
  }
})

test('回歸:Apple 的原始語意色不得再出現在淺色區塊', () => {
  // 這些就是當初造成問題的值。擋掉「改回比較鮮豔的版本」這種回歸。
  const ORIGINALS = ['#ffcc00', '#ff9500', '#34c759', '#ff3b30', '#007aff', '#af52de']
  for (const [name, sel] of [['自動淺色', LIGHT_AUTO], ['手動淺色', LIGHT_FORCE]]) {
    const vars = varsOf(sel)
    for (const key of SEMANTIC) {
      const v = (vars[key] || '').toLowerCase()
      assert.ok(
        !ORIGINALS.includes(v),
        `${name} 的 ${key} 被改回 Apple 原值 ${v} —— 那個值當文字色時對比度不足`,
      )
    }
  }
})

// ── 計算本身的 sanity check(測試的工具壞了會比沒測試更糟)──────────────────

test('對比度計算:已知值對得上', () => {
  assert.equal(contrast({ rgb: [0, 0, 0], alpha: 1 }, '#ffffff').toFixed(0), '21')   // 黑白 = 21:1
  assert.equal(contrast({ rgb: [255, 255, 255], alpha: 1 }, '#ffffff').toFixed(0), '1')
  // 半透明要先疊到背景再算
  const half = contrast({ rgb: [0, 0, 0], alpha: 0.5 }, '#ffffff')
  assert.ok(half > 1 && half < 21, `半透明黑應介於兩者之間,實得 ${half}`)
})

test('顏色解析:hex 與 rgba 都吃,壞字串回 null', () => {
  assert.deepEqual(parseColor('#1a1a1e'), { rgb: [26, 26, 30], alpha: 1 })
  assert.deepEqual(parseColor('#abc'), { rgb: [170, 187, 204], alpha: 1 })
  assert.deepEqual(parseColor('rgba(60,60,67,0.65)'), { rgb: [60, 60, 67], alpha: 0.65 })
  assert.deepEqual(parseColor('rgb(1,2,3)'), { rgb: [1, 2, 3], alpha: 1 })
  for (const bad of ['', 'red', 'var(--x)', '#12345', 'linear-gradient(90deg, red, blue)']) {
    assert.equal(parseColor(bad), null, `${JSON.stringify(bad)} 應回 null`)
  }
})
