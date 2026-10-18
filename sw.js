// Service worker : met en cache toute l'application (les packs de carte sont stockés à part, dans OPFS / Cache Storage).
const VERSION = 'gps-app-v1.0.0';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './css/app.css', './js/app.js', './js/storage.js', './js/router-worker.js', './js/dl-worker.js',
  './lib/maplibre-gl.js', './lib/maplibre-gl.css', './lib/pmtiles.js', './assets/style.json',
  './assets/sprites/dark.json', './assets/sprites/dark.png', './assets/sprites/dark@2x.json', './assets/sprites/dark@2x.png',
  './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png', './catalog.json',
  ...['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'].flatMap(f => ['0-255', '256-511', '512-767', '768-1023', '8192-8447', '8448-8703', '9728-9983'].map(r => `./assets/fonts/${f}/${r}.pbf`))
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('gps-app-') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/packs/')) return; // téléchargements des packs : réseau direct, jamais mis en cache ici
  if (url.pathname.endsWith('/catalog.json')) { // réseau d'abord, cache ensuite
    e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(VERSION).then(c => c.put('./catalog.json', cp)); return r; }).catch(() => caches.match('./catalog.json')));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok && r.type === 'basic') { const cp = r.clone(); caches.open(VERSION).then(c => c.put(e.request, cp)); }
    return r;
  }).catch(() => {
    if (url.pathname.includes('/assets/fonts/')) return new Response(new Uint8Array(0), { headers: { 'Content-Type': 'application/x-protobuf' } }); // plage de glyphes absente : réponse vide
    if (e.request.mode === 'navigate') return caches.match('./index.html');
    return new Response('', { status: 504 });
  })));
});
