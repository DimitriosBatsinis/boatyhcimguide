// Offline support: the app shell is served from cache and refreshed in the
// background. Wiki API calls and screenshots always go to the network.
const CACHE = 'hcim-v3-shell-2';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/parser.js',
  'js/render.js',
  'js/store.js',
  'js/sync.js',
  'data/guide.json',
  'guides/hardcore-worlds.json',
  'icon.svg',
  'manifest.webmanifest',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const network = fetch(e.request)
        .then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
