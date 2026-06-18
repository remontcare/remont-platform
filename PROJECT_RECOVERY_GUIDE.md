# Project Recovery Guide
**Project:** Remont India — AI-Powered Home Services Platform  
**Purpose:** Allow any developer to fully understand, rebuild, and redeploy this project from scratch without prior investigation.  
**Date produced:** 2026-06-18

---

## What This Project Is

A full-stack home services marketplace for India:
- Customers book services (AC repair, plumbing, electrician, etc.) via a web frontend
- AI chat widget handles natural language booking
- Vendors receive jobs, update location, complete tasks
- Razorpay handles payments; MSG91 handles OTP auth; Cloudinary stores images
- AMC (Annual Maintenance Contracts) and corporate B2B portals included

---

## Repository Structure

```
remont-platform/
├── backend/                   NestJS 10 + Prisma 5 API server
│   ├── src/
│   │   ├── app.module.ts      Root module — all 19 feature modules registered here
│   │   ├── main.ts            Bootstrap: port 3001, global prefix /api/v1, CORS
│   │   ├── prisma/            Prisma module (singleton PrismaService)
│   │   ├── common/            Shared: guards, decorators, filters, interceptors
│   │   └── modules/           One file per domain (module + service + controller combined)
│   │       ├── auth/          Phone OTP auth → JWT access + refresh tokens
│   │       ├── users/         User profile + addresses
│   │       ├── cities/        City management + service availability per city
│   │       ├── services/      Service categories + individual services
│   │       ├── products/      Product catalog (for product vendors)
│   │       ├── orders/        Full order lifecycle + smart vendor dispatch
│   │       ├── invoices/      GST invoice generation (3-party: customer/vendor/platform)
│   │       ├── wallet/        In-app wallet credit/debit
│   │       ├── coupons/       Discount coupons (PERCENT / FLAT)
│   │       ├── memberships/   Subscription plans with discount %
│   │       ├── vendors/       Service vendors + product vendors
│   │       ├── delivery/      Delivery partner assignment + tracking
│   │       ├── payments/      Razorpay order creation + webhook
│   │       ├── crm/           Lead capture, funnel, agent management
│   │       ├── amc/           Annual maintenance contracts + auto-renewal
│   │       ├── ai-agent/      Intent engine chat (rule-based, swap to LLM via env var)
│   │       ├── corporate/     B2B corporate accounts + order approval
│   │       ├── whatsapp/      MSG91 WhatsApp/SMS notifications
│   │       ├── notifications/ Internal notification system
│   │       ├── admin/         Admin dashboard + user/vendor/order management
│   │       └── health/        Health + readiness endpoints
│   ├── prisma/
│   │   ├── schema.prisma      Full DB schema (all 30+ models)
│   │   └── seed.ts            Creates admin user + sample cities/services
│   ├── .env                   Local env (git-ignored) — copy from .env.example
│   ├── .env.example           Template with all required variables
│   ├── nixpacks.toml          Railway build: installs openssl
│   └── nest-cli.json          NestJS CLI config
│
├── frontend/
│   ├── index.html             Single-page vanilla HTML/CSS/JS (~4130 lines)
│   │                          Includes: hero, AI chat, service catalog, premium showcase,
│   │                          city selector, product grid, AMC, corporate, footer
│   ├── .env.example           Documents API_BASE_URL for local dev
│   └── package.json           Scripts: dev (http-server), build (echo), start
│
├── vercel.json                Vercel config: outputDirectory=frontend, /api/* rewrite to Railway
├── docker-compose.yml         Local dev: PostgreSQL + Redis + backend + frontend
├── DEPLOYMENT_FIX_REPORT.md   What was broken and what was changed (2026-06-18)
├── FINAL_DEPLOYMENT_GUIDE.md  Step-by-step deploy to Railway + Vercel
└── PROJECT_RECOVERY_GUIDE.md  This file
```

---

## Backend Module Pattern

Every module follows the same pattern (all in one `.module.ts` file):
```typescript
// 1. DTOs / interfaces at the top
// 2. @Injectable() service class
// 3. @Controller('route-prefix') controller class
// 4. @Module({}) export at the bottom
```

This means **there are no separate `*.controller.ts` or `*.service.ts` files** — everything lives in `*.module.ts`.

---

## Authentication Flow

1. `POST /api/v1/auth/send-otp` → sends OTP via MSG91 WhatsApp to phone number
2. `POST /api/v1/auth/verify-otp` → validates OTP → returns `{ accessToken, refreshToken, user }`
3. All protected routes require `Authorization: Bearer <accessToken>` header
4. `POST /api/v1/auth/refresh` → exchange refresh token for new access token

**Roles:** `CUSTOMER`, `SERVICE_VENDOR`, `PRODUCT_VENDOR`, `DELIVERY_PARTNER`, `CRM_AGENT`, `ADMIN`, `SUPER_ADMIN`

**Public routes** (no auth): marked with `@Public()` decorator — includes `/auth/*`, `/ai/chat`, `/services/*`, `/products` (list+detail), `/cities/*`, `/memberships/plans`, `/amc/plans`, `/crm/leads/capture`, `/health/*`, `/payments/webhook`.

---

## AI Chat System

**File:** `backend/src/modules/ai-agent/ai-agent.module.ts`  
**Intent engine:** `backend/src/modules/ai-agent/intent-engine.ts` — rule-based keyword matching

