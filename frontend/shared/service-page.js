/* ══════════════════════════════════════════════════════════════════════════
   REMONT INDIA — SERVICE LANDING PAGE MODULE (shared behavior)
   Used by: /interior
   Reused by (future): /renovation /architecture /construction /painting
   Generic, data-attribute driven — no page-specific copy lives here, only
   in each page's <slug>-config.js (see interior-config.js).
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function cfg() { return window.INTERIOR_CONFIG || {}; }

  /* ── Header state (read-only — real cart/city/account state is owned by
     the homepage; this just reflects it so the header doesn't look broken) ── */
  function paintHeaderState() {
    try {
      var city = localStorage.getItem('remont_city');
      var cityEl = document.getElementById('svpCurrentCity');
      if (cityEl && city) cityEl.textContent = city;

      var cart = JSON.parse(localStorage.getItem('remont_cart') || '[]');
      var count = Array.isArray(cart) ? cart.reduce(function (n, i) { return n + (i.qty || 1); }, 0) : 0;
      var badge = document.getElementById('svpCartBadge');
      if (badge) {
        badge.textContent = count > 9 ? '9+' : String(count);
        badge.classList.toggle('show', count > 0);
      }
    } catch (e) { /* localStorage unavailable (private mode, etc.) — header just shows defaults */ }
  }

  /* ── Mobile nav drawer ── */
  function toggleMobileNav() {
    var nav = document.getElementById('svpMobileNav');
    if (nav) nav.classList.toggle('open');
  }

  /* ══════════════════════════════════════════════════════════════════════
     BOOKING / CONTACT ARCHITECTURE
     Every primary CTA on the page calls RemontCTA.book() — never WhatsApp
     directly. Today that means a plain redirect to the real, already-live
     Remont booking flow (frontend/booking.html), which already reads
     ?service=<slug> and ?city=<name> and pre-selects them against the real
     backend catalog. If a slug doesn't match a seeded Service yet, booking.html
     degrades gracefully to manual selection — nothing breaks either way.
     When a dedicated interior-booking workflow exists later, only this one
     function needs to change; no CTA, button, or page markup does.
     WhatsApp is wired up ONLY as RemontCTA.chatWithExpert(), used exclusively
     by the secondary "Chat with Expert" buttons.
     ══════════════════════════════════════════════════════════════════════ */
  var RemontCTA = {
    book: function (ctx) {
      ctx = ctx || {};
      var bookingCfg = (cfg().integrations && cfg().integrations.booking) || { baseUrl: '/booking' };
      var params = new URLSearchParams();
      if (ctx.slug) params.set('service', ctx.slug);
      if (cfg().category) params.set('category', cfg().category);
      if (ctx.label) params.set('note', ctx.label);
      try {
        var city = localStorage.getItem('remont_city');
        if (city) params.set('city', city);
      } catch (e) { /* private mode — booking.html just shows the manual city picker */ }
      var qs = params.toString();
      window.location.href = bookingCfg.baseUrl + (qs ? '?' + qs : '');
    },
    chatWithExpert: function (message) {
      var num = cfg().whatsapp || '919232071064';
      window.open('https://wa.me/' + num + '?text=' + encodeURIComponent(message || 'Hi Remont, I need help.'), '_blank', 'noopener');
    },
  };

  /* ══════════════════════════════════════════════════════════════════════
     CITY SERVICEABILITY — for 'onsite' services only. Backed by the real,
     already-live GET /api/v1/cities (same endpoint the homepage's city
     modal uses), which returns each city's isActive / activeVendors /
     activeServiceKeys. There is no hardcoded city list anywhere in this
     file — whoever manages the Cities table in the admin controls rollout,
     and this page picks it up on next load. 'digital' services never call
     this at all.
     ══════════════════════════════════════════════════════════════════════ */
  var RemontCity = {
    _promise: null,
    fetchAll: function () {
      if (this._promise) return this._promise;
      var citiesCfg = (cfg().integrations && cfg().integrations.cities) || { endpoint: '/api/v1/cities' };
      this._promise = fetch(citiesCfg.endpoint)
        .then(function (res) { return res.json(); })
        .then(function (json) { return Array.isArray(json) ? json : (json && json.data) || []; })
        .catch(function () { return []; }); // network hiccup — treat as "unknown", never as "available"
      return this._promise;
    },
    // Resolves true only when the city is live, has at least one active
    // vendor, and (if a categoryKey is given) that category is switched on
    // for this city. Anything else — unknown city, no data, network error —
    // resolves false, which routes the caller to lead-capture, never a hard
    // block and never a false "yes it's available".
    isServiceable: function (cityName, categoryKey) {
      if (!cityName) return Promise.resolve(false);
      return this.fetchAll().then(function (cities) {
        var match = cities.find(function (c) { return c.name && c.name.toLowerCase() === cityName.toLowerCase(); });
        if (!match || !match.isActive) return false;
        if (Number(match.activeVendors || 0) <= 0) return false;
        if (categoryKey && Array.isArray(match.activeServiceKeys)) {
          return match.activeServiceKeys.indexOf(categoryKey) !== -1;
        }
        return true;
      });
    },
  };

  /* ══════════════════════════════════════════════════════════════════════
     LEAD CAPTURE — for onsite requests in a not-yet-serviceable city. Posts
     to the real, already-live public CRM endpoint (POST /api/v1/crm/leads/capture,
     frontend/crm.html is the agent side of this same table) — the same
     capture path used by the AI chat and WhatsApp bot leads. No mock here:
     this one is real today because the endpoint already exists and is public.
     ══════════════════════════════════════════════════════════════════════ */
  var RemontLead = {
    capture: function (data) {
      var leadCfg = (cfg().integrations && cfg().integrations.leads) || { captureEndpoint: '/api/v1/crm/leads/capture', source: 'WEBSITE' };
      return fetch(leadCfg.captureEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: data.name,
          customerPhone: data.phone,
          customerEmail: data.email || undefined,
          cityName: data.city || undefined,
          serviceInterested: data.label || undefined,
          notes: data.requirement || undefined,
          source: leadCfg.source || 'WEBSITE',
        }),
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    },
  };

  /* ══════════════════════════════════════════════════════════════════════
     PAYMENT — MOCK. Swap by setting integrations.payment.mode = 'live' and
     keyId in interior-config.js, then replace the body of charge() with a
     real Razorpay Checkout call. Every caller already treats this as an
     async function returning {paymentId}, so no call site changes.
     ══════════════════════════════════════════════════════════════════════ */
  var RemontPayment = {
    charge: function (amountRupees, lead) {
      var payCfg = (cfg().integrations && cfg().integrations.payment) || { mode: 'mock' };
      if (payCfg.mode !== 'mock') {
        return Promise.reject(new Error('Live Razorpay integration is not wired up yet — see frontend/shared/INTERIOR_README.md'));
      }
      console.info('[MOCK PAYMENT] would charge ₹' + amountRupees + ' for', lead);
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({ mock: true, paymentId: 'mock_pay_' + Date.now(), amount: amountRupees });
        }, 900);
      });
    },
  };

  /* ══════════════════════════════════════════════════════════════════════
     AI DESIGN GENERATION — MOCK. Only ever called after RemontPayment.charge()
     resolves (enforced in initAiStudioUi below). Swap by setting
     integrations.ai.mode = 'live' + provider + generateEndpoint in
     interior-config.js, then replace the body of generate() with a real
     fetch() to your backend, which in turn calls the actual image API.
     ══════════════════════════════════════════════════════════════════════ */
  var RemontAI = {
    generate: function (options) {
      var aiCfg = (cfg().integrations && cfg().integrations.ai) || { mode: 'mock' };
      if (aiCfg.mode !== 'mock') {
        return Promise.reject(new Error('Live AI generation is not wired up yet — see frontend/shared/INTERIOR_README.md'));
      }
      console.info('[MOCK AI] would generate design with', options);
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({ mock: true, resultId: 'mock_design_' + Date.now() });
        }, 1400);
      });
    },
  };

  /* ── Sub-nav tabs: any [data-svp-tab-btn] toggles the [data-svp-panel]
     with the matching value, and updates the URL hash for deep-linking ── */
  function activateTab(name, opts) {
    opts = opts || {};
    document.querySelectorAll('[data-svp-tab-btn]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-svp-tab-btn') === name);
    });
    document.querySelectorAll('[data-svp-panel]').forEach(function (panel) {
      panel.classList.toggle('active', panel.getAttribute('data-svp-panel') === name);
    });
    if (!opts.skipScroll) {
      var subnav = document.querySelector('.svp-subnav');
      var y = subnav ? subnav.getBoundingClientRect().bottom + window.scrollY - 90 : 0;
      if (opts.scrollIntoView) window.scrollTo({ top: y, behavior: 'smooth' });
    }
    if (!opts.skipHash) history.replaceState(null, '', '#' + name);
  }

  function initTabs() {
    document.querySelectorAll('[data-svp-tab-btn]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activateTab(btn.getAttribute('data-svp-tab-btn'), { scrollIntoView: true });
      });
    });
    var firstBtn = document.querySelector('[data-svp-tab-btn]');
    if (!firstBtn) return;
    var hash = (location.hash || '').replace('#', '');
    var hashIsValidTab = hash && document.querySelector('[data-svp-panel="' + hash + '"]');
    var initial = hashIsValidTab ? hash : firstBtn.getAttribute('data-svp-tab-btn');
    activateTab(initial, { skipScroll: true, skipHash: true });
  }

  /* ── FAQ accordion ── */
  function initFaq() {
    document.querySelectorAll('.svp-faq-item').forEach(function (item) {
      var q = item.querySelector('.svp-faq-q');
      if (!q) return;
      q.addEventListener('click', function () {
        var wasOpen = item.classList.contains('open');
        document.querySelectorAll('.svp-faq-item.open').forEach(function (i) { i.classList.remove('open'); });
        if (!wasOpen) item.classList.add('open');
      });
    });
  }

  /* ── Portfolio filter chips ── */
  function initPortfolioFilter() {
    var chips = document.querySelectorAll('[data-svp-filter]');
    var cards = document.querySelectorAll('[data-svp-portfolio-cat]');
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        chips.forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        var f = chip.getAttribute('data-svp-filter');
        cards.forEach(function (card) {
          var match = f === 'all' || card.getAttribute('data-svp-portfolio-cat') === f;
          card.style.display = match ? '' : 'none';
        });
      });
    });
  }

  /* ── Portfolio before/after toggle (plain class flip — no slider library) ── */
  function initBeforeAfterToggle() {
    document.querySelectorAll('[data-svp-ba-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var card = btn.closest('.svp-portfolio-card');
        if (card) card.classList.toggle('show-before');
      });
    });
  }

  /* ── Any element with data-svp-book triggers the real booking flow —
     unless it's an 'onsite' service and the customer's city isn't live for
     it, in which case we open the lead-capture panel instead of booking
     (and never a hard block). Elements with no data-service-type, or
     service-type="digital", always book immediately — no city check runs
     for them at all, per the digital/onsite business rule. ── */
  function initBookingButtons() {
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-svp-book]');
      if (!el) return;
      e.preventDefault();
      var ctx = {
        slug: el.getAttribute('data-slug') || '',
        label: el.getAttribute('data-label') || '',
        serviceType: el.getAttribute('data-service-type') || 'digital',
        categoryKey: el.getAttribute('data-category-key') || '',
      };
      if (ctx.serviceType !== 'onsite') { RemontCTA.book(ctx); return; }

      var city = null;
      try { city = localStorage.getItem('remont_city'); } catch (err) { /* private mode */ }
      var original = el.textContent;
      el.textContent = 'Checking availability…';
      RemontCity.isServiceable(city, ctx.categoryKey).then(function (ok) {
        el.textContent = original;
        if (ok) { RemontCTA.book(ctx); return; }
        openAvailabilityGate(ctx, city);
      });
    });
  }

  /* ── City-not-serviceable lead capture panel (onsite only) ── */
  function openAvailabilityGate(ctx, city) {
    var backdrop = document.getElementById('svpAvailBackdrop');
    if (!backdrop) { RemontCTA.chatWithExpert('Hi Remont, I want ' + ctx.label + ' — is this available in my city?'); return; }
    var modal = backdrop.querySelector('.svp-avail-modal');
    modal.classList.remove('submitted');
    backdrop.querySelector('[data-svp-avail-msg]').textContent =
      'This service is not available in your city yet. Submit your requirement and we’ll notify you when we launch there.';
    var cityInput = backdrop.querySelector('[name="avail-city"]');
    if (cityInput) cityInput.value = city || '';
    var reqInput = backdrop.querySelector('[name="avail-requirement"]');
    if (reqInput) reqInput.value = ctx.label ? ('Interested in: ' + ctx.label) : '';
    backdrop.dataset.label = ctx.label;
    backdrop.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeAvailabilityGate() {
    var backdrop = document.getElementById('svpAvailBackdrop');
    if (!backdrop) return;
    backdrop.classList.remove('open');
    document.body.style.overflow = '';
  }
  function initAvailabilityGate() {
    var backdrop = document.getElementById('svpAvailBackdrop');
    if (!backdrop) return;
    var closeBtn = backdrop.querySelector('[data-svp-avail-close]');
    if (closeBtn) closeBtn.addEventListener('click', closeAvailabilityGate);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeAvailabilityGate(); });
    var submitBtn = backdrop.querySelector('[data-svp-avail-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        var nameEl = backdrop.querySelector('[name="avail-name"]');
        var phoneEl = backdrop.querySelector('[name="avail-phone"]');
        var emailEl = backdrop.querySelector('[name="avail-email"]');
        var cityEl = backdrop.querySelector('[name="avail-city"]');
        var reqEl = backdrop.querySelector('[name="avail-requirement"]');
        if (!nameEl.value || !phoneEl.value || !cityEl.value) {
          submitBtn.textContent = 'Fill name, phone & city';
          setTimeout(function () { submitBtn.textContent = 'Notify Me When Available'; }, 1800);
          return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';
        RemontLead.capture({
          name: nameEl.value, phone: phoneEl.value, email: emailEl.value,
          city: cityEl.value, requirement: reqEl.value, label: backdrop.dataset.label,
        }).then(function () {
          backdrop.querySelector('.svp-avail-modal').classList.add('submitted');
          backdrop.querySelector('[data-svp-avail-success]').classList.add('show');
        }).catch(function (err) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Could not submit — try again';
          console.error(err);
        });
      });
    }
  }

  /* ── Any element with data-svp-chat opens WhatsApp as a secondary contact
     channel only — never used for a primary CTA. ── */
  function initChatButtons() {
    document.querySelectorAll('[data-svp-chat]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        RemontCTA.chatWithExpert(btn.getAttribute('data-svp-chat') || undefined);
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     RENDER FROM CONFIG — Services / Consultancy / Packages / AI Studio price
     all come from window.INTERIOR_CONFIG (interior-config.js), not from
     hardcoded HTML. Edit that one file to change any price or label; this
     function (and the CSS classes it targets) is what future pages
     (renovation-config.js, etc.) reuse as-is.
     ══════════════════════════════════════════════════════════════════════ */
  function bookAttrs(item) {
    return 'data-svp-book data-slug="' + item.slug + '" data-service-type="' + (item.serviceType || 'digital') + '"' +
      (item.categoryKey ? ' data-category-key="' + item.categoryKey + '"' : '');
  }
  function serviceCardHtml(item) {
    return '<div class="svp-service-card">' +
      '<div class="ic">' + item.icon + '</div>' +
      '<div class="nm">' + item.name + '</div>' +
      '<div class="pr">' + item.priceLabel + '</div>' +
      '<button class="vw" ' + bookAttrs(item) + ' data-label="' + item.name + '">View →</button>' +
    '</div>';
  }
  function listRowHtml(item) {
    return '<div class="svp-list-row">' +
      '<div class="lf"><span class="ic">' + item.icon + '</span> ' + item.name + '</div>' +
      '<div class="rt"><span class="pr">' + item.priceLabel + '</span>' +
      '<button class="bk" ' + bookAttrs(item) + ' data-label="' + item.name + '">Book →</button></div>' +
    '</div>';
  }
  function packageCardHtml(pkg) {
    var bullets = pkg.bullets.map(function (b) { return '<li>' + b + '</li>'; }).join('');
    return '<div class="svp-pkg-card' + (pkg.featured ? ' featured' : '') + '">' +
      (pkg.featured ? '<div class="svp-pkg-badge">★ MOST POPULAR</div>' : '') +
      '<div class="nm">' + pkg.name + '</div>' +
      '<div class="pr">' + pkg.priceLabel + '</div>' +
      '<ul>' + bullets + '</ul>' +
      '<button class="svp-btn ' + (pkg.featured ? 'svp-btn-primary' : 'svp-btn-dark') + '" ' + bookAttrs({ slug: pkg.id, serviceType: pkg.serviceType, categoryKey: pkg.categoryKey }) + ' data-label="' + pkg.name + ' package">' +
      (pkg.id === 'complete-interior' ? 'Get Free Quote' : 'Choose ' + pkg.name) + '</button>' +
    '</div>';
  }

  function renderFromConfig() {
    var c = window.INTERIOR_CONFIG;
    if (!c) return;

    var svcResEl = document.querySelector('[data-svp-render="services-residential"]');
    if (svcResEl) svcResEl.innerHTML = c.services.residential.map(serviceCardHtml).join('');
    var svcComEl = document.querySelector('[data-svp-render="services-commercial"]');
    if (svcComEl) svcComEl.innerHTML = c.services.commercial.map(serviceCardHtml).join('');

    var consultEl = document.querySelector('[data-svp-render="consultancy-consultation"]');
    if (consultEl) consultEl.innerHTML = c.consultancy.consultation.map(listRowHtml).join('');
    var deliverEl = document.querySelector('[data-svp-render="consultancy-deliverables"]');
    if (deliverEl) deliverEl.innerHTML = c.consultancy.deliverables.map(listRowHtml).join('');

    var pkgEl = document.querySelector('[data-svp-render="packages"]');
    if (pkgEl) pkgEl.innerHTML = c.packages.map(packageCardHtml).join('');

    document.querySelectorAll('[data-svp-price="ai-amount"]').forEach(function (el) { el.textContent = c.aiStudio.priceLabel; });
    document.querySelectorAll('[data-svp-price="ai-pack"]').forEach(function (el) { el.textContent = c.aiStudio.packLabel; });
    var styleRow = document.querySelector('[data-svp-render="ai-styles"]');
    if (styleRow) styleRow.innerHTML = c.aiStudio.styles.map(function (s, i) { return '<span class="svp-chip' + (i === 0 ? ' selected' : '') + '" data-locked disabled>' + s + '</span>'; }).join('');
    var colourRow = document.querySelector('[data-svp-render="ai-colours"]');
    if (colourRow) colourRow.innerHTML = c.aiStudio.wallColours.map(function (s, i) { return '<span class="svp-chip' + (i === 0 ? ' selected' : '') + '" data-locked disabled>' + s + '</span>'; }).join('');
  }

  /* ══════════════════════════════════════════════════════════════════════
     AI DESIGN STUDIO — 4-step gated flow: (1) upload, (2) pay ₹19 capturing
     a lead, (3) customize (locked until paid), (4) generate + result (locked
     until paid). Payment and generation are RemontPayment/RemontAI, both
     MOCK today — see the comments above them. The AI image call only ever
     fires from the paid-success path, never before.
     ══════════════════════════════════════════════════════════════════════ */
  function initAiStudioUi() {
    var studio = document.querySelector('.svp-ai-studio');
    if (!studio) return;
    var paid = false;

    function setStep(n) {
      studio.querySelectorAll('.svp-ai-step').forEach(function (el, i) {
        el.classList.toggle('current', i === n - 1);
        el.classList.toggle('done', i < n - 1);
      });
    }

    // Step 1 — upload
    var uploadBox = studio.querySelector('.svp-upload-box');
    var fileInput = studio.querySelector('[data-svp-upload-input]');
    if (uploadBox && fileInput) {
      uploadBox.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        if (fileInput.files && fileInput.files[0]) {
          var label = uploadBox.querySelector('[data-svp-upload-label]');
          if (label) label.textContent = '✅ ' + fileInput.files[0].name + ' — ready';
          setStep(2);
        }
      });
    }

    // Step 2 — lead capture + mock pay
    var payBtn = studio.querySelector('[data-svp-pay]');
    var payGate = studio.querySelector('[data-svp-gate]');
    var paySuccess = studio.querySelector('[data-svp-pay-success]');
    if (payBtn) {
      payBtn.addEventListener('click', function () {
        var nameEl = studio.querySelector('[name="lead-name"]');
        var phoneEl = studio.querySelector('[name="lead-phone"]');
        var emailEl = studio.querySelector('[name="lead-email"]');
        var lead = { name: nameEl && nameEl.value, phone: phoneEl && phoneEl.value, email: emailEl && emailEl.value };
        if (!lead.name || !lead.phone) {
          payBtn.textContent = 'Enter name & phone first';
          setTimeout(function () { payBtn.textContent = (window.INTERIOR_CONFIG ? 'Pay ' + window.INTERIOR_CONFIG.aiStudio.priceLabel : 'Pay') + ' & Unlock'; }, 1800);
          return;
        }
        payBtn.disabled = true;
        payBtn.textContent = 'Processing payment…';
        var amount = window.INTERIOR_CONFIG ? window.INTERIOR_CONFIG.aiStudio.priceAmount : 19;
        RemontPayment.charge(amount, lead).then(function () {
          paid = true;
          if (payGate) payGate.classList.add('unlocked');
          if (paySuccess) paySuccess.classList.add('show');
          studio.querySelectorAll('[data-locked]').forEach(function (el) { el.removeAttribute('disabled'); });
          var generateBtn = studio.querySelector('[data-svp-generate]');
          if (generateBtn) generateBtn.removeAttribute('disabled');
          setStep(3);
        }).catch(function (err) {
          payBtn.disabled = false;
          payBtn.textContent = 'Payment failed — try again';
          console.error(err);
        });
      });
    }

    // Step 3 — customize chips (locked until paid)
    studio.querySelectorAll('.svp-chip-row').forEach(function (row) {
      row.addEventListener('click', function (e) {
        var chip = e.target.closest('.svp-chip');
        if (!chip || chip.hasAttribute('disabled')) return;
        row.querySelectorAll('.svp-chip').forEach(function (c) { c.classList.remove('selected'); });
        chip.classList.add('selected');
      });
    });

    // Step 4 — generate (locked until paid) + result
    var generateBtn = studio.querySelector('[data-svp-generate]');
    if (generateBtn) {
      generateBtn.addEventListener('click', function () {
        if (!paid) return;
        generateBtn.disabled = true;
        generateBtn.textContent = '✨ Generating…';
        var selectedStyle = studio.querySelector('[data-svp-render="ai-styles"] .selected');
        var selectedColour = studio.querySelector('[data-svp-render="ai-colours"] .selected');
        RemontAI.generate({
          style: selectedStyle ? selectedStyle.textContent : null,
          wallColour: selectedColour ? selectedColour.textContent : null,
        }).then(function () {
          setStep(4);
          var resultEl = studio.querySelector('[data-svp-result]');
          if (resultEl) resultEl.textContent = '✅ Mock design ready — this is a placeholder until the real AI provider is connected (see README).';
          var actions = studio.querySelector('[data-svp-result-actions]');
          if (actions) actions.style.display = 'flex';
          generateBtn.textContent = '✨ Generate Design';
          generateBtn.disabled = false;
        }).catch(function (err) {
          generateBtn.textContent = '✨ Generate Design';
          generateBtn.disabled = false;
          console.error(err);
        });
      });
    }
  }

  /* ── Sticky CTA bar: show after the hero scrolls out of view ── */
  function initStickyBar() {
    var bar = document.getElementById('svpStickyBar');
    var hero = document.querySelector('.svp-hero');
    if (!bar || !hero) return;
    var io = new IntersectionObserver(function (entries) {
      bar.classList.toggle('show', !entries[0].isIntersecting);
    }, { threshold: 0 });
    io.observe(hero);
  }

  /* ── Scroll reveal ── */
  function initReveal() {
    var els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) e.target.classList.add('visible'); });
    }, { threshold: 0.12 });
    els.forEach(function (el) { io.observe(el); });
  }

  window.SVP = { activateTab: activateTab, toggleMobileNav: toggleMobileNav };
  window.RemontCTA = RemontCTA;
  window.RemontCity = RemontCity;
  window.RemontLead = RemontLead;

  document.addEventListener('DOMContentLoaded', function () {
    renderFromConfig();
    paintHeaderState();
    initTabs();
    initFaq();
    initPortfolioFilter();
    initBeforeAfterToggle();
    initBookingButtons();
    initAvailabilityGate();
    initChatButtons();
    initAiStudioUi();
    initStickyBar();
    initReveal();
  });
})();
