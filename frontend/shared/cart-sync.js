/* Keeps localStorage.remont_cart in step with the signed-in customer's cart on the backend, so the
 * same cart shows on the website, the installed PWA and the Android app.
 *
 * Every page already reads and writes remont_cart directly, so this watches those writes instead
 * of changing each page. Guests keep a local-only cart, which is merged into the account's cart
 * when they sign in. Prices here are display values only: checkout re-prices on the server.
 */
(function () {
  var CART_KEY = 'remont_cart';
  var META_KEY = 'remont_cart_sync'; // { userId, dirty }
  var API = (window.location.hostname === 'localhost' ? 'http://localhost:3001' : '') + '/api/v1';
  var PUSH_DELAY_MS = 800;
  var realSet = Storage.prototype.setItem;
  var realRemove = Storage.prototype.removeItem;
  var pushTimer = null;
  var applying = false;

  function token() { try { return localStorage.getItem('remont_access_token') || localStorage.getItem('remont_token'); } catch (e) { return null; } }
  function currentUserId() {
    try { return (JSON.parse(localStorage.getItem('remont_user') || 'null') || {}).id || null; } catch (e) { return null; }
  }
  function readCart() {
    try { var c = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); return Array.isArray(c) ? c : []; } catch (e) { return []; }
  }
  function readMeta() { try { return JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function writeMeta(m) { try { realSet.call(localStorage, META_KEY, JSON.stringify(m)); } catch (e) {} }

  function request(method, body) {
    var t = token();
    if (!t) return Promise.reject(new Error('signed out'));
    var send = function (bearer) {
      return fetch(API + '/cart', {
        method: method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
        body: body ? JSON.stringify(body) : undefined,
      });
    };
    return send(t).then(function (res) {
      if (res.status === 401 && window.RemontAuth && RemontAuth.refresh) {
        return RemontAuth.refresh().then(function () { return send(token()); });
      }
      return res;
    }).then(function (res) {
      if (!res.ok) throw new Error('cart ' + res.status);
      return res.json();
    }).then(function (j) { return j && j.data ? j.data : j; });
  }

  // Pages keep a price, a unit and so on per line; only the line id and quantity must be valid.
  function pushable(cart) {
    return cart.filter(function (i) { return i && typeof i.id === 'string' && i.id; }).slice(0, 100).map(function (i) {
      var line = {};
      Object.keys(i).forEach(function (k) {
        if (['string', 'number', 'boolean'].indexOf(typeof i[k]) !== -1) line[k] = i[k];
      });
      line.qty = Math.min(99, Math.max(1, parseInt(i.qty, 10) || 1));
      return line;
    });
  }

  function push() {
    if (!token()) return Promise.resolve();
    return request('PUT', { items: pushable(readCart()) }).then(function () {
      var m = readMeta(); m.dirty = false; m.userId = currentUserId(); writeMeta(m);
    }).catch(function () { /* stays dirty; retried on the next focus or page load */ });
  }

  function schedulePush() {
    var m = readMeta(); m.dirty = true; writeMeta(m);
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, PUSH_DELAY_MS);
  }

  function applyServerCart(items) {
    applying = true;
    try { realSet.call(localStorage, CART_KEY, JSON.stringify(items)); } catch (e) {}
    applying = false;
    if (typeof window.updateCartBadge === 'function') { try { window.updateCartBadge(); } catch (e) {} }
    window.dispatchEvent(new CustomEvent('remont-cart-changed'));
  }

  // Signing in with a guest cart: both carts are kept, the larger quantity winning per line.
  function merge(local, server) {
    var byId = {}, out = [];
    server.concat(local).forEach(function (i) {
      if (!i || !i.id) return;
      if (byId[i.id]) byId[i.id].qty = Math.max(byId[i.id].qty || 1, i.qty || 1);
      else { byId[i.id] = Object.assign({}, i); out.push(byId[i.id]); }
    });
    return out;
  }

  function pull() {
    var userId = currentUserId();
    if (!token() || !userId) return Promise.resolve();
    var meta = readMeta();
    var signedInNow = meta.userId !== userId;
    if (!signedInNow && meta.dirty) return push(); // this device has the newest change
    return request('GET').then(function (d) {
      var server = Array.isArray(d.items) ? d.items : [];
      // A previous account's cart on a shared device never carries over; a guest cart does.
      var local = signedInNow && !meta.userId ? readCart() : [];
      var next = signedInNow ? merge(local, server) : server;
      if (JSON.stringify(next) !== JSON.stringify(readCart())) applyServerCart(next);
      writeMeta({ userId: userId, dirty: false });
      if (signedInNow && local.length) return push();
      return null;
    }).catch(function () {});
  }

  Storage.prototype.setItem = function (key, value) {
    realSet.call(this, key, value);
    if (key === CART_KEY && this === window.localStorage && !applying) {
      window.dispatchEvent(new CustomEvent('remont-cart-changed'));
      if (token()) schedulePush();
    }
    if (key === 'remont_user' && this === window.localStorage) setTimeout(pull, 0); // just signed in
  };
  Storage.prototype.removeItem = function (key) {
    realRemove.call(this, key);
    if (key === CART_KEY && this === window.localStorage && !applying) {
      window.dispatchEvent(new CustomEvent('remont-cart-changed'));
      if (token()) schedulePush();
    }
    if (key === 'remont_user' && this === window.localStorage) {
      // Signed out: the cart stays on the account, not on this device.
      clearTimeout(pushTimer);
      applying = true;
      try { realSet.call(localStorage, CART_KEY, '[]'); } catch (e) {}
      applying = false;
      writeMeta({});
      window.dispatchEvent(new CustomEvent('remont-cart-changed'));
    }
  };

  window.addEventListener('storage', function (e) { if (e.key === CART_KEY) window.dispatchEvent(new CustomEvent('remont-cart-changed')); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') pull(); });
  window.addEventListener('pageshow', pull);
  window.addEventListener('pagehide', function () {
    if (!readMeta().dirty || !token()) return;
    // keepalive lets the last change reach the server as the page closes. Its body is capped at
    // 64 KB, so a bigger cart is not cut short here: it stays dirty and is pushed on the next visit.
    var body = JSON.stringify({ items: pushable(readCart()) });
    if (body.length > 60000) return;
    fetch(API + '/cart', { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() }, body: body }).catch(function () {});
  });
})();
