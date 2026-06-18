# Deployment Fix Report
**Date:** 2026-06-18  
**Project:** remont-platform (Remont India — AI-powered home services platform)  
**Git backup tag:** `pre-deployment-fix-2026-06-18`

---

## 1. Deployment Blockers Identified

| # | Blocker | Severity |
|---|---|---|
| 1 | `backend/.env` does not exist — backend crashes on start without `DATABASE_URL` / `JWT_SECRET` | Critical |
| 2 | `vercel.json` does not exist — no deployment configuration for Vercel | Critical |
| 3 | Frontend (`index.html`) has zero API calls wired — static mockup only | High |
| 4 | `frontend/package.json` has no `build` script — Vercel rejects the build | High |

---

## 2. Files Changed

### Created
| File | Purpose |
|---|---|
| `vercel.json` | Tells Vercel to serve `frontend/` as static output; rewrites `/api/*` to Railway backend |
| `frontend/.env.example` | Documents the only frontend env var needed for local dev |
| `backend/.env` | Actual env file (git-ignored) — copy of `.env.example` with real values; required for local dev and Railway |

### Modified
| File | Change |
|---|---|
| `frontend/package.json` | Added `"build": "echo 'Static site — no build step required'"` script |
| `frontend/index.html` | Added `<script>` block before `</body>` (lines 4028–4095) wiring up AI chat, header search, and AI suggestion chips to verified backend endpoints |

---

## 3. All Required Environment Variables

### Backend (`backend/.env`) — also set in Railway dashboard for production

| Variable | Required | Purpose | Example |
|---|---|---|---|
| `NODE_ENV` | Yes | Runtime mode | `production` |
| `PORT` | Yes | Listen port | `3001` |
| `APP_URL` | Yes | Backend public URL | `https://your-app.up.railway.app` |
| `FRONTEND_URL` | Yes | CORS allow-list | `https://your-app.vercel.app` |
| `DATABASE_URL` | **Critical** | PostgreSQL connection | `postgresql://user:pass@host:5432/db` |
| `REDIS_URL` | Yes | Cache + real-time | `redis://user:pass@host:6379` |
| `JWT_SECRET` | **Critical** | Access token signing (≥32 chars) | random string |
| `JWT_EXPIRES_IN` | Yes | Token TTL | `7d` |
| `JWT_REFRESH_SECRET` | **Critical** | Refresh token signing (≥32 chars, different from JWT_SECRET) | random string |
| `JWT_REFRESH_EXPIRES_IN` | Yes | Refresh TTL | `30d` |
| `MSG91_AUTH_KEY` | Yes | SMS/WhatsApp OTP via MSG91 | from MSG91 dashboard |
| `MSG91_OTP_TEMPLATE_ID` | Yes | OTP message template ID | from MSG91 dashboard |
| `MSG91_SENDER_ID` | Yes | Sender ID | `RMNTIN` |
| `RAZORPAY_KEY_ID` | Yes | Payment gateway public key | `rzp_live_xxx` |
| `RAZORPAY_KEY_SECRET` | Yes | Payment gateway secret | from Razorpay dashboard |
| `RAZORPAY_WEBHOOK_SECRET` | Yes | Webhook signature verification | from Razorpay dashboard |
| `CLOUDINARY_CLOUD_NAME` | Yes | Image storage | from Cloudinary dashboard |
| `CLOUDINARY_API_KEY` | Yes | Image storage | from Cloudinary dashboard |
| `CLOUDINARY_API_SECRET` | Yes | Image storage | from Cloudinary dashboard |
| `AI_PROVIDER` | Yes | LLM mode: `RULE_BASED`, `OPENAI`, or `ANTHROPIC` | `RULE_BASED` |
| `OPENAI_API_KEY` | Optional | Required if `AI_PROVIDER=OPENAI` | `sk-...` |
| `ANTHROPIC_API_KEY` | Optional | Required if `AI_PROVIDER=ANTHROPIC` | `sk-ant-...` |
| `ADMIN_DEFAULT_PHONE` | Yes | Seed admin phone | `+919876543210` |
| `ADMIN_DEFAULT_EMAIL` | Yes | Seed admin email | `admin@remontindia.com` |
| `CRM_WEBHOOK_URL` | Optional | External CRM webhook | — |
| `CRM_WEBHOOK_SECRET` | Optional | External CRM HMAC secret | — |

