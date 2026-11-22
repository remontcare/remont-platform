// Homepage UX checks (Remont fix pack) at 1440px and 390px — run against the local harness only.
// See playwright.config.js. Every test also fails on any JS error / console error on the page.
const { test, expect } = require('@playwright/test');
const info = require('./harness/info.json');

const API = `${info.web}/api/v1`;
const ADMIN = { Authorization: `Bearer ${info.adminToken}`, 'Content-Type': 'application/json' };
const EMPTY = ['False Ceiling', 'Fabrication & Welding', 'Aluminium Work', 'Glass & Glazing', 'CCTV & Security',
  'Solar Installation', 'Modular Kitchen', 'Architecture & Planning', 'Commercial Fitout'];
const ADDRESS = { name: 'PW Customer', phone: '9999900001', address: '12 Test Road, Arera Colony', pincode: '462016', city: 'Bhopal' };

const mobile = (ti) => ti.project.name.startsWith('mobile');
const panelTitle = (page) => page.locator('#displayPanel .panel-head h3').first();

async function home(page) {
  await page.goto('/');
  await page.waitForFunction(() => window._visibleCatKeys && typeof serviceData !== 'undefined' && serviceData.ac && serviceData.ac._fromApi);
}
async function cart(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('remont_cart') || '[]')); }
async function typeSearch(page, q) {
  const input = page.locator('#headerSearchInput');
  await input.fill(q);
}

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|fonts\.g/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem('remont_city')) localStorage.setItem('remont_city', 'Bhopal');
    } catch (e) {}
  });
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => { try { localStorage.removeItem('remont_cart'); } catch (e) {} }).catch(() => {});
  expect(errors, 'no JS / console errors').toEqual([]);
});

// ── 1. Empty categories ────────────────────────────────────────────────────────────────────
test('the 9 empty categories are not in chips, sidebar, mobile grid, search, /services or the AI choices', async ({ page, request }, ti) => {
  await home(page);
  if (mobile(ti)) {
    await page.evaluate(() => window.openMobileCatalogPicker());
    const grid = page.locator('.mc-screen.open');
    await expect(grid).toContainText('Plumbing');
    for (const n of EMPTY) await expect(grid).not.toContainText(n);
  } else {
    const chips = await page.locator('.cat-nav-inner').innerText();
    const side = await page.locator('.svc-panel').innerText();
    expect(chips).toContain('Plumbing');
    expect(side).toContain('Plumbing');
    for (const n of EMPTY) { expect(chips).not.toContain(n); expect(side).not.toContain(n); }
  }
  for (const q of ['false ceiling', 'cctv camera', 'solar panel', 'modular kitchen']) {
    await typeSearch(page, q);
    await page.waitForTimeout(1500); // local results + backend discovery
    const drop = await page.locator('#searchDropdown').innerText();
    for (const n of EMPTY) expect(drop, q).not.toContain(n);
    // The same backend discovery feeds REMI's search_services / CATEGORY_CHOICES and the app.
    const d = await (await request.get(`${API}/services/discover?q=${encodeURIComponent(q)}`)).json();
    for (const c of (d.data || d).categories) expect(EMPTY, q).not.toContain(c.name);
  }
  await page.goto('/services');
  const list = await page.locator('body').innerText();
  for (const n of EMPTY) expect(list).not.toContain(n);
  for (const slug of ['false-ceiling', 'cctv-security']) {
    expect((await request.get(`${API}/services/category-page/${slug}`)).status(), slug).toBe(404);
  }
});

test('every chip and sidebar item opens its own panel (no stale panel)', async ({ page }, ti) => {
  test.skip(mobile(ti), 'chip bar and sidebar are desktop-only; mobile uses the mobile catalog');
  await home(page);
  const items = page.locator('.svc-panel .svc-item');
  const n = await items.count();
  expect(n).toBeGreaterThan(3);
  for (let i = 0; i < n; i++) {
    const it = items.nth(i);
    const key = await it.getAttribute('data-svc');
    if (key === 'interior') continue; // has its own page (checked below)
    const name = (await it.locator('h4').innerText()).trim();
    await it.click();
    await expect(panelTitle(page)).toHaveText(name);
    await expect(it).toHaveClass(/active/);
  }
  const chips = page.locator('.cat-nav-inner .cat-link[onclick*="selectCategoryChip"]');
  for (let i = 0; i < await chips.count(); i++) {
    const chip = chips.nth(i);
    const label = (await chip.innerText()).replace(/\s+/g, ' ').trim(); // icon + name
    if (/Interior/.test(label)) continue;
    await chip.click();
    const title = (await panelTitle(page).innerText()).trim();
    expect(label.endsWith(title), label + ' → ' + title).toBe(true);
  }
});

