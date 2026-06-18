# Claude Project Context — Remont India

> **INSTRUCTION FOR CLAUDE:**
> Never scan the entire repository unless explicitly requested.
> Read this file first and inspect only the specific files relevant to the task at hand.
> All architecture, routes, env vars, and deployment config are documented here.

---

## Project Identity

| Key | Value |
|---|---|
| Name | Remont India — AI-powered home services platform |
| Frontend | Vanilla HTML/CSS/JS — single file `frontend/index.html` (~4130 lines) |
| Backend | NestJS 10, served via Railway, listens on port `3001` |
| Global API prefix | `/api/v1` (set in `backend/src/main.ts:23`) |
| ORM | Prisma 5 → PostgreSQL |
| Cache / real-time | Redis |
| Auth | Phone OTP via MSG91 → JWT (access + refresh) |
| Payments | Razorpay |
| Images | Cloudinary |
| AI | Rule-based intent engine; swap via `AI_PROVIDER` env var |
| Frontend deploy | Vercel — `outputDirectory: frontend`, `/api/*` rewrite to Railway |
| Backend deploy | Railway — `nixpacks.toml` installs openssl |
| Git backup tag | `pre-deployment-fix-2026-06-18` |

---

## Architecture

```
Browser
  ├── page load  →  Vercel CDN (serves frontend/index.html)
  └── /api/*     →  Vercel rewrite → Railway NestJS backend
                         ↕
                   PostgreSQL (Prisma)  +  Redis
```

**CORS allow-list** (backend `main.ts:14`):
- `process.env.FRONTEND_URL` (set to Vercel URL)
- `https://remontindia.com`
- `https://www.remontindia.com`
- `https://remontone.in`

**Frontend API URL detection** (`index.html`, second `<script>` block, ~line 4030):
```javascript
var API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';
```

---

## Backend Module Pattern

All modules use a single-file pattern — no separate controller/service files:
```
backend/src/modules/<name>/<name>.module.ts
  contains: DTOs → @Injectable() service → @Controller() controller → @Module()
```

---

## All API Routes (prefix: `/api/v1`)

### Health (Public)
```
GET  /health          → { status, uptime, timestamp }
GET  /health/ready    → { status, databaseConfigured, timestamp }
```

### Auth (Public unless noted)
```
POST /auth/send-otp      body: { phone, role? }
POST /auth/verify-otp    body: { phone, otp, name?, email?, language? }
POST /auth/refresh        body: { refreshToken }
GET  /auth/me             [JWT]
```

### AI Agent — controller prefix: `ai` (NOT `ai-agent`)
```
POST /ai/chat             [Public]  body: { message, sessionId?, userId?, channel?, customerPhone?, customerName?, city? }
POST /ai/session/end      [Public]  body: { sessionId, orderId? }
GET  /ai/sessions/mine    [JWT]
GET  /ai/sessions/:id     [Public]
```
Response: `{ sessionId, reply, intent, confidence, language, suggestions[], leadId }`  
Intents: `AC | PLUMBING | ELECTRICAL | APPLIANCE | INTERIOR | RENOVATION | CONSTRUCTION | CLEANING | AMC | CORPORATE | UNKNOWN`

### Services (All Public)
```
GET /services/categories       ?city=
GET /services/categories/:key
GET /services/popular
GET /services/premium
GET /services/search           ?q=    ← GET with query string, NOT POST
GET /services/:id              ?city=
```

### Products
```
GET   /products                [Public]  ?category=&vendor=&q=&city=&limit=
GET   /products/:slug          [Public]
GET   /products/vendor/mine    [JWT + PRODUCT_VENDOR]
POST  /products                [JWT + PRODUCT_VENDOR]
PATCH /products/:id            [JWT + PRODUCT_VENDOR]
```

### Orders (All JWT)
```
POST  /orders
POST  /orders/:id/confirm-payment
GET   /orders/mine                       ?status=
GET   /orders/:id
PATCH /orders/:id/cancel
PATCH /orders/:id/en-route
POST  /orders/:id/verify-otp
POST  /orders/:id/extra-work
PATCH /orders/extra-work/:extraId/approve
POST  /orders/:id/complete
```

### Payments
```
POST /payments/create-order    [JWT]
POST /payments/verify          [JWT]
POST /payments/webhook         [Public — Razorpay HMAC signed via x-razorpay-signature header]
```

