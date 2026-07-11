# CHANGELOG.md — Remont India

> Append-only. Every entry: date, summary, files modified, API/DB/UI changes.
> Newest entries at the top.

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
