-- Centralised pricing rules. Additive only: an enum value, nullable/defaulted columns.
-- Existing TaxConfig rows become LEGACY (still used, flagged until a CA approval is recorded).
ALTER TYPE "ServiceRuleType" ADD VALUE IF NOT EXISTS 'ADDITIONAL_FEE';

ALTER TABLE "CommissionRule" ADD COLUMN "feeName" TEXT;
ALTER TABLE "CommissionRule" ADD COLUMN "feeDisplayName" TEXT;
ALTER TABLE "CommissionRule" ADD COLUMN "feeCondition" TEXT;
ALTER TABLE "CommissionRule" ADD COLUMN "feeAppliesTo" TEXT;
ALTER TABLE "CommissionRule" ADD COLUMN "feeBeneficiary" TEXT;
ALTER TABLE "CommissionRule" ADD COLUMN "feeSac" TEXT;
ALTER TABLE "CommissionRule" ADD COLUMN "nightStartHour" INTEGER;
ALTER TABLE "CommissionRule" ADD COLUMN "nightEndHour" INTEGER;

ALTER TABLE "ServiceCategory" ADD COLUMN "partnerGstProfile" TEXT NOT NULL DEFAULT 'UNREGISTERED_ONLY';

ALTER TABLE "Order" ADD COLUMN "pricingSnapshot" JSONB;
ALTER TABLE "Order" ADD COLUMN "isEmergency" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TaxConfig" ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "TaxConfig" ADD COLUMN "approvedBy" TEXT;
ALTER TABLE "TaxConfig" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "TaxConfig" ADD COLUMN "approvalNote" TEXT;

-- A credit note records which document of the invoice it credits (older notes: the customer page).
ALTER TABLE "CreditNote" ADD COLUMN "documentKind" TEXT NOT NULL DEFAULT 'CUSTOMER';
