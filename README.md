# 🏠 Remont India — Production Platform

AI-powered home services + products marketplace for India.
**Backend** (NestJS) + **Frontend** (Next.js / single-file HTML) + **APIs** for CRM, AMC, AI Agent integration.

---

## ⚡ Quick Start (Local Development)

### Prerequisites
- Node.js 20+
- PostgreSQL 16 (or use Docker)
- Redis 7 (or use Docker)
- npm or pnpm

### Option 1: Docker (recommended)
```bash
cd remont-platform
docker-compose up -d
# Backend running on http://localhost:3001
# API docs at http://localhost:3001/api/docs
```

### Option 2: Manual setup
```bash
cd remont-platform/backend
cp .env.example .env       # Update DATABASE_URL, JWT secrets etc.
npm install
npx prisma generate
npx prisma migrate dev     # Creates tables
npm run db:seed            # Loads cities, services, AMC plans, admin
npm run start:dev          # Starts API on http://localhost:3001
```

### Default Admin
After seeding:
- **Phone:** `+919876543210` (override via `ADMIN_DEFAULT_PHONE` env)
- **Email:** `admin@remontindia.com`
- **Role:** `SUPER_ADMIN`

To log in, hit `POST /api/v1/auth/send-otp` then `POST /api/v1/auth/verify-otp`. In dev mode, OTPs print to console.

---

## 🏗 Architecture Overview

### Tech Stack
| Layer | Tech |
|---|---|
| Backend | NestJS 10, TypeScript 5 |
| Database | PostgreSQL 16, Prisma 5 |
| Cache + Queue | Redis 7 |
| Auth | JWT + Passport (OTP-based) |
| Payments | Razorpay |
| WhatsApp / SMS | MSG91 |
| Storage | Cloudinary |
| Real-time | Socket.io |
| Frontend | Next.js 14 / Tailwind / ShadCN |

### 20 Modules
**Identity & Catalog:** Auth · Users · Cities · Services · Products
**Operations:** Vendors · Delivery · Orders · Invoices
**Money:** Wallet · Coupons · Memberships · Payments
**Strategic:** CRM · AMC · AI Agent · Corporate B2B
**Comms:** WhatsApp · Notifications · Admin

### Database
35 Prisma models. See `backend/prisma/schema.prisma` for full schema.

---

## 📡 Key APIs

Base URL: `http://localhost:3001/api/v1`

| Module | Sample endpoint |
|---|---|
| Auth | `POST /auth/send-otp` `POST /auth/verify-otp` |
| Services | `GET /services/categories?city=Mumbai` |
| Products | `GET /products?category=ac` |
| Orders | `POST /orders` `POST /orders/:id/confirm-payment` |
| AMC | `GET /amc/plans` `POST /amc/subscribe` |
| CRM | `POST /crm/leads/capture` `GET /crm/analytics/funnel` |
| AI Agent | `POST /ai/chat` `POST /ai/session/end` |
| Admin | `GET /admin/stats` `PATCH /admin/vendors/:id/approve` |
| Payments | `POST /payments/create-order` `POST /payments/webhook` |

Full API docs at `http://localhost:3001/api/docs` (Swagger UI).

---

## 🤖 AI Agent — Rule-based now, LLM-ready

The AI chat engine is rule-based today (see `src/modules/ai-agent/intent-engine.ts`).
It handles Hindi / English / Hinglish with 200+ keywords mapped to 14 intents.

To swap with OpenAI/Anthropic LLM later, replace `detectIntent()` in that one file:

```typescript
// Replace this function only:
export async function detectIntent(text: string) {
  const res = await openai.chat.completions.create({ /* ... */ });
  return { intent: res.intent, confidence: 1.0 };
}
```

No other code changes needed.

---

## 🚀 Deployment

### Production (recommended)
- **Frontend** → Vercel (free tier) → `remontindia.com`
- **Backend API** → Railway / Render / DigitalOcean → `api.remontindia.com`
- **Database** → Supabase / Neon (managed PostgreSQL)
- **Redis** → Upstash (serverless)
- **CDN** → Cloudflare (free)
- **Storage** → Cloudinary (free 25GB)

Estimated cost at launch: **~₹12,500/month**.

### Environment variables (production)
See `backend/.env.example` for the full list. Critical ones:
```
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=<32+ char random>
JWT_REFRESH_SECRET=<32+ char random>
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
MSG91_AUTH_KEY=...
FRONTEND_URL=https://remontindia.com
```

---

## 📂 Project Structure

```
remont-platform/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma     # 35 models, 16 enums
│   │   └── seed.ts            # Cities, services, AMC plans, admin
│   ├── src/
│   │   ├── main.ts            # Bootstrap (Swagger + CORS)
│   │   ├── app.module.ts      # Wires all 20 modules
│   │   ├── common/            # Decorators, guards, utils
│   │   ├── prisma/            # PrismaService (global)
│   │   └── modules/           # 20 self-contained modules
│   │       ├── auth/
│   │       ├── users/
│   │       ├── cities/
│   │       ├── services/
│   │       ├── products/
│   │       ├── vendors/
│   │       ├── delivery/
│   │       ├── orders/
│   │       ├── invoices/
│   │       ├── wallet/
│   │       ├── coupons/
│   │       ├── memberships/
│   │       ├── corporate/
│   │       ├── whatsapp/
│   │       ├── notifications/
│   │       ├── payments/
│   │       ├── crm/           # ★ NEW — Leads, funnel
│   │       ├── amc/           # ★ NEW — Subscriptions
│   │       ├── ai-agent/      # ★ NEW — Inbuilt AI chat
│   │       └── admin/
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── .env.example
├── frontend/
│   └── index.html             # Single-file UI (desktop + mobile shell)
├── docker-compose.yml
└── README.md
```

---

## 🧪 Testing the Setup

After seed, test the full flow:

```bash
# 1. Send OTP
curl -X POST http://localhost:3001/api/v1/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone":"+919876543210"}'

# Check console for OTP (dev mode)

# 2. Verify OTP
curl -X POST http://localhost:3001/api/v1/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone":"+919876543210","otp":"123456"}'

# 3. Test AI chat (public)
curl -X POST http://localhost:3001/api/v1/ai/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"AC se thandi hawa nahi aati","city":"Mumbai"}'
```

---

## 📞 Support

- **Tech docs:** `/api/docs` (Swagger UI)
- **Prisma Studio:** `npm run db:studio` → `http://localhost:5555`
- **Database reset:** `npm run db:reset` (⚠️ wipes data)

---

## 🛣 Roadmap (post-launch)

- [ ] Swap rule-based AI with OpenAI / Anthropic LLM
- [ ] Flutter mobile apps (customer + vendor)
- [ ] Multi-city read replicas
- [ ] Service vendor success agent (autonomous)
- [ ] Customer sales agent (autonomous)

---

**Built with ❤️ for India.**
© 2026 Remont India Technologies Pvt. Ltd.
