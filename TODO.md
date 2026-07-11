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

## Possible follow-on items (not started, not committed to — raise with user before building)

- Seller can't currently see order-detail (customer address/phone) beyond what `myOrders()` returns — may want a detail view if sellers ask for it.
- No email/SMS notification to a seller when a new order containing their product arrives — currently they must check the portal.
- No password/PIN recovery UI needed (OTP-only login has no such concept) — non-issue, noting for completeness.

## Explicitly not on this list (deferred — see `PROJECT_ROADMAP.md`)

Seller KYC documents, public seller registration, bulk upload, commission
automation/wallet/ledger, multi-warehouse, courier integration, AI product
enrichment, fuzzy/voice/image search, bundling engine.
