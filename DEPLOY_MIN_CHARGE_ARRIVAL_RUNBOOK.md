# Runbook — Minimum charge, arrival verification, post-arrival cancellation review

Status: **not deployed**. Nothing in this runbook may be run without explicit approval.

## Why there are two releases (rollback safety)

Code that is already deployed cannot be changed after the fact. The code live today (`4f9a5c9`):

- reads **every** active `CommissionRule` row as commission (its query has no `ruleType` filter), so a
  ₹199 *minimum-charge* rule would be applied as a ₹199 *commission* after a rollback; and
- fails to read any support case whose `issueType` is `CUSTOMER_REFUSED_SERVICE`
  (`Value 'CUSTOMER_REFUSED_SERVICE' not found in enum 'SupportIssueType'`), which breaks the admin
  support-case list.

Both were reproduced against a throwaway database (see the audit fix report). So the feature ships in
two steps, and a rollback of step 2 lands on step 1 — never on today's code:

| Step | Contents | Customer-visible change |
|---|---|---|
| **1 — rollback-safe base** | The full additive schema (+ migration) and two filters: commission resolution and the admin commission list read `ruleType = COMMISSION` only | None (no non-commission rules exist yet) |
| **2 — the feature** | Everything else on `feat/min-charge-arrival-review` | Yes |

Step 1 is exactly 4 files / 93 added lines (schema, migration, `common/index.ts` +3, `admin.module.ts` +2).

## Prerequisites before any deploy

1. **Railway health check (dashboard, backend service only):** Settings → Deploy → Healthcheck Path
   `/api/v1/health`. Do **not** add it to the repo-root `railway.json` — that file is shared with the
   ClamAV service, which has no HTTP endpoint and would then fail every deploy. With the health check,
   a failed start (see next item) leaves the previous deployment serving.
2. The backend start command now **fails closed** and **no longer uses `--accept-data-loss`**: if
   `prisma db push` fails — including when a change would drop or truncate data, which Prisma now
   refuses — the container exits non-zero instead of starting new code on an old schema. Verified on
   a throwaway database: this release applies cleanly without the flag (it is additive only).
3. Re-run the read-only schema diff immediately before deploying and confirm it is additive only:
   `prisma migrate diff --from-url <prod, read-only> --to-schema-datamodel backend/prisma/schema.prisma --script`.
   Expected: 2 `CREATE TYPE`, 1 `ALTER TYPE … ADD VALUE`, `ADD COLUMN`s, 2 `CREATE INDEX` — no `DROP`.

## Deploy order

1. Step 1 backend → verify `/api/v1/health`, checkout, commission preview unchanged.
2. Step 2 backend → verify; the website and app keep working (all new endpoints are additive).
3. Website (Vercel). 4. Partner App → Internal Testing only.
5. Only after sign-off: create minimum-charge / cancellation-charge rules (none exist; none created by this work).

## Rollback

- **Step 2 → step 1:** redeploy the step-1 commit. Safe with rules and new cases present: step 1
  ignores non-commission rules and its client knows every new enum value. Nothing to delete.
- **Step 1 → today's code** (only if step 1 itself must be undone): first deactivate non-commission
  rules and resolve `CUSTOMER_REFUSED_SERVICE` cases, or the two problems above return. Review-only SQL —
  **not executed**, requires approval:

  ```sql
  -- record what is switched off, so it can be restored
  SELECT id, "ruleType", value, "cityId", "categoryId", "serviceId" FROM "CommissionRule"
   WHERE "ruleType" <> 'COMMISSION' AND "isActive";
  UPDATE "CommissionRule" SET "isActive" = false WHERE "ruleType" <> 'COMMISSION' AND "isActive";
  ```
- New columns are never dropped on rollback; old code ignores them.

## Cancellation and refund workflow (approved rules)

- **Penalty after arrival** — CANCELLATION_CHARGE rules (Admin › Services › Commission tab, rule type
  "Cancellation penalty"), by service/category and city, with dates: flat ₹, or % of the service
  amount with an optional minimum; ₹0 or no rule = no penalty. Never more than the booking total.
  The customer sees the calculation before confirming. Before arrival: no penalty.
- **Start OTP shared** — self-service cancellation is closed; the customer is routed to a complaint
  (support case, "Issue During Service"). The completion OTP is untouched.
