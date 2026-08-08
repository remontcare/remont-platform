# Estimate Engine — review package (not yet deployed)

Status: **built, tested locally, NOT deployed.** Nothing has touched the live database or
production API. This doc is what you asked for before deployment: API structure, schema
changes, sample request/response, and test results.

## Why it's structured this way

- All money math lives in `estimate-engine.ts` as **plain exported functions**, not buried
  in a controller — same pattern this codebase already uses for `resolveCommission()` in
  `backend/src/common/index.ts`. That's what makes it reusable across Interior, Renovation,
  Architecture, and anything else: any module can call `generateEstimate(prisma, citiesService, params)`.
- Reused, not duplicated: city pricing/availability goes through the **existing**
  `CitiesService.getServicePrice()` / `getByName()` / `list()` (same functions the homepage's
  city modal already uses), tax rate comes from the **existing** `TaxConfig` table (previously
  admin-CRUD-only, never actually consumed until now), and lead capture goes through the
  **existing** public `POST /api/v1/crm/leads/capture` endpoint. Nothing new was invented for
  any of those three things.
- Zero hardcoded formulas: GST %, the "starting from" range spread, and every size/finish-style
  multiplier are DB rows (`TaxConfig`, `SiteSetting`, `ServicePriceModifier`) — change them from
  the admin panel later, no code deploy required.

## Files

| File | What |
|---|---|
| `backend/prisma/schema.prisma` | Additive changes only (below) |
| `backend/prisma/migrations/20260808000000_add_estimate_engine/migration.sql` | Hand-authored migration SQL — **not applied yet** |
| `backend/src/modules/estimates/estimate-engine.ts` | The engine — pure math + orchestration |
| `backend/src/modules/estimates/estimate-engine.spec.ts` | 22 Jest tests, all passing, zero DB |
| `backend/src/modules/estimates/estimates.module.ts` | NestJS controller/service/module wiring |
| `backend/src/app.module.ts` | One line added: registers `EstimatesModule` |

## Database / schema changes

**Fully additive** — no column dropped, renamed, or made non-nullable without a default; no
existing row is touched.

1. `LeadSource` enum gets one new value: `ESTIMATE_ENGINE` (lets leads captured through this
   flow be told apart from AI-chat/WhatsApp/website leads in the CRM).
2. Two new enums: `ServiceDeliveryType` (`DIGITAL` / `ONSITE` / `HYBRID`) and `PricingType`
   (`FIXED` / `STARTING_FROM` / `QUOTATION` / `PER_SQFT`).
3. `Service` gets 11 new nullable-or-defaulted columns: `serviceType` (default `ONSITE`),
   `pricingType` (default `FIXED`), `offerPrice`, `consultationFee`, `siteVisitFee`,
   `labourCost`, `materialCost`, `perSqftRate`, `gstOverridePercent`, `timelineMinDays`,
   `timelineMaxDays`. Every existing service row keeps working exactly as before — the new
   columns are simply empty until an admin fills them in.
4. Two new tables: `ServicePriceModifier` (admin-managed multipliers, e.g. size/finish
   options — service-level row overrides a category-level row for the same group, same
   override pattern as the existing `CommissionRule`) and `Estimate` (one row per estimate
   request, for audit/lead-followup/analytics).

Full SQL is in the migration file linked above — happy to walk through it line by line.

**One thing I did NOT do and want your input on:** I did not run `prisma migrate deploy` or
`prisma db push` against the live database. `backend/.env`'s `DATABASE_URL` points straight at
the production Railway Postgres — there's no separate dev/staging database in this setup — so
applying *anything* there is a live-system action I'm not taking without your explicit go-ahead,
consistent with "do not deploy partial changes." I also noticed there's no pre-existing
`prisma/migrations/` history in this repo at all, which suggests schema changes have been
applied via `db push` up to now rather than tracked migrations — worth confirming with you
which mechanism you want used for this one before we run it.

## API structure

### `POST /api/v1/estimate` (public)
Accepts customer inputs, returns cost breakdown + timeline + booking eligibility. Also
captures a lead (via the existing CRM endpoint) if name+phone are provided.

**Request**
```json
{
  "serviceId": "svc_modular_kitchen",
  "city": "Bhopal",
  "sqft": 120,
  "modifiers": [{ "group": "size", "label": "Large" }, { "group": "finish", "label": "Luxury" }],
  "customerName": "Anjali Sharma",
  "customerPhone": "9876543210",
  "customerEmail": "anjali@example.com"
}
```
`city`, `sqft`, `modifiers`, and the customer fields are all optional. `sqft` is required only
when the service's `pricingType` is `PER_SQFT` (400 error otherwise).

**Response — serviceable city**
```json
{
  "estimateId": "clx...",
  "service": { "id": "svc_modular_kitchen", "name": "Modular Kitchen", "categoryId": "cat_interior", "serviceType": "ONSITE", "pricingType": "STARTING_FROM" },
  "estimatedCost": { "low": 168000, "high": 210000, "currency": "INR" },
  "breakdown": {
    "basePrice": 120000,
    "materialCost": 0,
    "labourCost": 0,
    "modifiersApplied": [{ "group": "size", "label": "Large", "multiplier": 1.4 }],
    "consultationFee": 0,
    "siteVisitFee": 0,
    "gstPercent": 18,
    "gstAmount": 30240
  },
  "finalPayableAmount": 198240,
  "requiresQuotation": false,
  "timeline": { "minDays": 35, "maxDays": 49, "label": "5–7 weeks" },
  "bookingEligibility": { "eligible": true, "reason": "OK", "message": null }
}
```

