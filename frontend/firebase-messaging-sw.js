/* Remont — the one service worker for this origin (default scope /).
 * It keeps this file name because shared/remont-notifications.js registers it for push, and two
 * workers cannot share a scope. It does two jobs:
 *   1. PWA: app shell + static asset caching, offline fallback, update lifecycle.
 *   2. Push: shows FCM background messages. If Firebase isn't configured, no push ever arrives.
 *
 * Never cached: /api/* (prices, stock, OTP, auth, payments, orders), staff and partner portals,
 * and the payment-return page. Those always go straight to the network.
 */
// BUILD_ID is replaced at deploy time (scripts/stamp-sw.js), so each deployment is a new worker.
var CACHE_VERSION = 'remont-v1-__BUILD_ID__';
var STATIC_CACHE = CACHE_VERSION + '-static';
var PAGE_CACHE = CACHE_VERSION + '-pages';
var MAX_CACHED_PAGES = 30;
var OFFLINE_URL = '/offline';
var PRECACHE = [
  OFFLINE_URL,
  '/shared/app-shell.css',
  '/shared/app-shell.js',
  '/shared/cart-sync.js',
  '/icon-192.png',
  '/manifest.webmanifest',
];
var NETWORK_ONLY = /^\/(api|admin|socket\.io|vendor|seller|crm|delivery|corporate|partner-register|seller-register|payment-return)(\/|\.html|$)/;
var IMAGE_OR_FONT = /\.(png|jpe?g|webp|avif|svg|ico|woff2?)$/i;
var SCRIPT_OR_STYLE = /\.(js|css|webmanifest)$/i;

self.addEventListener('install', function (event) {
  // One missing file must not stop the worker installing, so each is added on its own.
  event.waitUntil(caches.open(STATIC_CACHE).then(function (cache) {
    return Promise.all(PRECACHE.map(function (url) { return cache.add(url).catch(function () {}); }));
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.map(function (name) {
      if (name.indexOf('remont-') === 0 && name !== STATIC_CACHE && name !== PAGE_CACHE) return caches.delete(name);
      return null;
    }));
  }).then(function () { return self.clients.claim(); }));
});

// A new version waits until the user taps "Update", so nobody is interrupted during checkout.
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function trimPages(cache) {
  return cache.keys().then(function (keys) {
    if (keys.length > MAX_CACHED_PAGES) return cache.delete(keys[0]);
    return null;
  });
}

function networkFirstPage(request, url) {
  var key = url.origin + url.pathname; // ?open=cart and the like are the same page
  return fetch(request).then(function (response) {
    if (response.ok && response.type === 'basic' && !response.redirected) {
      var copy = response.clone();
      caches.open(PAGE_CACHE).then(function (cache) { return cache.put(key, copy).then(function () { return trimPages(cache); }); });
    }
    return response;
  }).catch(function () {
    return caches.match(key).then(function (hit) { return hit || caches.match(OFFLINE_URL); });
  });
}

function networkFirstAsset(request) {
  return fetch(request).then(function (response) {
    if (response.ok && response.type === 'basic') {
      var copy = response.clone();
      caches.open(STATIC_CACHE).then(function (cache) { cache.put(request, copy); });
    }
    return response;
  }).catch(function () { return caches.match(request); });
}

function cacheFirstAsset(request) {
  return caches.match(request).then(function (hit) {
    return hit || networkFirstAsset(request);
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin || NETWORK_ONLY.test(url.pathname)) return;
  if (request.mode === 'navigate') event.respondWith(networkFirstPage(request, url));
  else if (IMAGE_OR_FONT.test(url.pathname)) event.respondWith(cacheFirstAsset(request));
  else if (SCRIPT_OR_STYLE.test(url.pathname)) event.respondWith(networkFirstAsset(request));
});

// ─── Push ───
self.addEventListener('push', function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { return; }
  var data = payload.data || {};
  var notification = payload.notification || {};
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    // An open, focused tab already gets this over the socket (shared/remont-notifications.js).
    if (clients.some(function (c) { return c.focused; })) return null;
    return self.registration.showNotification(notification.title || data.title || 'Remont', {
      body: notification.body || data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: data,
      // JOB_OFFER background notifications should feel urgent, not dismiss quietly.
      requireInteraction: data.type === 'JOB_OFFER',
      tag: data.orderId || undefined,
    });
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.actionUrl) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    for (var i = 0; i < clients.length; i++) {
      if ('focus' in clients[i] && new URL(clients[i].url).pathname === new URL(url, self.location.origin).pathname) return clients[i].focus();
    }
    return self.clients.openWindow(url);
  }));
});