- **Admin decides** — cancel the booking, reassign, continue the service (No Refund without
  cancelling), or refund. On a cancellation request a refund is only possible with/after the
  cancellation. A request alone never moves money (the old automatic before-arrival refund is gone).
- **Refund states** — cancellation (case: booking cancelled), refund approval (the amount the admin
  submits), initiation + completion (the linked Refund Request: Requested → Completed, or Needs
  attention). Shown on the case. Refunds are wallet credits through the existing RefundsService.
- **Limits** — never more than actually received (gateway payment only once PAID, plus wallet), minus
  everything refunded or claimed on the booking by any route. Claims are taken under a per-booking
  database lock, so two cases (or two admins) cannot over-refund. A wallet credit is posted at most
  once per refund request, even on a retry.
- **Failure / reconciliation** — if a refund fails after it was raised, the case keeps its claim (fail
  closed) and points to Admin › Refunds. After completing or rejecting it there, use
  "Reconcile refund total" on the case.
- **Partner ledger** — support-case refunds never touch the partner automatically; a job that never
  completed is never clawed back. Partner compensation (credit) and recovery (debit, only up to what
  the partner was paid for a completed job) are separate, once-only, audited ledger entries.

## Refund financial safety (final)

- **One booking boundary for every refund route** (support cases, Admin › Refunds, returns/RTO,
  warranty, seller rejection): `RefundsService.decide()` takes a per-booking Postgres advisory lock
  (a child booking locks on its master order) and, in the same transaction, checks the amount against
  money actually received (captured gateway/cash payments + wallet used) minus everything committed
  by any route (completed refunds + outstanding reservations), then persists the reservation
  (`RefundRequest.claimedAmount`) before any money moves.
- **Wallet credits** are posted at most once per refund request (guard row `RefundWalletCredit`,
  unique, written in the same transaction as the credit).
- **Razorpay refunds**: one `ProviderRefund` per request with a stable internal id and idempotency
  key (`X-Refund-Idempotency`), reused with the identical amount on every retry. States: pending →
  **Refund pending**; processed → **Processed** (only now completed: credit note, REFUNDED flag,
  customer notified); failed or definitively rejected → **Refund failed** (gateway part of the
  reservation released); timeout / 5xx / 409 / unclassified → **Needs attention** (reservation kept).
  "Check with Razorpay" fetches by provider id, else by our receipt, else re-sends with the SAME key
  and amount — never a second refund. PhonePe (no status API wired): an admin records the verified outcome.
- **Webhooks**: signature verified first, then de-duplicated by `x-razorpay-event-id`
  (`PaymentWebhookEvent`); an event is marked processed only after its handling succeeded. Refund
  states are monotonic — duplicates and out-of-order events never re-finalise or roll back.
  **Prerequisite:** subscribe the Razorpay webhook to `refund.processed` and `refund.failed`
  (optionally `refund.created`) in the Razorpay dashboard.
- **Partner recovery is never automatic** on any path (warranty-hold and live-balance clawbacks
  removed). Admins record it explicitly (support case or Admin › Refunds) with a reason: one
  transaction (claim + ledger debit + audit), only for a completed job, never above what the partner
  earned on the booking across all recoveries, at most once per source.
- **COD / unpaid penalties**: the admin-approved penalty (≤ the configured rule) is recorded as
  retained (from money actually received) and **pending collection** (never charged, not revenue).
- **Schema push without the data-loss flag**: every new uniqueness guarantee sits on a NEW table, so a
  plain `prisma db push` applies this release (verified on a baseline database with existing rows).

## Open decisions / launch dependencies

1. **Collecting a pending COD penalty** — recorded as pending collection only; no collection flow exists.
2. **GST/tax on the cancellation penalty** — unchanged; a qualified CA must confirm the treatment and
   the penalty invoice / credit-note workflow before penalties are applied.
3. **Partner recovery — legal basis**: confirm the partner agreement permits deductions for refunds
   on completed jobs before admins use the recovery action.
4. **Customer terms**: disclose the cancellation penalty in the published cancellation policy
   (Legal & Policies CMS) before activating penalty rules.
5. Penalty/minimum amounts per service and city — none exist; none were created by this work.
6. Rollback note: if step 2 is rolled back to step 1, the step-1 (old) refund code still
   auto-recovers from partners on new refunds — pause refund decisions until step 2 is redeployed.
