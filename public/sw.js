/* Transit HK (通) Service Worker — Explicit SKIP_WAITING Update Lifecycle */
const SW_BUILD_VERSION = '2026-11-25 19:34 HKT';
const CACHE_PREFIX = 'transit-hk-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${SW_BUILD_VERSION.replace(/[^0-9A-Za-z_-]+/g, '-')}`;

const CORE_SHELL_URLS = [
  './',
  'index.html',
  'icon.png',
  'icon.svg',
];

self.addEventListener('install', (event) => {
  // Intentionally do NOT call self.skipWaiting() here so updates enter the waiting state
  // and prompt the user via the in-app "New version available — Tap to update" toast.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(CORE_SHELL_URLS.map((u) => cache.add(u))))
      .catch(() => {})
  );
});

self.addEventListener('message', (event) => {
  const data = event && event.data;
  if (data === 'SKIP_WAITING' || (data && data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .catch(() => {})
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Always bypass SW cache for live API endpoints, version manifests, and sw.js itself
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.endsWith('/version.json') ||
    url.pathname === '/version.json' ||
    url.pathname.endsWith('/sw.js') ||
    url.pathname === '/sw.js'
  ) {
    return;
  }

  // Network-first for HTML documents and core JS scripts so fresh deploys load immediately
  const isNavOrCode =
    req.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js');

  if (isNavOrCode) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
    );
    return;
  }

  // Cache-first for static icons/assets (excluding large mutable JSON handled by IndexedDB)
  if (/\.(?:png|svg|ico|webp|jpg|jpeg|css|woff2?)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
  }
});
