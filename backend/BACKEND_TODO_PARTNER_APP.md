# Backend implementation prompt — Partner app follow-ups (do 1→8, in order)

You are working in this NestJS + Prisma backend repo. Below are 8 additive backend tasks. Finish
them **one at a time, in the exact order given** — do not start #2 until #1 is fully done, tested,
and committed, and so on through #8. After each task, run the existing test suite / a quick
manual smoke test of the endpoint you just added before moving to the next one.

**Hard rule for all 8 tasks: do not touch, rename, or restructure anything that isn't explicitly
named below.** No refactors, no "while I'm here" cleanups, no changes to routing/dispatch logic,
the order status machine, payment/settlement calculations, ledger/wallet logic, or any existing
endpoint's current request/response shape. Every task here is pure addition — new fields, new
tables, new endpoints, new admin-panel inputs — layered on top of what already exists. If
finishing a task honestly requires touching something outside its own file list, stop and flag it
instead of doing it silently.

Once all 8 are done and verified locally, deploy the backend (and the admin-panel frontend for
task 8) to production.

---

## 1. Partner profile photo

**File:** `src/modules/vendors/vendors.module.ts` (`ServiceVendorsController` /
`ServiceVendorsService`, `@Controller('vendors/service')`, around line 355-380).

- Add `photoUrl String?` to `model ServiceVendor` in `prisma/schema.prisma` (next to the other
  plain optional String fields like `businessName`). Run a migration.
- Add `ServiceVendorsService.updatePhoto(userId: string, photoBase64: string)` — decode/store the
  same way any other base64-image field already gets persisted elsewhere in this codebase (check
  how `Product.imageBase64` is handled and match that storage approach for consistency).
- Add to the controller:
  ```ts
  @Patch('me/photo') photo(@CurrentUser() u: JwtPayload, @Body() b: { photoBase64: string }) {
    return this.vs.updatePhoto(u.sub, b.photoBase64);
  }
  ```
- Route: `PATCH /vendors/service/me/photo`, body `{ "photoBase64": "data:image/jpeg;base64,..." }`,
  response includes the new `photoUrl`.
- Add `photoUrl` to whatever `.select`/mapping `ServiceVendorsService.profile()` (the `me` GET)
  already returns, so it round-trips on next load.

---

## 2. Partner documents (KYC) update

**File:** same `vendors.module.ts`. `model VendorDocument` already exists
(`id, vendorId, type, url, verified, uploadedAt`) — **no schema change needed**, just wiring.

- Add `ServiceVendorsService.upsertDocument(userId: string, type: string, imageBase64: string)` —
  find-or-create a `VendorDocument` row for `(vendorId, type)`. On re-upload of an existing type,
  update `url` and reset `verified: false`. `type` must match the exact strings the registration
  flow already uses (check `ServiceVendorRegistrationDto`/seed data — likely `AADHAAR`, `PAN`,
  `BANK_PASSBOOK`, `SELFIE_ID`).
- Add to the controller:
  ```ts
  @Post('me/documents') doc(@CurrentUser() u: JwtPayload, @Body() b: { type: string; imageBase64: string }) {
    return this.vs.upsertDocument(u.sub, b.type, b.imageBase64);
  }
  ```
- Route: `POST /vendors/service/me/documents`, body `{ "type": "AADHAAR", "imageBase64": "..." }`.
- `ServiceVendorsService.profile()` already includes `documents: true` (around line 77) — no
  change needed there.

---

## 3. Partner bank-detail change request

`ServiceVendor` has **no bank fields today** (unlike `ProductVendor`, which already has
`bankAccountHolder`/`bankName`/`bankAccountNumber`/`bankIfsc`/`bankBranch`). Bank changes must
never apply instantly — mirror the existing admin-approval pattern already used elsewhere in this
codebase (see `ProductVendorsService.register()`'s comment about the application/document/approval
flow).

- Add a new Prisma model:
  ```prisma
  model VendorBankUpdateRequest {
    id            String    @id @default(cuid())
    vendorId      String
    accountName   String
    accountNumber String
    ifsc          String
    status        String    @default("PENDING") // PENDING | APPROVED | REJECTED
    createdAt     DateTime  @default(now())
    reviewedAt    DateTime?
    reviewedBy    String?

    vendor ServiceVendor @relation(fields: [vendorId], references: [id])
    @@index([vendorId])
  }
  ```