test('sub-category tiles with 0 services are hidden', async ({ page }, ti) => {
  await home(page);
  if (mobile(ti)) {
    await page.evaluate(() => window.openMobileCatalog('ac'));
    const scr = page.locator('.mc-screen.open');
    await expect(scr).toContainText('AC Servicing');
    await expect(scr).not.toContainText('AMC & Plans');
  } else {
    await page.locator('.svc-item[data-svc="ac"]').click();
    const tiles = await page.locator('#displayPanel .subcat-tile .nm').allInnerTexts();
    expect(tiles).toContain('AC Servicing');
    expect(tiles).not.toContain('AMC & Plans');
  }
});

test('a category appears once it has a service and hides again when it is removed', async ({ page, request }, ti) => {
  test.skip(mobile(ti), 'data check — run once');
  const categoryId = info.ids.empty[0]; // False Ceiling
  const created = await request.post(`${API}/admin/services`, { headers: ADMIN, data: { categoryId, name: 'PW Test Ceiling Repair', basePrice: 999, hsnSac: '998719', isActive: true } });
  expect(created.status()).toBeLessThan(300);
  const svc = (await created.json()).data;
  try {
    await home(page);
    await expect(page.locator('.svc-panel')).toContainText('False Ceiling');
    await expect(page.locator('.cat-nav-inner')).toContainText('False Ceiling');
    await page.locator('.svc-item', { hasText: 'False Ceiling' }).click();
    await expect(page.locator('#displayPanel')).toContainText('PW Test Ceiling Repair');
  } finally {
    expect((await request.delete(`${API}/admin/services/${svc.id}`, { headers: ADMIN })).status()).toBeLessThan(300);
  }
  await home(page);
  await expect(page.locator('.svc-panel')).not.toContainText('False Ceiling');
  await expect(page.locator('.cat-nav-inner')).not.toContainText('False Ceiling');
});

// ── 2. Search → dashboard ──────────────────────────────────────────────────────────────────
test('search "ac service" → click the category → stays on "/", AC panel open', async ({ page }, ti) => {
  await home(page);
  await typeSearch(page, 'ac service');
  const best = page.locator('#searchDropdown .sd-item').first();
  await expect(page.locator('#searchDropdown')).toContainText('Best match');
  await expect(best).toContainText('AC Service & Repair');
  await best.click();
  if (mobile(ti)) await expect(page.locator('.mc-screen.open')).toContainText('AC Service & Repair');
  else await expect(panelTitle(page)).toHaveText('AC Service & Repair');
  expect(new URL(page.url()).pathname).toBe('/');
});

test('search "ac foam jet" → click the service → its sub-category, card highlighted, URL still "/"', async ({ page }, ti) => {
  await home(page);
  await typeSearch(page, 'ac foam jet');
  const svcItem = page.locator('#searchDropdown .sd-item', { hasText: 'Foam Jet' }).first();
  await expect(svcItem).toBeVisible();
  await svcItem.click();
  if (mobile(ti)) {
    await expect(page.locator('.mc-screen.open')).toContainText('AC Foam Jet');
  } else {
    await expect(page.locator('#displayPanel .sub-row-title')).toContainText('AC Servicing');
    const card = page.locator(`#displayPanel .sub-svc-card.search-hl[data-svc-id="${info.ids.foamJet}"]`);
    await expect(card).toBeVisible();
    await expect(card).toBeInViewport();
  }
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/');
  expect(await cart(page)).toEqual([]); // search never adds to cart
});

