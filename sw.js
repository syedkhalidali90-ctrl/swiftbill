/*
  SwiftBill POS — service worker (offline support for the installed app / APK)

  - Pre-caches the app shell on install, so the app opens with no internet.
  - Page loads are NETWORK-FIRST (with a short timeout): when online the latest
    index.html you uploaded is used and saved; when offline the cached copy opens.
  - Other files (icons, manifest) are cache-first and refreshed in the background.
  - Bill data is NOT here: it lives in the browser's localStorage, which a
    service worker update never touches.

  Bump CACHE_VERSION if you rename/remove files listed in APP_SHELL.
*/
const CACHE_VERSION = 'swiftbill-v2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './maskable-192.png',
  './maskable-512.png'
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Resolve with the network response, or reject after a timeout / failure. */
function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(
      res => { clearTimeout(timer); resolve(res); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // wa.me etc. go straight to the network

  // Page navigations (incl. e-invoice links: the #inv=… hash never reaches the server)
  if (req.mode === 'navigate') {
    const scopePath = new URL(self.registration.scope).pathname;
    const isAppPage = url.pathname === scopePath || url.pathname === scopePath + 'index.html';
    event.respondWith(
      fetchWithTimeout(req, NETWORK_TIMEOUT_MS)
        .then(res => {
          // Only the app page itself refreshes the offline copy
          if (res.ok && isAppPage) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put('./index.html', copy));
          }
          // Server error page for the app itself (hosting outage, bad upload): keep the working offline copy
          if (isAppPage && res.status >= 400) {
            return caches.match('./index.html').then(cached => cached || res);
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Static files: cache first, refresh in the background
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
