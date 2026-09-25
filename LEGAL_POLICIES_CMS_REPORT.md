# Legal & Policies CMS — Implementation Report

**Date:** 25 Sep 2026 · **Status:** implemented, Privacy Policy reviewed against the code (second pass), tested and committed. Policies are seeded as drafts; nothing is published automatically.

Structure: **Legal & Policies → 12 main policy documents → sections (sub-policies) → versions.** There are no per-section top-level policies and no per-section public URLs.

---

## 1. Main policy documents (seeded as v0.1 drafts, none published)

| # | Policy | Slug (admin) | Public route | Sections |
|---|---|---|---|---|
| 1 | Privacy Policy | `privacy-policy` | `/privacy` | 24 |
| 2 | Terms & Conditions | `terms-and-conditions` | `/terms` | 22 |
| 3 | Customer Policy | `customer-policy` | `/customer-policy` | 13 |
| 4 | Partner Policy | `partner-policy` | `/partner-policy` | 18 |
| 5 | Seller Policy | `seller-policy` | `/seller-policy` | 19 |
| 6 | Refund & Cancellation Policy | `refund-cancellation-policy` | `/refund-policy` | 12 |
| 7 | Payment Policy | `payment-policy` | `/payment-policy` | 10 |
| 8 | Service Policy | `service-policy` | `/service-policy` | 13 |
| 9 | Marketplace Policy | `marketplace-policy` | `/marketplace-policy` | 14 |
| 10 | Grievance & Legal Policy | `grievance-legal-policy` | `/grievance-policy` | 11 |
| 11 | Cookie & Technology Policy | `cookie-technology-policy` | `/cookie-policy` | 8 |
| 12 | AI & Communication Policy | `ai-communication-policy` | `/ai-policy` | 10 |

Admins can also create custom policies. Each one starts as a v0.1 draft with recommended sections and is served at `/policy/<slug>`.

## 2. Section hierarchy
The section lists follow the brief. Terms has two extra sections: "Limitation of Liability" (carried over from the current live Terms) and "Changes to These Terms". Privacy covers WhatsApp, Messenger, Instagram, Meta Business, Pages and professional accounts. It also covers the processing of messages, sender info, conversation metadata, account and business-asset identifiers and integration tokens, and it has the AI disclosure (answer questions, service info, collect enquiry details, qualify leads, create/update CRM leads, human handoff).

The templates live in `backend/src/modules/legal/legal.templates.ts`. They describe only behaviour the code actually has:
- Refunds are reviewed manually and default to wallet credit.
- Job start and finish are confirmed with an OTP.
- Warranty is set per service category and covers workmanship only.
- Partner withdrawals need admin approval.
- For returns, the seller recommends and admin decides.
- The site uses no analytics or ad trackers.
- Maps are OpenStreetMap, plus Google Maps links for directions only.

## 2a. Second-pass corrections (privacy review)
- **Privacy Policy** rewritten against the code (24 sections, **no [[placeholders]]**):
  - Platform role: technology and service-facilitation platform; partners are not employees.
  - Verification status covers only the checks Remont actually carries out. No Aadhaar, police or criminal checks are claimed; partners may upload a police certificate.
  - Newly disclosed: PhonePe (alongside Razorpay), CRM leads including UTM tags, Google Fonts, seller Aadhaar/PAN/GST documents, partner PAN/photo/police certificate/emergency contact, and stored website AI chat sessions.
  - Meta: covers messages, sender info, conversation metadata, webhook events, business-asset identifiers and CRM leads, and states it receives nothing beyond what Meta's APIs provide.
  - AI: covers errors, "not a human and not a technician", conversation summaries and human handoff.
  - Rights: DPDP-style rights, including the Data Protection Board route.
  - **Deletion is contact-based via remont.care@gmail.com**, because self-service account deletion does not exist in the code.
  - Children: under 18, verifiable consent of a parent or lawful guardian, and no tracking or targeted ads.
  - Added an unlawful-activity section and the non-exclusion-of-liability clause.