test('"pest control" + Enter → dashboard opens, no page change', async ({ page }, ti) => {
  await home(page);
  await typeSearch(page, 'pest control');
  await page.locator('#headerSearchInput').press('Enter');
  if (mobile(ti)) await expect(page.locator('.mc-screen.open')).toContainText('Pest Control');
  else await expect(panelTitle(page)).toHaveText('Pest Control');
  expect(new URL(page.url()).pathname).toBe('/');
});

test('search from /shop → lands on "/" with the service open, URL cleaned', async ({ page }, ti) => {
  await page.goto('/shop');
  await typeSearch(page, 'plumbing');
  const item = page.locator('#searchDropdown .sd-item', { hasText: 'Service' }).first();
  await expect(item).toBeVisible();
  await item.click();
  await page.waitForURL((u) => u.pathname === '/');
  await page.waitForFunction(() => window._visibleCatKeys && serviceData.plumbing && serviceData.plumbing._fromApi);
  if (mobile(ti)) await expect(page.locator('.mc-screen.open')).toContainText('Plumbing');
  else await expect(panelTitle(page)).toHaveText('Plumbing');
  await expect.poll(() => page.evaluate(() => location.search + location.hash)).toBe('');
});

test('product search result → product page (unchanged)', async ({ page }) => {
  await home(page);
  await page.evaluate(() => setSearchScope('product'));
  await typeSearch(page, 'Split AC 1.5 Ton');
  const item = page.locator('#searchDropdown .sd-item', { hasText: 'Split AC 1.5 Ton' }).first();
  await expect(item).toBeVisible();
  await item.click();
  await page.waitForURL(/\/product\//);
});

test('"Browse All →" stays on the homepage', async ({ page }, ti) => {
  test.skip(mobile(ti), 'the Services + Products section (and its Browse All) is desktop-only; phones use the mobile catalog');
  await home(page);
  await page.locator('#shop .shop-header a', { hasText: 'Browse All' }).click();
  await expect(panelTitle(page)).toHaveText('All services');
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.locator('#displayPanel')).toContainText('Plumbing');
  for (const n of EMPTY) await expect(page.locator('#displayPanel')).not.toContainText(n);
  await page.locator('#displayPanel .subcat-tile', { hasText: 'Plumbing' }).click();
  await expect(panelTitle(page)).toHaveText('Plumbing');
});

test('Interior still goes to /interior', async ({ page }, ti) => {
  await home(page);
  if (mobile(ti)) await page.evaluate(() => window.openMobileCatalog('interior'));
  else await page.locator('.svc-item[data-svc="interior"]').click();
  await page.waitForURL(/\/interior$/);
});

// ── 3. Quick Repair ────────────────────────────────────────────────────────────────────────
test('Quick Repair → mixed-category cards; + Cart and Book Now work', async ({ page }, ti) => {
  test.skip(mobile(ti), 'the chip bar is desktop-only');
  await home(page);
  await page.locator('.cat-nav-inner .cat-link', { hasText: 'Quick Repair' }).click();
  await expect(panelTitle(page)).toContainText('Quick Repair');
  await expect(page.locator('.svc-item.active')).toHaveCount(0);
  const cards = page.locator('#displayPanel .sub-svc-card');
  await expect(cards.first()).toBeVisible();
  const keys = await cards.evaluateAll((els) => [...new Set(els.map((e) => {
    const id = e.getAttribute('data-svc-id');
    return Object.keys(serviceData).find((k) => (serviceData[k].subServices || []).some((s) => s.id === id));
  }))]);
  expect(keys.length).toBeGreaterThan(1);
  await expect(page.locator('#displayPanel')).not.toContainText('Bathroom Renovation'); // not a quick fix
  await cards.first().locator('.svc-cart-btn').click();
  await expect(page.locator('#cart-toast')).toContainText('Added to cart');
  expect((await cart(page)).length).toBe(1);
  await cards.first().locator('.svc-book-btn').click();
  await expect(page.locator('#booking-modal')).toHaveCSS('display', 'flex');
});