### Frontend (`frontend/.env.example`) — local dev only

| Variable | Purpose |
|---|---|
| `API_BASE_URL` | Backend base URL for local dev (`http://localhost:3001`). In production Vercel rewrites `/api/*` — no env var needed. |

---

## 4. All API Routes (base prefix: `/api/v1`)

### Health (Public)
```
GET  /api/v1/health          → { status, uptime, timestamp }
GET  /api/v1/health/ready    → { status, databaseConfigured, timestamp }
```

### Authentication (Public)
```
POST /api/v1/auth/send-otp      body: { phone, role? }
POST /api/v1/auth/verify-otp    body: { phone, otp, name?, email?, language? }
POST /api/v1/auth/refresh        body: { refreshToken }
GET  /api/v1/auth/me             [JWT]
```

### AI Agent (controller: `ai`)
```
POST /api/v1/ai/chat             [Public]  body: { message, sessionId?, userId?, channel?, customerPhone?, customerName?, city? }
POST /api/v1/ai/session/end      [Public]  body: { sessionId, orderId? }
GET  /api/v1/ai/sessions/mine    [JWT]
GET  /api/v1/ai/sessions/:id     [Public]
```
Response shape from `/ai/chat`:
```json
{ "sessionId": "...", "reply": "...", "intent": "AC|PLUMBING|...", "confidence": 0.9, "language": "EN|HI", "suggestions": [], "leadId": "..." }
```

### Services (Public)
```
GET /api/v1/services/categories          ?city=
GET /api/v1/services/categories/:key
GET /api/v1/services/popular
GET /api/v1/services/premium
GET /api/v1/services/search              ?q=     ← GET with query string, NOT POST
GET /api/v1/services/:id                 ?city=
```

### Products (Public / JWT)
```
GET   /api/v1/products                   ?category=&vendor=&q=&city=&limit=
GET   /api/v1/products/:slug
GET   /api/v1/products/vendor/mine       [JWT + PRODUCT_VENDOR]
POST  /api/v1/products                   [JWT + PRODUCT_VENDOR]
PATCH /api/v1/products/:id               [JWT + PRODUCT_VENDOR]
```

### Orders [JWT]
```
POST  /api/v1/orders
POST  /api/v1/orders/:id/confirm-payment
GET   /api/v1/orders/mine                ?status=
GET   /api/v1/orders/:id
PATCH /api/v1/orders/:id/cancel
PATCH /api/v1/orders/:id/en-route
POST  /api/v1/orders/:id/verify-otp
POST  /api/v1/orders/:id/extra-work
PATCH /api/v1/orders/extra-work/:extraId/approve
POST  /api/v1/orders/:id/complete
```

### Payments
```
POST /api/v1/payments/create-order    [JWT]
POST /api/v1/payments/verify          [JWT]
POST /api/v1/payments/webhook         [Public — Razorpay HMAC signed]
```

### AMC
```
GET   /api/v1/amc/plans               [Public]  ?city=
GET   /api/v1/amc/plans/:id           [Public]
POST  /api/v1/amc/subscribe           [JWT]
GET   /api/v1/amc/mine                [JWT]
POST  /api/v1/amc/:id/use-service     [JWT]
POST  /api/v1/amc/:id/renew           [JWT]
PATCH /api/v1/amc/:id/cancel          [JWT]
POST  /api/v1/amc/plans               [JWT + ADMIN]
```

### CRM
```
POST  /api/v1/crm/leads/capture                    [Public]
GET   /api/v1/crm/leads                            [JWT + CRM_AGENT/ADMIN]  ?status=&agentId=&source=&limit=
GET   /api/v1/crm/leads/mine                       [JWT + CRM_AGENT/ADMIN]
GET   /api/v1/crm/leads/:id                        [JWT + CRM_AGENT/ADMIN]
PATCH /api/v1/crm/leads/:id/assign                 [JWT + ADMIN]
PATCH /api/v1/crm/leads/:id/status                 [JWT + CRM_AGENT/ADMIN]
POST  /api/v1/crm/leads/:id/activity               [JWT + CRM_AGENT/ADMIN]
GET   /api/v1/crm/analytics/funnel                 [JWT + CRM_AGENT/ADMIN]
GET   /api/v1/crm/analytics/agent/:agentId         [JWT + CRM_AGENT/ADMIN]
```

