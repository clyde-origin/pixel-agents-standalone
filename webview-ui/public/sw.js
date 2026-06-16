// Network-first service worker.
//
// The app needs its server live anyway (WebSocket on :3456), so always prefer
// fresh assets from the network and fall back to cache only when offline. The
// previous version was cache-first with no revalidation, which pinned the app
// to whatever bundle was first cached — new code never showed up. Bumping CACHE
// + deleting old caches on activate means shipping new code self-heals instead
// of being stuck behind a stale cache.
const CACHE = 'pixel-agents-v2'
const ASSETS = ['/', '/index.html']

self.addEventListener('install', (e) => {
  // Take over immediately instead of waiting for every tab to close.
  self.skipWaiting()
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Never intercept websockets or API calls.
  if (url.pathname.startsWith('/permission/') || url.pathname.startsWith('/watch-list')) return
  if (event.request.method !== 'GET') return
  // Network-first: serve fresh, cache a copy, fall back to cache only offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(event.request, copy))
        return res
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/'))),
  )
})
