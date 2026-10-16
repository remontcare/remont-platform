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

### 2.1 Two service models, fixed per category

The customer pays before anyone is assigned, so each service category says who supplies it: **Admin › Services › category › "Who provides these services"** (`ServiceCategory.serviceModel`). Checkout prices by it, and the booking keeps that model for good (`Order.serviceModel`). Dispatch follows it: in-house jobs go only to Remont's technicians (none online → admin queue), and partner jobs only to external partners. Admin assignment and partner acceptance refuse the wrong kind of staff. Bookings made before this change keep their original pricing.

Worked examples (illustrative; every rate comes from configuration): a ₹100 service, 20% commission, 18% GST.

| Model | Customer pays | Documents | Who is liable for GST |
|---|---|---|---|
| **In-house** (`IN_HOUSE`) | ₹100 + ₹18 = **₹118** | One Remont tax invoice, naming the technician who did the work | Remont (own supply); never 9(5) |
| **Partner marketplace** (`PARTNER_MARKETPLACE`, the default), unregistered partner | ₹80 + ₹20 fee + ₹3.60 = **₹103.60** | Partner's document ₹80 (no GST); Remont platform fee invoice ₹23.60 **to the customer**; booking summary | Remont on its fee; no GST on the partner's share |
| Partner marketplace, GST-registered partner | ₹80 + ₹14.40 + ₹20 + ₹3.60 = **₹118** | As above; the partner's ₹80 carries their GST | Partner on ₹14.40; Remont on ₹3.60 |
| Partner marketplace, unregistered partner, category **APPLICABLE** for 9(5) | ₹80 + ₹14.40 + ₹20 + ₹3.60 = **₹118** | Remont's tax invoice as e-commerce operator for the ₹80 service (₹94.40); Remont fee invoice ₹23.60; partner's receipt | Remont on both (§3) |

**A registered partner's GST is known only when they accept the job.** Checkout charges what is known (₹103.60). When a GST-registered partner accepts, the booking rises to ₹118 and the extra ₹14.40 becomes a balance due, collected through the normal balance flow (online, or cash confirmed by the completion code). If that partner later drops the job, it is recalculated again.

### 2.2 Platform fee (commission)

- Remont's commission comes from Admin › Commission rules (per category or service, optionally per city). **No default percentage is invented:** a category with no rule has no fee.
- **Partner marketplace:** the catalogue price includes the commission. The customer pays it as Remont's platform fee, with GST at the platform-fee rate, on Remont's own tax invoice addressed to the customer. The partner is credited their share (price − commission) and is **never** charged commission or its GST.
- A platform-funded discount (coupon, membership, bundle) reduces Remont's fee first. Any excess reduces the partner's line; the partner is still paid their full share, so Remont funds it.
- `partner_commission_gst_recovery` and the commission invoice to the partner apply only to bookings made before this change.

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

### 2.5 Partner marketplace documents

No document ever combines two suppliers.

| | A. Partner service document | B. Remont platform fee invoice | Booking summary |
|---|---|---|---|
| Supplier | The partner (name, registered address, GSTIN if registered) | Remont India Pvt Ltd | — (Remont's tax invoice under 9(5)) |
| Recipient | The customer | The customer | The customer |
| Series | PSI | PFI | CTI |
| Value | Partner's share after any discount, plus their GST if registered | Platform fee after any discount + GST | Everything paid (under 9(5): the partner's service + GST only) |
| References | Order, service date, the fee invoice number | Order, partner document number | Both document numbers |
| Download | Customer, partner, admin | Customer, admin | Customer, admin |

**Who issues document A** (setting `partner_invoice_issuance`, frozen on each invoice):

| Setting | Document A is |
|---|---|
| `STATEMENT` (default) | A partner service statement prepared by Remont: not a tax invoice and not signed for the partner. A registered partner issues its own tax invoice. |
| `ON_BEHALF` | The registered partner's tax invoice, issued by Remont on their behalf (the document says so). Only after legal confirms the authorisation and partners accept it. |

