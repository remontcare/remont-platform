/* Remont — Shared Notification Engine Client
 * One script, loaded by every portal (customer, vendor, seller, admin, crm,
 * corporate, delivery). Handles: FCM device-token registration, foreground
 * push display, and the WebSocket "live tick" connection used for Task 9's
 * live-refresh primitive and Task 7's instant foreground job ring.
 *
 * Loads Firebase + Socket.IO from CDN lazily (only once logged in) so portals
 * that never log in (or FCM isn't configured yet) pay zero extra network cost —
 * this repo has no build step, so CDN <script> tags are how every other
 * external lib here (Google Maps links, MSG91, Razorpay checkout.js) is used too.
 *
 * Ring UI (full-screen incoming-job overlay) is NOT here — that's partner-only,
 * see remont-ring.js, loaded only by vendor.html. This file only ever shows a
 * generic toast for non-ring notification types, on every portal.
 */
(function (global) {
  var API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';
  var socket = null;
  var messaging = null;
  var pushConfig = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function genericToast(title, body) {
    if (typeof window.showToast === 'function') { window.showToast(title + ': ' + body); return; }
    // Minimal fallback for portals without a showToast() helper.
    var el = document.createElement('div');
    el.textContent = title + ' — ' + body;
    el.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#111;color:#fff;padding:12px 16px;border-radius:8px;font-size:13px;z-index:99999;max-width:320px;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 6000);
  }

  function dispatchIncoming(payload) {
    if (payload && payload.type === 'JOB_OFFER' && global.RemontRing) {
      global.RemontRing.show(payload);
      return;
    }
    genericToast(payload.title || 'Remont', payload.body || '');
  }

  // ─── WebSocket (foreground/open-tab fast path) ───
  function connectSocket(token) {
    loadScript('https://cdn.socket.io/4.7.4/socket.io.min.js').then(function () {
      if (socket) socket.disconnect();
      socket = global.io((API_BASE || window.location.origin) + '/ws/notifications', {
        query: { token: token },
        transports: ['websocket', 'polling'],
      });
      socket.on('notification', dispatchIncoming);
    }).catch(function () {});
  }

  function disconnectSocket() {
    if (socket) { socket.disconnect(); socket = null; }
  }

  // ─── FCM (background/closed-tab path) ───
  function initFcm() {
    if (!('serviceWorker' in navigator) || !('Notification' in window)) return Promise.resolve(null);
    return fetch((API_BASE || '') + '/api/v1/notifications/push-config').then(function (r) { return r.json(); })
      .then(function (res) {
        pushConfig = res && res.data ? res.data : res;
        if (!pushConfig || !pushConfig.configured) return null; // Firebase not set up yet — safe no-op
        return loadScript('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js')
          .then(function () { return loadScript('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js'); })
          .then(function () { return navigator.serviceWorker.register('/firebase-messaging-sw.js'); })
          .then(function (registration) {
            if (!global.firebase.apps.length) {
              global.firebase.initializeApp({
                apiKey: pushConfig.apiKey,
                authDomain: pushConfig.authDomain,
                projectId: pushConfig.projectId,
                messagingSenderId: pushConfig.messagingSenderId,
                appId: pushConfig.appId,
              });
            }
            messaging = global.firebase.messaging();
            messaging.onMessage(function (payload) {
              var data = (payload && payload.data) || {};
              dispatchIncoming({ title: (payload.notification && payload.notification.title) || data.title, body: (payload.notification && payload.notification.body) || data.body, type: data.type, data: data });
            });
            return Notification.requestPermission().then(function (perm) {
              if (perm !== 'granted') return null;
              return messaging.getToken({ vapidKey: pushConfig.vapidKey, serviceWorkerRegistration: registration });
            });
          });
      })
      .catch(function () { return null; });
  }

  function registerDevice(apiFetch) {
    return initFcm().then(function (token) {
      if (!token) return;
      return apiFetch('/notifications/devices', {
        method: 'POST',
        body: JSON.stringify({ token: token, platform: 'WEB', userAgent: navigator.userAgent }),
      }).catch(function () {});
    }).catch(function () {});
  }

  function unregisterDevice(apiFetch, token) {
    if (!token) return Promise.resolve();
    return apiFetch('/notifications/devices', { method: 'DELETE', body: JSON.stringify({ token: token }) }).catch(function () {});
  }

  // ─── Public hooks — called from RemontAuth.storeSession()/logout() ───
  function onLogin(accessToken) {
    if (!accessToken) return;
    connectSocket(accessToken);
    if (global.RemontAuth && typeof global.RemontAuth.apiFetch === 'function') {
      registerDevice(global.RemontAuth.apiFetch);
    }
  }

  function onLogout() {
    disconnectSocket();
  }

  function ack(deliveryId, event) {
    if (!global.RemontAuth || !deliveryId) return Promise.resolve();
    return global.RemontAuth.apiFetch('/notifications/deliveries/' + deliveryId + '/ack', {
      method: 'PATCH', body: JSON.stringify({ event: event || 'OPENED' }),
    }).catch(function () {});
  }

  global.RemontNotifications = { onLogin: onLogin, onLogout: onLogout, ack: ack };

  // Auto-connect if already logged in when this script loads (page refresh case).
  if (global.RemontAuth && global.RemontAuth.isLoggedIn && global.RemontAuth.isLoggedIn()) {
    onLogin(global.RemontAuth.getToken());
  }
})(window);