- **Terms:** the blanket order-value liability cap was removed. There is now "Responsibility and Liability" (a [[placeholder]] for any cap, to be settled with counsel) plus the non-exclusion clause, a verification-status section and an unlawful-activity section. The same wording was added to Marketplace, Partner and Service.
- **GSTIN:** the placeholder `27AABCT1234L1Z5` was removed from the footers of index, about, contact, careers and interior, and from terms.html. GSTIN is now the Legal Information field `{{GSTIN}}`, left empty and used only in the Grievance & Legal "Company Information" section.
- **Static pages** (the current live fallback): "background-verified" and "30-day warranty" claims were removed from terms, privacy, shipping and refund. Children and liability wording was updated.
- **Publishing safety:** if an active section uses a critical Legal Information field (legal name, address, support email, privacy email, grievance officer, grievance email, GSTIN) that isn't set, publishing is **blocked with no override**. [[Placeholders]] and optional gaps only require confirmation. Privacy can be published as soon as legal name, address, grievance officer and grievance email are filled in.
- New Legal Information fields: `PRIVACY_EMAIL` (pre-filled with remont.care@gmail.com) and `GSTIN` (empty).
- Not changed: marketing copy on `index.html` (4 places) and `about.html` still says "background verified". It's outside the policy documents; review it separately.

## 3. Database migration
`backend/prisma/migrations/20260925000000_add_legal_policies_cms/migration.sql` is **additive only**: 4 new tables and 2 new enums, with no changes to existing tables.
- `LegalPolicy` — slug, publicPath, policyType, category, title, status, currentVersionId/currentVersion, effectiveDate, publishedAt/By, createdBy, SEO title/description, showInFooter, sortOrder
- `LegalPolicyVersion` — version label (major/minor), status, effectiveDate, changeNote, restoredFromVersionId, created/published by/at, archivedAt
- `LegalPolicySection` — title, slug, content (sanitised HTML), sortOrder, isActive
- `PolicyAcceptance` — policyId, versionId, version, userId?, subjectType/subjectId, ip, userAgent, acceptedAt

Verified on a throwaway local PostgreSQL 17 database: the pre-change schema plus this SQL gives exactly the new Prisma schema (`prisma migrate diff` reports "No difference detected"). The production database was never touched.

## 4. Backend APIs (`backend/src/modules/legal/`)
**Admin (ADMIN / SUPER_ADMIN), `/api/v1/admin/legal`:**
`GET|POST policies` · `POST policies/ensure-defaults` · `GET|PATCH policies/:id` · `POST policies/:id/{draft,publish,unpublish,archive,unarchive}` · `GET policies/:id/{audit,acceptances}` · `GET|PATCH versions/:id` · `GET versions/:id/preview` · `POST versions/:id/{sections,reorder,restore,discard}` · `PATCH|DELETE sections/:id` · `POST sections/:id/duplicate` · `GET|PUT legal-info`

**Public, `/api/v1/legal`:** `GET policies` (published only, used by the footer) · `GET policies/:key` (key = public path or slug). Authenticated: `POST accept` · `GET acceptances/me`.

## 5. Admin routes
- `/admin/settings/legal-policies` — cards with search and All / Published / Draft / Unpublished / Archived filters; each card has Edit, Preview and Versions buttons
- `/admin/settings/legal-policies/<slug>` — the policy editor. Sections can be added, edited (rich text, HTML source view, variable insertion), duplicated, deleted, reordered (drag or up/down buttons) and enabled/disabled. Also: draft details, settings/SEO, publish/unpublish/archive, and a Versions / Audit Log / Acceptances dialog
- `/admin/settings/legal-information` — values for the policy variables

Added to the sidebar under Settings → "Legal & Policies". Vercel rewrites map these URLs to `admin/legal-policies.html`.

## 6. Public routes
`/privacy /terms /customer-policy /partner-policy /seller-policy /refund-policy /payment-policy /service-policy /marketplace-policy /grievance-policy /cookie-policy /ai-policy`, plus `/policy/:slug`. `/cancellation-policy` redirects to `/refund-policy`.

These are static HTML pages that `shared/legal-page.js` fills with the published version. `/privacy`, `/terms` and `/refund-policy` **keep their current static text until you publish a CMS version**, so nothing live changes when this deploys. The new routes show "being prepared" (with `noindex`) until they are published.

## 7. Versioning
- Only DRAFT versions can be edited; the server rejects any edit to a published version.
- There is at most one draft and one published version per policy.
- The first publish of a v0.x draft becomes v1.0. Editing v1.0 creates draft v1.1. Publishing v1.1 archives v1.0.
- Restoring v1.0 creates a new draft (e.g. v1.2) with v1.0's content; it goes live only when published.
- Nothing is ever hard-deleted: a discarded draft is archived.

Publishing checks for unfilled `[[placeholders]]` and unset variables and requires explicit confirmation if any remain.

## 8. Audit logs
Uses the existing `AuditLog` / `logAudit` with `targetType = "LegalPolicy"`. It records create/update, draft created, section add/update/enable/disable/delete/reorder, publish (including anything published with unfilled placeholders), unpublish, archive/unarchive, restore, draft discarded, and Legal Information changes.