Today's partner agreement covers only the commission structure, so the setting stays `STATEMENT`.

**Partner ledger, per job** (posted once, only after the customer's payment is verified):

| Event | Unregistered partner | Registered partner |
|---|---|---|
| Earning | +₹80 | +₹80 |
| Their GST passed to them | — | +₹14.40 (theirs to remit) |
| Lead cost taken at acceptance | returned | returned |
| Paid online | nets **₹80** | nets **₹94.40** |
| Cash: customer paid the partner | −₹103.60 cash in hand → owes Remont **₹23.60** | −₹118 → owes Remont **₹23.60** |

The existing warranty hold and its automatic release apply unchanged.

### 2.6 In-house technicians: cash and salary

- In-house jobs never create partner earnings, commission or a commission invoice.
- **Cash an in-house technician collects** (verified by the customer's completion code, the customer or an admin) is recorded on that technician's existing ledger as cash held for Remont (e.g. −₹118). It is not earnings and not salary.
- **Deposits:** when Remont actually receives the cash, an admin records it in Admin › Reports › Accounting › *In-house technician cash*, against the job, with a receipt or bank-slip reference. Partial deposits are allowed, and the outstanding balance stays visible. The same reference never counts twice, a deposit can never exceed what is outstanding, and every deposit is audited. Completing a job never marks cash as deposited.
- The *In-house technician cash* report (Excel) lists, per technician and job: collected, method, verification, deposited, references and outstanding.
- **Salary** is recorded separately as an expense: Admin › Reports › Accounting › Purchase bills › *Salary*. It never carries GST or input tax credit and is never netted against cash collected.

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
2. GST rates for products that have none configured. These are blocked from sale until set.
3. When a tax invoice must be issued for a completed job that was never paid, and how it is cancelled.
4. Whether e-invoicing (IRN) and e-way bills are mandatory. This is simulation-only until a GSP/IRP is connected.
5. **Partner invoicing authority.** Whether Remont may issue a registered partner's tax invoice on their behalf, with what written authorisation, per-partner numbering and declarations. Until then, document A is a statement (§2.5).
6. **A registered partner's GST added after booking.** The customer is quoted ₹103.60 and asked for ₹14.40 more once a registered partner accepts. Confirm this is acceptable to show customers, and how they are told at checkout.
7. **Platform-funded discounts.** They reduce Remont's fee first, then the partner's line, while Remont pays the partner their full share. Confirm the documentation of Remont's funding.
8. **Refunds on partner marketplace jobs.** A refund issues a credit note against the customer's booking summary or 9(5) invoice. Whether Remont's fee invoice to the customer and the partner's document should also be credited, and in what proportion, is not automated. Partner recoveries remain an admin decision.
9. Bookings made before this change still follow the old model (GST on the full service, commission deducted from the partner, `partner_commission_gst_recovery`).

## 7. Settings reference

| Setting | Where | Default |
|---|---|---|
| `ServiceCategory.serviceModel` | Admin › Services › category › "Who provides these services" | `PARTNER_MARKETPLACE` (external partners) |
| `ServiceCategory.gstSection95Status` | Admin › Services › category | CA review required (no 9(5)) |
| Commission rules | Admin › Commission | none (₹0; configure every category) |
| `partner_commission_gst_recovery` | Admin › Settings | off (bookings made before the service models only) |
| `partner_invoice_issuance` | Admin › Settings | `STATEMENT` (Remont does not issue tax invoices in a partner's name) |
| Product GST rate | Product form / Admin › Taxes | none (product not sellable) |
| Billing identity (legal name, GSTIN, address) | Admin › Settings › Billing | required before invoicing |
| `gstr1_b2cl_threshold` | Admin › Settings | ₹1,00,000 |
| Lead cost, warranty hold %, warranty days | Admin › Settings › Vendor Wallet | as configured |
