/* Service Worker — Pedidos ET (Grupo ORO)
   Estrategia: RED PRIMERO (las actualizaciones que subís a GitHub llegan
   en cuanto el cliente abre), con respaldo en caché para trabajar sin
   internet. Los DATOS de Firebase nunca se cachean (siempre en vivo). */

const CACHE = 'pedidos-et-v1';
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async u => {
      try { await c.add(u); } catch(err){ /* archivo opcional: sigue */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Firebase (datos): siempre red, jamás caché
  if(url.hostname.indexOf('firebaseio.com') !== -1 ||
     url.hostname.indexOf('firebasedatabase.app') !== -1) return;

  e.respondWith(
    fetch(e.request).then(res => {
      if(res && (res.ok || res.type === 'opaque')){
        const copia = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copia)).catch(()=>{});
      }
      return res;
    }).catch(() =>
      caches.match(e.request, {ignoreSearch:true})
        .then(r => r || caches.match('./index.html'))
    )
  );
});
