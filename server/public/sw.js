// Service Worker, damit sich die Seite als App installieren lässt (Android, Chrome, Edge).
// Immer zuerst das Netz: nach einem Update kommt sofort die neue Fassung. Nur ohne Netz
// antwortet die zuletzt geladene Seite (sie sagt dann selbst, dass der Server nicht erreichbar ist).
// Räume, Aufnahmen und Packs (/api, /ws) laufen nie über den Zwischenspeicher.
const CACHE = 'vg-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