### AMC
```
GET   /amc/plans               [Public]  ?city=
GET   /amc/plans/:id           [Public]
POST  /amc/subscribe           [JWT]
GET   /amc/mine                [JWT]
POST  /amc/:id/use-service     [JWT]
POST  /amc/:id/renew           [JWT]
PATCH /amc/:id/cancel          [JWT]
POST  /amc/plans               [JWT + ADMIN]
```

### CRM
```
POST  /crm/leads/capture                   [Public]
GET   /crm/leads                           [JWT + CRM_AGENT/ADMIN]  ?status=&agentId=&source=&limit=
GET   /crm/leads/mine                      [JWT + CRM_AGENT/ADMIN]
GET   /crm/leads/:id                       [JWT + CRM_AGENT/ADMIN]
PATCH /crm/leads/:id/assign                [JWT + ADMIN]
PATCH /crm/leads/:id/status                [JWT + CRM_AGENT/ADMIN]
POST  /crm/leads/:id/activity              [JWT + CRM_AGENT/ADMIN]
GET   /crm/analytics/funnel                [JWT + CRM_AGENT/ADMIN]
GET   /crm/analytics/agent/:agentId        [JWT + CRM_AGENT/ADMIN]
```

### Users (All JWT)
```
GET    /users/me
PATCH  /users/me
GET    /users/me/addresses
POST   /users/me/addresses
DELETE /users/me/addresses/:id
```

### Cities
```
GET   /cities                       [Public]
GET   /cities/serviceability        [Public]  ?pincode=
GET   /cities/:name/services        [Public]
PATCH /cities/:name/services        [JWT + ADMIN]
PATCH /cities/:name/pricing         [JWT + ADMIN]
```

### Memberships
```
GET  /memberships/plans             [Public]
GET  /memberships/plans/:id         [Public]
POST /memberships/subscribe         [JWT]
```

### Coupons
```
GET  /coupons/available             [JWT]
POST /coupons/validate              [JWT]
POST /coupons                       [JWT + ADMIN]
```

### Wallet (All JWT)
```
GET /wallet/balance
GET /wallet/transactions
```

### Invoices (All JWT)
```
POST /invoices/orders/:orderId/generate
GET  /invoices/orders/:orderId
```

### Vendors — Service (All JWT + SERVICE_VENDOR)
```
POST  /vendors/service/register
GET   /vendors/service/me
PATCH /vendors/service/me/location
PATCH /vendors/service/me/status
GET   /vendors/service/me/earnings
GET   /vendors/service/me/jobs           ?status=
POST  /vendors/service/me/jobs/:orderId/accept
```

### Vendors — Product (All JWT + PRODUCT_VENDOR)
```
POST /vendors/product/register
GET  /vendors/product/me
GET  /vendors/product/me/dashboard
```

### Delivery (All JWT + DELIVERY_PARTNER / SERVICE_VENDOR)
```
POST  /delivery/register
PATCH /delivery/me/location
GET   /delivery/me/deliveries
PATCH /delivery/:id/status
```

### Corporate
```
POST /corporate/accounts                    [JWT + ADMIN]
POST /corporate/accounts/:id/members        [JWT + ADMIN]
GET  /corporate/dashboard                   [JWT]
POST /corporate/orders/:id/approve          [JWT]
```

### Admin (All JWT + ADMIN / SUPER_ADMIN)
```
GET   /admin/stats
GET   /admin/users                          ?role=&q=&limit=&offset=
PATCH /admin/users/:id/block
PATCH /admin/users/:id/wallet
GET   /admin/vendors/pending
PATCH /admin/vendors/:id/approve
PATCH /admin/vendors/:id/reject
PATCH /admin/vendors/:id/suspend
GET   /admin/orders                         ?status=&city=&limit=&offset=
PATCH /admin/orders/:id/assign-vendor
PATCH /admin/orders/:id/refund
PATCH /admin/cities/:name/toggle
```

---

## Deployment Configuration

### vercel.json (root)
```json
{
  "version": 2,
  "outputDirectory": "frontend",
  "rewrites": [{ "source": "/api/:path*", "destination": "https://REPLACE_WITH_RAILWAY_URL/api/:path*" }]
}
```
**Action required:** Replace `REPLACE_WITH_RAILWAY_URL` with actual Railway domain after backend deploys.

