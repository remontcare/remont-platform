-- Phase 1 hardening (M-06): optional client-supplied dedupe token on Order/MasterOrder.
-- Purely additive — nullable column, no default needed, no backfill. A unique index over a
-- nullable Postgres column permits any number of NULL rows, so every existing row (and every
-- caller that never sends a key) is completely unaffected.
ALTER TABLE "MasterOrder" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "MasterOrder_idempotencyKey_key" ON "MasterOrder"("idempotencyKey");

ALTER TABLE "Order" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");
