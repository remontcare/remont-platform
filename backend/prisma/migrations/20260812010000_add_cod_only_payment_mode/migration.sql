-- Payment Mode business rules — purely additive migration.
-- Adds COD_ONLY as a third Service.paymentMode option, alongside the existing
-- ANY (Online + Cash on Delivery) and ONLINE_ONLY. No existing enum value is renamed or
-- removed, so every row currently at ANY/ONLINE_ONLY is completely untouched.
-- Safe to run against the live database with zero downtime.

-- AlterEnum
ALTER TYPE "ServicePaymentMode" ADD VALUE 'COD_ONLY';
