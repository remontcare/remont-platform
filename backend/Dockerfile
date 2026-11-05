FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY .npmrc ./
COPY prisma ./prisma/
RUN apk add --no-cache openssl
RUN npm ci --ignore-scripts

COPY . .
RUN npx prisma generate
RUN npm run build

# ─── Production stage ───
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache openssl

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

EXPOSE 3001

# Fail closed: if the schema cannot be prepared, the container exits non-zero instead of starting
# new code against an old schema (Railway's ON_FAILURE policy retries; with a dashboard health
# check the previous deployment keeps serving). `exec` makes node PID 1 so signals reach it.
# No --accept-data-loss: a schema change that would drop or truncate data is REFUSED by Prisma,
# so it stops the deploy instead of being applied (additive changes are unaffected).
CMD ["sh", "-c", "npx prisma db push 2>&1 && echo '✓ Schema pushed' && exec node dist/main || { echo '✖ DB push failed — refusing to start' >&2; exit 1; }"]
