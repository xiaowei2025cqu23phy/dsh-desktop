/**
 * 手机 PWA 离线外壳 Service Worker。
 * 缓存应用壳(HTML/JS/CSS/图标),离线或弱网时兜底;API/事件流不缓存,始终走网络。
 * 注意:SW 只能在「安全上下文」注册——网关走明文 HTTP 时(http://192.168.x.x)
 * 浏览器会拒绝注册,此时 PWA 自动退化为「浏览器标签页使用」(见 docs/PWA.md)。
 */
/**
 * 缓存名带构建版本(构建期由 scripts/copy-assets.mjs 替换 __DSH_CACHE_VERSION__)。
 * 版本变化 → 新缓存名 → install 重新拉取外壳、activate 删除旧缓存,
 * 手机端才会拿到新版 app.js / app.css。
 */
const CACHE = 'dsh-remote-__DSH_CACHE_VERSION__'
const SHELL = ['./', './index.html', './app.js', './app.css', './manifest.webmanifest', './icon.png', './icon-192.png', './icon-512.png', './icon-maskable.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  // API / 事件流(Session 数据、审批、token)不缓存,始终走网络。
  if (url.pathname.startsWith('/api/')) return
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached
      return fetch(event.request).then((resp) => {
        if (resp.ok && /\.(js|css|png|html|webmanifest)$/.test(url.pathname) || url.pathname === '/') {
          const clone = resp.clone()
          caches.open(CACHE).then((cache) => cache.put(event.request, clone))
        }
        return resp
      }).catch(() => caches.match('./index.html'))
    }),
  )
})
