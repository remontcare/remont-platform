# Project Map — Remont India

> **INSTRUCTION FOR CLAUDE:**
> Never scan the entire repository unless explicitly requested.
> Read `CLAUDE_PROJECT_CONTEXT.md` first, then use this map to navigate
> directly to the specific file you need.

---

## Top-Level Files

| File | Purpose |
|---|---|
| `vercel.json` | Vercel deployment: serves `frontend/`, rewrites `/api/*` to Railway |
| `docker-compose.yml` | Local dev: PostgreSQL + Redis + backend + frontend containers |
| `.gitignore` | Excludes `backend/.env`, `node_modules`, `dist/`, etc. |
| `CLAUDE_PROJECT_CONTEXT.md` | **Read this first** — architecture, all routes, env vars, config |
| `PROJECT_MAP.md` | This file — every file and its purpose |
| `DEPLOYMENT_FIX_REPORT.md` | Audit trail of fixes applied 2026-06-18 |
| `FINAL_DEPLOYMENT_GUIDE.md` | Step-by-step Railway + Vercel deploy |
| `PROJECT_RECOVERY_GUIDE.md` | Full recovery guide for new developers |

---

## Frontend

```
frontend/
├── index.html          Single-page app — ALL HTML, CSS, and JS in one file (~4130 lines)
│                         Lines    1–10:   <head>, fonts
│                         Lines   11–1800: <style> CSS (all components)
│                         Lines 1801–4027: <body> HTML (hero, services, products, sections)
│                         Lines 4028–4027: First <script> — city filter, search scope toggle
│                         Lines 4028–4129: Second <script> — backend API calls (ADDED 2026-06-18)
├── package.json        Scripts: dev (http-server:3000), start, build (echo — no build step)
└── .env.example        Documents API_BASE_URL=http://localhost:3001 for local dev
```

### Frontend key elements (for DOM queries)
| Element | Selector | Purpose |
|---|---|---|
| AI chat message | `.ai-msg` | Displays AI reply text |
| AI chat input | `.ai-input-row input` | User types message here |
| AI chat send | `.ai-send` | Send button |
| AI suggestions | `.ai-sugg` | Clickable suggestion chips |
| Header search input | `#headerSearchInput` | Search bar |
| Header search button | `.search-btn-icon` | Search submit |
| City display | `#currentCity` | Shows selected city name |
| Current city variable | `currentCity` (JS var) | Set by city selector script |

---

## Backend

```
backend/
├── src/
│   ├── main.ts                     Bootstrap: port=3001, prefix=/api/v1, CORS, Swagger
│   ├── app.module.ts               Root module — imports all 19 feature modules
│   │
│   ├── common/
│   │   ├── index.ts                Barrel export for guards, decorators, helpers
│   │   ├── filters/
│   │   │   └── http-exception.filter.ts    Global error response shaping
│   │   └── interceptors/
│   │       └── transform.interceptor.ts    Wraps all responses in { data, statusCode, ... }
│   │
│   ├── prisma/
│   │   └── prisma.module.ts        Singleton PrismaService — import PrismaModule everywhere
│   │
│   └── modules/                    ONE FILE PER MODULE (service + controller + module combined)
│       ├── auth/
│       │   └── auth.module.ts      OTP send/verify, JWT issue/refresh, JwtStrategy, AuthService
│       │                           Routes: POST /auth/send-otp, /verify-otp, /refresh  GET /auth/me
│       │
│       ├── users/
│       │   └── users.module.ts     Profile CRUD, address management
│       │                           Routes: GET/PATCH /users/me, /me/addresses
│       │
│       ├── cities/
│       │   └── cities.module.ts    City list, serviceability check, per-city service availability
│       │                           Routes: GET /cities, /cities/serviceability, /cities/:name/services
│       │
│       ├── services/
│       │   └── services.module.ts  Service categories + individual services + search
│       │                           Routes: GET /services/categories, /popular, /premium, /search?q=, /:id
│       │
│       ├── products/
│       │   └── products.module.ts  Product catalog, vendor product management, AI description
│       │                           Routes: GET /products, /products/:slug  POST/PATCH [vendor]
│       │
│       ├── orders/
│       │   └── orders.module.ts    Full order lifecycle: create → dispatch → complete
│       │                           Includes: DispatchService (haversine vendor matching), ExtraWorkService
│       │                           Routes: POST /orders  GET /orders/mine  PATCH cancel/en-route/complete
│       │
│       ├── invoices/
│       │   └── invoices.module.ts  GST invoice generation (3-party: customer/vendor/platform split)
│       │                           Routes: POST /invoices/orders/:id/generate  GET /invoices/orders/:id
│       │
│       ├── wallet/
│       │   └── wallet.module.ts    In-app wallet: credit, debit, transaction history
│       │                           Routes: GET /wallet/balance, /wallet/transactions
│       │
│       ├── coupons/
│       │   └── coupons.module.ts   Coupon validation (PERCENT/FLAT), usage tracking
│       │                           Routes: GET /coupons/available  POST /coupons/validate
│       │
│       ├── memberships/
│       │   └── memberships.module.ts  Subscription plans with discount %
│       │                              Routes: GET /memberships/plans  POST /memberships/subscribe
│       │
│       ├── vendors/
│       │   └── vendors.module.ts   ServiceVendorsController + ProductVendorsController
│       │                           Routes: /vendors/service/...  /vendors/product/...
│       │
│       ├── delivery/
│       │   └── delivery.module.ts  Delivery partner registration, location, status updates
│       │                           Routes: POST /delivery/register  PATCH /delivery/me/location
│       │
│       ├── payments/
│       │   └── payments.module.ts  Razorpay order create, client-side verify, webhook handler
│       │                           Routes: POST /payments/create-order, /verify, /webhook
│       │
│       ├── crm/
│       │   └── crm.module.ts       Lead lifecycle, agent assignment, funnel analytics
│       │                           Routes: POST /crm/leads/capture [Public]  GET/PATCH /crm/leads/*
│       │
│       ├── amc/
│       │   └── amc.module.ts       Annual Maintenance Contracts, auto-renewal cron job
│       │                           Routes: GET /amc/plans  POST /amc/subscribe, /renew, /cancel
│       │
│       ├── ai-agent/
│       │   ├── ai-agent.module.ts  Controller @Controller('ai'), AiAgentService, session management
│       │   │                       Routes: POST /ai/chat [Public]  GET /ai/sessions/mine
│       │   └── intent-engine.ts    Rule-based NLP: detectIntent(), detectLanguage(), getReply(), getSuggestions()
│       │
│       ├── corporate/
│       │   └── corporate.module.ts B2B corporate accounts, multi-member, order approval flow
│       │                           Routes: GET /corporate/dashboard  POST /corporate/orders/:id/approve
│       │
│       ├── whatsapp/
│       │   └── whatsapp.module.ts  MSG91 adapter: sendOtp(), sendJobAssigned(), sendExtraWorkApproval()
│       │                           No HTTP routes — internal service only
│       │
│       ├── notifications/
│       │   └── notifications.module.ts  Internal notification system
│       │                               No HTTP routes — internal service only
│       │
│       ├── admin/
│       │   └── admin.module.ts     Admin dashboard: stats, user/vendor/order management
│       │                           Routes: GET /admin/stats  PATCH /admin/users/:id/block  etc.
│       │
│       └── health/
│           └── health.controller.ts  GET /health  GET /health/ready  (only standalone controller file)
│
├── prisma/
│   ├── schema.prisma           Full DB schema — all models
│   └── seed.ts                 Creates admin user + sample cities/services
│
├── dist/                       Compiled JS output (git-ignored in prod)
├── .env                        Local env file (git-ignored) — fill from .env.example
├── .env.example                All required env vars with placeholder values
├── nixpacks.toml               Railway build config: installs openssl
├── nest-cli.json               NestJS CLI config
├── tsconfig.json               TypeScript config (full)
├── tsconfig.build.json         TypeScript config (build — excludes test files)
└── package.json                Dependencies: NestJS 10, Prisma 5, Passport, Razorpay, Socket.IO
```