### Users [JWT]
```
GET    /api/v1/users/me
PATCH  /api/v1/users/me
GET    /api/v1/users/me/addresses
POST   /api/v1/users/me/addresses
DELETE /api/v1/users/me/addresses/:id
```

### Cities
```
GET   /api/v1/cities                        [Public]
GET   /api/v1/cities/serviceability         [Public]  ?pincode=
GET   /api/v1/cities/:name/services         [Public]
PATCH /api/v1/cities/:name/services         [JWT + ADMIN]
PATCH /api/v1/cities/:name/pricing          [JWT + ADMIN]
```

### Memberships
```
GET  /api/v1/memberships/plans              [Public]
GET  /api/v1/memberships/plans/:id          [Public]
POST /api/v1/memberships/subscribe          [JWT]
```

### Coupons [JWT]
```
GET  /api/v1/coupons/available
POST /api/v1/coupons/validate
POST /api/v1/coupons                        [JWT + ADMIN]
```

### Wallet [JWT]
```
GET /api/v1/wallet/balance
GET /api/v1/wallet/transactions
```

### Invoices [JWT]
```
POST /api/v1/invoices/orders/:orderId/generate
GET  /api/v1/invoices/orders/:orderId
```

### Vendors — Service [JWT + SERVICE_VENDOR]
```
POST  /api/v1/vendors/service/register
GET   /api/v1/vendors/service/me
PATCH /api/v1/vendors/service/me/location
PATCH /api/v1/vendors/service/me/status
GET   /api/v1/vendors/service/me/earnings
GET   /api/v1/vendors/service/me/jobs         ?status=
POST  /api/v1/vendors/service/me/jobs/:orderId/accept
```

### Vendors — Product [JWT + PRODUCT_VENDOR]
```
POST /api/v1/vendors/product/register
GET  /api/v1/vendors/product/me
GET  /api/v1/vendors/product/me/dashboard
```

### Delivery [JWT + DELIVERY_PARTNER / SERVICE_VENDOR]
```
POST  /api/v1/delivery/register
PATCH /api/v1/delivery/me/location
GET   /api/v1/delivery/me/deliveries
PATCH /api/v1/delivery/:id/status
```

### Corporate [JWT]
```
POST /api/v1/corporate/accounts                     [ADMIN]
POST /api/v1/corporate/accounts/:id/members         [ADMIN]
GET  /api/v1/corporate/dashboard
POST /api/v1/corporate/orders/:id/approve
```

### Admin [JWT + ADMIN / SUPER_ADMIN]
```
GET   /api/v1/admin/stats
GET   /api/v1/admin/users                           ?role=&q=&limit=&offset=
PATCH /api/v1/admin/users/:id/block
PATCH /api/v1/admin/users/:id/wallet
GET   /api/v1/admin/vendors/pending
PATCH /api/v1/admin/vendors/:id/approve
PATCH /api/v1/admin/vendors/:id/reject
PATCH /api/v1/admin/vendors/:id/suspend
GET   /api/v1/admin/orders                          ?status=&city=&limit=&offset=
PATCH /api/v1/admin/orders/:id/assign-vendor
PATCH /api/v1/admin/orders/:id/refund
PATCH /api/v1/admin/cities/:name/toggle
```

---

## 5. Architecture Summary

```
[Vercel — Static Frontend]        [Railway — NestJS Backend]
  frontend/index.html        →     /api/v1/* (port 3001)
  Vercel rewrite proxy              ↕
  /api/* → Railway URL        [PostgreSQL + Redis]
                                    ↕
                              [Prisma ORM]
```

**Frontend:** Vanilla HTML/CSS/JS — no framework, no build step.  
**Backend:** NestJS 10 + Prisma 5 + PostgreSQL + Redis. Deployed via Railway (nixpacks).  
**OTP auth:** Phone-based via MSG91 WhatsApp/SMS.  
**Payments:** Razorpay (live + webhook).  
**Storage:** Cloudinary.  
**AI:** Rule-based intent engine (swap to OpenAI/Anthropic via `AI_PROVIDER` env var).
