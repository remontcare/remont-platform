# PROJECT_PROGRESS.md — Remont India

> Update this file after every completed module. Read it first, continue from
> "Next Task" — never restart or regenerate completed work.

---

## Current Phase

**Phase 1 — Single-City Service + Product Marketplace MVP** (see `PROJECT_ROADMAP.md`)

## Current Status

All 3 seller-marketplace objectives AND the dynamic city-activation system approved
2026-07-11 are **complete and verified live**:
1. ✔ Admin-managed Product Sellers
2. ✔ Lightweight Seller Portal
3. ✔ Seller Orders Management
4. ✔ Dynamic City Activation Management (bulk actions, stats dashboard, order-creation enforcement fix)
5. ✔ Dynamic Product Coverage System (Pan India / Selected Cities / Store Pickup / Zones-schema-ready)

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

- [x] Found (via production DB query, not assumption): all 13 cities were simultaneously active, contradicting the single-city launch goal — this was the trigger for building the city management system.
- [x] Backend: `ProductVendor.city` schema addition, bulk/all/stats city endpoints — commit `03fbafd`
- [x] Backend: fixed a real enforcement gap — 2 of 3 order-creation paths never checked `city.isActive` at all — commit `543da2b`
- [x] Frontend: `admin/cities.html` stats dashboard + bulk actions + global switch; city field added to seller creation and seller profile — commit `8658a51`
- [x] E2E verified live: deactivate a (throwaway test) city → both order-creation paths correctly blocked → reactivate → both succeed. Visually confirmed the new admin dashboard renders correctly with live data (13 cities, real per-city technician counts).
- [x] Deliberately did NOT fire `PATCH /admin/cities/all` against production during testing — verified by code review only, since it has no scoping and would affect all 13 real cities. Documented so the admin knows to trigger it consciously.
- [x] Built the Product Coverage System (Pan India/Selected Cities/Store Pickup/Zones-schema-only) on top of the city system — reused the existing `CityProduct` table (previously written by 2 admin endpoints with zero frontend using them) rather than building a parallel mechanism — commits `7006ad8`, `53d83a3`.
- [x] E2E verified live: 6 scenarios (Pan India both-cities, Selected-Cities scoping, Store-Pickup scoping, priority ordering, edit-coverage replace-not-accumulate, myProducts() prefill data) all passed against throwaway test cities/seller/products, cleaned up after.

## In Progress

(none — all objectives approved so far are done; see `TODO.md` for any follow-on items)

## Next Task

None queued. **Open decision for the business, not a dev task:** all 13 cities are
still active in production. The city-management tooling to fix this now exists —
someone needs to actually decide which city (or cities) to launch with and use the
new admin/cities.html bulk actions to deactivate the rest.

## Bugs Found

(all found this session were fixed immediately — see below; none outstanding)

## Bugs Fixed (this phase, chronological)

1. **Mobile: real service catalog unreachable** — `frontend/index.html`, commit `a3047c4`, 2026-07-11.
2. **Dispatch: vendor skill vocabulary mismatch** — `backend/src/common/index.ts` + `partner-registration.module.ts` + `vendors.module.ts` + one-off prod backfill, commit `2640701`, 2026-07-11.
3. **Products: `vendorId` spoofable via PATCH** — `backend/src/modules/products/products.module.ts`, commit `5dc7c86`, 2026-07-11. Pre-existing gap, found while building the seller portal on top of it.
4. **Admin: no phone validation on seller creation** — `backend/src/modules/admin/admin.module.ts`, commit `c2f33fa`, 2026-07-11. Found by the E2E verification test itself.

(Earlier-session bugs — admin role lockout, services-display cap, mobile-audit 8-fixes — are documented in memory, not repeated here; this file starts fresh from the seller-marketplace phase.)
