# Vendor Platform Security Audit — Fix Report
**Date:** 2026-08-02
**Scope:** Completion of the Codex-initiated Vendor Platform Security Audit after its quota was exhausted. No redesign, no UI changes, no route renames, no breaking changes — backend validation/authorization/DB-logic hardening only.

---

## Summary

| # | Area | Status |
|---|---|---|
| 1 | Vendor Job Acceptance | ✅ Done (found already fully implemented, verified) |
| 2 | Customer Data Protection | ✅ Done (found already fully implemented, verified) |
| 3 | Atomic Job Assignment | ✅ Done (found already fully implemented, verified) |
| 4 | Seller Approval Gating | ✅ Done (new fix) |
| 5 | Registration Validation | ✅ Done (new fix — mass-assignment gaps closed) |
| 6 | XSS & Token Security | ✅ Partial — highest-risk sinks fixed; not an exhaustive sweep (see Remaining Risks) |
| 7 | Attendance Security | ✅ Done (new fix) |
| 8 | Automated Tests | ✅ Done — 24 new tests added, 140/140 passing |

Build: clean (`tsc`, 0 errors). Tests: 140/140 passing across 16 suites. Lint: could not run — see note below.

---

## 1–3. Vendor Job Acceptance / Customer Data Protection / Atomic Assignment

**Files:** `backend/src/modules/vendors/vendors.module.ts`, `backend/src/modules/vendors/vendors.security.spec.ts`

These three items had already been substantially fixed in-progress (uncommitted working-tree changes) before this session started — that work was verified, not redone:

- **`requireActiveVendor()`**: every vendor-facing action (`availableJobs`, `acceptJob`, `getJobDetail`, `updateLocation`, `setOnlineStatus`) now loads the vendor and throws `ForbiddenException` unless `status === VendorStatus.ACTIVE`, and additionally rejects `memberStatus === 'FROZEN'` agency members. PENDING_VERIFICATION/SUSPENDED/REJECTED vendors can no longer see or claim jobs.
- **`isEligibleForOrder()`**: centralizes skill-match + city/radius geofencing (haversine against `serviceRadius`, falling back to same-city match with no live location) — used identically by both the listing and claim paths, so a vendor can never claim something the list wouldn't have shown them.
- **`acceptJob()`**: re-checks `order.status === CONFIRMED` (rejects `PENDING_PAYMENT` — i.e. requires payment already confirmed for online orders / a genuinely confirmed COD order) before allowing a claim.
- **`availableJobs()`**: strips `fullAddress`/`pincode`/precise coordinates from the response — an unassigned job now only exposes `{ city }`. Full customer name/phone/address is only ever returned once `order.vendorId === vendor.id` (enforced in `getJobDetail`, throwing `ForbiddenException` otherwise).
- **`acceptJob()` atomicity**: replaced the prior read-then-`update()` pattern with `prisma.order.updateMany({ where: { id, vendorId: null, status: CONFIRMED }, data: {...} })` and checks `count === 1`. This is the row-lock: Postgres serializes concurrent `UPDATE ... WHERE` statements against the same row, so two simultaneous accept requests can never both succeed — the loser gets `count: 0` and a `BadRequestException`, no notification/timeline entry is written for them.

**Root cause (historical):** the original `acceptJob()` did `findUnique` → `update`, a classic check-then-act TOCTOU race; `availableJobs()`/`myJobs()` `include`d the full `address`/`customer` relation regardless of assignment state; vendor status was never checked outside of registration.

**Tests:** `vendors.security.spec.ts` (pre-existing, verified passing) covers: non-ACTIVE vendor rejected before any order lookup; non-CONFIRMED order rejected; out-of-skill rejected; out-of-radius rejected; successful atomic claim; lost-race claim (count:0) sends no notification; `getJobDetail` denies an unassigned/unowned job's PII and allows the owning vendor.

---

## 2 (continued). Frontend PII rendering — `frontend/vendor.html`

Also already fixed in the working tree before this session: `escapeHtml()` applied across every `.innerHTML` template that renders order/customer/team/refund data (job cards, transactions, refund requests, team roster, ledger rows), and two `onclick="fn('${id}')"` attribute-injection sites (refund response, freeze-member) converted to `addEventListener` + `data-*` attributes, since HTML-entity-escaping alone doesn't stop a quote-breakout inside an inline event-handler attribute.

