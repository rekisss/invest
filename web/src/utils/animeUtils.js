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

/** Brief scale bump + shadow flash on a price element when value changes */
export function flashPriceEl(el, isUp) {
  if (!el) return
  const shadow = isUp
    ? ['0 0 0 2px rgba(255,69,58,0.6)', '0 0 0 0px rgba(255,69,58,0)']
    : ['0 0 0 2px rgba(48,209,88,0.6)',  '0 0 0 0px rgba(48,209,88,0)']
  animate(el, {
    scale:     [1, 1.07, 1],
    boxShadow: shadow,
    duration:  480,
    ease:      'outBack(2)',
  })
}
