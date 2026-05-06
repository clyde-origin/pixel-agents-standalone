const CACHE = 'pixel-agents-v1'
const ASSETS = ['/', '/index.html']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)))
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Never cache websockets or API
  if (url.pathname.startsWith('/permission/') || url.pathname.startsWith('/watch-list')) return
  if (event.request.method !== 'GET') return
  event.respondWith(
    caches.match(event.request).then(
      (hit) => hit || fetch(event.request).then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(event.request, copy))
        return res
      }).catch(() => caches.match('/')),
    ),
  )
})
