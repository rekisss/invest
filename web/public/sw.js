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

  const isNavigation = req.mode === 'navigate'
  const isHtml = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')

  // data.json is multi-MB. Serving it network-first made every visit block the
  // first render on the full download — on a slow / mobile connection that is a
  // long blank spinner ("頁面跑不出東西"), and the App's `?t=<now>` cache-buster
  // means the browser HTTP cache never helps. Switch to stale-while-revalidate:
  // hand back the cached copy immediately (instant render for返回訪客) and
  // refresh it in the background so the next load — and the App's periodic
  // refresh, which re-fetches after meta.json signals new data — picks up fresh
  // data. First-ever visit (no cache) still falls through to the network.
  // 「去掉 query 的正規化 key」存取：App 以 data.json?t=<now> 破快取，若以完整
  // URL 當 key，每次載入都新增一份大快取（無上限成長）。只快取成功回應——把
  // 404/500 存起來會讓離線 fallback 重播錯誤頁。
  if (url.pathname.endsWith('/data.json')) {
    const key = new Request(url.origin + url.pathname)
    // fresh=1:App 已先用 meta.json(network-first)確認伺服器有新版資料,
    // 這次要的就是新版——走網路優先,失敗才回退快取。沒有這個通道的話,
    // App 發現資料舊了重抓,仍會拿到下面 stale-while-revalidate 的舊快取
    // (背景更新的 20MB+ 還沒下載完),使用者就會卡在舊資料上。
    if (url.searchParams.get('fresh') === '1') {
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
    event.respondWith(
      caches.match(key).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE).then((c) => c.put(key, copy))
            }
            return res
          })
          .catch(() => cached || Response.error())
        return cached || network
      })
    )
    return
  }

  // HTML entry / navigations + meta.json: network-first so a new deploy (fresh
  // hashed bundle) and the freshness signal load immediately; fall back to
  // cache when offline. meta.json is a few hundred bytes and the App polls it to
  // decide whether to re-pull data.json, so it must never be served stale —
  // otherwise the background-refreshed data.json above would go unnoticed.
  const isMeta = url.pathname.endsWith('/meta.json')
  if (isNavigation || isHtml || isMeta) {
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
