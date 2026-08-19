# Interior Design page — how it's built, and how to go live

## Stack (detected, reused as-is)

This is a **plain static HTML / CSS / vanilla JS site, no build step, no framework.**
`vercel.json` sets `outputDirectory: frontend` and serves every `.html` file directly;
`cleanUrls: true` is what lets `/interior` resolve to `frontend/interior.html` with no
`.html` in the URL. The backend is a separate NestJS API on Railway, called via `fetch()`.

Nothing here adds React/Next/a bundler/npm dependencies — `/interior` is one more
static HTML file, same as `frontend/index.html` or `frontend/booking.html`, just built
from three small shared files instead of one giant one.

## Files

| File | Purpose |
|---|---|
| `frontend/interior.html` | Page content/structure only. No prices hardcoded here — see below. |
| `frontend/shared/interior-config.js` | **The one file to edit for prices, labels, and API keys.** Defines `window.INTERIOR_CONFIG`. |
| `frontend/shared/service-page.css` | Reusable visual system (header/footer shell + hero/tabs/cards/packages/portfolio/FAQ/sticky-bar). Shared by future pages. |
| `frontend/shared/service-page.js` | Reusable behavior: tab switching, FAQ accordion, portfolio filter, config-driven rendering, booking/chat/payment/AI hooks. Shared by future pages. |

## Where prices live

`interior.html` does **not** hardcode "₹85,000" anywhere. The Services, Consultancy,
and Packages tabs are empty containers (`data-svp-render="..."`) that `service-page.js`'s
`renderFromConfig()` fills in from `window.INTERIOR_CONFIG` on page load. Change a price,
add a service, or reorder packages by editing `interior-config.js` only — you don't touch
HTML or JS.

## CTA architecture — why nothing here calls WhatsApp for booking

Every primary action (Book Consultation, View a service, Book a package, Book This
Design) calls `RemontCTA.book({slug, label})` in `service-page.js`. For the `interior`
category specifically, that function redirects to `/?openLead=1#premium` — the
homepage's Premium Interior lead modal (`index.html`), a dedicated consultation-first
flow, **never** the generic handyman `/booking` catalogue. Every other category still
gets the original behavior: redirect to `/booking?service=<slug>&city=<city>&category=<cat>`
(`frontend/booking.html`), which fetches real services/cities from the backend and
pre-selects the slug if it matches a seeded `Service` record; if it doesn't match, the
user just lands on `/booking` and picks manually — nothing breaks.

**To change the interior consultation flow later:** edit only the body of
`RemontCTA.book()` in `service-page.js` (the `category === 'interior'` branch). No
button, no CTA, no page markup changes needed — they all already call this one function.

WhatsApp is wired up as `RemontCTA.chatWithExpert(message)`, used **only** by the
small secondary "Chat with Expert" / "Need Help?" links (Hero, sticky bar). It is never
a primary CTA.

## AI Design Studio — currently 100% mocked, and hidden from customers

The tab button, panel, and every entry point into it (`interior.html`) are hidden
(`display:none` / removed buttons) — not deleted — because the flow underneath is fully
simulated (see below): a customer who completed it would receive a fake, non-personalized
"AI-generated" result presented as if it were real. Nothing was removed from
`service-page.js`; re-enabling is a pure markup change (remove the `display:none` on
`[data-svp-panel="ai-studio"]`, restore the tab button and the "Upload Room Photo" CTAs)
**once the steps below are actually done** — don't re-enable the UI alone.

The 4-step flow (Upload → Pay → Customize → Result) is fully built and fully clickable,
but two pieces are stub functions in `service-page.js`, both clearly marked:

- **`RemontPayment.charge(amount, lead)`** — simulates a ₹19 (or configured amount)
  payment after a short delay and resolves with a fake `paymentId`. The lead's
  name/phone/email are captured from the form and logged to the console
  (`[MOCK PAYMENT] would charge ₹19 for {...}`) instead of being sent anywhere.
- **`RemontAI.generate(options)`** — simulates AI image generation after a delay and
  resolves with a fake `resultId`. No image API is called; no photo is uploaded anywhere.

