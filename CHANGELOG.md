# CHANGELOG.md — Remont India

> Append-only. Every entry: date, summary, files modified, API/DB/UI changes.
> Newest entries at the top.

---

## 2026-07-11 — Enterprise Seller Module, Part 1: Public Registration + Approval

**Summary:** Full reversal of the earlier "admin-only seller creation" rule, per
explicit instruction — seller registration is now a public multi-step application
that lands in PENDING status and requires admin approval before login is possible.
First module of a larger "enterprise-grade multi-vendor marketplace" build; ~13 more
modules (location-based inventory routing, order management, returns, wallet/
settlement, reports, notifications) remain, to be built one at a time per the user's
explicit "one module, tested and committed, before the next" instruction.

Built by mirroring the proven `PartnerRegistration`/`partner-registration.module.ts`
pattern exactly (same init/save-step/submit/status/draft API shape, same admin
review flow, same activate-on-approval mechanism) rather than inventing a new one —
satisfies the "clean architecture, reusable components, don't duplicate" requirement.

**Confirmed external-API constraints** (no fabricated integrations): no GST
verification provider → GST number is manual entry only. No Google Maps API key →
pickup-location GPS uses free Leaflet + OpenStreetMap (interactive drag-pin,
click-to-place, and browser-geolocation "current location", all keyless) instead.
No email/SMS provider → WhatsApp (MSG91, already integrated) is the only real
notification channel; a new generic `WhatsappService.sendCustom()` was added for
this and future flows that don't have a dedicated template yet.

**Files added:**
- `backend/src/modules/seller-registration/seller-registration.module.ts` — public wizard API (`init`/`save-step`/`pickup-locations`/`submit`/`status`/`draft`) + admin review API (`list`/`detail`/`status` with PENDING/APPROVED/REJECTED/HOLD/MORE_INFO) + `_activateSeller()` (provisions the real `User`+`ProductVendor`+`PickupLocation`+`SellerDocument` rows on approval)
- `frontend/seller-register.html` — 7-step public application wizard (Business Details → Contact/OTP → Address → Pickup Locations w/ interactive map → Documents → Bank → Review/Submit)

**Files modified:**
- `backend/prisma/schema.prisma` — `SellerRegistration` + `SellerRegistrationPickup` (the draft application), `PickupLocation` + `SellerDocument` (the real, approved entities — one seller can have multiple pickup locations, each independently geocoded), `ProductVendor` extended with the full KYC/bank field set (ownerName, businessType, panNumber, aadhaarNumber, cin, msmeNumber, alternatePhone, whatsappNumber, email, officeAddress, warehouseAddress, bank fields, rejectionReason)
- `backend/src/modules/whatsapp/whatsapp.module.ts` — added `sendCustom(phone, body)`
- `backend/src/app.module.ts` — registered `SellerRegistrationModule`
- `frontend/admin/vendors.html` — new "Seller Applications" tab mirroring the Partner Registrations review UI exactly (document previews, GPS map previews per pickup location, Approve/Reject/Hold/Request-More-Info); corrected the now-stale "public registration is disabled" copy on the Product Sellers tab
- `frontend/admin/common.js` — sidebar nav entry
- `frontend/seller.html` — login screen links to the new public wizard; a failed login now checks application status and shows a specific reason (pending/hold/more-info/rejected-with-note) instead of a generic dead end

**Security note (unchanged mechanism, just confirming it holds here too):** a seller's
`User.role` only becomes `PRODUCT_VENDOR`-with-a-real-profile inside `_activateSeller()`,
which only runs on admin APPROVED — exactly the same gate already proven for service
vendors. A pending/rejected applicant's OTP-verified session has no `ProductVendor`
row, so `GET /vendors/product/me` 404s and no dashboard access is possible, with zero
new gating logic required.

**DB changes:** all additive (new tables + nullable columns on `ProductVendor`)

