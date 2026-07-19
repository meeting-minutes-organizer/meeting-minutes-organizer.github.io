// Service Worker：快取 App 靜態殼，離線可開啟並瀏覽已存記錄。
// Gemini API 一律走網路（不快取）。
const CACHE = 'meeting-app-v33';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/settings.js',
  './js/store.js',
  './js/gemini.js',
  './js/format.js',
  './js/search.js',
  './js/usage.js',
  './js/audio.js',
  './js/export.js',
  './js/docx.js',
  './js/sync.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 網路優先（network-first）：連線時一律拿最新程式碼，離線時才用快取。
// 避免舊版程式被快取卡住，同時保留離線可開啟已存記錄的能力。
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // Gemini API 等外部一律走網路
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