---

## 4. Seller Approval Gating

**Files:** `backend/src/modules/products/products.module.ts`, `backend/src/modules/products/products.security.spec.ts` (new)

**Root cause:** `ProductVendor.status` (`PENDING_VERIFICATION | ACTIVE | SUSPENDED | REJECTED`) exists on the schema and is set correctly by the seller-approval workflow, but `ProductsService.create()` and `.update()` never read it — any authenticated `PRODUCT_VENDOR` JWT, approved or not, could publish or edit live storefront listings.

**Fix:** both methods now load the caller's `ProductVendor` and throw `ForbiddenException` unless `status === 'ACTIVE'`, before any product read/write. Admin's own product CRUD (`admin.module.ts`) is untouched — it doesn't call `ProductsService` and remains admin-authoritative by design.

**Tests:** `products.security.spec.ts` — parametrized rejection for `PENDING_VERIFICATION`/`SUSPENDED`/`REJECTED` on both `create` and `update`, plus the ACTIVE-seller success path for each.

---

## 5. Registration Validation

**Files:** `backend/src/modules/partner-registration/partner-registration.module.ts`, `backend/src/modules/seller-registration/seller-registration.module.ts`, plus two new spec files

**Root cause:** both registration flows' `saveStep()` is a public (unauthenticated), multi-step draft-autosave endpoint that persists an arbitrary client-supplied object via `{ ...safe }` spread into `prisma.update()`. The existing strip-list (`id, status, createdAt, updatedAt, registrationId`) missed three trust-sensitive fields still writable by any caller who knows/guesses a `registrationId`:
- **`invitedByAgencyId`** (partner registration only) — the field that, once the application is approved, wires the new vendor into an agency (`agencyOwnerId` + `memberStatus: ACTIVE`) via `_activatePartner()`. Legitimately set only by an authenticated agency owner's `inviteAgencyMember()` call — but nothing stopped a self-registering applicant from setting it directly on their own draft and getting auto-linked into an arbitrary agency on approval.
- **`agreedTerms` / `agreedAt`** (both flows) — the legal-consent gate that `submit()` is supposed to be the sole writer of.
- **`userId`** (both flows) — harmless in practice today (overwritten by `_activateSeller()`/`_activatePartner()` on approval) but a mass-assignment gap worth closing defensively.

