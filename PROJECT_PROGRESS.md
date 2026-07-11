# PROJECT_PROGRESS.md — Remont India

> Update this file after every completed module. Read it first, continue from
> "Next Task" — never restart or regenerate completed work.

---

## Current Phase

**Phase 1 — Single-City Service + Product Marketplace MVP** (see `PROJECT_ROADMAP.md`)

## Current Status

All 3 objectives approved 2026-07-11 are **complete and verified live**:
1. ✔ Admin-managed Product Sellers
2. ✔ Lightweight Seller Portal
3. ✔ Seller Orders Management

## Completed This Phase

- [x] Architecture audit against 11-part enterprise brief (deferred — see `PROJECT_ROADMAP.md`)
- [x] Fixed: mobile real-service-catalog was unreachable (`.shop-section` force-hidden on mobile, no equivalent mobile UI existed) — added mobile-only catalog overlay reusing existing render functions. Commit `a3047c4`.
- [x] Fixed: automatic order dispatch silently matched zero vendors for every category (vendor `skills` vocabulary never matched real `ServiceCategory.key` values). Added `normalizeSkillKey()`, backfilled 28 production vendor records, fixed `availableJobs()` filter. Commit `2640701`.
- [x] Documentation scaffold created: `PROJECT_PROGRESS.md`, `PROJECT_ROADMAP.md`, `CHANGELOG.md`, `CLAUDE_CONTEXT.md`, `TODO.md`
- [x] Backend: admin-managed `ProductVendor` CRUD (list/create/suspend/activate) in `admin.module.ts` — commit `795b7b2`
- [x] Backend: seller "my orders" endpoint in `vendors.module.ts` — commit `4292678`
- [x] Backend: public product-categories endpoint — commit `83732f9`
- [x] Admin UI: "Product Sellers" tab in `admin/vendors.html` + sidebar nav entry — commit `64a9dc3`
- [x] Frontend: `seller.html` lightweight portal (login/products/orders/profile) — commit `5dc7c86`
- [x] Security hardening: fixed pre-existing `vendorId` PATCH-spoofing gap in `products.module.ts` — commit `5dc7c86`
- [x] Bug found + fixed via E2E test: `createProductVendor` had no phone validation — commit `c2f33fa`
- [x] End-to-end verification: 13-step live-API test (admin login → create seller → list → seller OTP login → profile → categories → create product → list own products → dashboard stats → orders → ownership-spoof attempt blocked → suspend → reactivate). All passed. Test data cleaned from production afterward.
- [x] Visual smoke test: `seller.html` and `admin/vendors.html` load with zero JS errors on live Vercel deploy.
- [x] Full changelog entry recorded in `CHANGELOG.md`.

## In Progress

(none — Phase 1's 3 objectives are done; see `TODO.md` for any follow-on polish items)

## Next Task

None queued. Awaiting next instruction — likely either polish/iterate on the seller
portal based on real usage, or move to another Phase 1 item if one emerges.

## Bugs Found

(all found this session were fixed immediately — see below; none outstanding)

## Bugs Fixed (this phase, chronological)

1. **Mobile: real service catalog unreachable** — `frontend/index.html`, commit `a3047c4`, 2026-07-11.
2. **Dispatch: vendor skill vocabulary mismatch** — `backend/src/common/index.ts` + `partner-registration.module.ts` + `vendors.module.ts` + one-off prod backfill, commit `2640701`, 2026-07-11.
3. **Products: `vendorId` spoofable via PATCH** — `backend/src/modules/products/products.module.ts`, commit `5dc7c86`, 2026-07-11. Pre-existing gap, found while building the seller portal on top of it.
4. **Admin: no phone validation on seller creation** — `backend/src/modules/admin/admin.module.ts`, commit `c2f33fa`, 2026-07-11. Found by the E2E verification test itself.

(Earlier-session bugs — admin role lockout, services-display cap, mobile-audit 8-fixes — are documented in memory, not repeated here; this file starts fresh from the seller-marketplace phase.)