// ── 4/5. Related products + bundle offer ───────────────────────────────────────────────────
test('a category with no linked products shows no Bundle Offer / Related Products block', async ({ page }, ti) => {
  test.skip(mobile(ti), 'the Related Products block lives in the desktop dashboard');
  await home(page);
  await page.locator('.svc-item[data-svc="pest-control"]').click();
  await expect(panelTitle(page)).toHaveText('Pest Control');
  await expect(page.locator('#displayPanel .panel-promo')).toHaveCount(0);
  await expect(page.locator('#displayPanel .product-row-title')).toHaveCount(0);
  await page.locator('.svc-item[data-svc="ac"]').click();
  await expect(page.locator('#displayPanel .panel-promo')).toBeVisible();
  await expect(page.locator('#displayPanel .product-grid')).toContainText('Split AC 1.5 Ton');
  await expect(page.locator('#displayPanel .product-grid')).not.toContainText('Mixer Tap');
});

test('bundle discount only for a related product + service, at the admin %', async ({ page, request }, ti) => {
  test.skip(mobile(ti), 'pricing check — run once');
  const quote = async (items) => {
    const r = await request.post(`${API}/master-orders/public/quote`, { data: { name: 'PW', phone: '+919999900001', items, fullAddress: '12 Test Road, Arera Colony', city: 'Bhopal', state: 'Madhya Pradesh', pincode: '462016', latitude: 23.2156, longitude: 77.4304 } });
    expect(r.status()).toBeLessThan(300);
    return (await r.json()).data;
  };
  const acBundle = [{ type: 'PRODUCT', productId: info.ids.acProduct, quantity: 1 }, { type: 'SERVICE', serviceId: info.ids.acInstall, quantity: 1 }];
  const unrelated = [{ type: 'PRODUCT', productId: info.ids.acProduct, quantity: 1 }, { type: 'SERVICE', serviceId: info.ids.tapRepair, quantity: 1 }];
  const setPct = (v) => request.patch(`${API}/admin/settings/bundle_discount_percent`, { headers: ADMIN, data: { value: String(v), group: 'operations' } });
  try {
    let q = await quote(acBundle);
    expect(q.bundleDiscount).toBeCloseTo(149.9, 2); // 10% of ₹1,499
    expect(q.bundleLabel).toContain('Split AC Installation');
    expect((await quote(unrelated)).bundleDiscount).toBe(0); // AC product + Tap Repair
    expect((await setPct(20)).status()).toBeLessThan(300);
    q = await quote(acBundle);
    expect(q.bundleDiscount).toBeCloseTo(299.8, 2);
    expect(q.bundleDiscountPercent).toBe(20);
  } finally {
    await setPct(10);
  }
  // The cart line in checkout shows it with what it is for.
  await home(page);
  await page.evaluate((ids) => {
    localStorage.setItem('remont_cart', JSON.stringify([
      { id: ids.acProduct, name: 'Split AC 1.5 Ton 3 Star', price: 32000, type: 'product', unit: 'piece', qty: 1 },
      { id: ids.acInstall, name: 'Split AC Installation (1.5 Ton)', price: 1499, type: 'service', unit: 'per visit', categoryKey: 'AC_SERVICE', qty: 1 },
    ]));
    updateCartBadge(); openCheckoutModal();
  }, info.ids);
  await expect(page.locator('#co-bundle-line')).toBeVisible();
  await expect(page.locator('#co-bundle-line')).toContainText('149.9');
  await expect(page.locator('#co-bundle-line')).toContainText('Split AC Installation');
});

