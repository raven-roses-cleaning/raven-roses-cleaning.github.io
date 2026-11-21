/* Raven & Roses Puzzle Book — service worker.
   Caches the app shell pieces that live alongside this file so repeat
   visits load fast. The page itself is network-first, so a new weekly
   set reaches the phone on the FIRST open after it ships. Everything
   is best-effort: if a cache step fails, the app still works straight
   from the network. */
var CACHE = 'raven-puzzle-v5';
var FILES = [
  './',
  './index.html',
  './manifest.json',
  './assets/cover.webp',
  './assets/share-cover.jpg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/card-rose.webp',
  './assets/raven-engraving-gold.png',
  './assets/piano-soft.mp3',
  './assets/owl-rain-1hour-loop.mp3'
];
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(FILES); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () {})
  );
});
self.addEventListener('activate', function (e) {
  // Delete every older cache so a phone can never be served a stale copy.
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
  // The page itself is network-first: a new weekly set must reach the
  // phone on the first open after it ships, not be served stale.
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
  // Everything else (cover, music, icons): stale-while-revalidate.
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