**Response — city not yet serviceable (requirement #8 — never blocked)**
```json
{
  "estimateId": "clx...",
  "service": { "...": "..." },
  "estimatedCost": { "low": 168000, "high": 210000, "currency": "INR" },
  "breakdown": { "...": "..." },
  "finalPayableAmount": 198240,
  "requiresQuotation": false,
  "timeline": { "minDays": 35, "maxDays": 49, "label": "5–7 weeks" },
  "bookingEligibility": {
    "eligible": false,
    "reason": "CITY_NOT_SERVICEABLE",
    "message": "Estimate Available, Execution Not Available Yet."
  }
}
```
The estimate is identical either way — only `bookingEligibility` differs. Nothing about the
response blocks the customer from seeing their number.

**Response — digital service, any/no city**
```json
{ "bookingEligibility": { "eligible": true, "reason": "DIGITAL_NO_RESTRICTION", "message": null }, "...": "..." }
```

**Response — QUOTATION pricing type (e.g. Complete Interior / custom projects)**
```json
{
  "estimatedCost": null,
  "requiresQuotation": true,
  "breakdown": { "basePrice": null, "consultationFee": 999, "siteVisitFee": 500, "gstPercent": 18, "gstAmount": 269.82, "...": "..." },
  "finalPayableAmount": 1768.82
}
```

### `GET /api/v1/estimate/modifiers?serviceId=X` (public)
Returns the live, admin-managed modifier options for a service/category, grouped:
```json
{ "size": [{ "label": "Compact", "multiplier": 0.8 }, { "label": "Large", "multiplier": 1.4 }], "finish": [{ "label": "Essential", "multiplier": 0.85 }] }
```

### Admin (JWT + `ADMIN`/`SUPER_ADMIN`, same guard pattern as the rest of the admin API)
- `GET/POST /api/v1/estimate/admin/modifiers`
- `PATCH/DELETE /api/v1/estimate/admin/modifiers/:id`

CRUD for `ServicePriceModifier` rows — same shape as the existing `TaxConfig` admin CRUD.
Service pricing fields themselves (`consultationFee`, `siteVisitFee`, etc.) are edited via
whatever the existing Service admin-update endpoint is — no new endpoint needed since they're
just new columns on a row that's already editable.

## Test results (real, executed — not claimed)

```
PASS src/modules/estimates/estimate-engine.spec.ts
  computePrice — pure math                                                  7 passed
  determineEligibility — pure, requirement #8 (never blocks the customer)   7 passed
  generateEstimate — orchestration (mocked prisma + citiesService)          8 passed

Test Suites: 1 passed, 1 total
Tests:       22 passed, 22 total
```

Then the **full existing backend suite** was run to confirm zero regressions from the schema
change and the new module registration:

```
Test Suites: 23 passed, 23 total
Tests:       208 passed, 208 total
```

Also verified, no DB involved in any of these:
- `npx prisma generate` — schema parses and generates correct TypeScript types.
- `npx tsc --noEmit` — the whole backend, including the new module, compiles with zero type errors.

### What the 22 tests actually prove
- **Pricing math**: FIXED / STARTING_FROM / PER_SQFT / QUOTATION all compute correctly,
  including a case that caught a real rounding edge (messy multiplier × price still rounds to
  exactly 2 decimals) and a case proving GST is charged on the LOW/headline figure, not the high one.
- **Eligibility**: every one of the digital-vs-onsite branches from your earlier business rule,
  re-verified here at the backend layer — digital is unconditionally eligible; onsite with no
  city asks for one; onsite in an unrecognized/inactive/vendor-less city returns the exact
  required message and reason code, never a block.
- **Orchestration caught a real bug before you ever saw it**: my first draft queried city data
  for digital services even though the result was discarded. The test asserting "digital never
  calls `getByName`" failed against that draft, I fixed the source (skip city resolution
  entirely when `serviceType === 'DIGITAL'`), and it now passes. That's the kind of thing this
  test suite is for.

## Open questions for you before I touch anything live

1. **Migration mechanism** — `prisma migrate deploy` (tracked history, what the Dockerfile
   already runs on every deploy) or `prisma db push` (matches what looks like the actual
   history of this schema so far, since no prior migrations exist)? I can do either, but the
   first migration establishing tracked history is a one-time decision worth you confirming.
2. **Existing services** — none of your current `Service` rows have `pricingType`/`serviceType`
   set beyond the defaults (`ONSITE` / `FIXED`) yet, since that data doesn't exist. Do you want
   me to also draft the admin-side data (which existing services are digital vs onsite, and
   their consultation/site-visit fees) as a seed/update script, or will that be entered through
   the admin panel by hand once it's live?
3. Nothing in the frontend calls this API yet — per your instruction, no UI was touched this
   round. Once you approve and this deploys, wiring `/interior`'s existing estimator UI to call
   `POST /api/v1/estimate` instead of its current client-side math is the natural next step.
