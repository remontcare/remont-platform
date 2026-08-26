/* Remont — FCM background message handler.
 * Lives at the site root (not /shared/) so its default scope (/) covers every
 * portal on this origin. Firebase config is fetched at runtime from the backend
 * (never hardcoded here) — see NotificationEngineController.pushConfig() /
 * GET /api/v1/notifications/push-config, which only ever returns non-secret,
 * publicly-shareable values (same idea as PaymentsController exposing Razorpay's
 * public keyId). If FCM isn't configured yet (no Firebase project set up), this
 * file simply never receives a push — no error, no crash.
 */
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

// Activate a new deployment of this file immediately instead of sitting in "waiting"
// until every open tab/installed-PWA instance of the old version closes — otherwise a
// returning PWA session can stay stuck on a stale service worker indefinitely.
self.addEventListener('install', function (event) { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

var API_BASE = self.location.hostname === 'localhost' ? 'http://localhost:3001' : '';

var readyPromise = fetch((API_BASE || '') + '/api/v1/notifications/push-config')
  .then(function (r) { return r.json(); })
  .then(function (res) {
    var cfg = res && res.data ? res.data : res;
    if (!cfg || !cfg.configured) return null;
    firebase.initializeApp({
      apiKey: cfg.apiKey,
      authDomain: cfg.authDomain,
      projectId: cfg.projectId,
      messagingSenderId: cfg.messagingSenderId,
      appId: cfg.appId,
    });
    var messaging = firebase.messaging();
    messaging.onBackgroundMessage(function (payload) {
      var data = (payload && payload.data) || {};
      var title = (payload.notification && payload.notification.title) || data.title || 'Remont';
      var body = (payload.notification && payload.notification.body) || data.body || '';
      self.registration.showNotification(title, {
        body: body,
        icon: '/icon.svg',
        data: data,
        // JOB_OFFER background notifications should feel urgent, not dismiss quietly.
        requireInteraction: data.type === 'JOB_OFFER',
        tag: data.orderId || undefined,
      });
    });
    return messaging;
  })
  .catch(function () { return null; });

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.actionUrl) || '/';
  event.waitUntil(self.clients.openWindow(url));
});