- Also add the same 5 bank fields (`bankAccountHolder`/`bankName`/`bankAccountNumber`/`bankIfsc`/`bankBranch`)
  to `ServiceVendor` itself, same names `ProductVendor` already uses — somewhere for an approved
  request to eventually land. Writing them (the actual admin-approval action) is a small separate
  admin-panel follow-up — don't build that UI now unless asked, just make the fields exist.
- Add `ServiceVendorsService.requestBankUpdate(userId, { accountName, accountNumber, ifsc })` —
  inserts a `VendorBankUpdateRequest` row with `status: 'PENDING'`, no side effects.
- Add to the controller:
  ```ts
  @Post('me/bank-update-request') bankReq(@CurrentUser() u: JwtPayload, @Body() b: { accountName: string; accountNumber: string; ifsc: string }) {
    return this.vs.requestBankUpdate(u.sub, b);
  }
  ```
- Route: `POST /vendors/service/me/bank-update-request`, body `{ accountName, accountNumber, ifsc }`.
  Response just needs `{ status: 'PENDING', createdAt }` — the app already shows a static
  "admin will verify within 24-48h" message.

---

## 4. Extra-work OTP confirmation

**File:** `src/modules/orders/orders.module.ts`, `ExtraWorkService` class (around line 279).
Today `addExtraWork()` sends a WhatsApp approval message and the customer approves via
`PATCH extra-work/:extraId/approve` — **keep that path working as-is**. This adds a second,
OTP-based confirmation path.

- Add 3 fields to `model ExtraWorkItem`, matching the naming convention `Order.startOtp`/
  `startOtpVerified`/`startOtpLastSentAt` already uses:
  ```prisma
  otp           String?
  otpVerified   Boolean   @default(false)
  otpLastSentAt DateTime?
  ```
- Add to `ExtraWorkService`:
  ```ts
  async requestOtp(vendorUserId: string, orderId: string) {
    // same vendor/order ownership + status checks addExtraWork() already does
    // generate a 4-digit code the same way Order.regenerateOtp() does
    // save it onto the most recent pending (customerApproved: false) ExtraWorkItem for this order
    // send via WhatsappService — add sendExtraWorkOtp(phone, orderNumber, otp), same shape as sendServiceOtpResent()
  }

  async verifyOtp(vendorUserId: string, orderId: string, otp: string) {
    // find the pending ExtraWorkItem(s) for this order with a matching otp
    // set otpVerified: true AND customerApproved: true, approvedAt: new Date()
    // call the same recalc(orderId) already used elsewhere in this class
  }
  ```
- Add to `OrdersController` (near the existing `@Post(':id/extra-work')` /
  `@Patch('extra-work/:extraId/approve')` routes, ~line 1438):
  ```ts
  @Post(':id/extra-work/otp') extraOtp(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.extras.requestOtp(u.sub, id);
  }
  @Post(':id/extra-work/verify-otp') extraVerify(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { otp: string }) {
    return this.extras.verifyOtp(u.sub, id, b.otp);
  }
  ```
- Routes: `POST /orders/:id/extra-work/otp` (no body), `POST /orders/:id/extra-work/verify-otp`
  with `{ "otp": "1234" }`. Reuse the existing `OTP_REGEN_COOLDOWN_SECONDS` constant for the resend
  cooldown rather than defining a new one.

---

## 5. Real UPI/QR for in-person cash collection

**File:** `src/modules/payments/payments.module.ts`. Today only the standard Razorpay Orders-API
+ checkout-modal flow exists — no VPA, no Payment Links `short_url`.

Pick whichever is less work given what's already enabled on this Razorpay account:

- **Option A (recommended):** Use Razorpay's Payment Links API via the already-imported `razorpay`
  npm SDK (`this.razorpay.paymentLink.create(...)`). Create one for the exact `balanceDue` amount,
  return its `short_url` as the QR content. Wire this into the existing `collectBalance()` flow in
  `orders.module.ts` (~line 748): add `PaymentsService.createPaymentLink(amount, orderId)`, return
  `{ ...balance, paymentLinkUrl: shortUrl }` alongside the existing fields.
