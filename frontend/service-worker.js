const CACHE_NAME = 'pinbox-wms-v1.0.20';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/html5-qrcode.min.js',
  '/js/qrcode.min.js',
  '/js/local-db.js',
  '/js/papaparse.min.js',
  '/js/sha256.min.js',
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
          if (key.startsWith('pinbox-wms-') && key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!['http:', 'https:'].includes(url.protocol)) return;

  // API 请求：仅网络，离线时返回明确错误
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ detail: '网络已断开，请切换到本地模式或重新连接服务器' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // 静态资源：网络优先，失败回退缓存（保证部署后立即拿到新版本）
  event.respondWith(
    fetch(event.request, { cache: 'reload' })   // 绕过 HTTP 缓存，确保新版本立即可见
      .then(async (response) => {
        if (response && response.ok) {
          const clone = response.clone();
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, clone);
        }
        return response;
      })
      .catch(() => {
        return caches.open(CACHE_NAME).then(async cache => {
          const cached = await cache.match(event.request, { ignoreSearch: true });
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return cache.match('/index.html');
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});