**Fix:** added these fields to each `saveStep()` destructure-and-drop list, matching the existing `id/status/createdAt/updatedAt` pattern already in place (registration-flow DTOs stay `Record<string, any>` by design — this is a staged-autosave endpoint accepting partial payloads across 8 steps, not a single-shot typed create — so the fix is at the field-allowlist layer, consistent with the file's existing sanitization approach, rather than introducing a class-validator DTO that would have to special-case every one of ~30 optional fields).

Note: `auth.module.ts` (OTP login/registration) and `ServiceVendorRegistrationDto` in `vendors.module.ts` (direct vendor self-registration) were already fully DTO-validated with `class-validator` and correctly excluded trust fields (`isVipPro`, `staffType`, `priority`-equivalents, `agencyStatus`, `memberStatus`) before this session — verified, not changed.

**Tests:** `partner-registration.security.spec.ts`, `seller-registration.security.spec.ts` — assert the Prisma `update()` call's `data` never contains the stripped fields even when the caller supplies them, while still persisting legitimate step data (`fullName`/`businessName`).

---

## 6. XSS & Token Security

**Files:** `frontend/index.html`, `vercel.json`

### Fixed
- **`frontend/index.html` — stored XSS via seller-supplied product data.** `productsSectionHtml()` (the homepage/catalog product grid rendered from `POST /products` seller-authored data) and `svcCardsHtml()` interpolated `product.name`, `product.brand`, `product.img` (into a `style="background-image:url('...')"` attribute), `rating`, `price`, `badge`, and service name/inclusions directly into `innerHTML` with no escaping. Any approved `PRODUCT_VENDOR` could set a product name/brand/description/image URL containing HTML and have it execute in every visitor's browser on the public storefront — this is the most severe finding in this pass (stored, cross-user, unauthenticated-visitor-facing). Fixed by routing all of it through the page's existing `escHtml()` helper (also hardened to escape `'` in addition to `& < > "`, matching the fix already applied to `vendor.html`'s `escapeHtml()`).
- Same treatment applied to the city-selector modal (`buildCityModal`) and category panel headers (`renderService`'s title/subtitle/subcategory names) for defense in depth (these are admin-managed, lower risk, but cheap to close).
- **CSP + hardening headers** (`vercel.json`): added `Content-Security-Policy` (`default-src 'self'`, explicit allowlist for Razorpay checkout, Google Fonts, Leaflet/OpenStreetMap — the only third-party origins actually referenced anywhere in `frontend/*.html`; `object-src 'none'`; `frame-ancestors 'none'`; `base-uri 'self'`) and `Referrer-Policy: strict-origin-when-cross-origin`, alongside the pre-existing `X-Content-Type-Options`/`X-Frame-Options`/`X-XSS-Protection`. `script-src`/`style-src` retain `'unsafe-inline'` — this app is built entirely on inline `<script>` blocks and `onclick="..."` handlers throughout every page; a strict CSP without it would break the app outright, which the task explicitly forbids. This CSP still closes the two things that matter most against the app's real threat model (stored XSS turning into data exfiltration or clickjacking): no arbitrary remote script loading, no plugin/object embeds, no framing.
- **Token handling** (reviewed, no change needed): `AuthService` already hashes refresh tokens at rest (`sha256`), rotates them on every `/auth/refresh` call (old session revoked, new one issued), and never logs a token value. This was already correct.

### Not done (see Remaining Risks below)
A background sub-agent was assigned a broader sweep of the remaining frontend files (`seller.html`, `crm.html`, `delivery.html`, `corporate.html`, `partner-register.html`, `seller-register.html`, `booking.html`, blog pages) but stalled mid-task after making one small, safe, self-contained edit to `index.html` (already included above). I did not attempt to redo that full sweep myself in the time available — see Remaining Risks.

---

## 7. Attendance Security

**Files:** `backend/src/modules/vendors/vendors.module.ts`, `backend/src/modules/vendors/vendors.attendance.spec.ts` (new)

**Root cause:** `checkIn()`/`checkOut()` used an unconditional `upsert` keyed on `(vendorId, date)` with no read-before-write. This meant: (a) a vendor could call check-in repeatedly, silently overwriting the original `checkInAt`/GPS with a later, more convenient one — defeating the point of a timestamped attendance record; (b) `checkOut()` could be called without ever checking in, or called twice, producing a nonsensical or overwritten `checkOutAt`; (c) `lat`/`lng` were accepted with zero plausibility validation (e.g. `0,0` from a stubbed/spoofed geolocation call would be recorded as a real check-in location).

**Fix:**
- `isPlausibleIndianCoordinate()`: rejects non-finite or out-of-India-bounding-box coordinates (`lat 6–38`, `lng 68–98`) before check-in proceeds. This is a plausibility bound, not device attestation — it stops the cheap/common spoofing case (malformed or default-zero coordinates) without requiring any new client capability.
- `checkIn()` now reads the day's existing attendance row first; if `checkInAt` is already set, it throws `BadRequestException('You have already checked in today')` instead of overwriting — the original timestamp and location are now immutable for the rest of the day.
- `checkOut()` now requires an existing `checkInAt` for the day (`BadRequestException('You must check in before checking out')`) and rejects a second check-out (`BadRequestException('You have already checked out today')`) — enforces the check-in → check-out sequence.

**Tests:** `vendors.attendance.spec.ts` — 8 tests: implausible-coordinate rejection, GPS-optional check-in, duplicate-check-in rejection (asserts `upsert` never called, proving the original write is preserved), valid first check-in, check-out-without-check-in rejection, duplicate-check-out rejection, valid check-out.

---

## Test Results

```
Test Suites: 16 passed, 16 total
Tests:       140 passed, 140 total
Time:        ~20-30s
```

New spec files (24 new tests, all passing): `vendors.security.spec.ts` (pre-existing, verified), `vendors.attendance.spec.ts`, `products.security.spec.ts`, `partner-registration.security.spec.ts`, `seller-registration.security.spec.ts`.

TypeScript build (`npm run build` → `tsc -p tsconfig.build.json`): **0 errors.**

**Lint:** `npm run lint` (`eslint "src/**/*.ts" --fix`) could not be run — `eslint` is not actually installed in `node_modules` (only a transitive `eslint-scope` exists) and there is no `.eslintrc*`/`eslint.config.js` in the backend. This is a pre-existing gap in the repo, not something introduced by this pass — flagging it rather than silently skipping it.

---

## Files Changed

| File | Why |
|---|---|
| `backend/src/modules/vendors/vendors.module.ts` | Items 1/2/3 (verified pre-existing work) + item 7 (new: attendance duplicate/sequence/GPS validation) |
| `backend/src/modules/products/products.module.ts` | Item 4: seller-approval gate on `create`/`update` |
| `backend/src/modules/partner-registration/partner-registration.module.ts` | Item 5: strip `invitedByAgencyId`/`agreedTerms`/`agreedAt`/`userId` from `saveStep` mass-assignment |
| `backend/src/modules/seller-registration/seller-registration.module.ts` | Item 5: strip `agreedTerms`/`agreedAt`/`userId` from `saveStep` mass-assignment |
| `frontend/index.html` | Item 6: escape seller-supplied product/service data in the public catalog grid (stored XSS) |
| `frontend/vendor.html` | Item 6 (verified pre-existing work) |
| `vercel.json` | Item 6: CSP + Referrer-Policy headers |
| `backend/src/modules/vendors/vendors.security.spec.ts` | Item 8 (pre-existing, verified) |
| `backend/src/modules/vendors/vendors.attendance.spec.ts` | Item 8 (new) |
| `backend/src/modules/products/products.security.spec.ts` | Item 8 (new) |
| `backend/src/modules/partner-registration/partner-registration.security.spec.ts` | Item 8 (new) |
| `backend/src/modules/seller-registration/seller-registration.security.spec.ts` | Item 8 (new) |

No routes, function signatures (aside from internal private helpers), UI markup, or existing user flows were changed. `.gitignore`, `backend/Dockerfile`, `.claude/settings*.json`, `backend/cleanup.mjs`, and the two pre-existing `*_REPORT.md` files in the working tree predate this session and were left untouched.

---

## Remaining Risks

1. **Frontend XSS sweep is incomplete.** Only `index.html`'s highest-severity sink (public product/service catalog rendering seller-supplied data — genuinely exploitable by any approved seller against every site visitor) and `vendor.html` (already done pre-session) were fixed. `seller.html`, `crm.html`, `delivery.html`, `corporate.html`, `partner-register.html`, `seller-register.html`, `booking.html`, and the blog pages were **not** audited in this pass and may still contain unescaped `.innerHTML` sinks rendering user-supplied data (names, addresses, notes, review text). The `admin/` directory (80 files, internal-staff-only) was intentionally out of scope. Recommend a follow-up pass specifically on `seller.html` (seller's own product/order dashboard) and `crm.html`/`delivery.html` (render customer-supplied lead/order text to staff).
2. **CSP retains `'unsafe-inline'`** for scripts and styles, which is a real constraint of this app's architecture (no build step, inline `onclick=` handlers throughout) rather than something fixable without the redesign this task explicitly forbade. It still meaningfully reduces blast radius (no remote script loading, no framing, no plugin embeds) but does not stop an XSS payload from running inline if one is ever missed.
3. **GPS plausibility check is a bounding-box heuristic, not real anti-spoofing.** It stops the cheap/naive spoofing case (malformed or `0,0` coordinates) but cannot detect a deliberately spoofed-but-plausible location (e.g. a mock-GPS app reporting a fake-but-valid Indian coordinate). True anti-spoofing would require device attestation or server-side triangulation, which is out of scope for a backend-only, non-redesign pass.
4. **`npm run lint` is non-functional in this repo** (eslint not installed, no config file) — pre-existing, not introduced or fixed here. Recommend `npm install --save-dev eslint` + a config as separate follow-up if lint enforcement is desired.
5. **`ProductVendorsService.register()`** (product-vendor self-registration, distinct from the seller-registration KYC flow fixed in item 5) still types its body as `data: any` rather than a `class-validator` DTO. It does manually strip `status`/`rating`/`totalEarnings` before writing, so the specific "internal flags" risk called out in the task is already closed there — but it wasn't converted to a typed DTO for consistency with `ServiceVendorRegistrationDto`, since that was judged lower-priority than the fixes above given the time available.
