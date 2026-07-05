// Service worker for 台股 AI 助手 PWA
// Strategy: HTML/navigation + data.json network-first (so new deploys and fresh
// data load immediately), hashed assets cache-first (immutable by content hash).
// NOTE: previously index.html was cache-first, which pinned users to a stale
// bundle for a launch or more after each deploy — fixed here.
// v3: data.json 曾以「完整 URL(含 ?t=時間戳)」當快取 key，每次載入囤一份 ~25MB
// 且離線查找永遠 miss;升版讓 activate 清掉 v2 累積的肥大快取。
const CACHE = 'invest-pwa-v3'
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
    // 用「去掉 query 的正規化 key」存取：App 以 data.json?t=<now> 破快取，若以完整
    // URL 當 key，每次載入都新增一份大快取（無上限成長），而離線 fallback 查的是新
    // 時間戳 URL，永遠比對不到舊存檔。另外只快取成功回應——把 404/500 存起來會讓
    // 離線 fallback 重播錯誤頁。
    const key = new Request(url.origin + url.pathname)
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(key, copy))
          }
          return res
        })
        .catch(() => caches.match(key).then((hit) => hit || Response.error()))
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
        .catch(() => cached || Response.error()) // respondWith(undefined) 會直接 TypeError
      return cached || network
    })
  )
})