**API changes:**
```
POST /seller-registration/init | save-step | pickup-locations | submit    [Public]
GET  /seller-registration/status | draft/:id | pickup-locations/:id      [Public]
GET  /admin/seller-registrations | /:id                                   [ADMIN]
PATCH /admin/seller-registrations/:id/status                              [ADMIN]
```

**Verified live** (throwaway test applications, cleaned up after): registered two
full applications end-to-end (all 7 steps, real pickup-location coordinates, real
base64 document uploads, bank details); confirmed both landed correctly for admin
review with pickup locations and documents intact; approved one — confirmed a real
`ProductVendor` + `PickupLocation` were provisioned and that seller could immediately
log in and reach `/vendors/product/me`; rejected the other with a reason — confirmed
that phone number could NOT reach a seller profile (404) and that
`/seller-registration/status` correctly surfaces the rejection reason. Separately
confirmed the `submit` endpoint's terms-acceptance validation actually blocks
(caught by the test itself skipping that field) and separately confirmed the true
happy path succeeds. Browser-verified the wizard's Leaflet map actually initializes
on the live page and `seller.html`'s updated login screen renders correctly.

**Commits:** `e3d9f38` (backend + schema), `681a08b` (admin review UI), `a30c33d` (public wizard), `bbc09dd` (seller.html login updates)

---

## 2026-07-11 — Proper seller form, attractive seller dashboard, critical login fix

**Summary:** Three asks in one: (1) a proper sectioned admin seller-creation form
with business/pickup address, (2) an attractive individual seller dashboard with
sales + order-status breakdown, (3) confirm direct-to-dashboard login. Building #3
surfaced a severe pre-existing bug affecting both `vendor.html` and `seller.html`'s
own OTP login screens, fixed as part of this same pass.

**GST auto-fetch:** intentionally not built — no GST verification API/provider is
configured (confirmed with user). Field stays manual entry, structured so a real
provider can be wired in later without a schema change.

**Files modified:**
- `backend/prisma/schema.prisma` — `ProductVendor.address` / `pickupAddress` (additive nullable)
- `backend/src/modules/admin/admin.module.ts` — `CreateProductVendorDto`/new `UpdateProductVendorDto` gain address fields; new `updateProductVendor()` + `PATCH /admin/product-vendors/:id` (previously only suspend/activate existed — no way to fix a typo after creation)
- `backend/src/modules/vendors/vendors.module.ts` — `ProductVendorsService.dashboard()` gains `todayRevenue`/`monthRevenue`, mirroring the proven today/month/lifetime pattern already used by `ServiceVendorsService.earnings()`; bucketed by `createdAt` since product orders don't reliably set `completedAt`
- `frontend/admin/vendors.html` — seller modal restructured into Contact/Business/Address sections with a "pickup same as business address" shortcut; Edit action added per seller row
- `frontend/admin/style.css` — new `.form-section-label` utility class
- `frontend/seller.html` — Home view redesigned with a gradient sales banner (Today/Month/Total) and 4 tappable status tiles (Pending/Ongoing/Completed/Returns); Orders view gets matching tabs; bucketing is pure client-side grouping of existing `OrderStatus` values, no new endpoint
- **`frontend/seller.html` + `frontend/vendor.html`** — critical fix: `apiFetch()` never unwrapped the backend's `{success, statusCode, data, timestamp}` response envelope (from the global `TransformInterceptor`), so every call site reading fields directly off the response (`res.user`, `res.accessToken`, a returned profile's own fields) was broken. **This means `vendor.html`'s own OTP login screen has been broken this whole time** — vendors have apparently only ever reached the app via the redirect from `index.html`'s login (which unwraps defensively on its own side). `seller.html` inherited the same bug by starting from `vendor.html`'s pattern.

**DB changes:** `ProductVendor.address`, `ProductVendor.pickupAddress` (additive nullable columns)

**API changes:**
```
PATCH /admin/product-vendors/:id   [ADMIN]  edit businessName/gstNumber/city/address/pickupAddress
```
`GET /vendors/product/me/dashboard` response gains `todayRevenue`, `monthRevenue` (additive fields, existing consumers unaffected)

