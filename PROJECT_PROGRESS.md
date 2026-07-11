# PROJECT_PROGRESS.md — Remont India

> Update this file after every completed module. Read it first, continue from
> "Next Task" — never restart or regenerate completed work.

---

## Current Phase

**Phase 1 — Single-City Service + Product Marketplace MVP** (see `PROJECT_ROADMAP.md`)

## Current Status

Implementing the 3 objectives approved 2026-07-11:
1. Admin-managed Product Sellers
2. Lightweight Seller Portal
3. Seller Orders Management

## Completed This Phase

- [x] Architecture audit against 11-part enterprise brief (deferred — see `PROJECT_ROADMAP.md`)
- [x] Fixed: mobile real-service-catalog was unreachable (`.shop-section` force-hidden on mobile, no equivalent mobile UI existed) — added mobile-only catalog overlay reusing existing render functions. Commit `a3047c4`.
- [x] Fixed: automatic order dispatch silently matched zero vendors for every category (vendor `skills` vocabulary never matched real `ServiceCategory.key` values). Added `normalizeSkillKey()`, backfilled 28 production vendor records, fixed `availableJobs()` filter. Commit `2640701`.
- [x] Documentation scaffold created: `PROJECT_PROGRESS.md`, `PROJECT_ROADMAP.md`, `CHANGELOG.md`, `CLAUDE_CONTEXT.md`, `TODO.md`

## In Progress

- [ ] Backend: admin-managed `ProductVendor` CRUD (list/create/suspend/activate) in `admin.module.ts`
- [ ] Backend: seller "my orders" endpoint in `vendors.module.ts`
- [ ] Admin UI: "Product Sellers" tab in `admin/vendors.html`
- [ ] Frontend: `seller.html` lightweight portal
- [ ] End-to-end verification with a real test seller account
- [ ] Final changelog entry + commits + push

## Next Task

Implement admin `ProductVendor` CRUD endpoints (see `TODO.md` for the exact task list and order).

## Bugs Found

(none new this session beyond what's already fixed above)

## Bugs Fixed (this phase, chronological)

1. **Mobile: real service catalog unreachable** — `frontend/index.html`, commit `a3047c4`, 2026-07-11.
2. **Dispatch: vendor skill vocabulary mismatch** — `backend/src/common/index.ts` + `partner-registration.module.ts` + `vendors.module.ts` + one-off prod backfill, commit `2640701`, 2026-07-11.

(Earlier-session bugs — admin role lockout, services-display cap, mobile-audit 8-fixes — are documented in memory, not repeated here; this file starts fresh from the seller-marketplace phase.)
