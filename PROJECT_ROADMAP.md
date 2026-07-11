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

**Explicitly out of scope for Phase 1** (do not build without new instruction):
- Seller KYC documents (PAN/Aadhar/bank/cancelled cheque/trade license/MSME)
- Public seller self-registration
- Bulk CSV/Excel product upload
- Seller commission/wallet/ledger/settlement automation (commission is admin-set manually for now, not computed)
- Multi-warehouse, third-party courier integration, AWB/RTO
- AI product description generation, fuzzy/voice/image search
- Service+product bundling engine

---

## Phase 2+ — Deferred until Phase 1 is stable and the business signals readiness

See the full enterprise audit artifact for reference when this is revisited:
`https://claude.ai/code/artifact/8b336c01-750f-456c-b6eb-3c7ce6a6332e`

Rough shape (not committed, not scheduled):
1. Seller KYC + commission/settlement automation, once seller count grows past what manual admin management can handle.
2. Bulk catalog tooling, once single-product entry becomes a bottleneck.
3. Real AI product enrichment (currently a rule-based stub in `products.module.ts`).
4. Multi-city expansion (schema already supports this — activate more `City` rows).
5. Logistics/courier integration, once order volume outgrows in-house delivery capacity.

---

## Change log of this roadmap

- **2026-07-11**: Phase 1 defined (this document created). Superseded the enterprise 9-phase draft per explicit user instruction: "do not implement enterprise features that are not required for the current business stage."
