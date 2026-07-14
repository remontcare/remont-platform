# TODO.md — Remont India

> Remaining tasks for the current phase. Ordered by dependency, not importance.
> See `PROJECT_ROADMAP.md` for what's explicitly deferred — don't add those back here
> without a new explicit instruction.

## Phase 1 — Seller Marketplace (current)

All original tasks complete — see `CHANGELOG.md` 2026-07-11 entry for full detail.

| # | Task | Priority | Depends on | Status |
|---|---|---|---|---|
| 1 | `admin.module.ts`: `listProductVendors`, `createProductVendor`, `suspendProductVendor`, `activateProductVendor` + routes under `/admin/product-vendors` | High | — | ✅ |
| 2 | `vendors.module.ts`: `ProductVendorsService.myOrders()` + `GET /vendors/product/me/orders` | High | — | ✅ |
| 3 | `admin/vendors.html`: add "Product Sellers" tab (list, create modal, suspend/activate) | High | 1 | ✅ |
| 4 | `admin/common.js`: sidebar nav entry for Product Sellers | Medium | 3 | ✅ |
| 5 | `frontend/seller.html`: login (OTP, PRODUCT_VENDOR role) + app shell | High | 1 | ✅ |
| 6 | `seller.html`: Products view (list/add/edit via existing `/products` endpoints) | High | 5 | ✅ |
| 7 | `seller.html`: Orders view (via task 2's endpoint) | High | 2, 5 | ✅ |
| 8 | `seller.html`: Profile/logout view | Low | 5 | ✅ |
| 9 | Backend typecheck + frontend script syntax-check | High | 1–8 | ✅ |
| 10 | End-to-end smoke test against live production (13 steps, all passed; test data cleaned up) | High | 1–8 | ✅ |
| 11 | Update `CHANGELOG.md`, `PROJECT_PROGRESS.md`, this file; commit + push | High | 10 | ✅ |

## Phase 1 — Dynamic City Activation (added 2026-07-11, complete)

| # | Task | Priority | Status |
|---|---|---|---|
| 1 | `ProductVendor.city` schema addition | High | ✅ |
| 2 | Bulk city endpoints (`/admin/cities/bulk`, `/admin/cities/all`) + stats endpoint | High | ✅ |
| 3 | Fix city.isActive enforcement gap in the 2 unguarded order-creation paths | High | ✅ |
| 4 | `admin/cities.html` stats dashboard + bulk UI | High | ✅ |
| 5 | City field on seller creation + seller profile | Medium | ✅ |
| 6 | Live E2E verification (throwaway test city, cleaned up) | High | ✅ |

**⚠ Business action needed, not a dev task:** all 13 cities are still active in
production. Use the new bulk actions in `admin/cities.html` to deactivate all but
the launch city when ready.

## Phase 1 — Dynamic Product Coverage System (added 2026-07-11, complete)

| # | Task | Priority | Status |
|---|---|---|---|
| 1 | `ProductCoverageType` enum + `Product.coverageType` + `ProductZone` schema | High | ✅ |
| 2 | Coverage-aware filtering + priority ordering in `products.module.ts list()` | High | ✅ |
| 3 | `create()`/`update()`/`myProducts()` coverage handling (seller + admin) | High | ✅ |
| 4 | Admin Coverage Area UI + coverage-aware Cities tab + table column | High | ✅ |
| 5 | Seller Coverage Area UI on product form | High | ✅ |
| 6 | Live E2E verification (6 scenarios, throwaway test data, cleaned up) | High | ✅ |

**Known deliberate gap:** `ZONES` coverage type has schema (`ProductZone`) but zero
enforcement — it currently behaves identically to `SELECTED_CITIES`. Build real
pincode/area-level filtering only when the business actually needs it.

## Phase 1 — Proper seller form + attractive dashboard (added 2026-07-11, complete)

| # | Task | Priority | Status |
|---|---|---|---|
| 1 | `ProductVendor.address`/`pickupAddress` schema + admin edit endpoint | High | ✅ |
| 2 | Admin sectioned seller form (Contact/Business/Address) + Edit action | High | ✅ |
| 3 | Seller dashboard: sales banner (today/month/total), 4 order-status tiles, Orders tabs | High | ✅ |
| 4 | GST auto-fetch | Deferred | ⛔ No provider/API key available — manual entry only |
| 5 | **Fix critical apiFetch bug in vendor.html + seller.html** | Critical | ✅ (found via live browser testing) |
| 6 | Live E2E + browser verification of both login screens | High | ✅ |

**Recommended, not started:** spot-check `index.html`'s and `admin/common.js`'s own
API helpers for any similar edge case, given how long the apiFetch bug went unnoticed.

## Phase 2 — Enterprise Seller Module (started 2026-07-11)

Explicit instruction: one module at a time, tested and committed before the next.
Reverses the earlier "admin-only seller" decision — see `PROJECT_ROADMAP.md` Phase 2.

### Module 1 — Public Registration + Admin Approval (complete)

| # | Task | Status |
|---|---|---|
| 1 | Schema: `SellerRegistration`, `SellerRegistrationPickup`, `PickupLocation`, `SellerDocument`, extended `ProductVendor` | ✅ |
| 2 | Backend: `seller-registration.module.ts` (public wizard API + admin review + `_activateSeller()`) | ✅ |
| 3 | Admin UI: Seller Applications review tab | ✅ |
| 4 | Public frontend: 7-step `seller-register.html` wizard w/ Leaflet map | ✅ |
| 5 | `seller.html`: apply link + status-aware login messaging | ✅ |
| 6 | Live E2E verification (2 full applications: 1 approved, 1 rejected) | ✅ |

### Module 2 — Location-Based Inventory (next)

- [ ] Per-`PickupLocation` stock (likely a new `LocationInventory` join table: pickupLocationId + productId + stock, mirroring `CityProduct`'s shape)
- [ ] Nearest-pickup-location resolution given a customer address (haversine, same pattern as `DispatchService`/`haversineKm` already used for service dispatch)
- [ ] Order-routing logic: pick the pickup location by distance + stock availability + (later) delivery time/cost — start with distance + stock, defer full cost/ETA optimization unless asked
- [ ] Seller-facing UI: assign/edit stock per pickup location
- [ ] Live E2E verification before moving to Module 3

### Modules 3–9 (not started — see `PROJECT_ROADMAP.md` Phase 2 table for full list)

Seller Dashboard (full) · Product Management (full) · Order Management actions ·
Returns/Replacement/Refund · Wallet & Settlement · Reports · Notifications (partial —
WhatsApp only, no email/SMS provider).

## Bug fix — Cart billing showing ₹0 (deployed & verified, 2026-07-13)

Root cause: fallback `serviceData` (rendered before the live API responds)
had no `pNum` numeric field on its 32 `subServices` entries — the "+ Cart"
button sent `price: 0`. First fix commit (`39012d7`) was only committed
locally per instruction to wait for approval; live site kept failing until
pushed. **Pushed and verified against the actual production URL**
(`remont-platform-five.vercel.app`) via a real button click, not just a
local file check — Subtotal ₹999 / GST ₹179.82 / Total ₹1,178.82.

**Separate finding, not a code bug:** the custom domain `remontindia.com`
does not point at this Vercel project at all — it currently serves an
unrelated legacy PHP/CodeIgniter site. If that's the URL being used to
test, no frontend fix here will ever be visible there until DNS/domain
is repointed to the Vercel deployment. Flagged to the user; not touched.

**Also noted, not fixed (out of scope for this task):** fallback
`subServices` entries have no `id` field, so cart items sourced from
fallback data get `id: "undefined"` (string) — doesn't affect billing but
could cause incorrect item de-duplication in `addToCart()`.

## Bug fix — Language toggle (complete, 2026-07-13)

| # | Task | Status |
|---|---|---|
| 1 | Wire up `EN/हिं` toggle (`setSiteLang`/`applySiteLang`) + `localStorage` persistence | ✅ |
| 2 | `data-en`/`data-hi` coverage across the entire static landing page (394 elements) | ✅ |
| 3 | Fix `innerHTML` vs `textContent` so embedded `<em>`/`<br>`/`<strong>` render correctly | ✅ |
| 4 | Keep "Remont India" brand name untranslated in Hindi | ✅ |
| 5 | Syntax check + Playwright local render/toggle verification | ✅ |

**Known gap, not started:** dynamic/API-rendered content (service display panel,
product cards inside it) has no translation — would need real i18n on the API
response, not a static toggle. Modals beyond the footer (cart, checkout, login,
city picker) are also not yet covered — raise with user if they want that extended.

## Possible follow-on items (not started, not committed to — raise with user before building)

- Seller can't currently see order-detail (customer address/phone) beyond what `myOrders()` returns — may want a detail view if sellers ask for it.
- No email/SMS notification to a seller when a new order containing their product arrives — currently they must check the portal.
- No password/PIN recovery UI needed (OTP-only login has no such concept) — non-issue, noting for completeness.

## Explicitly still deferred (see `PROJECT_ROADMAP.md`)

Bulk product upload, third-party courier integration, AI product enrichment,
fuzzy/voice/image search, bundling engine. (Seller KYC documents, public seller
registration, and multi-warehouse/location inventory are **no longer deferred** —
reversed 2026-07-11, see Phase 2 above.)
