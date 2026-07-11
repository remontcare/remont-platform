# CLAUDE_CONTEXT.md — Remont India

> Read this file, `PROJECT_PROGRESS.md`, and `TODO.md` before touching any module.
> This file documents current architecture, business rules, and conventions.
> `PROJECT_PROGRESS.md` tracks what's done/next. `CHANGELOG.md` is the append-only history.
> This supersedes `CLAUDE_PROJECT_CONTEXT.md` (2026-06-18, stale) for current architecture facts —
> that file is kept for historical deployment-recovery reference only.

---

## 1. What Remont India is (current phase)

A home & property services marketplace launching in **one city first** (Phase 1,
done), now building an **enterprise-grade multi-vendor marketplace seller module**
(Phase 2, in progress — started 2026-07-11, ~1 of ~9 modules done):
- Remont sells products directly (admin-managed catalog — already fully supported, `Product.vendorId` is nullable).
- Sellers **self-register publicly** via a 7-step wizard (`seller-register.html`) and land in `PENDING` status; Admin reviews and Approves/Rejects/Holds/Requests-more-info before login is possible.
- Admin can *also* still create a seller account directly (the Phase-1 shortcut) — both paths converge on the same `ProductVendor` entity.
- Once approved, a seller manages only their own products, pickup locations, stock, pricing, orders.

**Public registration was previously disabled, then explicitly reversed 2026-07-11** —
see `feedback_remont_scope_discipline.md` memory for the full reasoning. Building
module-by-module per explicit instruction: each module tested live and committed
before the next starts. See `PROJECT_ROADMAP.md` Phase 2 for the module list/status.

---

## 2. Tech stack (real, not aspirational)

| Layer | Technology |
|---|---|
| Backend | NestJS 10 + Prisma 5 → PostgreSQL, hosted on Railway |
| Frontend | Static HTML + vanilla JS — **no framework, no bundler, no SSR** |
| Frontend hosting | Vercel (`outputDirectory: frontend`, `/api/*` rewritten to Railway) |
| Auth | Phone OTP (WhatsApp via MSG91) → JWT access + refresh, `passport-jwt` |
| Payments | Razorpay |
| AI | OpenAI, behind `AI_PROVIDER` env var; shared client at `backend/src/modules/ai-agent/openai-client.ts` |
| Global API prefix | `/api/v1` |

Do **not** introduce Next.js, React, or Supabase — that would force a full frontend rewrite and violates the standing "don't change current UI" rule.

---

## 3. Folder structure

```
backend/
  prisma/schema.prisma          — single schema file, all models
  prisma/*.js                   — one-off backfill/migration scripts (run manually against prod)
  src/modules/<name>/<name>.module.ts   — single-file-per-domain: DTOs → @Injectable() service → @Controller() → @Module()
  src/common/index.ts           — shared guards, decorators, utils (JwtAuthGuard, RolesGuard, Roles, CurrentUser, slugify, haversineKm, normalizeSkillKey, ...)

frontend/
  index.html                    — main customer site (desktop + mobile, one file)
  vendor.html                   — service-vendor app shell (login, jobs, earnings)
  seller.html                   — product-seller portal (login, products, orders, dashboard)
  seller-register.html          — NEW: public 7-step seller application wizard (Leaflet/OSM maps, no Google Maps key)
  partner-register.html         — service-vendor onboarding wizard (the proven pattern seller-register.html mirrors)
  admin/*.html                  — admin panel, one file per page, shared admin/common.js + admin/style.css
```

---

## 4. Backend module pattern (follow exactly)

Every domain is ONE file: `backend/src/modules/<name>/<name>.module.ts` containing, in order:
1. DTOs (`class-validator` decorators)
2. `@Injectable() class XService` — business logic, talks to `PrismaService` directly
3. `@Controller('<route>') class XController` — thin, delegates to service
4. `@Module({...}) class XModule`

No separate controller/service/dto files. Do not split an existing module into multiple files.

---

## 5. Auth & roles

`UserRole` enum: `CUSTOMER · SERVICE_VENDOR · PRODUCT_VENDOR · DELIVERY_PARTNER · CORPORATE_USER · CRM_AGENT · ADMIN · SUPER_ADMIN`