**UI changes:** admin seller form restructured (additive fields + edit capability); `seller.html` Home/Orders views redesigned. No customer-facing UI touched.

**Verified live:** full E2E via direct API calls (create-with-address, edit, dashboard field presence) — all passed. Then browser-driven verification of the actual login UI caught the apiFetch bug (screenshot: "Cannot read properties of undefined (reading 'role')"); confirmed the same failure live on `vendor.html`'s login screen before concluding it was pre-existing and not new-code-only; fixed; re-verified both `vendor.html` and `seller.html` login live via the real UI (not just the API) — seller now lands directly on `screen-app`/`view-home` after OTP verification, sales banner and status tiles render with live data, tapping a status tile correctly jumps to the matching Orders tab. All test accounts/data cleaned from production afterward.

**Commits:** `c3cdb45` (backend address fields), `e295bc8` (admin form), `dd2ea16` (seller dashboard), `f17b581` (apiFetch fix)

---

## 2026-07-11 — Dynamic Product Coverage System

**Summary:** Every product (admin-owned, seller-owned, or "Remont Direct") now
declares where it's available: Pan India (default), Selected Cities, Store Pickup
Only, or Zones (schema-only, future-ready). Built directly on top of the city
activation system from earlier today — reused the existing `CityProduct` table
(previously written by two admin endpoints with zero frontend consuming them) rather
than introducing a parallel mechanism.

**Files modified/added:**
- `backend/prisma/schema.prisma` — `ProductCoverageType` enum, `Product.coverageType` (default `PAN_INDIA`, so all pre-existing products keep working unchanged), new `ProductZone` model (pincode/areaName — schema only, not yet enforced)
- `backend/src/modules/products/products.module.ts` — `list()` rewritten with coverage-aware filtering + priority ordering (city-specific before Pan India, ineligible hidden); `syncCityCoverage()` replace-semantics helper; `create()`/`update()`/`myProducts()` updated
- `backend/src/modules/admin/admin.module.ts` — same coverage handling for `adminCreateProduct`/`adminUpdateProduct`; `adminListProducts` now includes an active-city count
- `frontend/admin/products.html` — Coverage Area radio group; the previously-dead Cities tab is now coverage-aware (Pan India = opt-out list, Selected Cities = opt-in list, Store Pickup = hidden); Coverage column on the products table
- `frontend/seller.html` — same Coverage Area section on the product form, backed by the public city list

**DB changes:** `Product.coverageType` (additive, default `PAN_INDIA`), new `ProductZone` table (additive, empty/unused)

**API changes:** no new routes — `coverageType`/`cityIds` are new optional fields accepted by the existing `POST/PATCH /products` and `POST/PATCH /admin/products`

**UI changes:** additive fields on existing admin/seller product forms; a previously entirely-unused admin "Cities" tab is now functional. No customer-facing UI touched (this changes what customers *see* via filtering, not any customer-facing page).

**Verified live** (throwaway test cities/seller/products, cleaned up after): Pan India product appeared in both test cities; a Selected-Cities product scoped to one city was correctly hidden in the other; a Store-Pickup product was correctly scoped to its seller's city only; city-specific results correctly ranked before Pan India in the same query; editing a product's coverage from one city to another correctly replaced rather than accumulated the assignment (no duplication); `myProducts()` correctly returns `coverageType` + `cityProducts` for edit-form prefill.

**Commits:** `7006ad8` (backend), `53d83a3` (frontend)

---

## 2026-07-11 — Dynamic City Activation Management System

**Summary:** Found (via direct production DB query) that all 13 configured cities were
active simultaneously — contradicting the single-city-launch goal — and that the
existing single-city toggle wasn't actually enforced consistently at order creation.
Built a full configuration-driven, no-redeploy-required city management system per
explicit spec, and fixed the enforcement gap it surfaced.

