# CHANGELOG.md — Remont India

> Append-only. Every entry: date, summary, files modified, API/DB/UI changes.
> Newest entries at the top.

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