### Railway (backend)
- Root directory: `backend/`
- Build: nixpacks (reads `nixpacks.toml` — installs openssl)
- Start: `node dist/main.js`
- PostgreSQL and Redis added as Railway plugins (auto-inject `DATABASE_URL`, `REDIS_URL`)

### Swagger (dev only)
Available at `http://localhost:3001/api/docs` when `NODE_ENV !== production`.

---

## Environment Variables

### Backend — `backend/.env` (local) / Railway dashboard (production)

| Variable | Critical | Notes |
|---|---|---|
| `NODE_ENV` | | `development` or `production` |
| `PORT` | | `3001` |
| `APP_URL` | | Backend public URL |
| `FRONTEND_URL` | | Must match Vercel domain for CORS |
| `DATABASE_URL` | **Yes** | Backend won't start without this |
| `REDIS_URL` | | Cache + sockets |
| `JWT_SECRET` | **Yes** | Min 32 chars; generate: `openssl rand -hex 32` |
| `JWT_EXPIRES_IN` | | `7d` |
| `JWT_REFRESH_SECRET` | **Yes** | Min 32 chars; must differ from `JWT_SECRET` |
| `JWT_REFRESH_EXPIRES_IN` | | `30d` |
| `MSG91_AUTH_KEY` | | OTP SMS/WhatsApp |
| `MSG91_OTP_TEMPLATE_ID` | | OTP template |
| `MSG91_SENDER_ID` | | `RMNTIN` |
| `RAZORPAY_KEY_ID` | | Payments |
| `RAZORPAY_KEY_SECRET` | | Payments |
| `RAZORPAY_WEBHOOK_SECRET` | | Webhook HMAC verify |
| `CLOUDINARY_CLOUD_NAME` | | Image uploads |
| `CLOUDINARY_API_KEY` | | Image uploads |
| `CLOUDINARY_API_SECRET` | | Image uploads |
| `AI_PROVIDER` | | `RULE_BASED` \| `OPENAI` \| `ANTHROPIC` |
| `OPENAI_API_KEY` | | Only if `AI_PROVIDER=OPENAI` |
| `ANTHROPIC_API_KEY` | | Only if `AI_PROVIDER=ANTHROPIC` |
| `ADMIN_DEFAULT_PHONE` | | Seed script |
| `ADMIN_DEFAULT_EMAIL` | | Seed script |
| `CRM_WEBHOOK_URL` | | Optional |
| `CRM_WEBHOOK_SECRET` | | Optional |

### Frontend — local dev only
| Variable | Notes |
|---|---|
| `API_BASE_URL` | `http://localhost:3001` — documented in `frontend/.env.example`; not injected at runtime |

---

## Files Modified 2026-06-18

| File | Action | Why |
|---|---|---|
| `vercel.json` | Created | No Vercel config existed |
| `frontend/.env.example` | Created | No frontend env documentation |
| `backend/.env` | Created (git-ignored) | Backend crashed without it |
| `frontend/package.json` | Modified | Added `build` script for Vercel CI |
| `frontend/index.html` | Modified (+91 lines) | Frontend had zero API calls |
| `DEPLOYMENT_FIX_REPORT.md` | Created | Fix audit trail |
| `FINAL_DEPLOYMENT_GUIDE.md` | Created | Step-by-step deploy instructions |
| `PROJECT_RECOVERY_GUIDE.md` | Created | Full recovery reference |
| `CLAUDE_PROJECT_CONTEXT.md` | Created | This file |
| `PROJECT_MAP.md` | Created | File-level project map |

---

## User Roles

`CUSTOMER` · `SERVICE_VENDOR` · `PRODUCT_VENDOR` · `DELIVERY_PARTNER` · `CRM_AGENT` · `ADMIN` · `SUPER_ADMIN`

---

## Common Investigation Starting Points

| Question | File to read first |
|---|---|
| How does auth work? | `backend/src/modules/auth/auth.module.ts` |
| How does the AI chat work? | `backend/src/modules/ai-agent/ai-agent.module.ts` + `intent-engine.ts` |
| How are orders processed? | `backend/src/modules/orders/orders.module.ts` |
| What DB models exist? | `backend/prisma/schema.prisma` |
| How does the frontend call the backend? | `frontend/index.html` — second `<script>` block (~line 4030) |
| What modules are registered? | `backend/src/app.module.ts` |
| How does CORS work? | `backend/src/main.ts` lines 13–21 |
| Where is global API prefix set? | `backend/src/main.ts` line 23 |
