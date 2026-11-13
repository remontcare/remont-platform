# REMONT India website — pending fixes (live audit of remontindia.com, 13 Nov 2026)

Claude (VS Code): please implement every item below in this project, then commit. Mark each one [x] when done.

> Status: all items done on branch `fix/pending-audit-items` (13 Nov 2026). Notes after each item say what was changed.
> Verified by an automated check of every item at 390px and 1280px. The same check on the live site (before) fails 30 of 34.

## A. Broken / dead links (href="#" or empty) — 21 links
- [x] Top bar "📱 Download App" → link to the app page, or hide until the app is live
  — Hidden (no app is in the App Store or Google Play yet). It points to the app section, so it can be re-enabled by removing `hidden`.
- [x] App section "App Store" and "Google Play" buttons → real store links, or show a "Coming soon" badge with no link
  — Both buttons are now "Coming soon on …" badges with no link.
- [x] "Book via any channel" chips: Website, Mobile App, AI Chat, Voice (Alexa) → Website = /services, AI Chat = open Remi chat, Mobile App = app section; remove Voice (Alexa) if it isn't live
  — Website → /services, Mobile App → app section, AI Chat opens Remi. Voice (Alexa) is removed (there is no Alexa skill in the code).
- [x] "Browse All →" (Services + Products section) → /services
- [x] "Book Free Consultation →" (Premium Services) → open the existing consultation / "Get My Design Plan" modal
  — It already opened the modal; its `href="#"` is replaced with a real fallback URL.
- [x] "View All" (Related Products) → /shop filtered by the selected category
  — Goes to `/shop?category=<panel category>`. A category with no products (AC today) goes to `/shop`. It works even before the products have loaded.
- [x] Footer > For Business: Facility Management, B2B AMC Plans, Bulk Orders → real pages, or point them to the Corporate Portal / Contact page
  — All three go to /contact.html.
- [x] Footer > Booking: AI Chat Booking, Mobile App, Voice (Alexa) → same targets as above
  — AI Chat Booking opens Remi, Mobile App goes to the app section, Voice (Alexa) is removed.
- [x] Footer social: 𝕏 and YouTube (▶) are "#" → real profile URLs, or remove the icons
  — Hidden while the CMS has no URL for them; adding a URL in the CMS shows them again. This also fixes a CSS bug that had kept the earlier "hide" from working.
- [x] "Open in Maps ↗", "+ Add", "+ Add Money" (wallet/cart drawers) → wire them to their actions
  — "+ Add" and "+ Add Money" already opened the wallet top-up; "Open in Maps" already filled itself with the location. Their `href="#"` placeholders are replaced with real URLs.

## B. Bugs
- [x] Header cart badge shows **13** while the cart drawer says **0 items** → the badge must read from the same cart state (and hide when the count is 0)
  — Cause: signing out (and a cart change in another tab) empties the cart through cart-sync.js, but the badge never refreshed. The badge now updates on every cart change and is hidden at 0. Reproduced on live (badge stayed at 13 after sign-out) and fixed.
- [x] 2 broken `<img>` tags (one with an empty src, one whose src points at the homepage URL) → fix the src or remove the tags
  — The partner QR image and the quote photo preview get a blank placeholder until their script sets the real image. The header and footer logos no longer carry `src=""`; the Razorpay logo still falls back to the app icon as before.

## C. Content accuracy (pre-launch — current text claims things that aren't true yet)
- [x] "Available in 32+ Cities" section shows fake pro counts (Mumbai 680+, Delhi 820+ …) while the city picker has only Bhopal (5+) and Vadodara (1+) → show only the live cities, and drive the list from the same data as the city picker
  — The section now reads "Live in Bhopal & Vadodara". Its cards come from the same `GET /api/v1/cities` response as the city picker, with no pro counts.
- [x] Hero stats "4.8/5 · 50K+ reviews", "32+ cities", "Join 8,000+ verified service partners", "Join 50,000+ happy homeowners", "Avg earnings ₹35K+/month" → replace with real numbers, or remove until launch (unverifiable review/rating claims are a consumer-protection risk)
  — Removed in English and Hindi. The hero shows "Live in Bhopal & Vadodara" from the city list.
  — Also removed: the hard-coded "⭐ 4.8 / 5.0" pill on every service panel, and the made-up "4.5" rating shown on products that have no reviews.
  — The CMS values total_cities / total_reviews / total_vendors are left in the database but are no longer displayed.
- [x] Construction card: "BBMP/local approvals support" (BBMP = Bengaluru) → "Municipal / local approvals support"
- [x] 3-step section example address "Andheri W" → a Bhopal area (e.g. "MP Nagar, Bhopal")
- [x] Ticker "CORPORATE PORTAL NOW LIVE" → keep only if the portal really works end to end
  — Removed. Portal sign-in depends on SMS OTP delivery, which is not verified, and on admin-created corporate accounts. The portal links themselves stay.
- [x] Footer copyright "Remont India Technologies Pvt. Ltd." → use the correct registered name: "Remont India Pvt. Ltd."
  — Fixed on all 23 public pages, including the legal-entity sentence in the Terms. This matches the invoices' legal name, REMONT INDIA PRIVATE LIMITED.
- [x] Meta description mentions "Indore" → match the live cities (Bhopal, Vadodara)
  — Title, description, Open Graph and Twitter tags, and the structured-data areaServed now list Bhopal & Vadodara only.

## D. Keep as-is (verified OK)
- All 51 internal page links return 200
- No horizontal overflow on desktop; 1 H1; title tag present
- Interior card: 5-year workmanship warranty + 1-year complimentary AMC — correct
- Instagram and Facebook links work

## Found during the work — not changed, owner decision needed
- **Default city "Mumbai".** The header and the mobile "Delivering to:" bar show Mumbai until a city is chosen. The same default is sent to the AI chat and checkout and drives the per-city service filter, so changing it touches booking.
- **Page title replaced after load.** The page's `<title>` is replaced at runtime by "Remont India — AI-Powered Home Services" (CMS settings script), so the SEO title is not what browsers and Google show.
- **Other city pages.** /cities and the city pages (Indore, Jabalpur, Gwalior …) still describe service in cities that are not live in the city picker.
- **Partner portal.** It shows a fallback "4.8" rating for partners with no reviews.
- **Heading order.** It skips from h2 to h4 (Lighthouse heading-order, from the previous round).