**Files modified/added:**
- `backend/prisma/schema.prisma` — `ProductVendor.city` (additive, nullable String, indexed) — sellers now have a city association, needed for real city-wise seller counts
- `backend/src/modules/admin/admin.module.ts` — `bulkToggleCities()`, `toggleAllCities()`, `cityStats()` + routes; `createProductVendor` accepts `city`
- `backend/src/modules/orders/orders.module.ts` — **bug fix**: of 3 order-creation paths, only guest service booking checked `city.isActive`; the authenticated `/orders` endpoint and guest product checkout had no city gate at all. Both now block with a clear error when the named city resolves to a deactivated managed city; unresolvable city text is left unchanged (no regression)
- `frontend/admin/cities.html` — stats strip (total/active/inactive/launch mode), per-city Sellers/Technicians/Products/Services columns, per-row checkboxes + bulk activate/deactivate, global Enable-All/Disable-All (confirm-gated)
- `frontend/admin/vendors.html` — City dropdown on seller-creation form; City column on sellers table
- `frontend/seller.html` — City shown on seller Profile view

**DB changes:** `ProductVendor.city` (additive nullable column, `db push` applied to production)

**API changes:**
```
GET   /admin/cities/stats                        [ADMIN]
PATCH /admin/cities/bulk                          [ADMIN]  { cityNames: string[], isActive: boolean }
PATCH /admin/cities/all                           [ADMIN]  { isActive: boolean }
```
(existing `GET /admin/cities`, `POST /admin/cities`, `PATCH /admin/cities/:name`, `PATCH /admin/cities/:name/toggle` unchanged)

**UI changes:** `admin/cities.html` substantially extended (additive — existing single-toggle button untouched); small additive fields on `admin/vendors.html` and `seller.html`. No customer-facing UI touched.

**Bug found + fixed during E2E verification:** confirmed via a real deactivate→attempt-order→reactivate test against production (using a throwaway test city, cleaned up after) that both previously-unguarded order-creation paths are now correctly blocked with a 400 and the expected message when the target city is inactive, and correctly succeed when active.

**Deliberately not tested against production:** `PATCH /admin/cities/all` (global enable/disable-all) — it has no scoping and would have flipped all 13 real live cities. Verified by code review only (a straightforward `prisma.city.updateMany`); the admin should trigger this consciously when actually needed, not have it fired as a test.

**Commits:** `03fbafd` (bulk endpoints + stats + schema), `543da2b` (order enforcement fix), `8658a51` (frontend)

---

## 2026-07-11 — Phase 1: Admin-managed Product Sellers + Seller Portal + Orders

**Summary:** Implemented all 3 approved Phase 1 objectives — hybrid seller model
(admin-managed accounts, no public registration), a lightweight seller portal, and
seller-scoped orders visibility. Verified end-to-end against live production via a
real admin→create-seller→login→product→order-visibility flow (test data created
and cleaned up afterward), not just typecheck.

**Files modified/added:**
- `backend/src/modules/admin/admin.module.ts` — `listProductVendors`, `createProductVendor` (with `CreateProductVendorDto` phone validation), `suspendProductVendor`, `activateProductVendor` + routes under `/admin/product-vendors`
- `backend/src/modules/vendors/vendors.module.ts` — `ProductVendorsService.myOrders()` + `GET /vendors/product/me/orders`
- `backend/src/modules/products/products.module.ts` — public `GET /products/categories`; fixed a pre-existing gap where `update()` passed the PATCH body straight through, letting a seller reassign `vendorId` on their own product
- `frontend/admin/vendors.html` — new "Product Sellers" tab (list/search/filter, create-seller modal, suspend/reactivate)
- `frontend/admin/common.js` — sidebar nav entry for Product Sellers
- `frontend/seller.html` (new) — lightweight seller portal: OTP login, Home (dashboard stats), Products (list/add/edit with client-side image compression), Orders (read-only, own-products-only), Profile

**DB changes:** none (all additive via existing models — `ProductVendor`, `Product`, `OrderItem` were already sufficient)

**API changes:**
```
GET   /admin/product-vendors                    [ADMIN]
POST  /admin/product-vendors                     [ADMIN]
PATCH /admin/product-vendors/:id/suspend         [ADMIN]
PATCH /admin/product-vendors/:id/activate        [ADMIN]
GET   /vendors/product/me/orders                 [PRODUCT_VENDOR]
GET   /products/categories                       [Public]
```

