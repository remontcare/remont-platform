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

## Possible follow-on items (not started, not committed to — raise with user before building)

- Seller can't currently see order-detail (customer address/phone) beyond what `myOrders()` returns — may want a detail view if sellers ask for it.
- No email/SMS notification to a seller when a new order containing their product arrives — currently they must check the portal.
- No password/PIN recovery UI needed (OTP-only login has no such concept) — non-issue, noting for completeness.

## Explicitly not on this list (deferred — see `PROJECT_ROADMAP.md`)

Seller KYC documents, public seller registration, bulk upload, commission
automation/wallet/ledger, multi-warehouse, courier integration, AI product
enrichment, fuzzy/voice/image search, bundling engine.
