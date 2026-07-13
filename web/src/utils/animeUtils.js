import { animate, stagger, spring } from 'animejs'

export const tabSpring  = spring({ stiffness: 380, damping: 28, mass: 0.9, velocity: 0 })
export const cardSpring = spring({ stiffness: 300, damping: 22, mass: 1,   velocity: 0 })

/** Slide a tab panel in from left or right */
export function animateTabIn(el, direction, onComplete) {
  if (!el || !direction) return
  animate(el, {
    translateX: [direction === 'right' ? 64 : -64, 0],
    opacity:    [0, 1],
    ease:       tabSpring,
    onComplete,
  })
}

/** Stagger-animate rows inside a container (elements with data-row attribute) */
export function animateListRows(containerEl) {
  if (!containerEl) return
  const els = [...containerEl.querySelectorAll('[data-row]')]
  if (!els.length) return
  animate(els, {
    opacity:    [0, 1],
    translateY: [10, 0],
    duration:   320,
    ease:       'outQuart',
    delay:      stagger(38, { start: 0 }),
  })
}

/** 全域按鈕按壓回饋:pointerdown 縮小、放開 spring 彈回(事件委派,涵蓋所有 <button>)。
 *  只動 transform scale,不干擾按鈕既有樣式/點擊;disabled 或 data-nopress 略過。 */
export function installPressFeedback(root = document) {
  const pressSpring = spring({ stiffness: 520, damping: 26, mass: 0.7, velocity: 0 })
  const down = (e) => {
    const btn = e.target?.closest?.('button')
    if (!btn || btn.disabled || btn.dataset.nopress != null) return
    animate(btn, { scale: 0.94, duration: 90, ease: 'outQuad' })
    const release = () => {
      root.removeEventListener('pointerup', release)
      root.removeEventListener('pointercancel', release)
      animate(btn, { scale: 1, ease: pressSpring })
    }
    root.addEventListener('pointerup', release, { passive: true })
    root.addEventListener('pointercancel', release, { passive: true })
  }
  root.addEventListener('pointerdown', down, { passive: true })
  return () => root.removeEventListener('pointerdown', down)
}

/** 內容區滑動未過門檻時,把跟手位移 spring 回 0 */
export function springBackX(el) {
  if (!el) return
  animate(el, { translateX: 0, ease: cardSpring })
}

/** Brief scale bump + shadow flash on a price element when value changes */
export function flashPriceEl(el, isUp) {
  if (!el) return
  const shadow = isUp
    ? ['0 0 0 2px rgba(255,51,64,0.6)', '0 0 0 0px rgba(255,51,64,0)']
    : ['0 0 0 2px rgba(22,214,126,0.6)',  '0 0 0 0px rgba(22,214,126,0)']
  animate(el, {
    scale:     [1, 1.07, 1],
    boxShadow: shadow,
    duration:  480,
    ease:      'outBack(2)',
  })
}
