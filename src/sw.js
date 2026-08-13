// Service worker: precache the shell so the app runs with no network at all.
// The model bundle is deliberately not precached — `lib/storage.js` owns that
// one-time download and its own cache entry.

const SHELL_CACHE = 'blinkcode-shell-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'lib/arith.js',
  'lib/codec.js',
  'lib/format.js',
  'lib/geometry.js',
  'lib/image-codec.js',
  'lib/model.js',
  'lib/palette.js',
  'lib/rs.js',
  'lib/spectracode.js',
  'lib/spectra-decode.js',
  'lib/storage.js',
  'lib/surface.js',
  'workers/worker-rpc.js',
  'workers/model-loader.js',
  'workers/compression-worker.js',
  'workers/decompression-worker.js',
  'workers/spectracode-decoder-worker.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('blinkcode-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
            return response;
          })
          .catch(() => caches.match('index.html')),
    ),
  );
});
