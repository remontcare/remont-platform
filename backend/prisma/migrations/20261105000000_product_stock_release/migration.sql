-- Product stock reservation tracking (additive, nullable).
ALTER TABLE "Order" ADD COLUMN "stockReservedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "stockReleasedAt" TIMESTAMP(3);
