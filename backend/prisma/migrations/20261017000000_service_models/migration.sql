-- Service models (in-house vs partner marketplace) and in-house cash deposits. Additive only:
-- new enum value, new columns with defaults or nullable. Existing orders keep serviceModel NULL
-- (legacy pricing); existing categories take the default PARTNER_MARKETPLACE.
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'CASH_DEPOSIT';

ALTER TABLE "ServiceCategory" ADD COLUMN "serviceModel" TEXT NOT NULL DEFAULT 'PARTNER_MARKETPLACE';

ALTER TABLE "Order" ADD COLUMN "serviceModel" TEXT;
ALTER TABLE "Order" ADD COLUMN "platformFeeGst" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "partnerServiceGst" DECIMAL(10,2) NOT NULL DEFAULT 0;

ALTER TABLE "PartnerLedgerEntry" ADD COLUMN "reference" TEXT;
