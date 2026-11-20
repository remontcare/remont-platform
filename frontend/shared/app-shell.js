/* The app-style layer on customer pages: bottom navigation, cart pill and Offers (matching the
 * Customer App's shell), plus PWA registration, install guidance, update prompt and offline notice.
 * Reuses each page's existing functions and the existing APIs. Desktop keeps its own layout: the
 * elements added here are only displayed by app-shell.css below 769px.
 */
(function () {
  var CHECKOUT_PATHS = /^\/(booking|payment-return)(\.html)?$/;
  var INSTALL_DISMISS_KEY = 'remont_install_dismissed_at';
  var INSTALL_DISMISS_DAYS = 30;
  var PROMPT_DELAY_MS = 20000;
  var API = (window.location.hostname === 'localhost' ? 'http://localhost:3001' : '') + '/api/v1';
  var isStandalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  if (isStandalone) document.documentElement.classList.add('as-standalone');

  function fn(name) { return typeof window[name] === 'function' ? window[name] : null; }
  function isHomePage() { return window.location.pathname === '/' || /\/index(\.html)?$/.test(window.location.pathname); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function store(get, key, value) {
    try {
      if (get) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { /* private mode */ }
    return null;
  }

  // ─── Bottom navigation: Call, WhatsApp, raised Book Now, Categories, Account ───
  // Call and WhatsApp are the two fastest ways to book from a phone, so they sit in the bar.
  // Home is the header logo; Offers is in the menu (and still opens from /?open=offers).
  // Fallbacks are the CMS support_phone / whatsapp_number; a page's own links win (the home
  // page rewrites them from CMS settings, service pages carry a service-specific message).
  var SUPPORT_TEL = '+919232071064';
  var SUPPORT_WA = 'https://wa.me/919232071064?text=' + encodeURIComponent('Hi Remont, I want to book a service');
  function pageLink(selectors, fallback) {
    for (var i = 0; i < selectors.length; i++) {
      var a = document.querySelector(selectors[i]);
      if (a && a.getAttribute('href')) return a.getAttribute('href');
    }
    return fallback;
  }
  var ICONS = {
    call: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
    whatsapp: '<path d="M3 21l1.7-5A8.5 8.5 0 1 1 8 19.3z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-1.9-1-1 .8a4 4 0 0 1-2.2-2.2l.8-1-1-1.9z"/>',
    home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    categories: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    offers: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="8" cy="8" r="1.4"/>',
    account: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  // What each tab does on the home page, where these functions live. Elsewhere the same action
  // is a link to /?open=<action>, so tabs work (and stay crawlable) from every page.
  var ACTIONS = {
    home: function () { window.scrollTo({ top: 0, behavior: 'smooth' }); },
    categories: function () { var f = fn('openMobileCatalogPicker'); if (f) f(); },
    book: function () { var f = fn('openRemiChat'); if (f) f(); },
    offers: function () { openOffers(); },
    account: function () { var f = fn('openAccountSection'); if (f) f(); },
    orders: function () { var f = fn('openMyOrdersModal'); if (f) f(); },
    cart: function () { var f = fn('openCart'); if (f) f(); },
  };
  function runAction(name) {
    if (ACTIONS[name]) ACTIONS[name]();
  }
  window.RemontShellAction = runAction; // used by the home page's phone menu
  function tab(action, label, iconName) {
    var href = action === 'home' ? '/' : '/?open=' + action;
    return '<a class="as-tab" href="' + href + '" data-action="' + action + '">' + icon(iconName) + '<span>' + label + '</span></a>';
  }
  function buildNav() {
    var nav = document.createElement('nav');
    nav.className = 'as-nav';
    nav.setAttribute('aria-label', 'Main');
    nav.innerHTML =
      '<a class="as-tab as-call" href="tel:' + SUPPORT_TEL + '" aria-label="Call Remont to book">' + icon('call') + '<span>Call</span></a>' +
      '<a class="as-tab as-wa" href="' + SUPPORT_WA + '" target="_blank" rel="noopener" aria-label="Book on WhatsApp">' + icon('whatsapp') + '<span>WhatsApp</span></a>' +
      '<a class="as-book" href="/?open=book" data-action="book" aria-label="Book a service now">' + icon('plus') + '<span>Book Now</span></a>' +
      tab('categories', 'Categories', 'categories') + tab('account', 'Account', 'account');
    // Pick up the page's current numbers at tap time: CMS settings arrive after the nav is built.
    var call = nav.querySelector('.as-call'), wa = nav.querySelector('.as-wa');
    var syncContacts = function () {
      call.setAttribute('href', pageLink(['[data-setting="mobile-phone-link"]', 'main a[href^="tel:"]', 'a[href^="tel:"]'], 'tel:' + SUPPORT_TEL));
      wa.setAttribute('href', pageLink(['[data-setting="mobile-whatsapp-link"]', 'main a[href*="wa.me/"]', 'a[href*="wa.me/"]'], SUPPORT_WA));
    };
    syncContacts();
    nav.addEventListener('pointerdown', syncContacts);
    nav.addEventListener('focusin', syncContacts);
    nav.addEventListener('click', function (e) {
      var link = e.target.closest('[data-action]');
      if (!link || !isHomePage()) return;
      e.preventDefault();
      setActive(link.getAttribute('data-action'));
      runAction(link.getAttribute('data-action'));
    });
    document.body.appendChild(nav);
    document.body.classList.add('as-has-nav');
    if (isHomePage()) setActive('home');
    return nav;
  }
  function setActive(action) {
    Array.prototype.forEach.call(document.querySelectorAll('.as-tab'), function (t) {
      var on = t.getAttribute('data-action') === action;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
  }

  // ─── Back navigation ───
  // Every overlay (modal, drawer, sheet, inner screen) gets one history entry while it is open,
  // so the Android Back button, the browser's Back and an on-screen back arrow all close the
  // top overlay instead of leaving the app. Each entry stores its depth; on popstate, every
  // overlay deeper than the entry we landed on is closed. An overlay closed by its own button
  // removes its entry again (a "silent" back that the popstate handler ignores).
  var Nav = (function () {
    var stack = []; // { id, depth, close, back }
    var silent = 0;
    var queued = []; // opened while a silent back was still in flight
    var popping = false;
    var depthNow = function () { return (window.history.state && window.history.state.asDepth) || 0; };
    function open(id, close, back) {
      if (stack.some(function (e) { return e.id === id; })) return;
      // history.back() is asynchronous: pushing now would let that back remove this new entry.
      if (silent > 0) { queued.push([id, close, back]); return; }
      var depth = depthNow() + 1;
      stack.push({ id: id, depth: depth, close: close, back: back });
      window.history.pushState({ asDepth: depth, asId: id }, '');
    }
    // Called when an overlay was closed by anything other than Back.
    function closed(id) {
      var i = -1;
      stack.forEach(function (e, n) { if (e.id === id) i = n; });
      if (i === -1 || popping) return;
      var wasTop = i === stack.length - 1;
      stack.splice(i, 1);
      if (wasTop && depthNow() > 0) { silent++; window.history.back(); }
    }
    function isOpen(id) { return stack.some(function (e) { return e.id === id; }); }
    window.addEventListener('popstate', function () {
      if (silent > 0) {
        silent--;
        if (!silent) queued.splice(0).forEach(function (q) { open(q[0], q[1], q[2]); });
        return;
      }
      var landed = depthNow();
      popping = true;
      try {
        while (stack.length && stack[stack.length - 1].depth > landed) {
          var top = stack[stack.length - 1];
          // An overlay with steps (the booking form) goes back one step first, keeping its entry.
          if (top.back && top.back()) { window.history.pushState({ asDepth: top.depth, asId: top.id }, ''); break; }
          stack.pop();
          try { top.close(); } catch (e) { /* the page's own close failed; the entry is gone either way */ }
        }
      } finally { popping = false; }
    });
    return { open: open, closed: closed, isOpen: isOpen };
  })();
  window.RemontNav = Nav;

  // The page's existing overlays, each with the function the page already uses to close it.
  // They are watched rather than edited, so every way of opening one (buttons, search, AI chat
  // actions, deep links) gets Back support without touching those call sites.
  var OVERLAYS = [
    { el: 'booking-modal', close: 'closeBookingModal', back: function () { if (window._bmStep > 1 && fn('bmGoStep')) { window.bmGoStep(window._bmStep - 1); return true; } return false; } },
    { el: 'cartDrawer', close: 'closeCart', visible: function (el) { return el.classList.contains('open'); } },
    { el: 'checkout-modal', close: 'closeCheckoutModal' },
    { el: 'auth-modal', close: 'closeAuthModal' },
    { el: 'account-modal', close: 'closeAccountModal' },
    { el: 'my-orders-modal', close: 'closeMyOrdersModal' },
    { el: 'order-details-modal', close: 'closeOrderDetailsModal' },
    { el: 'order-success-modal', close: 'closeOrderSuccessModal' },
    { el: 'payment-detail-modal', close: 'closePaymentDetailModal' },
    { el: 'rate-order-modal', close: 'closeRateModal' },
    { el: 'support-case-modal', close: 'closeSupportModal' },
    { el: 'tracking-modal', close: 'closeTrackingModal' },
    { el: 'wallet-topup-modal', close: 'closeWalletTopupModal' },
    { el: 'remi-chat-modal', close: 'closeRemiChat' },
    { el: 'svc-detail-overlay', close: 'closeSvcDetail' },
    { el: 'mobile-catalog-overlay', close: 'closeMobileCatalog' },
    { el: 'city-unavail-modal', close: 'closeCityUnavailModal' },
    { el: 'loc-modal-overlay', close: 'closeLocModal' },
    // These fade in, so the class is the reliable signal (opacity is still 0 at that moment).
    { el: 'cityModal', close: 'closeCityModal', visible: function (el) { return el.classList.contains('open'); } },
    { el: 'quoteModal', close: 'closeQuotationModal', visible: function (el) { return el.classList.contains('open'); } },
    { el: 'premiumLeadModal', close: 'closePremiumLeadModal', visible: function (el) { return el.classList.contains('open'); } },
    { el: 'booking-success', close: 'closeBookingSuccess' },
    { el: 'mobileNav', close: 'toggleMenu', visible: function (el) { return el.classList.contains('open'); } },
  ];
  // Some modals stay display:flex and fade in with opacity and pointer-events instead.
  function shown(el) {
    var s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && s.pointerEvents !== 'none' && el.getClientRects().length > 0;
  }
  function watchOverlays() {
    OVERLAYS.forEach(function (o) {
      var el = document.getElementById(o.el);
      if (!el) return;
      var was = false;
      var check = function () {
        var now = o.visible ? o.visible(el) : shown(el);
        if (now === was) return;
        was = now;
        if (now) Nav.open(o.el, function () { var f = fn(o.close); if (f) f(); else el.style.display = 'none'; }, o.back);
        else Nav.closed(o.el);
      };
      new MutationObserver(check).observe(el, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
      check();
    });
  }

  // Installed app on the home screen: the first Back with nothing open asks before leaving.
  function guardExit() {
    if (!isStandalone || !isHomePage()) return;
    var armed = false;
    var arm = function () { if (!window.history.state || !window.history.state.asGuard) window.history.pushState({ asDepth: 1, asGuard: true }, ''); };
    window.history.replaceState({ asDepth: 0 }, '');
    arm();
    window.addEventListener('popstate', function () {
      if (window.history.state && window.history.state.asDepth) return; // still inside the app
      if (armed) return; // second Back: let it leave
      armed = true;
      var t = notice('<strong>Press Back again to exit</strong>', [], 'as-toast');
      setTimeout(function () { armed = false; if (t) t.remove(); arm(); }, 2000);
    });
  }

  // The full-screen chat follows the on-screen keyboard: Android Chrome only shrinks the visual
  // viewport, so without this the message box would sit under the keyboard.
  function fitChatToKeyboard() {
    var chat = document.getElementById('remi-chat-modal');
    if (!chat || !window.visualViewport) return;
    var fit = function () {
      // Only real changes are written: each write is itself a style mutation this observes.
      var want = !isMobileWidth() || chat.style.display === 'none' ? '' : Math.round(window.visualViewport.height) + 'px';
      if (chat.style.getPropertyValue('--as-vh') === want) return;
      if (!want) { chat.style.removeProperty('--as-vh'); return; }
      chat.style.setProperty('--as-vh', want);
      var list = document.getElementById('remi-messages');
      if (list) list.scrollTop = list.scrollHeight;
    };
    window.visualViewport.addEventListener('resize', fit);
    new MutationObserver(fit).observe(chat, { attributes: true, attributeFilter: ['style'] });
  }

  // ─── Cart pill ───
  function cartCount() {
    try {
      var c = JSON.parse(localStorage.getItem('remont_cart') || '[]');
      return c.reduce(function (n, i) { return n + (i.qty || 1); }, 0);
    } catch (e) { return 0; }
  }
  function buildCartPill() {
    var pill = document.createElement('a');
    pill.className = 'as-cart-pill';
    pill.href = '/?open=cart';
    pill.addEventListener('click', function (e) {
      if (!isHomePage()) return;
      e.preventDefault();
      runAction('cart');
    });
    document.body.appendChild(pill);
    var refresh = function () {
      var n = cartCount();
      pill.textContent = n + (n === 1 ? ' item' : ' items') + ' · View cart';
      pill.classList.toggle('show', n > 0);
    };
    window.addEventListener('remont-cart-changed', refresh);
    refresh();
  }

  // ─── Offers (same data as the app's Offers tab: GET /services/popular) ───
  var offersEl = null;
  function closeOffers() {
    if (offersEl) offersEl.classList.remove('open');
    setActive('home');
    Nav.closed('offers');
  }
  function openOffers() {
    if (!offersEl) {
      offersEl = document.createElement('div');
      offersEl.className = 'as-sheet';
      offersEl.setAttribute('role', 'dialog');
      offersEl.setAttribute('aria-label', 'Offers');
      offersEl.innerHTML = '<div class="as-sheet-head"><button type="button" class="as-back" aria-label="Back">&#8592;</button><h2>Offers</h2></div><div class="as-sheet-body"></div>';
      offersEl.querySelector('.as-back').addEventListener('click', function () { window.history.back(); });
      document.body.appendChild(offersEl);
    }
    offersEl.classList.add('open');
    Nav.open('offers', closeOffers);
    var body = offersEl.querySelector('.as-sheet-body');
    body.innerHTML = '<div class="as-skeleton"></div><div class="as-skeleton"></div><div class="as-skeleton"></div>';
    fetch(API + '/services/popular').then(function (r) {
      if (!r.ok) throw new Error('offers ' + r.status);
      return r.json();
    }).then(function (j) {
      var list = (j && j.data) || [];
      if (!Array.isArray(list) || !list.length) { body.innerHTML = '<p class="as-empty">No offers right now.</p>'; return; }
      body.innerHTML = '<div class="as-offer-hero"><strong>Popular offers</strong><span>On home services &amp; products</span></div>' + list.map(function (s, i) {
        var price = Number(s.offerPrice || s.basePrice || s.price || 0);
        return '<button type="button" class="as-offer" data-i="' + i + '"><span class="as-offer-name">' + esc(s.name) + '</span><span class="as-offer-price">' + (price ? '&#8377;' + price.toLocaleString('en-IN') : '') + '</span></button>';
      }).join('');
      Array.prototype.forEach.call(body.querySelectorAll('.as-offer'), function (b) {
        b.addEventListener('click', function () {
          var s = list[Number(b.getAttribute('data-i'))];
          var price = Number(s.offerPrice || s.basePrice || s.price || 0);
          closeOffers();
          var book = fn('openBookingModal');
          if (book) book(s.id, s.name, price ? '₹' + price : '');
        });
      });
    }).catch(function () {
      body.innerHTML = '<p class="as-empty">Could not load offers. Please check your connection and try again.</p>';
    });
  }
  // ?open=<action> from a tab on another page or a manifest shortcut.
  function runRequestedAction() {
    var params = new URLSearchParams(window.location.search);
    var action = params.get('open');
    if (!action || !ACTIONS[action] || !isHomePage()) return;
    params.delete('open');
    var qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
    setActive(action);
    runAction(action);
  }

  // ─── Small notices ───
  function notice(html, actions, cls) {
    var el = document.createElement('div');
    el.className = 'as-notice ' + (cls || '');
    el.setAttribute('role', 'status');
    el.innerHTML = '<div class="as-notice-text">' + html + '</div><div class="as-notice-actions"></div>';
    var row = el.querySelector('.as-notice-actions');
    actions.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.addEventListener('click', function () { el.remove(); if (a.run) a.run(); });
      row.appendChild(b);
    });
    document.body.appendChild(el);
    return el;
  }

  // ─── Offline notice: anything shown while offline may be out of date ───
  function watchConnection() {
    var el = null;
    var update = function () {
      if (navigator.onLine) { if (el) { el.remove(); el = null; } return; }
      if (!el) {
        el = document.createElement('div');
        el.className = 'as-offline';
        el.setAttribute('role', 'alert');
        el.textContent = "You're offline. Prices may be out of date and booking is unavailable.";
        document.body.appendChild(el);
      }
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  // ─── Install ───
  function installDismissed() {
    var at = Number(store(true, INSTALL_DISMISS_KEY) || 0);
    return at && Date.now() - at < INSTALL_DISMISS_DAYS * 86400000;
  }
  function dismissInstall() { store(false, INSTALL_DISMISS_KEY, String(Date.now())); }
  function isMobileWidth() { return window.innerWidth <= 768; }
  function setupInstall() {
    if (isStandalone) return;
    // Android / Chrome: the browser decides when the app is installable.
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      if (installDismissed() || !isMobileWidth()) return;
      setTimeout(function () {
        notice('<strong>Install Remont</strong><span>Open it from your home screen, like an app.</span>', [
          { label: 'Not now', run: dismissInstall },
          { label: 'Install', primary: true, run: function () { e.prompt(); } },
        ], 'as-install');
      }, PROMPT_DELAY_MS);
    });
    // iPhone / iPad: no install prompt exists, so the steps are shown. Only Safari could add to
    // the home screen on older iOS, so other iOS browsers get the same steps worded for Share.
    var ua = navigator.userAgent;
    var isIos = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIos && !installDismissed() && isMobileWidth()) {
      setTimeout(function () {
        notice('<strong>Add Remont to your Home Screen</strong><span>Tap the Share button, then choose <b>Add to Home Screen</b>.</span>', [
          { label: 'Got it', primary: true, run: dismissInstall },
        ], 'as-install');
      }, PROMPT_DELAY_MS);
    }
  }

  // ─── Service worker + updates ───
  function isVisible(el) {
    if (!el) return false;
    var s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  function isCheckoutInProgress() {
    // Razorpay's script adds its container at page load, hidden, so presence alone means nothing.
    return CHECKOUT_PATHS.test(window.location.pathname) ||
      isVisible(document.querySelector('.razorpay-container')) ||
      isVisible(document.getElementById('checkout-modal')) ||
      isVisible(document.getElementById('bm-service'));
  }
  function offerUpdate(worker) {
    if (!worker) return;
    if (isCheckoutInProgress()) {
      setTimeout(function () { offerUpdate(worker); }, 30000);
      return;
    }
    if (document.querySelector('.as-update')) return;
    notice('<strong>A new version of Remont is ready</strong>', [
      { label: 'Later' },
      { label: 'Update', primary: true, run: function () {
        window.__remontUpdateRequested = true;
        worker.postMessage({ type: 'SKIP_WAITING' });
      } },
    ], 'as-update');
  }
  function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      // Only after the user chose to update; a first install also changes the controller.
      if (window.__remontUpdateRequested) window.location.reload();
    });
    navigator.serviceWorker.register('/firebase-messaging-sw.js', { updateViaCache: 'none' }).then(function (reg) {
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', function () {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') reg.update().catch(function () {});
      });
    }).catch(function () {});
  }

  // Icon-only controls and unlabelled fields need a name for screen readers.
  var NAMES = {
    '.cart-btn': 'Cart', '.profile-btn': 'Account', '#qPhotoInput': 'Add a photo',
    '#plPropertyType': 'Property type', '#plBudget': 'Budget', '#plCallbackTime': 'Preferred callback time',
  };
  function nameControls() {
    Object.keys(NAMES).forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el && !el.getAttribute('aria-label')) el.setAttribute('aria-label', NAMES[sel]);
    });
  }

  function init() {
    nameControls();
    buildNav();
    buildCartPill();
    guardExit();
    watchOverlays();
    fitChatToKeyboard();
    watchConnection();
    setupInstall();
    if (document.readyState === 'complete') setupServiceWorker();
    else window.addEventListener('load', setupServiceWorker);
    // After the page's own scripts have defined the functions the action needs.
    if (document.readyState === 'complete') runRequestedAction();
    else window.addEventListener('load', runRequestedAction);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