// ── 6. Hot Deals ───────────────────────────────────────────────────────────────────────────
test('Hot Deals: card / Shop Now → product page, cart unchanged; "+" → toast + badge +1; real photos where linked', async ({ page }, ti) => {
  test.skip(mobile(ti), 'Hot Deals are hidden on phones');
  await home(page);
  const section = page.locator('#deals');
  await section.scrollIntoViewIfNeeded();
  const card = section.locator('.deal-card').first();
  await expect(card).toBeVisible();
  // photos: the AC (has an image) shows its photo; others show the placeholder tile, not a blank
  const ac = section.locator('.deal-feature, .deal-card').filter({ hasText: 'Split AC 1.5 Ton' }).first();
  if (await ac.locator('.pm-photo').count()) await expect(ac.locator('.pm-photo')).toHaveClass(/pm-on/);
  const noPhoto = section.locator('.deal-card').filter({ hasText: 'Hand Saw' }).first();
  if (await noPhoto.count()) await expect(noPhoto.locator('.pm-fallback')).toBeVisible();
  // "+" adds, with a toast and a badge bump
  const before = (await cart(page)).length;
  await card.hover();
  await card.locator('.dc-add').click();
  await expect(page.locator('#cart-toast')).toContainText('Added to cart');
  await expect(page.locator('#cart-toast button')).toHaveText('View cart');
  expect((await cart(page)).length).toBe(before + 1);
  // card body → product page, cart unchanged
  const after = (await cart(page)).length;
  await card.locator('.deal-card-name').click();
  await page.waitForURL(/\/product\//);
  expect((await cart(page)).length).toBe(after);
  await page.goBack();
  await home(page);
  await page.locator('#deals .deal-feature .df-cta').click();
  await page.waitForURL(/\/product\//);
  expect((await cart(page)).length).toBe(after);
});

// ── 7. Update banner ───────────────────────────────────────────────────────────────────────
test('update banner: not on reloads; once after a new deploy; Update reloads once', async ({ page }, ti) => {
  test.skip(mobile(ti), 'service worker flow — run once');
  await home(page);
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()) && !!navigator.serviceWorker.controller, null, { timeout: 20000 })
    .catch(async () => { await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 }); });
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await page.waitForTimeout(1500);
    await expect(page.locator('.as-update')).toHaveCount(0);
  }
  await page.request.get('/__test/new-deploy'); // a new deploy = a new worker build
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await expect(page.locator('.as-update')).toHaveCount(1, { timeout: 20000 });
  let loads = 0;
  page.on('load', () => { loads += 1; });
  await page.locator('.as-update button', { hasText: 'Update' }).click();
  await page.waitForEvent('load', { timeout: 20000 });
  await page.waitForTimeout(3000);
  expect(loads).toBe(1); // reloaded exactly once — no loop
  await expect(page.locator('.as-update')).toHaveCount(0);
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.locator('.as-update')).toHaveCount(0);
});

// ── 8. Cart / booking / checkout end to end (cash, never a real payment) ───────────────────
test('cart, Book Now and checkout still work end to end', async ({ page }, ti) => {
  test.skip(mobile(ti), 'checkout flow — run once');
  await home(page);
  await page.locator('.svc-item[data-svc="plumbing"]').click();
  await page.locator('#displayPanel .subcat-tile', { hasText: 'Tap & Faucet' }).click();
  const card = page.locator(`#displayPanel .sub-svc-card[data-svc-id="${info.ids.tapRepair}"]`);
  await card.locator('.svc-cart-btn').click();
  await expect(page.locator('#cart-toast')).toContainText('Added to cart');
  await page.locator('#cart-toast button', { hasText: 'View cart' }).click();
  await page.evaluate(() => cartCheckout());
  await expect(page.locator('#co-name')).toBeVisible();
  await page.fill('#co-name', ADDRESS.name);
  await page.fill('#co-phone', ADDRESS.phone);
  await page.fill('#co-address', ADDRESS.address);
  await page.fill('#co-pincode', ADDRESS.pincode);
  await page.locator('#co-city').evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, ADDRESS.city);
  const dateOk = await page.locator('#co-date').evaluate((el) => { if (el.options) { const o = [...el.options].find((x) => x.value); if (o) el.value = o.value; } else { el.value = new Date(Date.now() + 86400000).toISOString().slice(0, 10); } el.dispatchEvent(new Event('change', { bubbles: true })); return !!el.value; });
  expect(dateOk).toBe(true);
  await page.locator('#co-time').evaluate((el) => { if (el.options) { const o = [...el.options].find((x) => x.value && !x.disabled); if (o) el.value = o.value; } el.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(page.locator('#co-total')).toContainText('₹', { timeout: 15000 }); // server quote arrived
  await page.locator('input[name="co-payment"][value="COD"]').check({ force: true });
  await page.locator('#co-submit-btn').click();
  // Order placed (cash on service): the success screen, and the cart is emptied.
  await expect.poll(async () => (await cart(page)).length, { timeout: 20000 }).toBe(0);
});
