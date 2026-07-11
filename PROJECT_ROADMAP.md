# PROJECT_ROADMAP.md — Remont India

## Operating principle

Build in modular phases, scoped to the current business stage. Do not implement
enterprise features not required for the current phase. Design the database so
future modules can be added without redesign — but implement only what's required now.

A full enterprise multi-vendor marketplace roadmap (Amazon/Flipkart/Urban-Company
scale — seller KYC, bulk catalog tooling, courier aggregators, AI search, etc.) was
audited and drafted on 2026-07-11, then **explicitly deferred** in favor of the lean
plan below. That audit's *findings* remain valid reference; its *sequencing* was
rejected. Do not resume it without explicit instruction.

---

## Phase 0 — Foundations (done, pre-existing)

Service booking, dispatch, vendor app, admin panel (36 pages), city-scoping schema,
product catalog + mixed service/product checkout. All confirmed working via direct
code audit — see `CLAUDE_CONTEXT.md` §6–7.

**Status: ✔ Complete** (this is the platform as it existed before this phase's work began)

---

## Phase 1 — Single-City Service + Product Marketplace MVP (current phase)

**Goal:** stable launch in one city, hybrid seller model (Remont-direct + a small
number of admin-onboarded local sellers).

| Module | Status | Notes |
|---|---|---|
| Admin-managed Product Sellers | ✔ Done | Admin creates seller accounts directly (phone + OTP login, no password system). No public registration. Verified live 2026-07-11. |
| Lightweight Seller Portal (`seller.html`) | ✔ Done | Login, own-products CRUD (reuses existing `/products` endpoints), orders visibility. Verified live 2026-07-11. |
| Seller Orders Management | ✔ Done | Seller sees only orders containing their own products, enforced at query layer. Verified live 2026-07-11. |
| Mobile catalog real-service browsing | ✔ Done | Fixed 2026-07-11 — see `CHANGELOG.md`. |
| Automatic order dispatch (service side) | ✔ Done | Vendor skill-vocabulary bug fixed 2026-07-11. |
| Dynamic City Activation Management | ✔ Done | Bulk/all/stats endpoints, admin dashboard, order-creation enforcement fix. Verified live 2026-07-11. Business still needs to actually pick a launch city and deactivate the rest via this tooling — see `TODO.md`. |
| Dynamic Product Coverage System | ✔ Done | Pan India / Selected Cities / Store Pickup / Zones (schema-ready). Verified live 2026-07-11 — 6 scenarios including priority ordering and edit-replace semantics. |
| Proper seller form + attractive dashboard | ✔ Done | Address/pickup-address fields, edit support, sales banner, order-status tiles. Verified live 2026-07-11. |
| **Fix: vendor.html/seller.html OTP login broken** | ✔ Done | Pre-existing bug, not caught until this session finally browser-tested the actual login UI instead of only the API. See `CHANGELOG.md`. |

**Explicitly still out of scope** (do not build without new instruction):
- Bulk CSV/Excel product upload
- Multi-warehouse *routing logic* beyond what Phase 2 below covers (courier-aggregator integration, AWB/RTO with a real carrier)
- AI product description generation, fuzzy/voice/image search
- Service+product bundling engine

**Reversed 2026-07-11** (moved from "out of scope" to Phase 2, explicit instruction — see `feedback_remont_scope_discipline.md` memory): seller KYC documents, public seller self-registration, seller commission/wallet/settlement automation. These are no longer deferred.

---

## Phase 2 — Enterprise Seller Module (multi-vendor marketplace) — IN PROGRESS

Started 2026-07-11. Explicit instruction: build one module at a time, test and
commit each before starting the next, don't change existing UI/UX, no fabricated
external-API integrations (GST verification / Google Maps / email — none are
configured; see `feedback_remont_scope_discipline.md`).

| # | Module | Status | Notes |
|---|---|---|---|
| 1 | Public Seller Registration + Admin Approval | ✔ Done | Mirrors `PartnerRegistration` pattern exactly. Verified live 2026-07-11 — see `CHANGELOG.md`. |
| 2 | Location-Based Inventory | ⏳ Next | Per-`PickupLocation` stock; nearest-location/fastest-delivery/lowest-cost order routing. `PickupLocation` entity already exists from Module 1. |
| 3 | Seller Dashboard (full) | Not started | Pending/Confirmed/Packed/Ready-for-Pickup/Shipped/Delivered/Cancelled/Returned/Replacement order buckets, wallet, settlement, inventory, analytics, reports, notifications, support tickets. Builds on the existing lightweight dashboard from Phase 1. |
| 4 | Product Management (full) | Not started | Variants, per-location stock assignment, HSN/GST management UI (fields mostly already exist on `Product`). |
| 5 | Order Management actions | Not started | Accept/Reject order, print invoice, generate shipping label, ready-to-ship, track. |
| 6 | Returns / Replacement / Refund | Not started | No return/replacement concept exists in the `Order` model yet beyond `CANCELLED`/`REFUNDED` statuses — needs real schema design. |
| 7 | Wallet & Settlement | Not started | Commission computation, pending/paid amounts, transaction history. Currently commission is admin-set manually, not computed. |
| 8 | Reports | Not started | Sales/orders/returns/profit/taxes/top-products/warehouse-wise/location-wise. |
| 9 | Notifications | Partial | WhatsApp works (MSG91). SMS/Email/Push have no provider configured — will stay WhatsApp-only unless the user supplies credentials. |

**Explicitly not fabricated, by confirmed decision:**
- GST auto-fetch/verification — manual entry only, no provider.
- Google Maps (interactive picker) — Leaflet + OpenStreetMap instead (free, keyless), already built into Module 1's pickup-location step.
- Email/SMS sending — WhatsApp only.

For historical reference, the original 9-phase enterprise-scale audit (broader than
this seller-module rebuild — covers products/AI/logistics/SEO too) is at:
`https://claude.ai/code/artifact/8b336c01-750f-456c-b6eb-3c7ce6a6332e`

---

## Change log of this roadmap

- **2026-07-11**: Phase 1 defined (this document created). Superseded the enterprise 9-phase draft per explicit user instruction: "do not implement enterprise features that are not required for the current business stage."
- **2026-07-11 (later same day)**: Phase 2 (Enterprise Seller Module) opened per explicit instruction, reversing the "admin-only seller, no public registration" decision from Phase 1. Module 1 (Public Registration + Approval) completed and verified live the same day.
