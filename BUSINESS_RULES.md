# Remont India: Business Rules and Configuration Plan

These are the rules the platform enforces as of October 2026, and where each one is configured. A rule marked **CA decision** is not decided in code. The platform keeps the safe default until your CA or legal adviser confirms otherwise.

## 1. Two separate workflows

Remont runs two businesses through one platform. They share customers, checkout and payments, but nothing else about how they are invoiced, taxed or settled.

| | Partner services (home services) | Marketplace products |
|---|---|---|
| Who supplies | An external partner, or a Remont in-house employee | A seller (marketplace), or Remont itself (own stock) |
| Order record | Service job (`Order.type = SERVICE`) | Product order (`Order.type = PRODUCT`) |
| Fulfilment | Dispatch → partner accepts → arrival → start code → completion code | Seller accepts → processing → ready for pickup → shipment → delivery |
| Customer pays | Online (Razorpay), wallet, or cash to the partner | Online, wallet, or cash on delivery (COD) |
| Invoice type | `PLATFORM_SERVICE` (partner) or `DIRECT_PROJECT` (in-house) | `MARKETPLACE_PRODUCT` |
| GST | Service GST; Section 9(5) only where §3 says so | Product GST from the product's rate or Admin › Taxes; seller TCS where applicable |
| Returns and refunds | Refund requests; credit note on an invoiced job | Return/RTO workflow; refund and credit note |
| Money to the supplier | Partner ledger → withdrawal → settlement | Seller ledger → seller settlement |

**Section 9(5) is a service rule. It never applies to product sales** just because they are sold through Remont. The invoice engine decides 9(5) only for `PLATFORM_SERVICE` jobs, and product invoices always carry `section95 = false`. This is covered by the accounting integration test and end-to-end scenario 11.

## 2. Partner services

### 2.1 Who supplies the service

| Supplier | Invoice | GST |
|---|---|---|
| External partner, GST-registered | Booking summary to the customer. The partner's own tax invoice carries the GST. | Partner's liability |
| External partner, not registered, category **APPLICABLE** for 9(5) | Remont tax invoice to the customer for the full service value | Remont pays it as the e-commerce operator (§3) |
| External partner, not registered, category not approved | Booking summary, flagged **tax review required** | CA decision |
| In-house employee | Remont tax invoice for the full service amount | Remont's own supply; never 9(5) |

### 2.2 Commission and platform fee

- Remont's commission comes from Admin › Commission rules, set per category or service and optionally per city. **No default percentage is invented:** a category with no rule earns ₹0 commission, so configure every active category.
- The commission is part of the service price and is deducted from the partner; it is never charged to the customer a second time.
- Remont issues a commission tax invoice to the partner: commission plus GST at the platform-fee rate.
- **CA decision:** whether the partner ledger also recovers that GST. The setting `partner_commission_gst_recovery` defaults to off, which recovers the commission only (the approved behaviour). Set it to `true` only after your CA confirms. The GST is then posted as its own ledger entry.

### 2.3 Payment and cash

- **Online payments** are confirmed only after the Razorpay signature *and* the captured amount are verified. A confirmation from the browser, the webhook and retries can arrive together; only one of them counts.
- **Cart payments:** one online payment for a cart is shared across its jobs (`cartPaidAmount`), so a paid job is never asked for money again.
- **Cash to the partner** counts as paid only once it is confirmed by one of:
  1. the customer's completion code, when the partner records the cash with the completion (partner portal and the updated app);
  2. the customer ("Yes, I paid");
  3. an admin, who must write down how it was confirmed (recorded in the audit log).

  Cash a partner reports separately stays pending until then.
- **Wallet:**
  - Only a logged-in owner can spend a wallet.
  - The wallet amount is taken atomically at checkout.
  - It is returned once, automatically, if an order that was never paid is cancelled.
- **Partner earnings** post once, and only when the customer's payment is verified. A completed but unpaid job is never withdrawable.

### 2.4 Job security

- **Start and completion codes:** 5 wrong attempts lock the code until a new one is sent to the customer. A re-sent code expires after 15 minutes. A job never completes without the customer's completion code.
- **Admin status changes** are limited to "partner on the way" and "closed". Completion, payment, refunds and starting a job happen only through their real workflows. Cancelling goes through the cancellation workflow.

## 3. Section 9(5): configuration plan

