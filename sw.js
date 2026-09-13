/* Increment this version whenever changing a shipped local file or dependency. */
const PREFIX = `bookscan-${new URL(self.registration.scope).pathname}-`;
const CACHE = `${PREFIX}v5`;
const LOCAL = ['./', './index.html', './styles.css', './js/app.js', './js/isbn.js', './js/metadata.js', './js/db.js', './js/csv.js', './js/scanner.js', './manifest.webmanifest', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png', './assets/book-placeholder.svg'];
LOCAL.push('./js/barcode-camera.js', './js/barcode-worker.js', './js/barcode-decoder.js', './vendor/zxing-wasm/reader/index.js', './vendor/zxing-wasm/share.js', './vendor/zxing-wasm/reader/zxing_reader.wasm');
const CDN = ['https://unpkg.com/dexie@4.0.11/dist/dexie.js', 'https://cdn.tailwindcss.com'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // A new cache version must not reuse stale scripts from the HTTP cache.
    await cache.addAll(LOCAL.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload' })));
    // Required CDN libraries must cache successfully before this worker installs.
    // An unsuccessful update leaves the previous working offline app untouched.
    await Promise.all(CDN.slice(0, 1).map(async url => {
      const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!response.ok) throw new Error('Could not cache runtime dependency');
      await cache.put(url, response);
    }));
    try { await cache.add(CDN[1]); } catch { /* Local CSS is sufficient. */ }
    // No skipWaiting: updates activate after existing app tabs are closed.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const localUrls = LOCAL.map(path => new URL(path, self.registration.scope).href);
  if (localUrls.includes(url.href) || CDN.includes(url.href)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
  }
  // Bibliographic APIs are intentionally network-only: failures must advance the
  // waterfall. Cover requests are optional and fall back to a local SVG offline.
});
