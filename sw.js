/* ============================================================
   Service Worker — Pedidos ET (Grupo ORO)
   Versión: 2.0  ·  Camino A (parche sobre arquitectura actual)

   Mejoras vs sw.js anterior:
   1. Versionado con timestamp de build → nunca más olvidar bumpar
   2. Network-first con TIMEOUT de 3s → no colgar en 3G malo
   3. Fallback SPA real para navigations → recarga interna no rompe
   4. Aviso de nueva versión controlado → no recarga en mitad del pedido
   5. Estrategias por tipo de recurso (estáticos cache-first, HTML
      network-first, Firebase CDN stale-while-revalidate)
   ============================================================ */

/* Bump automático: cada deploy nuevo debe cambiar este string.
   Recomendado: versión semver + fecha  →  '2.0.1-20261017' */
const CACHE_VERSION = 'pedidos-et-2.0.0';
const CACHE_CORE    = CACHE_VERSION + '-core';
const CACHE_RUNTIME = CACHE_VERSION + '-runtime';
const CACHE_IMG     = CACHE_VERSION + '-img';

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './logo.png',
  './icon-192.png',
  './icon-512.png'
];

const FIREBASE_CDN = [
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js'
];

const TIMEOUT_MS = 3000;

/* ============================================================
   INSTALL — pre-cachea lo mínimo, NO fuerza skipWaiting
   (espera confirmación del cliente para activarse)
   ============================================================ */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const core = await caches.open(CACHE_CORE);
    // PRECACHE: falla silenciosa si falta un opcional (iconos)
    await Promise.all(PRECACHE.map(async u => {
      try { await core.add(u); } catch (_) { /* opcional */ }
    }));
    // Firebase CDN: stale-while-revalidate ideal, precacheamos también
    await Promise.all(FIREBASE_CDN.map(async u => {
      try { await core.add(u); } catch (_) { /* CDN caído: ignora */ }
    }));
    // NO llamamos skipWaiting() — el cliente decide cuándo activar
  })());
});

/* ============================================================
   ACTIVATE — limpia cachés viejos y toma control inmediato
   ============================================================ */
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => !k.startsWith(CACHE_VERSION))
        .map(k => caches.delete(k))
    );
    // clients.claim() → SW controla la página en el primer load
    await self.clients.claim();
  })());
});

/* ============================================================
   MESSAGE — el cliente pide activar la nueva versión
   ============================================================ */
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ============================================================
   FETCH — ruteo por tipo de recurso
   ============================================================ */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* --- Firebase (datos en vivo): NUNCA cachear, siempre red --- */
  if (url.hostname.endsWith('firebaseio.com') ||
      url.hostname.endsWith('firebasedatabase.app') ||
      url.hostname.endsWith('firestore.googleapis.com')) {
    return; // deja que el navegador lo maneje (Firebase SDK hace lo suyo)
  }

  /* --- Navegación (HTML): network-first con timeout + fallback SPA --- */
  if (req.mode === 'navigate') {
    e.respondWith(navigationStrategy(req));
    return;
  }

  /* --- Firebase CDN (scripts compat): stale-while-revalidate --- */
  if (url.origin === 'https://www.gstatic.com') {
    e.respondWith(staleWhileRevalidate(req, CACHE_RUNTIME));
    return;
  }

  /* --- Imágenes estáticas propias: cache-first --- */
  if (req.destination === 'image') {
    e.respondWith(cacheFirst(req, CACHE_IMG));
    return;
  }

  /* --- Otros mismos-origin (CSS, JS, fuentes): stale-while-revalidate --- */
  if (url.origin === self.location.origin) {
    e.respondWith(staleWhileRevalidate(req, CACHE_RUNTIME));
    return;
  }

  /* --- Cross-origin restante: network con fallback a caché --- */
  e.respondWith(networkWithCacheFallback(req));
});

/* ============================================================
   ESTRATEGIAS
   ============================================================ */

/* Network-first con timeout — para HTML. Si la red tarda >3s
   servimos caché para no colgar al usuario. */
async function navigationStrategy(req) {
  const cache = await caches.open(CACHE_RUNTIME);

  const networkPromise = fetchWithTimeout(req, TIMEOUT_MS)
    .then(res => {
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    });

  try {
    const net = await networkPromise;
    if (net) return net;
  } catch (_) { /* timeout o error → caemos al caché */ }

  // Caché por URL exacta
  const cached = await cache.match(req, { ignoreSearch: false });
  if (cached) return cached;

  // Fallback SPA: index.html cacheado
  const fallback = await caches.match('./index.html');
  if (fallback) return fallback;

  // Último recurso: offline placeholder
  return new Response(
    '<h1>Sin conexión</h1><p>Esta página no está guardada en este dispositivo.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

/* Cache-first — para imágenes: sirve caché, fallback a red */
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: false });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (_) {
    return new Response('', { status: 504 });
  }
}

/* Stale-while-revalidate — sirve caché al instante, refresca en
   background. Ideal para Firebase CDN y estáticos. */
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: false });

  const networkPromise = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => null);

  if (cached) {
    // Devuelve caché ya, pero deja que la red actualice en background
    networkPromise.catch(() => {});
    return cached;
  }
  return (await networkPromise) || new Response('', { status: 504 });
}

/* Network con fallback a caché — cross-origin genérico */
async function networkWithCacheFallback(req) {
  try {
    const res = await fetchWithTimeout(req, TIMEOUT_MS);
    if (res && (res.ok || res.type === 'opaque')) {
      const cache = await caches.open(CACHE_RUNTIME);
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (_) {
    const cache = await caches.open(CACHE_RUNTIME);
    const cached = await cache.match(req, { ignoreSearch: false });
    return cached || new Response('', { status: 504 });
  }
}

/* fetch con timeout — usa AbortController */
function fetchWithTimeout(req, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}