**UI changes:** new admin tab (additive, existing tabs unchanged); new standalone `seller.html` page (doesn't touch `index.html` or any customer-facing UI).

**Bug found + fixed during E2E verification:** `createProductVendor` had no phone-format validation — a typo would silently create a `User` row that could never pass `/auth/send-otp`'s `IsPhoneNumber` check, i.e. a seller account permanently unable to log in with no error at creation time. Added `CreateProductVendorDto` with the same validation `auth.module.ts` already uses.

**Commits:** `fcdc441` (docs scaffold), `795b7b2` (admin seller CRUD), `4292678` (seller orders endpoint), `64a9dc3` (admin UI tab), `83732f9` (public categories endpoint), `5dc7c86` (seller portal + ownership hardening), `c2f33fa` (phone validation fix)

---

## 2026-07-11 — Documentation scaffold

**Summary:** Created the standing project documentation set requested for long-term,
resumable, phased development.

**Files added:**
- `PROJECT_PROGRESS.md` — current/pending work tracker
- `PROJECT_ROADMAP.md` — phase plan, Phase 1 scope, deferred enterprise roadmap reference
- `CHANGELOG.md` — this file
- `CLAUDE_CONTEXT.md` — current architecture, DB structure, APIs, business rules, conventions
- `TODO.md` — Phase 1 task list with dependencies

**DB changes:** none
**API changes:** none
**UI changes:** none

---

## 2026-07-11 — Fix: automatic order dispatch matched zero vendors

**Summary:** All 28 production `ServiceVendor.skills` values used a vocabulary that
never matched real `ServiceCategory.key` values (e.g. `ELECTRICIAN` vs `ELECTRICAL`,
lowercase-hyphen slugs vs uppercase-underscore keys). `DispatchService`'s exact-match
lookup therefore matched zero vendors for every order, in every category, since the
feature was built. Root cause of "orders need manual processing."

**Files modified:**
- `backend/src/common/index.ts` — added `normalizeSkillKey()`
- `backend/src/modules/partner-registration/partner-registration.module.ts` — apply normalization on approval
- `backend/src/modules/vendors/vendors.module.ts` — apply normalization on self-registration; fixed `availableJobs()` to filter by category + proximity (previously had no filter at all)
- `backend/prisma/normalize-vendor-skills.js` (new) — one-off backfill, executed against production (28/28 vendors updated)

**DB changes:** data backfill only (no schema change) — `ServiceVendor.skills` values normalized in place.
**API changes:** `GET /vendors/service/me/available-jobs` now actually filters (previously returned unfiltered results).
**UI changes:** none

**Commit:** `2640701`

---

## 2026-07-11 — Fix: real service catalog unreachable on mobile

**Summary:** The Category → SubCategory → Service browser only ever rendered into
`#displayPanel`, which lives inside `.shop-section` — force-hidden on every mobile
viewport. Mobile users could never browse the real 196-service catalog; every tap
opened a generic fake-price booking modal instead.

**Files modified:**
- `frontend/index.html` — `renderService()`/`renderSubCategoryServices()` now accept an optional render-target id (default `displayPanel`, so desktop is byte-for-byte unchanged); added `#mobile-catalog-overlay` reusing the same render functions/markup/CSS; rewired mobile category tiles to open real catalog data with fallback to the old generic modal only when a category has no real products yet.

**DB changes:** none
**API changes:** none
**UI changes:** mobile-only, additive (new overlay). Desktop UI unchanged — verified via headless-browser diff.

**Commit:** `a3047c4`

---

## Earlier work (pre-dates this changelog — see memory / git log for full detail)

SubCategory hierarchy (Category → SubCategory → Service) for the customer site,
mobile functionality audit (8 fixes), admin role-lockout fix, services-display cap
fix, vendor portal build. Not repeated here — this changelog starts tracking from
the seller-marketplace phase onward.
