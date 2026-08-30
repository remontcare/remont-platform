-- Phase 8 (Workstream 4) — purely additive: distinguishes a SANDBOX/mock e-Invoice or
-- e-Way Bill record from a real PRODUCTION/government-issued one. Defaults to SANDBOX for
-- every existing and new row — accurate today, since no live IRP/EWB credentials exist in
-- this codebase yet.

-- AlterTable
ALTER TABLE "EInvoiceRecord" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'SANDBOX';

-- AlterTable
ALTER TABLE "EWayBillRecord" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'SANDBOX';
