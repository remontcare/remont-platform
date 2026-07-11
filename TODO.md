# TODO.md — Remont India

> Remaining tasks for the current phase. Ordered by dependency, not importance.
> See `PROJECT_ROADMAP.md` for what's explicitly deferred — don't add those back here
> without a new explicit instruction.

## Phase 1 — Seller Marketplace (current)

| # | Task | Priority | Depends on | Status |
|---|---|---|---|---|
| 1 | `admin.module.ts`: `listProductVendors`, `createProductVendor`, `suspendProductVendor`, `activateProductVendor` + routes under `/admin/product-vendors` | High | — | ⏳ |
| 2 | `vendors.module.ts`: `ProductVendorsService.myOrders()` + `GET /vendors/product/me/orders` | High | — | ⏳ |
| 3 | `admin/vendors.html`: add "Product Sellers" tab (list, create modal, suspend/activate) | High | 1 | ⏳ |
| 4 | `admin/common.js`: sidebar nav entry for Product Sellers | Medium | 3 | ⏳ |
| 5 | `frontend/seller.html`: login (OTP, PRODUCT_VENDOR role) + app shell | High | 1 | ⏳ |
| 6 | `seller.html`: Products view (list/add/edit via existing `/products` endpoints) | High | 5 | ⏳ |
| 7 | `seller.html`: Orders view (via task 2's endpoint) | High | 2, 5 | ⏳ |
| 8 | `seller.html`: Profile/logout view | Low | 5 | ⏳ |
| 9 | Backend typecheck + frontend script syntax-check | High | 1–8 | ⏳ |
| 10 | End-to-end smoke test: admin creates test seller → seller logs in → adds product → product appears in `/products` → (optional) place a test order → seller sees it | High | 1–8 | ⏳ |
| 11 | Update `CHANGELOG.md`, `PROJECT_PROGRESS.md`, this file; commit + push | High | 10 | ⏳ |

## Explicitly not on this list (deferred — see `PROJECT_ROADMAP.md`)

Seller KYC documents, public seller registration, bulk upload, commission
automation/wallet/ledger, multi-warehouse, courier integration, AI product
enrichment, fuzzy/voice/image search, bundling engine.
