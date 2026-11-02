/* Mobile service catalog: the home category grid and popular services, then full-screen
 * category and service-detail screens, all rendered from the /services/categories data the
 * home page already loads (index.html hands it over in buildServicePanel). Nothing here holds
 * a price or a service of its own; booking goes through the page's existing openBookingModal.
 * Desktop keeps its own catalog: these screens only replace the mobile overlay below 769px.
 */
(function () {
  var IMG = '/assets/categories/';
  // One image per category, by its key in the admin (both spellings of the duplicated ones).
  var CATEGORY_IMAGES = {
    PEST_CONTROL: 'pest-control', AC_SERVICE: 'ac-service', PLUMBING: 'plumbing', ELECTRICAL: 'electrical',
    APPLIANCE: 'appliance-repair', CLEANING: 'cleaning', PAINTING: 'painting', INTERIOR: 'interior', interior: 'interior',
    RENOVATION: 'renovation', CARPENTRY: 'carpentry', CONSTRUCTION: 'construction', construction: 'civil-construction',
    WATERPROOFING: 'waterproofing', 'FALSE-CEILING': 'false-ceiling', FALSE_CEILING: 'false-ceiling', FABRICATION: 'fabrication',
    'aluminium-work': 'aluminium-work', 'glass-work': 'glass-work', 'CCTV-SECURITY': 'cctv', solar: 'solar',
    'modular-kitchen': 'modular-kitchen', architecture: 'architecture', commercial: 'commercial',
  };
  var HOME_TILES = 7; // plus "All"

  var cats = []; // [{ fkey, cat }] in display order, only categories that have services
  var byKey = {};
  var screen = null;
  var views = []; // the screens currently stacked: { kind, fkey, svcId, sub }

  function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function inr(n) { return '₹' + Number(n).toLocaleString('en-IN'); }
  function price(s) { return Number(s.offerPrice != null ? s.offerPrice : s.basePrice) || 0; }
  function was(s) { var o = Number(s.originalPrice) || 0; return o > price(s) ? o : 0; }
  function duration(min) {
    min = Number(min) || 0;
    if (!min) return '';
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    return h + (h === 1 ? ' hr' : ' hrs') + (m ? ' ' + m + ' min' : '');
  }
  function categoryImage(cat) {
    var name = CATEGORY_IMAGES[cat.key];
    if (name) return IMG + name + '.webp';
    // A category added later in the admin: its own uploaded image, else the general one.
    var own = cat.imageUrl || cat.logoUrl || '';
    return /^(https?:|\/api\/uploads\/)/.test(own) ? own : IMG + 'general.webp';
  }
  // Cloudinary images are stored at 1200px wide; a card needs far less.
  function sized(url, w) {
    return String(url || '').replace(/\/upload\/([^/]*\b)w_\d+/, '/upload/$1w_' + w);
  }
  function serviceImage(s, cat, w) {
    var own = s.imageUrl || (s.images && s.images[0]) || '';
    return own ? sized(own, w) : categoryImage(cat);
  }
  function allServices(entry) { return entry.cat.services || []; }
  function findService(id) {
    for (var i = 0; i < cats.length; i++) {
      var s = allServices(cats[i]).filter(function (x) { return x.id === id; })[0];
      if (s) return { s: s, entry: cats[i] };
    }
    return null;
  }

  // ─── Home: category grid and popular services ───
  function renderHome() {
    var grid = document.getElementById('m-cat-grid');
    if (grid) {
      grid.innerHTML = cats.slice(0, HOME_TILES).map(function (e) {
        return '<button type="button" class="mc-tile" data-cat="' + esc(e.fkey) + '">' +
          '<span class="mc-tile-img"><img src="' + esc(categoryImage(e.cat)) + '" alt="" width="64" height="64" decoding="async"></span>' +
          '<span class="mc-tile-name">' + esc(e.cat.name) + '</span></button>';
      }).join('') +
        '<button type="button" class="mc-tile" data-all="1"><span class="mc-tile-img mc-tile-all" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>' +
        '</span><span class="mc-tile-name">All services</span></button>';
    }
    var row = document.getElementById('m-svc-scroll');
    if (row) {
      var popular = [];
      cats.forEach(function (e) { allServices(e).forEach(function (s) { if (s.isPopular && price(s)) popular.push({ s: s, entry: e }); }); });
      if (popular.length) {
        row.innerHTML = popular.slice(0, 12).map(function (p, i) {
          // The first cards are on screen at load (often the largest paint): fetch them at once.
          var load = i < 2 ? 'fetchpriority="high"' : 'loading="lazy"';
          return '<button type="button" class="mc-pop" data-svc="' + esc(p.s.id) + '">' +
            '<img src="' + esc(serviceImage(p.s, p.entry.cat, 300)) + '" alt="" width="150" height="110" ' + load + ' decoding="async">' +
            '<span class="mc-pop-name">' + esc(p.s.name) + '</span>' +
            '<span class="mc-pop-price">' + inr(price(p.s)) + (was(p.s) ? ' <s>' + inr(was(p.s)) + '</s>' : '') + '</span></button>';
        }).join('');
      }
    }
  }

  // ─── Full-screen screens ───
  function ensureScreen() {
    if (screen) return screen;
    screen = document.createElement('div');
    screen.className = 'mc-screen';
    screen.setAttribute('role', 'dialog');
    screen.setAttribute('aria-modal', 'true');
    screen.innerHTML = '<div class="mc-head"><button type="button" class="mc-back" aria-label="Back">' +
      '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>' +
      '</button><h2 class="mc-title"></h2></div><div class="mc-body"></div><div class="mc-bar" hidden></div>';
    screen.querySelector('.mc-back').addEventListener('click', function () { window.history.back(); });
    screen.addEventListener('click', onScreenClick);
    document.body.appendChild(screen);
    return screen;
  }

  function push(view) {
    ensureScreen();
    views.push(view);
    var id = 'mc-' + views.length;
    // Back from this screen shows the one under it (or closes the catalog from the first).
    if (window.RemontNav) window.RemontNav.open(id, pop);
    render();
  }
  function pop() {
    var v = views.pop();
    if (v) v.scroll = 0;
    if (!views.length) { hide(); return; }
    render();
  }
  function hide() {
    if (!screen) return;
    screen.classList.remove('open');
    document.body.classList.remove('mc-lock');
  }
  function render() {
    var v = views[views.length - 1];
    if (!v) return hide();
    screen.classList.add('open');
    document.body.classList.add('mc-lock');
    var body = screen.querySelector('.mc-body');
    var bar = screen.querySelector('.mc-bar');
    bar.hidden = true;
    if (v.kind === 'all') renderAll(body);
    else if (v.kind === 'cat') renderCategory(body, v);
    else if (v.kind === 'svc') renderService(body, bar, v);
    body.scrollTop = v.scroll || 0;
  }
  function title(t) { screen.querySelector('.mc-title').textContent = t; }

  function renderAll(body) {
    title('All services');
    body.innerHTML = '<div class="mc-grid">' + cats.map(function (e) {
      return '<button type="button" class="mc-tile" data-cat="' + esc(e.fkey) + '">' +
        '<span class="mc-tile-img"><img src="' + esc(categoryImage(e.cat)) + '" alt="" width="64" height="64" loading="lazy" decoding="async"></span>' +
        '<span class="mc-tile-name">' + esc(e.cat.name) + '</span>' +
        '<span class="mc-tile-count">' + allServices(e).length + ' services</span></button>';
    }).join('') + '</div>';
  }

  function card(s, cat) {
    var d = duration(s.durationMinutes);
    return '<div class="mc-card" data-svc="' + esc(s.id) + '">' +
      '<img class="mc-card-img" src="' + esc(serviceImage(s, cat, 200)) + '" alt="" width="76" height="76" loading="lazy" decoding="async">' +
      '<div class="mc-card-main">' +
        '<div class="mc-card-name">' + esc(s.name) + '</div>' +
        (s.description ? '<div class="mc-card-desc">' + esc(s.description) + '</div>' : '') +
        '<div class="mc-card-meta"><span class="mc-price">' + inr(price(s)) + '</span>' +
          (was(s) ? '<s>' + inr(was(s)) + '</s>' : '') +
          '<span>' + esc(s.unit || '') + (d ? ' · ' + d : '') + '</span></div>' +
        '<div class="mc-card-actions"><button type="button" class="mc-link" data-details="' + esc(s.id) + '">View details</button>' +
          '<button type="button" class="mc-book" data-book="' + esc(s.id) + '">Book</button></div>' +
      '</div></div>';
  }
  function strip(title, list, cat) {
    if (!list.length) return '';
    return '<section class="mc-sec"><h3>' + esc(title) + '</h3><div class="mc-strip">' + list.map(function (s) {
      return '<button type="button" class="mc-pop" data-svc="' + esc(s.id) + '">' +
        '<img src="' + esc(serviceImage(s, cat, 400)) + '" alt="" width="150" height="110" loading="lazy" decoding="async">' +
        '<span class="mc-pop-name">' + esc(s.name) + '</span><span class="mc-pop-price">' + inr(price(s)) + (was(s) ? ' <s>' + inr(was(s)) + '</s>' : '') + '</span></button>';
    }).join('') + '</div></section>';
  }

  function renderCategory(body, v) {
    var e = byKey[v.fkey];
    var cat = e.cat;
    title(cat.name);
    var services = allServices(e).filter(function (s) { return price(s) > 0; });
    var subs = (cat.subCategories || []).filter(function (sc) { return (sc.services || []).length; });
    var popular = services.filter(function (s) { return s.isPopular; }).slice(0, 10);
    // "Best value": the configured discounts, largest saving first.
    var value = services.filter(function (s) { return was(s); })
      .sort(function (a, b) { return (was(b) - price(b)) - (was(a) - price(a)); }).slice(0, 10);

    var html = '<div class="mc-banner"><img src="' + esc(categoryImage(cat)) + '" alt="" width="120" height="120" decoding="async">' +
      '<div><h3>' + esc(cat.name) + '</h3><p>' + esc(cat.description || '') + '</p>' +
      '<span class="mc-count">' + services.length + ' services available</span></div></div>';
    if (subs.length > 1) {
      html += '<div class="mc-chips" role="tablist">' +
        '<button type="button" class="mc-chip' + (!v.sub ? ' on' : '') + '" data-sub="">All</button>' +
        subs.map(function (sc) { return '<button type="button" class="mc-chip' + (v.sub === sc.key ? ' on' : '') + '" data-sub="' + esc(sc.key) + '">' + esc(sc.name) + '</button>'; }).join('') +
        '</div>';
    }
    if (!v.sub) html += strip('Popular', popular, cat) + strip('Best value', value, cat);

    var groups = subs.length > 1
      ? subs.filter(function (sc) { return !v.sub || sc.key === v.sub; }).map(function (sc) {
          var ids = {};
          (sc.services || []).forEach(function (x) { ids[x.id] = 1; });
          return { name: sc.name, list: services.filter(function (s) { return ids[s.id]; }) };
        })
      : [{ name: 'All services', list: services }];
    if (!v.sub && subs.length > 1) {
      var grouped = {};
      groups.forEach(function (g) { g.list.forEach(function (s) { grouped[s.id] = 1; }); });
      var rest = services.filter(function (s) { return !grouped[s.id]; });
      if (rest.length) groups.push({ name: 'More services', list: rest });
    }
    html += groups.filter(function (g) { return g.list.length; }).map(function (g) {
      return '<section class="mc-sec"><h3>' + esc(g.name) + ' <span>' + g.list.length + '</span></h3>' +
        g.list.map(function (s) { return card(s, cat); }).join('') + '</section>';
    }).join('') || '<p class="mc-empty">No services are bookable in this category right now.</p>';
    body.innerHTML = html;
  }

  function list(title, items) {
    if (!items || !items.length) return '';
    return '<section class="mc-sec"><h3>' + esc(title) + '</h3><ul class="mc-list">' +
      items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></section>';
  }
  function renderService(body, bar, v) {
    var hit = findService(v.svcId);
    if (!hit) { body.innerHTML = '<p class="mc-empty">This service is no longer available.</p>'; title('Service'); return; }
    var s = hit.s, cat = hit.entry.cat;
    title(cat.name);
    var d = duration(s.durationMinutes);
    var faqs = Array.isArray(s.faqJson) ? s.faqJson.filter(function (f) { return f && f.q && f.a; }) : [];
    // Only the price parts this service actually has configured.
    var parts = [
      ['Service price', price(s), s.unit],
      ['Inspection / consultation fee', Number(s.consultationFee) || 0],
      ['Site visit fee', Number(s.siteVisitFee) || 0],
      ['Labour', Number(s.labourCost) || 0],
      ['Material', Number(s.materialCost) || 0],
      ['Rate per sq ft', Number(s.perSqftRate) || 0],
    ].filter(function (p) { return p[1] > 0; });
    // A service without its own photo shows its category's product image whole, not cropped.
    var ownPhoto = !!(s.imageUrl || (s.images && s.images[0]));
    body.innerHTML =
      '<img class="mc-hero' + (ownPhoto ? '' : ' mc-hero-fit') + '" src="' + esc(serviceImage(s, cat, 800)) + '" alt="" width="400" height="260" decoding="async">' +
      '<div class="mc-detail-head"><h3>' + esc(s.name) + '</h3>' +
        '<div class="mc-card-meta"><span class="mc-price">' + inr(price(s)) + '</span>' + (was(s) ? '<s>' + inr(was(s)) + '</s>' : '') +
        '<span>' + esc(s.unit || '') + (d ? ' · ' + d : '') + '</span></div></div>' +
      (s.description ? '<section class="mc-sec"><h3>About this service</h3><p class="mc-text">' + esc(s.description) + '</p></section>' : '') +
      list("What's included", s.inclusions) +
      list("What's not included", s.exclusions) +
      '<section class="mc-sec"><h3>Pricing</h3><table class="mc-price-table">' +
        parts.map(function (p) { return '<tr><td>' + esc(p[0]) + (p[2] ? ' <small>(' + esc(p[2]) + ')</small>' : '') + '</td><td>' + inr(p[1]) + '</td></tr>'; }).join('') +
        (was(s) ? '<tr class="mc-save"><td>You save</td><td>' + inr(was(s) - price(s)) + '</td></tr>' : '') +
      '</table><p class="mc-note">Taxes, any applicable fees and coupons are shown at checkout before you pay.</p></section>' +
      (faqs.length ? '<section class="mc-sec"><h3>Questions</h3>' + faqs.map(function (f) {
        return '<details class="mc-faq"><summary>' + esc(f.q) + '</summary><p>' + esc(f.a) + '</p></details>';
      }).join('') + '</section>' : '');
    bar.hidden = false;
    bar.innerHTML = '<div><strong>' + inr(price(s)) + '</strong><span>' + esc(s.unit || '') + '</span></div>' +
      '<button type="button" class="mc-book mc-book-lg" data-book="' + esc(s.id) + '">Book now</button>';
  }

  // ─── Actions ───
  function book(id) {
    var hit = findService(id);
    if (!hit || typeof window.openBookingModal !== 'function') return;
    window.openBookingModal(hit.s.id, hit.s.name, inr(price(hit.s)));
  }
  function openCategory(fkey) {
    if (fkey === 'interior') { window.location.href = '/interior'; return true; } // its own page
    if (!byKey[fkey]) return false;
    push({ kind: 'cat', fkey: fkey });
    return true;
  }
  function openAll() {
    if (!cats.length) return false;
    push({ kind: 'all' });
    return true;
  }
  function openServiceDetails(id) {
    if (!findService(id)) return false;
    push({ kind: 'svc', svcId: id });
    return true;
  }
  function onScreenClick(e) {
    var t = e.target.closest('[data-book],[data-details],[data-svc],[data-cat],[data-sub]');
    if (!t || !screen.contains(t)) return;
    var v = views[views.length - 1];
    if (v) v.scroll = screen.querySelector('.mc-body').scrollTop;
    if (t.hasAttribute('data-book')) return book(t.getAttribute('data-book'));
    if (t.hasAttribute('data-details')) return openServiceDetails(t.getAttribute('data-details'));
    if (t.hasAttribute('data-svc')) return openServiceDetails(t.getAttribute('data-svc'));
    if (t.hasAttribute('data-cat')) return openCategory(t.getAttribute('data-cat'));
    if (t.hasAttribute('data-sub')) { v.sub = t.getAttribute('data-sub') || null; v.scroll = 0; render(); }
  }
  // Bound on the containers themselves: a page handler higher up stops some taps from bubbling.
  function onHomeClick(e) {
    var t = e.target.closest('[data-cat], [data-all], [data-svc]');
    if (!t) return;
    e.stopPropagation();
    if (t.hasAttribute('data-all')) openAll();
    else if (t.hasAttribute('data-cat')) openCategory(t.getAttribute('data-cat'));
    else openServiceDetails(t.getAttribute('data-svc'));
  }
  ['m-cat-grid', 'm-svc-scroll'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', onHomeClick);
  });

  window.RemontCatalog = {
    // entries: [{ fkey, cat }] as the home page keys its catalog, deduplicated and sorted.
    setCategories: function (entries) {
      cats = entries.filter(function (e) { return (e.cat.services || []).some(function (s) { return price(s) > 0; }); });
      byKey = {};
      cats.forEach(function (e) { byKey[e.fkey] = e; });
      renderHome();
      if (screen && screen.classList.contains('open')) render();
    },
    openCategory: openCategory,
    openAll: openAll,
    openService: openServiceDetails,
  };

  // The page's own entry points (search results, the Categories tab, ?open= links) call these.
  var origCatalog = window.openMobileCatalog;
  var origPicker = window.openMobileCatalogPicker;
  window.openMobileCatalog = function (fkey) {
    if (isMobile() && cats.length) return openCategory(fkey);
    return origCatalog ? origCatalog.apply(this, arguments) : false;
  };
  window.openMobileCatalogPicker = function () {
    if (isMobile() && cats.length) return openAll();
    return origPicker ? origPicker.apply(this, arguments) : false;
  };
  if (window.__remontCatalogEntries) window.RemontCatalog.setCategories(window.__remontCatalogEntries);
})();
