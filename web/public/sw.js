// Service worker for 台股 AI 助手 PWA
// Strategy: HTML/navigation + data.json network-first (so new deploys and fresh
// data load immediately), hashed assets cache-first (immutable by content hash).
// NOTE: previously index.html was cache-first, which pinned users to a stale
// bundle for a launch or more after each deploy — fixed here.
const CACHE = 'invest-pwa-v2'
const BASE = '/invest/'
const SHELL = [BASE, BASE + 'index.html', BASE + 'manifest.json', BASE + 'icon.svg']

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // let cross-origin (fonts, APIs) hit network directly

  // HTML entry / navigations + market data: network-first so a new deploy (and
  // fresh data) is picked up immediately; fall back to cache when offline.
  const isNavigation = req.mode === 'navigate'
  const isHtml = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')
  if (url.pathname.endsWith('/data.json') || isNavigation || isHtml) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
          return res
        })
        .catch(() => caches.match(req))
    )
    return
  }

  // App shell + hashed assets: cache-first, refresh in background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        })
        .catch(() => cached)
      return cached || network
    })
  )
})
