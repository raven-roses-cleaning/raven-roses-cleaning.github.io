/* Raven & Roses Colouring Book — service worker.
   Caches the app shell pieces that live alongside this file (images, icons,
   manifest) so repeat visits load fast. Everything is best-effort: if a
   cache step fails, the app still works straight from the network. */
var CACHE = 'raven-colouring-v41';
var FILES = [
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './media-generation-raven-colouring-title-page-v3-0-d2080ffa-02d7-4d5f-aae8-37447f1e4be4.webp',
  './media-generation-raven-colouring-page-01-v3-rav-0-61351067-f43a-45b5-b12c-d1c9a3c039e3.webp',
  './media-generation-raven-colouring-page-02-v3-qui-0-c24d3b09-3fec-4790-99df-16255f19a09c.webp',
  './media-generation-raven-colouring-page-03-v3-rav-0-3f479067-9a20-42a3-b031-011eebdc28d4.webp',
  './media-generation-raven-colouring-page-04-v3-rav-0-984a3ee2-6bfa-4910-8c54-74e313dbd616.webp',
  './media-generation-raven-colouring-page-05-v3-dar-0-ce16e471-4c91-45c4-9976-c42b09adfd03.webp',
  './media-generation-raven-colouring-page-06-v3-rav-0-d66dd91d-c1cf-4ff5-85f0-a7c659153b5f.webp',
  './media-generation-raven-colouring-page-07-v3-rav-0-4097389d-b70a-488d-b10a-c7ffa0835a0d.webp',
  './media-generation-raven-colouring-page-08-v6-ros-0-485c7240-a87a-4878-830d-395abf193888.webp',
  './media-generation-raven-colouring-page-09-v6-bir-0-d9f4e94c-097e-47dc-9a1c-ee5447a20393.webp',
  './media-generation-raven-lakeside-cabin-level2-re-0-8885449a-8330-49f8-a2ab-5ce83beeb2c4.webp',
  './media-generation-raven-rugged-mountain-level4-0-11fc21e4-8630-4edf-b4c8-e94ae7543057.webp'
];
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(FILES); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () {})
  );
});
self.addEventListener('activate', function (e) {
  // Delete every older cache (v1, v2, …) so a phone can never be served
  // a stale copy of the app shell from a previous version.
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); }).catch(function () {})
  );
});
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  // The book's PAGE ITSELF is network-first: a published fix must
  // reach the phone on the FIRST open after it ships, not be served
  // stale from the cache and only refreshed in the background (that
  // is exactly why the v22 Cover fix "did not take effect" — the
  // phone kept running the cached v21 page). The fresh page is still
  // copied into the cache as it loads, and when the network is
  // unavailable the cached page is served, so the book keeps working
  // offline exactly as before.
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      caches.open(CACHE).then(function (cache) {
        return fetch(e.request).then(function (resp) {
          if (resp && (resp.status === 200 || resp.type === 'opaque')) {
            cache.put(e.request, resp.clone()).catch(function () {});
          }
          return resp;
        }).catch(function () {
          return cache.match(e.request).then(function (cached) {
            return cached || cache.match('./');
          });
        });
      })
    );
    return;
  }
  // Everything else (page pictures, music, icons, fonts):
  // stale-while-revalidate — serve the cached copy at once if there
  // is one, and refresh it from the network in the background.
  // Anything not yet cached is fetched once and then kept, so after
  // the first open the book — pages and music included, as they are
  // loaded — works offline.
  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(e.request).then(function (cached) {
        var network = fetch(e.request).then(function (resp) {
          if (resp && (resp.status === 200 || resp.type === 'opaque')) {
            cache.put(e.request, resp.clone()).catch(function () {});
          }
          return resp;
        }).catch(function () { return cached; });
        return cached || network;
      });
    })
  );
});