- Single `User` table, phone is the identity. Login is always `POST /auth/send-otp` → `POST /auth/verify-otp`, same flow for every role — **no separate password system for sellers or vendors.**
- A `User` row can be created directly with a target role (e.g. by an admin endpoint doing `prisma.user.upsert({ where: { phone }, create: { role: 'PRODUCT_VENDOR', isVerified: true, ... } })`) and that person can log in immediately via the standard OTP flow — no extra auth plumbing needed. This is how admin-created sellers log in.
- `AuthService.verifyOtp()` has a narrow self-elevation path (`ELEVATABLE_ROLES`) that only lets a `CUSTOMER` upgrade themselves to `SERVICE_VENDOR`/`PRODUCT_VENDOR` — **never** touches `ADMIN`/`SUPER_ADMIN`, never downgrades. Do not widen this without explicit instruction (a prior incident had this logic accidentally demoting an admin — see `PROJECT_PROGRESS.md` history).
- **Public seller self-registration is live** (`seller-register.html` → `seller-registration.module.ts`). Critical nuance: `verify-otp` during registration DOES set `role: PRODUCT_VENDOR` immediately (mirrors `partner-registration`'s exact pattern) — but that alone grants **no** dashboard access, because `GET /vendors/product/me` 404s until a real `ProductVendor` row exists, and that row is only created by `_activateSeller()` on admin APPROVED. The actual security boundary is profile-row existence, not the role value — don't "fix" the role-timing without understanding this, it's intentional and proven (same mechanism as service-vendor partner registration).

---

## 6. Database structure — key models

Full source of truth: `backend/prisma/schema.prisma` (44+ models). Highlights relevant to current phase:

- **`City` / `CityService` / `CityProduct`** — per-city activation, stock override, custom price, price multiplier. Already supports multi-city; launching in one city means activating exactly one `City` row and leaving others `isActive: false`. **No schema change needed to expand cities later.**
- **`Product`** — `vendorId String?` (nullable → admin-owned when null; in practice all current products are attributed to a "Remont Direct" seller account rather than actually null), `categoryId`, price/mrp/stock, images, SEO fields (unpopulated placeholders for now), `isActive`, `coverageType` (`PAN_INDIA` default / `SELECTED_CITIES` / `STORE_PICKUP` / `ZONES`-schema-only) — see §8 for the coverage business rules.
- **`ProductZone`** — pincode/areaName per product. Schema exists for future zone-level coverage; nothing reads it yet (`ZONES` coverage type currently falls back to city-level `CityProduct` matching).
- **`ProductVendor`** — now the full KYC/bank profile: identity (ownerName, businessType, gstNumber, panNumber, aadhaarNumber, cin, msmeNumber), contact (alternatePhone, whatsappNumber, email), address (address/officeAddress/warehouseAddress — `pickupAddress` is a **legacy field**, superseded by `PickupLocation`, do not write to it from new code), bank (bankAccountHolder/bankName/bankAccountNumber/bankIfsc/bankBranch/upiId), `status (VendorStatus)`, `rating`.
- **`PickupLocation`** — one seller can have multiple; each has its own lat/lng, address fields, `isPrimary` flag (enforced at the application layer, not a DB constraint). Created from `SellerRegistrationPickup` drafts on approval. No per-location stock yet — that's Phase 2 Module 2.
- **`SellerDocument`** — mirrors the older `VendorDocument` (service-vendor) pattern; one row per uploaded document type per seller.
- **`SellerRegistration` / `SellerRegistrationPickup`** — the draft public application, mirrors `PartnerRegistration` exactly (`status`: PENDING/APPROVED/REJECTED/HOLD/MORE_INFO). **Note:** `status` defaults to `"PENDING"` at record creation (before `submit()` is ever called) — an abandoned draft looks identical to a genuinely-submitted one in the admin queue. This is inherited from `PartnerRegistration`'s identical pre-existing behavior, not a new bug — don't "fix" only the seller side without revisiting the service-vendor side too.
- **`Order` / `OrderItem`** — one `Order` can carry both a service booking (`serviceId`) and product line items (`items: OrderItem[]`) in the same checkout. This already works end-to-end (`orders.module.ts`).
- **`VendorStatus` enum**: `PENDING_VERIFICATION · ACTIVE · SUSPENDED · REJECTED`.

**Rule for this phase:** all schema changes are additive only — new nullable columns or new tables. Never a destructive migration on a live table. Migrations are applied via `npx prisma db push` (no migration files in this repo) — always additive-safe by construction, but still reason about it explicitly before running against the production `DATABASE_URL`.

---

## 7. APIs — current + this-phase additions

Full historical route list: `CLAUDE_PROJECT_CONTEXT.md` (stale but broadly accurate for pre-existing routes). New routes added this phase are logged in `CHANGELOG.md` as they land — check there for the authoritative current list rather than duplicating it here.

Key existing routes this phase builds on:
```
POST  /products                    [JWT + PRODUCT_VENDOR]  — seller creates own product
PATCH /products/:id                [JWT + PRODUCT_VENDOR]  — seller updates own product (ownership-checked)
GET   /products/vendor/mine        [JWT + PRODUCT_VENDOR]  — seller's product list
GET   /vendors/product/me/dashboard [JWT + PRODUCT_VENDOR]  — todayRevenue/monthRevenue/totalRevenue + products/orders/lowStock
GET   /vendors/product/me/orders    [JWT + PRODUCT_VENDOR]  — orders containing this seller's products only
```

Seller registration (Phase 2 Module 1):
```
POST /seller-registration/init | save-step | pickup-locations | submit    [Public]
GET  /seller-registration/status | draft/:id | pickup-locations/:id       [Public]
GET  /admin/seller-registrations | /:id                                    [ADMIN]
PATCH /admin/seller-registrations/:id/status                               [ADMIN]
```

---

## 8. Business rules (never violate without explicit new instruction)

1. Remont is the primary seller — admin-managed catalog always works with zero seller involvement.
2. **Sellers can self-register publicly** (`seller-register.html`), and land in `PENDING` until admin approves. Admin can also still create a seller account directly. Either way, a seller **cannot log in / reach a dashboard until `ProductVendor.status = ACTIVE`** — see §5's role-vs-profile-row nuance.
3. Every seller manages only their own products, stock, pricing, and can only see orders containing their own products — enforced at the query layer (`vendorId` scoping), not just UI-hidden.
4. Admin controls commissions (mechanism deferred until needed — not built yet, see roadmap Phase 2 Module 7).
5. **Customer-facing UI (`index.html`) must remain visually unchanged** unless a task explicitly calls for a customer-facing change.
6. Existing functionality must never break — verify against real data before considering a task done (this repo's established pattern: headless-browser smoke test against local-serving-real-API or live site, not just typecheck).
7. **The Enterprise Seller Module (Phase 2) is an explicit, deliberate exception to "lean MVP only"** — build it module-by-module, each tested live and committed before the next. Everything *outside* the seller module still follows the lean-MVP discipline (see `PROJECT_ROADMAP.md`'s guardrails). Don't use Phase 2's scope as license to over-build elsewhere.
8. **Product coverage**: Pan India products must appear automatically in any city activated later — no manual per-city update, ever (enforced by the filtering *rule*, not by writing rows: a Pan India product with zero `CityProduct` rows is eligible everywhere by default). Selected-Cities/Store-Pickup products are opt-in and only show where explicitly assigned. One product row serves every city it's eligible in — never duplicate a product to cover multiple cities.
9. **No fabricated external integrations.** GST verification, Google Maps, email/SMS sending — none are configured (no provider/API key). Manual entry / Leaflet+OpenStreetMap / WhatsApp-only are the confirmed real substitutes. Do not build a UI that implies a live external integration exists when it doesn't.

---

## 9. Coding conventions

- Frontend: vanilla JS, `var`-based (not `let`/`const` blocks that assume module scoping — matches existing files), inline `<script>`, no build step. Syntax-check any edited `<script>` block with `node -e "new Function(scriptText)"` before considering it done.
- Shared frontend API helper patterns: `admin/common.js` (`api()`, `toast()`, `renderSidebar()`, `requireAuth()`) for admin pages; each app-shell file (`vendor.html`, `seller.html`) has its own local `apiFetch()` following the same shape.
- Backend: reuse `backend/src/common/index.ts` guards/decorators (`JwtAuthGuard`, `RolesGuard`, `@Roles(...)`, `@CurrentUser()`, `@Public()`) — never hand-roll auth checks.
- Verify backend changes with `cd backend && npx tsc --noEmit -p .` before considering a task done.
- Git: small logical commits, one per completed module, `type(scope): summary` messages (e.g. `feat(seller): admin-managed product seller accounts`), `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.

---

## 10. Things that should NEVER be changed without explicit instruction

- Customer-facing UI layout, color theme, or design language in `index.html`.
- The `ELEVATABLE_ROLES` self-elevation guard in `auth.module.ts` (security-sensitive — see §5).
- The `DispatchService` service-vendor matching logic in `orders.module.ts` (working, verified this session).
- The single-file-per-module backend pattern — do not split modules into separate controller/service/dto files.
- Do not switch the frontend to a framework (Next.js/React) or the backend off Prisma/PostgreSQL.
