-- Vendor auto-dispatch retry tracking — purely additive migration.
-- Lets DispatchRetryService find orders whose last dispatch wave is stale enough to
-- re-cycle, and lets the admin "stuck orders" queue find confirmed, unassigned orders
-- that already had at least one dispatch wave go out with no vendor accepting.
-- Safe to run against the live database with zero downtime.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastDispatchedAt" TIMESTAMP(3);
