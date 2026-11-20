# Payment Workflow Rebuild — Final Report

**Date:** 2026-07-27
**Scope:** Full rebuild of the Remont India platform's payment lifecycle — booking, COD/Online collection, balance/extra-work collection, refunds, partner settlement, admin reporting, and customer/partner notifications.
**Status: All 7 planned phases complete and merged to `main`.**

---

## Why this rebuild happened

An audit of the pre-existing payment system found it was built almost entirely around the **happy path of an immediate, fully-paid online booking**, with no support for the business's actual required flows:

- `PaymentTransaction.orderId` was a loose string doubling as an Order id, a MasterOrder id, or a `'WALLET_TOPUP'` sentinel — no referential integrity.
- The main booking modal's Online/COD choice was **silently ignored server-side** — every booking auto-confirmed regardless of what the customer picked, meaning a customer choosing "Pay Online" was never actually charged.
- COD orders had **no way to ever leave `paymentStatus: PENDING`** — no collection step existed anywhere.
- No refund model or approval workflow existed; `AdminService.refundOrder()` was a pure status-flag flip with no evidence, no partner input, and no money ever actually moving.
- No partner-settlement backend existed despite the admin UI already expecting one (dead "Withdraw" button, no `onclick`).
- The vendor app's "Collect Payment" step at job completion was an explicit labeled stub — captured a method selection but sent it nowhere.
- `WhatsappService.sendPaymentReceived()` was fully templated but never called; `NotificationsService.create()` was never called anywhere in the codebase — the in-app notification bell could never populate.
- Three admin pages (`partner-earnings.html`, `payments.html`, `wallet.html`) called endpoints that didn't exist or referenced enum values that didn't exist, so their filters/actions silently no-op'd or returned empty.
- The same GST invoice-math was copy-pasted verbatim across three modules, and invoice generation had **no ownership check** — any authenticated user could generate and read another customer's GST invoice by guessing an order id.

The rebuild was staged across 7 phases so each layer (schema → flow → collection → customer visibility → refunds → reporting → notifications) built on a verified previous one.

---

## Phase-by-phase summary

| Phase | Focus | Key deliverables |
|---|---|---|
| 1 | Schema, wallet, ledger backbone | New enums (`INITIATED`/`CANCELLED` statuses, `PaymentCollectionMode`, `OrderPaymentMethod`, `RefundRequestStatus`, `RefundDecisionMode`, `SettlementMode`); `RefundRequest`/`RefundRequestLog` models; `PartnerSettlement` model + `SettlementsService`; `gatewayResponse` persistence; shared `computeInvoiceBreakdown()` helper; fixed a boot-time crash when Postgres is unreachable at startup |
| 2 | Online/COD/retry/failed-payment flow | `GuestBookingDto.paymentMethod` actually respected; `retryPayment()` / `switchToCod()` / `collectCod()`; AMC subscriptions gated to activate only after real payment confirmation; frontend Retry/Pay-via-Cash recovery UI |
| 3 | Partner payment & balance collection | `getBalance()` as single source of truth for amount owed; `collectBalance()` / `confirmBalancePayment()`; vendor app's job-completion flow now actually collects payment (cash/UPI/card in person, or live Razorpay checkout); Partner Dashboard's dead Withdraw button now shows real payout history |
| 4 | Customer payment dashboard | `getPaymentHistory()` (customer-safe, gateway secrets excluded); ownership checks added to `balance` and invoice generation (closing the cross-customer invoice leak); "Payment Details" modal — amount/paid/remaining, transaction history, Pay Remaining, Download Invoice/Receipt |
| 5 | Refund approval pipeline + admin fixes | Full state machine: request → evidence → partner response → admin review → decision (Full Wallet Credit / Partial Wallet+Gateway / Full Gateway Refund / No Refund / Free Rework / Discount Coupon) — never automatic, ADMIN/SUPER_ADMIN only; real Razorpay/PhonePe refund API calls; new `admin/refunds.html`; fixed the three broken admin pages (`partner-earnings.html`, `payments.html`, `wallet.html`) |
| 6 | Accounts, reports, ledgers, analytics | `paymentDashboard()` (total/pending collection, failed amount, refund amount, COD-vs-Online, settlement totals, trend); `getOrderLedger()` and `getPartnerLedger()` — always-live, nothing to keep in sync |
| 7 | Notifications, COD→Online nudges | `PaymentNotificationsService` pairing WhatsApp + in-app notification for every lifecycle event (payment success/failed/balance due/refund/work completed), each channel failing independently; wired into every real payment event across Orders, MasterOrders, ExtraWork, Refunds, and the Razorpay webhook; "Pay online now" banner on stale COD orders |

---

## Verification

- **TypeScript build:** clean, 0 errors (re-verified 2026-07-27).
- **Test suite:** 91/91 passing across 10 spec files (re-verified 2026-07-27), including coverage added in every phase — invoice math, settlements, COD/retry/AMC-gating, balance calculation, dashboard authorization, refund decision matrix, vendor-earnings aggregation, dashboard/ledger trend bucketing, and notification-pairing fault isolation.
- App boots cleanly with no circular-module-dependency errors despite `PaymentNotificationsModule` now being imported by Orders/MasterOrders/Payments/Refunds.
- All touched frontend inline `<script>` blocks parse without syntax errors.
- Live, DB-backed end-to-end click-through in a browser was **not** performed during development (no reachable Postgres instance in the dev environment at the time) — this remains the primary pre-launch verification gap.

---

## Known gaps (carried forward, not yet built)

1. **Wallet top-up confirmation notifications** — Phase 7 wired notifications for every order-payment lifecycle event but not for wallet top-ups specifically.
2. **Razorpay Payment Links / SMS delivery** — payment collection at job completion currently relies on in-device Razorpay checkout (vendor's or customer's own device). There's no mechanism to text a customer a payable link for cases where neither party has the gateway checkout open in front of them; no SMS gateway is configured beyond MSG91-for-WhatsApp.
3. **Live end-to-end verification** — every phase's automated tests pass, but no phase has been click-tested against a real running Postgres + live Razorpay test-mode flow end to end.
4. **No payout gateway** — `PartnerSettlement` is manual record-keeping only (bank transfer/UPI/cash/cheque + reference); nothing moves partner payouts automatically.

---

## What changed since the last production-readiness snapshot

The existing `PRODUCTION_READINESS_REPORT.md` (2026-06-22) predates this entire rebuild and scored Payments 4/4 routes with "Razorpay webhook, order payment" — that assessment is now superseded for anything payment-related: the schema, flow, refunds, settlements, reporting, and notifications described above did not exist at that time and should be treated as the current source of truth for payment-system status.
