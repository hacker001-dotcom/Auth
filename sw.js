// Auth service worker: keeps a copy of the app so it opens offline.
// It never sees your codes; they live in the page's encrypted storage.
//
// If you change any file in the app, change VERSION too. That's how
// installed copies know to fetch the new files.

const VERSION = '1.0.0';
const CACHE = `auth-${VERSION}`;
const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './core.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './barlow-sc-500.woff2',
  './barlow-sc-600.woff2',
  './jsqr.js',
  './qrcode.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('auth-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cached) => cached || fetch(request))
    );
    return;
  }
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => cached || fetch(request))
  );
});