Section 9(5) of the CGST Act applies only to **notified services** supplied through an e-commerce operator, and only where the supplier is not liable to register. It must not be applied to every category.

**Mechanism.** Each service category has `ServiceCategory.gstSection95Status` (Admin › Services › edit category › "GST Section 9(5)").

| Value | Meaning | Effect |
|---|---|---|
| empty: **CA review required** (default for every category) | Not yet confirmed | Never 9(5). A job by an unregistered partner that charged GST is flagged for tax review. |
| `APPLICABLE` | CA-approved as a 9(5) service | Remont issues the tax invoice and pays the GST for unregistered partners |
| `NOT_APPLICABLE` | CA-confirmed not 9(5) | Never 9(5); same tax-review flag |

**Rules enforced in code:**
- Only `APPLICABLE` triggers 9(5).
- It never applies to registered partners, in-house employees or products.
- Nothing is switched on automatically. A new category starts at "CA review required".

The admin category list shows a **9(5) badge** on every category: *applicable*, *not applicable* or *CA review*, so categories still waiting for confirmation are visible at a glance.

**Current state:** all service categories are on *CA review required*, so no category gets 9(5) treatment yet.

**Plan:**
1. Send your CA the category list (Admin › Services).
2. Mark each confirmed category `APPLICABLE` or `NOT_APPLICABLE`.
3. Until then, check jobs flagged for tax review in Admin › Reports › Accounting & GST.

## 4. Marketplace products

- **Product GST:**
  - A product can't be sold until its GST rate is configured, either on the product or in Admin › Taxes (by category, HSN or a blanket rate).
  - It is never sold at a silent 0%.
  - An exempt or nil-rated product must be configured explicitly.
- **Seller workflow:**
  - Every product job records whether it is COD or prepaid.
  - A COD shipment tells the courier to collect cash; a prepaid one doesn't.
- **Product invoice:**
  - The seller is the supplier (Remont for own stock).
  - It is issued automatically when the order is handed to logistics, with delivery as a backstop.
  - Remont's marketplace commission is invoiced to the seller separately.
- **TCS** is withheld from seller settlements where configured.
- **Returns, RTO, refunds and seller settlements** follow the product workflow (product ledger), never the partner ledger.

## 5. Test and demo transactions

| Record | Classification | How it is kept |
|---|---|---|
| DEV_MOCK / RAZORPAY_DEV payments | Development test gateways | Excluded from every accounting report and listed separately (Admin › Reports › test payments) |
| Six development invoices (Oct 2026) | Demo | Removed with backup; the bookings were cancelled with a timeline note |
| Demo partner balances and withdrawals | Demo | Reconciled to the current rules with backup (Oct 2026) |
| ₹10 Razorpay top-up by the in-house test account (`pay_TRrH…`, 20 Aug 2026) | **Owner-created test transaction** (owner-confirmed 16 Oct 2026) | Payment and ledger entry kept unchanged for the audit trail. Its ₹10 withdrawal request is closed as "owner test — no payout". No payout or refund. |

New test transactions on live Razorpay keys are real gateway transactions. Prefer Razorpay test keys in a separate environment.

## 6. Decisions still with your CA or legal adviser

1. Which service categories are notified under Section 9(5) (§3).
2. Whether partners should bear GST on Remont's commission (`partner_commission_gst_recovery`, §2.2).
3. GST rates for products that have none configured. These are blocked from sale until set.
4. When a tax invoice must be issued for a completed job that was never paid, and how it is cancelled.
5. Whether e-invoicing (IRN) and e-way bills are mandatory. This is simulation-only until a GSP/IRP is connected.

## 7. Settings reference

| Setting | Where | Default |
|---|---|---|
| `ServiceCategory.gstSection95Status` | Admin › Services › category | CA review required (no 9(5)) |
| Commission rules | Admin › Commission | none (₹0; configure every category) |
| `partner_commission_gst_recovery` | Admin › Settings | off |
| Product GST rate | Product form / Admin › Taxes | none (product not sellable) |
| Billing identity (legal name, GSTIN, address) | Admin › Settings › Billing | required before invoicing |
| `gstr1_b2cl_threshold` | Admin › Settings | ₹1,00,000 |
| Lead cost, warranty hold %, warranty days | Admin › Settings › Vendor Wallet | as configured |
