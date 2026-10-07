/*
 * Service worker de Carga y Ahorra.
 *  - Shell de la app (HTML/JS/CSS/íconos): cache, con actualización en segundo plano.
 *  - Datos (data/app-data.json) y API: SIEMPRE red primero. Si no hay conexión se devuelve la última respuesta
 *    guardada marcada con el encabezado `x-offline-cache` (fecha), y la app la
 *    muestra como "datos guardados, pueden estar desactualizados". Nunca se
 *    presenta información vieja como si fuera actual.
 */
const SHELL = 'cya-shell-v2';
const API = 'cya-data-v2';
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, API].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/api/') || url.pathname.includes('/data/')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(API).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (!cached) return new Response(JSON.stringify({ error: 'Sin conexión' }), { status: 503, headers: { 'content-type': 'application/json' } });
          const body = await cached.blob();
          const headers = new Headers(cached.headers);
          headers.set('x-offline-cache', cached.headers.get('date') || 'desconocida');
          return new Response(body, { status: 200, headers });
        }),
    );
    return;
  }

  // Navegación: red primero, shell como respaldo offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  // Recursos estáticos: cache primero, actualizar en segundo plano.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