- **Option B (fallback):** Add a static business VPA as a `SiteSetting` (key e.g.
  `razorpay_collection_vpa`), expose via the existing site-settings GET. QR encodes
  `upi://pay?pa=<vpa>&am=<amount>&tn=<orderNumber>`. Downside: no automatic reconciliation with the
  order — only use if Payment Links aren't available on this account tier.

The app's `job_flow_screen.dart` already has a placeholder waiting for whichever field you add
(`paymentLinkUrl` or a VPA) — once `collect-balance`'s response includes it, that's a separate
follow-up on the app side, not part of this backend task.

---

## 6. Push notifications when the app is killed (WhatsApp-call-style ringtone)

**No code changes in this task** — `FcmService`, the `DeviceToken` model, and the registration
endpoints (`POST/DELETE /notifications/devices`) already exist and are already wired into the
job-offer notification flow. The only blocker is environment configuration:

- Set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` in production, from a
  Firebase project's service-account JSON (Firebase Console → Project Settings → Service Accounts
  → Generate new private key). `FcmService.isConfigured()` no-ops until these are set.
- (Not this task's concern: the Flutter app also needs `firebase_messaging` + `google-services.json`
  for the same Firebase project — tracked separately on the app side.)

---

## 7. Partner ID card + real photo visible to the customer

Depends on #1 (`ServiceVendor.photoUrl`) already being done.

**File:** `src/modules/orders/orders.module.ts` — every place a vendor is attached to an order
response only pulls `user: { select: { name: true, phone: true } }` (3 call sites — search
`vendor: { include: { user:` to find all of them, around lines 1010, 1025, 1386). None select
anything off the `ServiceVendor` row itself. Update all 3 to also include `photoUrl` and `rating`:
```ts
vendor: { select: { photoUrl: true, rating: true, user: { select: { name: true, phone: true } } } }
```
Keep everything else about those includes/selects exactly as-is — purely additive.

`frontend/admin/partner-id-cards.html` already exists — check whether it already reads `photoUrl`
or needs a small update once the field exists.

(The customer app's call button already works today, no backend change needed for that part.)

---

## 8. Images + promotional video/ad on Categories, Sub-categories, and Services

`ServiceCategory` and `SubCategory` currently only have an `icon` field (plain emoji text input in
`admin/services.html`) — no image field at all. `Service` already has `imageUrl` + a gallery, with
a working upload widget in `admin/services.html` (`attachImageUpload('svc-img', ...)`, ~line 1230)
— reuse that exact pattern for the two levels missing it, and add a video field to all three.

**Schema:**
- Add `imageUrl String?` to `model ServiceCategory` and `model SubCategory`.
- Add `videoUrl String?` to `model ServiceCategory`, `model SubCategory`, AND `model Service` — one
  field for either a pasted external link (YouTube/Vimeo/etc.) or an uploaded file's resulting URL.

**Admin panel (`frontend/admin/services.html`):**
- Category form (~line 234) and Sub-category form (~line 286): add an image-upload field using the
  same `attachImageUpload(...)` helper already wired to `svc-img`, pointed at new `cat-img`/
  `subcat-img` inputs. Keep the existing emoji `icon` field as a fallback, don't remove it.
- Add a "Promo video" field to all three forms with two input modes: a text input for pasting an
  external URL, and an upload button for a local file.
- Extend `UploadsService.processAndStore()` in `src/modules/uploads/uploads.module.ts` (or add a
  sibling method) to accept `video/*` mimetypes — it currently rejects anything that isn't
  `image/*` and runs a sharp/WebP resize that makes no sense for video. For video, skip the resize,
  just write the raw file to the same `uploads/` directory and return `{ url }`.
- Note (already true for the existing image uploads, just repeating it here): this endpoint writes
  to local disk, which does not survive a Railway redeploy. Ship as-is for now; a persistent-storage
  fix (Railway Volume or S3/Cloudinary) is a separate task.

**Not part of this task:** actually displaying these images/videos in the Flutter customer app is a
separate follow-up — `GET /services/categories` will return the new fields automatically once they
exist in the schema, no further backend work needed for that.
