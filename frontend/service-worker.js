const CACHE_NAME = 'pinbox-wms-v28';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/html5-qrcode.min.js',
  '/js/qrcode.min.js',
  '/js/local-db.js',
  '/js/local-api.js',
  '/js/api.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // API 请求：仅网络，离线时返回明确错误
  if (url.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: '网络已断开' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // 静态资源：网络优先，失败回退缓存（保证部署后立即拿到新版本）
  event.respondWith(
    fetch(event.request, { cache: 'reload' })   // 绕过 HTTP 缓存，确保新版本立即可见
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match('/');
          }
        });
      })
  );
});
