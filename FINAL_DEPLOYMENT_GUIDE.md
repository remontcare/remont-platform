# Final Deployment Guide
**Project:** Remont India — AI-Powered Home Services Platform  
**Date produced:** 2026-06-18  
**Stack:** NestJS 10 (Railway) + Vanilla HTML (Vercel) + PostgreSQL + Redis

---

## Architecture

```
[Browser]
   │  page load → Vercel CDN (frontend/)
   │  /api/* calls → Vercel rewrite → Railway backend
   ▼
[Vercel — Static Frontend]          [Railway — NestJS Backend :3001]
  frontend/index.html                /api/v1/* routes
  Served from outputDirectory        Uses Prisma → PostgreSQL
  Rewrite: /api/* → Railway          OTP via MSG91
                                     Payments via Razorpay
                                     Images via Cloudinary
```

---

## Step 1 — Deploy Backend to Railway

### 1a. Create a Railway project
1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo.
2. Select the `remont-platform` repo.
3. Set the **root directory** to `backend`.

### 1b. Add PostgreSQL and Redis
- In your Railway project → New → Database → Add **PostgreSQL**.
- Add **Redis** the same way.
- Railway auto-injects `DATABASE_URL` and `REDIS_URL` into the service environment.

### 1c. Set environment variables in Railway dashboard
Go to your backend service → Variables. Add every variable from this list:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `APP_URL` | `https://<your-railway-domain>` (fill after first deploy) |
| `FRONTEND_URL` | `https://<your-vercel-domain>` (fill after Vercel deploy) |
| `DATABASE_URL` | Auto-injected by Railway PostgreSQL plugin |
| `REDIS_URL` | Auto-injected by Railway Redis plugin |
| `JWT_SECRET` | Run `openssl rand -hex 32` — paste result |
| `JWT_EXPIRES_IN` | `7d` |
| `JWT_REFRESH_SECRET` | Run `openssl rand -hex 32` again — **must differ from JWT_SECRET** |
| `JWT_REFRESH_EXPIRES_IN` | `30d` |
| `MSG91_AUTH_KEY` | From [msg91.com](https://msg91.com) dashboard |
| `MSG91_OTP_TEMPLATE_ID` | From MSG91 dashboard |
| `MSG91_SENDER_ID` | `RMNTIN` |
| `RAZORPAY_KEY_ID` | From [razorpay.com](https://razorpay.com) dashboard |
| `RAZORPAY_KEY_SECRET` | From Razorpay dashboard |
| `RAZORPAY_WEBHOOK_SECRET` | From Razorpay → Webhooks → your webhook secret |
| `CLOUDINARY_CLOUD_NAME` | From [cloudinary.com](https://cloudinary.com) dashboard |
| `CLOUDINARY_API_KEY` | From Cloudinary dashboard |
| `CLOUDINARY_API_SECRET` | From Cloudinary dashboard |
| `AI_PROVIDER` | `RULE_BASED` (or `OPENAI` / `ANTHROPIC`) |
| `OPENAI_API_KEY` | Only if `AI_PROVIDER=OPENAI` |
| `ANTHROPIC_API_KEY` | Only if `AI_PROVIDER=ANTHROPIC` |
| `ADMIN_DEFAULT_PHONE` | `+919876543210` |
| `ADMIN_DEFAULT_EMAIL` | `admin@remontindia.com` |

### 1d. Run database migrations
In Railway → your backend service → Shell (or via Railway CLI):
```bash
npx prisma migrate deploy
npx prisma db seed   # optional: creates admin user and sample data
```

### 1e. Verify health check
```
GET https://<your-railway-domain>/api/v1/health
→ { "status": "ok", "uptime": ..., "timestamp": "..." }

GET https://<your-railway-domain>/api/v1/health/ready
→ { "status": "ready", "databaseConfigured": true, "timestamp": "..." }
```
If `databaseConfigured: false` — `DATABASE_URL` env var is missing.

---

## Step 2 — Deploy Frontend to Vercel

### 2a. Update vercel.json with your Railway URL
Open `vercel.json` and replace the placeholder:
```json
{
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://YOUR-ACTUAL-RAILWAY-DOMAIN.up.railway.app/api/:path*"
    }
  ]
}
```
Commit this change.

### 2b. Import to Vercel
1. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub.
2. Select `remont-platform` repo.
3. **Framework Preset:** Other (or leave as auto-detected).
4. **Root Directory:** leave as `/` (root — `vercel.json` at root handles routing).
5. **Build Command:** leave blank (the `package.json` `build` script echoes a message).
6. **Output Directory:** leave blank (`vercel.json` sets `outputDirectory: "frontend"`).
7. Deploy.

### 2c. Update CORS in Railway
After getting your Vercel URL (e.g. `https://remont-platform.vercel.app`), go back to Railway and update:
- `FRONTEND_URL` = your Vercel URL
- `APP_URL` = your Railway URL

The backend CORS allow-list also includes `https://remontindia.com` and `https://remontone.in` — add those to Vercel's domain settings when you have a custom domain.

---

## Step 3 — Configure Razorpay Webhook

In Razorpay dashboard → Settings → Webhooks → Add new webhook:
- **URL:** `https://<your-railway-domain>/api/v1/payments/webhook`
- **Events:** `payment.captured`
- **Secret:** must match `RAZORPAY_WEBHOOK_SECRET` in Railway

---

## Step 4 — Verify End-to-End

Run these checks in order:

```
1. Backend health
   GET https://<railway>/api/v1/health
   Expected: { status: "ok" }

2. AI chat (public, no auth)
   POST https://<railway>/api/v1/ai/chat
   Body: { "message": "AC not cooling", "city": "Delhi" }
   Expected: { reply: "...", intent: "AC", suggestions: [...] }

3. Services list (public)
   GET https://<railway>/api/v1/services/categories?city=Delhi
   Expected: array of service categories

4. Frontend loads (Vercel)
   Open https://<vercel-domain>
   Expected: Remont India homepage renders

5. AI widget (frontend → backend via Vercel rewrite)
   Type "AC not cooling" in the homepage chat widget → click send
   Expected: reply text replaces the default greeting
   Open browser DevTools → Network → filter /api → confirm request goes to /api/v1/ai/chat
```

---

## Local Development

### Backend
```bash
cd backend
cp .env.example .env   # already done — fill in real values
npm install
npx prisma migrate dev
npm run start:dev      # runs on http://localhost:3001
# Swagger docs: http://localhost:3001/api/docs
```

### Frontend
```bash
cd frontend
npm run dev            # serves on http://localhost:3000
```

The JS in `index.html` auto-detects `localhost` and points API calls directly to `http://localhost:3001` — no proxy needed locally.

---

## Domain Setup (Optional)

| Domain | Points to |
|---|---|
| `remontindia.com` | Vercel (frontend) |
| `api.remontindia.com` | Railway (backend) — then update `vercel.json` destination |
| `remontone.in` | Vercel (alternate domain) |

---

## Rollback

The pre-fix git tag `pre-deployment-fix-2026-06-18` marks the state before these deployment changes. To roll back:
```bash
git checkout pre-deployment-fix-2026-06-18
```