**Intents recognised:** `AC`, `PLUMBING`, `ELECTRICAL`, `APPLIANCE`, `INTERIOR`, `RENOVATION`, `CONSTRUCTION`, `CLEANING`, `AMC`, `CORPORATE`, `UNKNOWN`

**Languages:** English and Hindi (detected automatically)

**To swap to an LLM:** Set `AI_PROVIDER=OPENAI` or `AI_PROVIDER=ANTHROPIC` in env, add API key. The intent engine in `intent-engine.ts` is the swap point.

**Frontend wiring:** `frontend/index.html` lines ~4030–4129 — the second `<script>` block.
- `sendChat(message)` → `POST /api/v1/ai/chat`
- `runSearch(query)` → `GET /api/v1/services/search?q=`

---

## Database

**ORM:** Prisma 5  
**DB:** PostgreSQL  
**Schema:** `backend/prisma/schema.prisma`

Key models: `User`, `ServiceVendor`, `ProductVendor`, `DeliveryPartner`, `ServiceCategory`, `Service`, `Product`, `Order`, `OrderItem`, `Invoice`, `WalletTransaction`, `Coupon`, `UserMembership`, `MembershipPlan`, `City`, `CityService`, `CorporateAccount`, `Lead`, `CrmActivity`, `AmcPlan`, `AmcSubscription`, `AiSession`, `PaymentTransaction`, `Delivery`, `Notification`

**Migrations:**
```bash
npx prisma migrate dev      # development — creates migration files
npx prisma migrate deploy   # production — applies pending migrations
npx prisma db seed          # seed admin + sample data
npx prisma studio           # visual DB browser
```

---

## Critical Configuration Points

### 1. CORS — `backend/src/main.ts:13`
The CORS allow-list is hardcoded + env var:
```typescript
origin: [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  'https://remontindia.com',
  'https://www.remontindia.com',
  'https://remontone.in',
]
```
**If your Vercel URL is not in this list, all API calls from the frontend will be blocked.** Set `FRONTEND_URL` in Railway env.

### 2. Global API prefix — `backend/src/main.ts:23`
```typescript
app.setGlobalPrefix('api/v1');
```
Every route is `/api/v1/...`. The Vercel rewrite matches `/api/:path*` (without the `v1`) to capture the entire path.

### 3. API base URL — `frontend/index.html` (second `<script>` block)
```javascript
var API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';
```
In production the empty string means relative URL → Vercel rewrite handles it.

### 4. vercel.json destination URL
```json
"destination": "https://REPLACE_WITH_RAILWAY_URL/api/:path*"
```
**This must be updated with the actual Railway domain before deploying to Vercel.**

---

## Known Issues Fixed (2026-06-18)

| Issue | Root Cause | Fix Applied |
|---|---|---|
| Backend crashes on start | `backend/.env` did not exist | Created `backend/.env` from `.env.example` |
| Vercel deploy rejected | No `vercel.json` | Created `vercel.json` with static output + API rewrite |
| Frontend has no API calls | `index.html` was pure static HTML with no fetch calls | Added second `<script>` block wiring AI chat + search to backend |
| Vercel build fails | No `build` script in `frontend/package.json` | Added `"build": "echo 'Static site'"` |

**AI agent route correction:** The controller is `@Controller('ai')` not `@Controller('ai-agent')`, so the route is `POST /api/v1/ai/chat` (not `/ai-agent/chat`).

**Services search correction:** `GET /api/v1/services/search?q=` is a GET with query string (not POST with body).

---

## Recovering From a Broken State

### Backend won't start
1. Check `backend/.env` exists and `DATABASE_URL` is set.
2. Check `JWT_SECRET` and `JWT_REFRESH_SECRET` are set (≥32 chars, different values).
3. Run `npx prisma generate` if Prisma client is missing.
4. Check Railway logs for the exact error.

### Frontend API calls fail (CORS error)
1. Check `FRONTEND_URL` in Railway matches your Vercel domain exactly (no trailing slash).
2. Redeploy the backend after updating the env var.

### Frontend API calls return 502/503
1. The Railway backend is not running — check Railway logs.
2. Check `vercel.json` destination URL matches your Railway domain.

### Database migration fails
```bash
npx prisma migrate reset   # WARNING: drops all data
npx prisma migrate deploy
npx prisma db seed
```

### Git rollback to pre-fix state
```bash
git checkout pre-deployment-fix-2026-06-18
```

---

## Local Dev Quick Start

```bash
# 1. Clone and install
git clone <repo>
cd remont-platform

# 2. Start infrastructure (PostgreSQL + Redis)
docker-compose up -d

# 3. Backend
cd backend
cp .env.example .env
# Edit .env — set DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET at minimum
npm install
npx prisma migrate dev
npx prisma db seed
npm run start:dev
# → http://localhost:3001/api/docs (Swagger)

# 4. Frontend (new terminal)
cd frontend
npm run dev
# → http://localhost:3000
```

---

## Files Modified / Created On 2026-06-18

| File | Action | Purpose |
|---|---|---|
| `vercel.json` | Created | Vercel deployment config |
| `frontend/.env.example` | Created | Documents frontend env var for local dev |
| `backend/.env` | Created | Local + Railway env (git-ignored) |
| `frontend/package.json` | Modified | Added `build` script |
| `frontend/index.html` | Modified | Added API connection `<script>` block |
| `DEPLOYMENT_FIX_REPORT.md` | Created | Detailed record of blockers and fixes |
| `FINAL_DEPLOYMENT_GUIDE.md` | Created | Step-by-step deploy instructions |
| `PROJECT_RECOVERY_GUIDE.md` | Created | This file |