The UI enforces the required order itself: the Customize chips and the Generate button
are `disabled` until `RemontPayment.charge()` resolves — `RemontAI.generate()` is never
reachable before payment succeeds, mock or live.

### To go live

1. **Payment (Razorpay):**
   - In `interior-config.js`, set `integrations.payment.mode = 'live'` and
     `integrations.payment.keyId` to your real Razorpay key id.
   - Replace the body of `RemontPayment.charge()` in `service-page.js` with a real
     Razorpay Checkout flow: create an order via your backend
     (`integrations.payment.createOrderEndpoint` is already defined as a placeholder —
     point it at a real `POST /api/v1/payments/create-order`-style endpoint), open
     `new Razorpay(options).open()`, and resolve the promise from the `handler` callback.
   - Persist the captured lead (name/phone/email) server-side at this point.

2. **AI image generation:**
   - Pick **one** affordable image-generation API (the spec calls for a single clean
     backend function — don't wire up more than one provider).
   - In `interior-config.js`, set `integrations.ai.mode = 'live'`, `provider`, and
     `generateEndpoint` to your real backend route.
   - Replace the body of `RemontAI.generate()` with a `fetch()` to that endpoint,
     sending the uploaded photo (already available as `fileInput.files[0]` in
     `initAiStudioUi()`) plus the selected style/wall colour.
   - **Backend responsibility, not frontend:** call the image API only after payment
     succeeds (already guaranteed by the UI gating above, but enforce it server-side
     too — never trust the client), store the uploaded photo + generated result in
     cloud storage, and set a 30-day auto-delete/lifecycle rule on that bucket/prefix.

3. Nothing in `interior.html` needs to change for either of the above — only
   `interior-config.js` (config values) and `service-page.js` (the two function bodies).

## Digital vs. onsite services — city gating

Every service/consultancy/package item in `interior-config.js` carries a `serviceType`:
`'digital'` (AI Room Design, Online Consultation, 2D/3D/Elevation/Space Planning, Material
Consultation, Budget Planning, the Basic/Standard/Premium packages) or `'onsite'` (every
physical install/execution item — Full Home Interior, Modular Kitchen, False Ceiling, Home
Visit, the Complete Interior package, etc.), plus a `categoryKey` for onsite items.

- **Digital** items call `RemontCTA.book()` immediately. No city check ever runs — verified:
  clicking a digital CTA makes zero calls to `/api/v1/cities`.
- **Onsite** items go through `RemontCity.isServiceable(city, categoryKey)` first, which
  calls the real, already-live `GET /api/v1/cities` (same endpoint the homepage's city
  modal uses) and checks that city's `isActive`, `activeVendors > 0`, and `activeServiceKeys`
  array. **Nothing about city rollout is hardcoded anywhere in this page** — whoever manages
  the Cities table in the backend/admin controls it, and this page reflects that on next load.
- If the check fails (city inactive, category not yet live there, or the city is unknown to
  the API), the customer is **never blocked** — `openAvailabilityGate()` shows a modal with
  exactly the required copy ("This service is not available in your city yet…") and a
  name/phone/email/city/requirement form. Submitting it calls `RemontLead.capture()`, which
  posts to `POST /api/v1/crm/leads/capture` — a **real, already-live, public** endpoint
  backing the CRM (`frontend/crm.html` is its agent-facing side), so these leads land in the
  same system as AI-chat and WhatsApp-bot leads today. This one isn't mocked; it works now.

To reclassify a service or change which categories are gated, edit only `serviceType` /
`categoryKey` in `interior-config.js`. To change *which cities/categories are live*, no code
change is needed at all — that's managed wherever the Cities table already gets updated.

## Extending to Renovation / Architecture / Construction / Painting

Copy `interior.html` → `renovation.html`, copy `interior-config.js` →
`renovation-config.js` with that category's services/consultancy/packages, change the
`window.INTERIOR_CONFIG` variable name references in the new HTML file's `<script>` tag
to point at the new config file, and swap the hero copy + portfolio images. Everything
else — `service-page.css`, `service-page.js`, the tab system, the booking/chat/payment/AI
architecture — is reused unchanged.