---

## Database Schema Quick Reference

| Model | Key Fields | Relates To |
|---|---|---|
| `User` | phone, role, otpCode, walletBalance, isVerified | addresses, membership, city |
| `ServiceVendor` | userId, skills[], rating, isOnline, currentLat/Lng, serviceRadius | orders, documents |
| `ProductVendor` | userId, businessName, rating | products |
| `DeliveryPartner` | userId, type, isAvailable, currentLat/Lng | deliveries |
| `ServiceCategory` | key, name, icon, sortOrder | services |
| `Service` | categoryId, name, basePrice, isPopular, isPremium | orders |
| `Product` | vendorId, slug, sku, price, stock | orderItems |
| `Order` | customerId, vendorId, serviceId, status, totalAmount, startOtp | items, invoice, extras |
| `OrderItem` | orderId, productId, quantity, unitPrice | — |
| `Invoice` | orderId, invoiceNumber, customer/vendor/platform splits | — |
| `WalletTransaction` | userId, type, reason, amount, balanceAfter | — |
| `Coupon` | code, type (PERCENT/FLAT), discountPercent, usedCount | usages |
| `UserMembership` | userId, planId, endDate, discountPercent | plan |
| `City` | name, pincodes[], priceMultiplier, activeServiceKeys[], isActive | services, products |
| `Lead` | customerPhone, source, status, assignedAgentId, aiSessionId | activities, orders |
| `AiSession` | userId, channel, messages[], resolvedIntent, languageDetected | lead, order |
| `AmcPlan` | name, type, freeServicesCount, priceYearly, durationMonths | subscriptions |
| `AmcSubscription` | userId, planId, status, servicesRemaining, autoRenew | — |
| `PaymentTransaction` | userId, orderId, gateway, gatewayOrderId, status | — |
| `Delivery` | partnerId, trackingNumber, status, receiverOtp | — |
| `CorporateAccount` | companyCode, creditLimit, creditUsed | members |
| `Notification` | userId, type, title, body, isRead | — |

---

## Common Code Patterns

### Guard usage
```typescript
@Public()                              // no auth required (overrides global guard)
@UseGuards(JwtAuthGuard)               // any authenticated user
@UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.ADMIN)   // role-restricted
```

### Getting current user in a handler
```typescript
@CurrentUser() user: JwtPayload   // { sub: userId, phone, role, name }
```

### Prisma access (in any service)
```typescript
constructor(private prisma: PrismaService) {}
// then: this.prisma.user.findUnique(...)
```

### Module imports needed for cross-module calls
If module A calls service B, module B must `exports: [ServiceB]` and module A must `imports: [ModuleB]`.

---

## Files NOT to Modify Without Care

| File | Risk if changed |
|---|---|
| `backend/src/main.ts` | Changes CORS or API prefix — breaks all frontend calls |
| `backend/prisma/schema.prisma` | Requires migration — data loss risk if not careful |
| `vercel.json` | Destination URL must match deployed Railway domain |
| `frontend/index.html` (first `<script>`) | Contains city filter + search scope — existing UI logic |