## 9. Policy acceptance
- **Partner registration submit** records acceptance of the Terms, Privacy and Partner policies that are published at that moment.
- **Seller registration submit** does the same with Terms, Privacy and Seller.
- The recording is a no-op for unpublished policies and can never block a submission.
- `POST /legal/accept` is available for future customer flows. It is idempotent and returns 409 if the version is stale.
- Customers are not forced to accept anything. Admins see acceptance counts per version.

## 10. Security
- RBAC uses the existing `JwtAuthGuard` + `RolesGuard` (ADMIN, SUPER_ADMIN). Customers and CRM agents get 403.
- Section HTML is sanitised against an allow-list **when saved and again when rendered publicly**. It strips script/style/iframe/svg/object, every `on*` handler, style/class attributes, and `javascript:`/`data:`/`vbscript:` links (including entity-encoded forms).
- Variable values are HTML-escaped. Public page titles are set as text, never as HTML.
- Admin pages get `noindex` from both a meta tag and an `X-Robots-Tag` header; `/admin` is already disallowed in robots.txt.
- Tenant isolation: **not applicable**. This codebase is single-tenant (no tenant model), so there is no `tenant_id`.

## 11. SEO
- Every public page has a title, description, canonical, Open Graph tags and JSON-LD breadcrumbs, and the published SEO title/description are applied.
- `/privacy`, `/terms` and `/refund-policy` were added to `sitemap.xml`.
- The footer (homepage and policy pages) adds links to published policies marked "show in footer".
- Limitation: content on the new routes is rendered client-side. Google renders JavaScript, but some crawlers do not. `/privacy` always has full static text.

## 12. Tests
- `legal.sanitize.spec.ts` + `legal.module.spec.ts`: **48 tests** (incl. publishing-safety: critical-field block, GSTIN, placeholder confirmation) — XSS payloads, hierarchy, seeding idempotency, publish/unpublish/archive, versioning and restore, section CRUD and reorder, variables, acceptance, RBAC metadata, and templates free of unverified compliance claims.
- Full backend suite: **111 suites / 1106 tests, all passing.**
- HTTP end-to-end against real Postgres: **54/54 passed** (RBAC 401/403, CRUD, XSS, publish flow, public rendering without login, versioning 1.0 → 1.1 → restore 1.2, acceptance, audit).
- Headless Chrome:
  - Public pages render; unpublished pages fall back correctly.
  - The footer shows only published policies.
  - At 390px there is no horizontal overflow on the public pages or the admin pages.
  - The admin editor flow works: edit → save (injected script stripped) → preview → publish confirmation → live.

## 13. Build
`npm run build` (tsc) passes. `prisma validate` passes, and the Prisma client was regenerated locally.

## 14. Deployment
On push to main:
- Railway runs `prisma migrate deploy` on start. At boot it seeds the 12 drafts; this happens once, is idempotent and never publishes anything.
- Vercel picks up the new pages and rewrites.

## 15. Production URLs (after deploy + publish)
`https://www.remontindia.com/privacy` (works today with the existing static text, no login) and the other routes listed in §6. Admin: `https://www.remontindia.com/admin/settings/legal-policies`.

## 16. Environment changes
None required. `LEGAL_SKIP_SEED=true` is available (optional) to turn off seeding at boot.

## 17. Remaining manual actions
1. Review, commit and deploy.
2. Fill in Settings → Legal Information.
3. Resolve the `[[placeholders]]`, have a lawyer review each policy, then publish.
4. After publishing, add the newly published routes to `sitemap.xml`.
5. Update the Meta app's privacy-policy / data-deletion URL settings if needed.
6. The existing migration history cannot be replayed onto an empty database (an early migration references enum `LeadSource` before it exists). This was already the case before this change, and it does not affect `migrate deploy` in production.

## 18. Business/legal information still needed from the admin
- Registered legal entity name, registered address, grievance officer name/designation and grievance email
- Confirmed support phone/email. The fallback `support_email` / `support_phone` defaults look like placeholders (`+91 98765 43210`)
- **The footer and Terms show GSTIN `27AABCT1234L1Z5`. This looks like a placeholder (state code 27 is Maharashtra, while the business is in MP). Verify it before relying on it**
- Commission rates, payout and settlement cycles, penalties, incentives, and partner/customer no-show rules
- Rescheduling and cancellation charges, the product return window, replacement rules and the dispatch SLA
- The gateway refund timeline to state, and the retention period for chat history
- Response time for data requests, and the jurisdiction (the current site says Madhya Pradesh)
- Which Meta channels are actually connected (WhatsApp / Messenger / Instagram)
- AMC terms, emergency service terms, and any extra prohibited categories
