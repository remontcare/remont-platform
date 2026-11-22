/* Live category page — the real services of one category, straight from the catalogue.
 *
 *   <div id="cl" data-slug="plumbing" data-full="1"></div>
 *   RemontCategoryLive.mount(document.getElementById('cl'), { slug, full, onLoad })
 *
 * Used by /services/<slug> (services/category.html, any slug: "plumber", "ac-repair", the DB slug
 * or key — resolved by the backend's service discovery) and the static service landing pages.
 * Shows the category, its sub-categories, every active service with price, variant chips (Admin →
 * Variants: one card per listing, common description + images) and Add to cart into the same
 * remont_cart the homepage checkout reads. City availability follows the homepage rule.
 * Needs shared/catalog-variants.js.
 */
(function () {
  'use strict';
  var API = '/api/v1';
  var CART_KEY = 'remont_cart';
  // Same key mapping the homepage uses for City.activeServiceKeys (index.html CITY_SERVICES).
  var KEY_MAP = { AC_SERVICE: 'ac', PLUMBING: 'plumbing', ELECTRICAL: 'electrical', APPLIANCE: 'appliance', CLEANING: 'cleaning', INTERIOR: 'interior', RENOVATION: 'renovation', CONSTRUCTION: 'construction', PEST_CONTROL: 'pest-control', FALSE_CEILING: 'false-ceiling', 'FALSE-CEILING': 'false-ceiling' };
  function homeKey(k) { k = String(k || ''); return KEY_MAP[k] || KEY_MAP[k.toUpperCase()] || k.toLowerCase().replace(/_/g, '-'); }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function cssUrl(u) { return "url('" + String(u).replace(/['"\\()\s]/g, encodeURIComponent) + "')"; }
  // Small drawn icons (inline/.svg) are shown whole and centred, photos fill the box.
  function isIcon(u) { return /^data:image\/svg|\.svg(\?|$)/i.test(String(u || '')); }
  function inr(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function unwrap(j) { return j && j.data !== undefined && j.category === undefined && !Array.isArray(j) ? j.data : j; }
  function getJson(path) {
    return fetch(API + path, { headers: { Accept: 'application/json' } }).then(function (r) {
      if (r.status === 404) { var e = new Error('not found'); e.status = 404; throw e; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(unwrap);
  }
  function cartGet() { try { var c = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); return Array.isArray(c) ? c : []; } catch (e) { return []; } }
  function cartSet(c) { try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch (e) {} }
  function storedCity() { try { return localStorage.getItem('remont_city') || ''; } catch (e) { return ''; } }

  function mount(root, opts) {
    opts = opts || {};
    var slug = opts.slug || root.getAttribute('data-slug') || '';
    var full = opts.full != null ? !!opts.full : root.getAttribute('data-full') === '1';
    var CV = window.RemontCatalogVariants;
    var state = { page: null, entries: [], sub: 'all', blocked: null };
    root.classList.add('cl-root');
    root.innerHTML = '<div class="cl-loading" role="status">Loading services…</div>';

    function priceOf(s) { return num(s.basePrice); }
    function entryRows() {
      var rows = state.page.services.filter(function (s) { return state.sub === 'all' || s.subCategoryId === state.sub; });
      return CV ? CV.group(rows, { price: priceOf }) : rows.map(function (r) { return { kind: 'one', item: r }; });
    }

    // ── one card ───────────────────────────────────────────────────────────────────────
    function cardHtml(e, idx, sel) {
      var grouped = e.kind === 'group';
      var s = grouped ? e.members[sel] : e.item;
      var common = CV ? CV.commonContent(s) : null;
      var images = (common && common.images.length ? common.images : [s.imageUrl].concat(s.images || [])).filter(Boolean);
      images = images.filter(function (u, i) { return images.indexOf(u) === i; }).slice(0, 5);
      // No picture of its own → its listing's (a sibling option's) photo, never a blank box.
      if (!images.length && CV) { var pic = CV.listingImage(s, grouped ? e.members : null); if (pic) images = [pic]; }
      var desc = (common && common.description) || s.description || '';
      var price = priceOf(s), orig = num(s.originalPrice);
      var from = grouped && sel === e.sel && CV.hasPriceRange(e);
      var inCart = cartGet().filter(function (c) { return c.id === s.id; }).reduce(function (n, c) { return n + (c.qty || 1); }, 0);
      var canBuy = price > 0 && !state.blocked;
      var off = orig > price && price > 0 ? Math.round((1 - price / orig) * 100) : 0;
      var waText = encodeURIComponent('Hi Remont, I want a quote for ' + (grouped ? e.group.name : s.name) + (grouped ? ' (' + CV.memberLabel(e, sel) + ')' : ''));
      return '<article class="cl-card" id="svc-' + esc(s.id) + '" data-entry="' + idx + '" data-sel="' + sel + '">' +
        // A real <img> (inline SVG icons are not valid CSS backgrounds); the category emoji shows
        // when there is no image or it fails to load.
        '<div class="cl-img">' + (images[0]
          ? '<img src="' + esc(images[0]) + '" alt="' + esc(grouped ? e.group.name : s.name) + '" loading="lazy" decoding="async" class="' + (isIcon(images[0]) ? 'icon' : '') + '" onerror="this.hidden=true;this.nextElementSibling.hidden=false">' +
            '<span hidden>' + esc(state.page.category.icon || '🛠️') + '</span>'
          : '<span>' + esc(state.page.category.icon || '🛠️') + '</span>') + '</div>' +
        (images.length > 1 ? '<div class="cl-thumbs">' + images.map(function (u, i) {
          return '<button type="button" class="' + (i ? '' : 'on') + '" data-img="' + esc(u) + '" aria-label="Photo ' + (i + 1) + '" style="background-image:' + cssUrl(u) + '"></button>';
        }).join('') + '</div>' : '') +
        '<div class="cl-body">' +
          '<h3>' + esc(grouped ? e.group.name : s.name) + '</h3>' +
          '<div class="cl-price">' + (price > 0
            ? (from ? '<span class="cl-from">From</span>' : '') + '<b>' + inr(price) + '</b>' + (orig > price ? '<s>' + inr(orig) + '</s><span class="cl-off">' + off + '% off</span>' : '') + '<span class="cl-unit">' + esc(s.unit || 'per visit') + '</span>'
            : '<b style="font-size:15px">Price after inspection</b>') + '</div>' +
          (grouped ? CV.chipsHtml(e, sel, 'clv') : '') +
          (desc ? '<p class="cl-desc">' + esc(desc) + '</p>' + (desc.length > 140 ? '<button type="button" class="cl-more">Read more</button>' : '') : '') +
          (s.inclusions && s.inclusions.length ? '<ul class="cl-incl">' + s.inclusions.slice(0, 3).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
          '<div class="cl-actions">' + (price > 0
            ? '<button type="button" class="cl-add"' + (canBuy ? '' : ' disabled') + ' aria-label="Add ' + esc(s.name) + ' to cart">' + (inCart ? 'Add another' : 'Add to cart') + '</button>' + (inCart ? '<span class="cl-incart">✓ ' + inCart + ' in cart</span>' : '')
            : '<a class="cl-quote" href="https://wa.me/919232071064?text=' + waText + '" target="_blank" rel="noopener">💬 Get a quote</a>') + '</div>' +
        '</div></article>';
    }

    function render() {
      var p = state.page, c = p.category;
      state.entries = entryRows();
      var prices = p.services.map(priceOf).filter(function (x) { return x > 0; });
      var minPrice = prices.length ? Math.min.apply(null, prices) : 0;
      var heroImg = c.imageUrl || c.logoUrl || '';
      var html = '';
      if (full) {
        html += '<header class="cl-hero' + (heroImg ? ' has-img' : '') + '"><div>' +
          '<div class="cl-eyebrow">' + esc(c.icon || '') + ' Services</div>' +
          '<h1>' + esc(c.name) + '</h1>' +
          (c.description || c.seoDesc ? '<p>' + esc(c.description || c.seoDesc) + '</p>' : '') +
          '<div class="cl-hero-meta"><span class="cl-pill">' + p.services.length + ' service' + (p.services.length === 1 ? '' : 's') + '</span>' +
          (minPrice ? '<span class="cl-pill">From ' + inr(minPrice) + '</span>' : '') + '<span class="cl-pill">✓ Verified professionals</span></div>' +
          '</div>' + (heroImg ? '<div class="cl-hero-img" style="background-image:' + cssUrl(heroImg) + '"></div>' : '') + '</header>';
      }
      html += '<div class="cl-head"><h2>' + (full ? 'Choose a service' : esc(c.name) + ' services & prices') + '</h2><span>' + p.services.length + ' available</span></div>';
      if (state.blocked) html += '<div class="cl-note" role="note">' + state.blocked + '</div>';
      var subs = c.subCategories || [];
      if (subs.length > 1) {
        html += '<div class="cl-subs" role="tablist" aria-label="Filter ' + esc(c.name) + ' services">' +
          [{ id: 'all', name: 'All' }].concat(subs).map(function (sc) {
            return '<button type="button" role="tab" class="cl-sub' + (state.sub === sc.id ? ' on' : '') + '" aria-selected="' + (state.sub === sc.id) + '" data-sub="' + esc(sc.id) + '">' + esc(sc.name) + '</button>';
          }).join('') + '</div>';
      }
      if (!p.services.length) {
        html += '<div class="cl-empty">No ' + esc(c.name) + ' services are listed online yet.<br>' +
          '<a class="cl-quote" href="https://wa.me/919232071064?text=' + encodeURIComponent('Hi Remont, I need ' + c.name) + '" target="_blank" rel="noopener">💬 Ask us on WhatsApp</a></div>';
      } else {
        html += '<div class="cl-grid">' + state.entries.map(function (e, i) { return cardHtml(e, i, e.kind === 'group' ? e.sel : 0); }).join('') + '</div>';
      }
      root.innerHTML = html;
      renderCartBar();
    }

    function rerenderCard(card, sel) {
      var idx = Number(card.getAttribute('data-entry'));
      var tmp = document.createElement('div');
      tmp.innerHTML = cardHtml(state.entries[idx], idx, sel);
      card.replaceWith(tmp.firstChild);
    }

    function selected(card) {
      var e = state.entries[Number(card.getAttribute('data-entry'))];
      var sel = Number(card.getAttribute('data-sel')) || 0;
      return { e: e, sel: sel, s: e.kind === 'group' ? e.members[sel] : e.item };
    }

    function addToCart(card) {
      var v = selected(card), s = v.s;
      if (!(priceOf(s) > 0) || state.blocked) return;
      var c = cartGet();
      var existing = c.find(function (x) { return x.id === s.id; });
      if (existing) existing.qty = (existing.qty || 1) + 1;
      else {
        var item = { id: s.id, name: s.name, price: priceOf(s), type: 'service', unit: s.unit || 'per visit', categoryKey: state.page.category.key, inclusions: s.inclusions || [], qty: 1 };
        if (v.e.kind === 'group') { item.variant = CV.memberLabel(v.e, v.sel); item.variantGroupId = v.e.key; }
        c.push(item);
      }
      cartSet(c);
      toast('✓ Added to cart');
      rerenderCard(card, v.sel);
      renderCartBar();
    }

    function renderCartBar() {
      var bar = document.getElementById('cl-cartbar');
      var cart = cartGet();
      var count = cart.reduce(function (n, i) { return n + (i.qty || 1); }, 0);
      var total = cart.reduce(function (n, i) { return n + num(i.price) * (i.qty || 1); }, 0);
      if (!count) { if (bar) bar.hidden = true; document.body.classList.remove('cl-has-bar'); return; }
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'cl-cartbar';
        bar.className = 'cl-cartbar';
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', 'Cart');
        document.body.appendChild(bar);
      }
      bar.innerHTML = '<span><b>' + count + ' item' + (count === 1 ? '' : 's') + '</b> · ' + inr(total) + '</span><a href="/?open=cart">View cart &amp; book →</a>';
      bar.hidden = false;
      document.body.classList.add('cl-has-bar');
    }

    var toastEl = null, toastTimer = null;
    function toast(msg) {
      if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'cl-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1800);
    }

    root.addEventListener('click', function (ev) {
      var t = ev.target;
      var sub = t.closest('.cl-sub');
      if (sub) { state.sub = sub.getAttribute('data-sub'); render(); return; }
      var card = t.closest('.cl-card');
      if (!card) return;
      if (t.closest('.cl-add')) { addToCart(card); return; }
      if (t.closest('.cl-more')) { var d = card.querySelector('.cl-desc'); d.classList.toggle('open'); t.textContent = d.classList.contains('open') ? 'Show less' : 'Read more'; return; }
      var thumb = t.closest('.cl-thumbs button');
      if (thumb) {
        var big = card.querySelector('.cl-img img'), src = thumb.getAttribute('data-img');
        if (big) { big.hidden = false; big.nextElementSibling.hidden = true; big.className = isIcon(src) ? 'icon' : ''; big.src = src; }
        Array.prototype.forEach.call(thumb.parentNode.children, function (b) { b.classList.toggle('on', b === thumb); });
        return;
      }
      var chip = t.closest('[data-variant-opt]');
      if (chip && CV) {
        var v = selected(card);
        var next = CV.pick(v.e, v.sel, chip.getAttribute('data-variant-opt'), chip.getAttribute('data-variant-val'));
        if (next >= 0 && next !== v.sel) rerenderCard(card, next);
      }
    });
    window.addEventListener('storage', function (e) { if (e.key === CART_KEY && state.page) renderCartBar(); });
    window.addEventListener('pageshow', function () { if (state.page) renderCartBar(); }); // back/forward cache

    // ?service=<id> (from search / REMI): open on that service, with its option selected.
    function focusService(id) {
      if (!id) return;
      var hit = -1, sel = 0;
      state.entries.forEach(function (e, i) {
        if (hit >= 0) return;
        if (e.kind === 'one' && e.item.id === id) hit = i;
        if (e.kind === 'group') e.members.forEach(function (m, j) { if (m.id === id) { hit = i; sel = j; } });
      });
      if (hit < 0) return;
      var card = root.querySelector('.cl-card[data-entry="' + hit + '"]');
      if (!card) return;
      if (sel !== Number(card.getAttribute('data-sel'))) { rerenderCard(card, sel); card = root.querySelector('.cl-card[data-entry="' + hit + '"]'); }
      card.classList.add('hl');
      setTimeout(function () { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
    }

    function cityCheck(category) {
      var city = storedCity();
      if (!city) return Promise.resolve(null);
      return getJson('/cities').then(function (list) {
        var row = (Array.isArray(list) ? list : []).find(function (c) { return c.name === city; });
        if (!row) return null; // unknown city — don't block (same as the homepage)
        if (Number(row.activeVendors || 0) <= 0) return 'Booking isn’t open in <b>' + esc(city) + '</b> yet. <a href="/">Change city</a>';
        var keys = (row.activeServiceKeys || []).map(homeKey);
        return keys.indexOf(homeKey(category.key)) === -1 ? esc(category.name) + ' isn’t available in <b>' + esc(city) + '</b> yet. <a href="/">Change city</a>' : null;
      }).catch(function () { return null; });
    }

    function load() {
      root.innerHTML = '<div class="cl-loading" role="status">Loading services…</div>';
      return getJson('/services/category-page/' + encodeURIComponent(slug)).then(function (page) {
        state.page = page;
        return cityCheck(page.category).then(function (blocked) {
          state.blocked = blocked;
          render();
          focusService(new URLSearchParams(window.location.search).get('service'));
          if (opts.onLoad) opts.onLoad(page);
        });
      }).catch(function (err) {
        if (err && err.status === 404) {
          root.innerHTML = '';
          if (opts.onNotFound) opts.onNotFound(slug); else root.innerHTML = '<div class="cl-empty">This service page was not found.</div>';
          return;
        }
        root.innerHTML = '<div class="cl-error" role="alert">Couldn’t load services — check your connection.<br><button type="button" class="cl-add">Try again</button></div>';
        root.querySelector('.cl-error button').onclick = load;
        if (opts.onError) opts.onError(err);
      });
    }
    return load();
  }

  window.RemontCategoryLive = { mount: mount };
  // Auto-mount: <div data-category-live data-slug="…">
  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-category-live]'), function (el) { mount(el); });
  });
})();
