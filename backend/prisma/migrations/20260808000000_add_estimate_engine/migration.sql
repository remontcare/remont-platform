-- Estimate Engine — purely additive migration.
-- No existing column is dropped, renamed, or made non-nullable-without-default.
-- No existing row is touched. Safe to run against the live database with zero downtime.

-- AlterEnum
ALTER TYPE "LeadSource" ADD VALUE 'ESTIMATE_ENGINE';

-- CreateEnum
CREATE TYPE "ServiceDeliveryType" AS ENUM ('DIGITAL', 'ONSITE', 'HYBRID');

-- CreateEnum
CREATE TYPE "PricingType" AS ENUM ('FIXED', 'STARTING_FROM', 'QUOTATION', 'PER_SQFT');

-- AlterTable
ALTER TABLE "Service"
  ADD COLUMN "serviceType" "ServiceDeliveryType" NOT NULL DEFAULT 'ONSITE',
  ADD COLUMN "pricingType" "PricingType" NOT NULL DEFAULT 'FIXED',
  ADD COLUMN "offerPrice" DECIMAL(10,2),
  ADD COLUMN "consultationFee" DECIMAL(10,2),
  ADD COLUMN "siteVisitFee" DECIMAL(10,2),
  ADD COLUMN "labourCost" DECIMAL(10,2),
  ADD COLUMN "materialCost" DECIMAL(10,2),
  ADD COLUMN "perSqftRate" DECIMAL(10,2),
  ADD COLUMN "gstOverridePercent" DECIMAL(5,2),
  ADD COLUMN "timelineMinDays" INTEGER,
  ADD COLUMN "timelineMaxDays" INTEGER;

-- CreateTable
CREATE TABLE "ServicePriceModifier" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT,
    "categoryId" TEXT,
    "group" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "multiplier" DECIMAL(4,2) NOT NULL DEFAULT 1.0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServicePriceModifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Estimate" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "cityId" TEXT,
    "customerId" TEXT,
    "leadId" TEXT,
    "inputsJson" JSONB NOT NULL,
    "estimatedLow" DECIMAL(10,2),
    "estimatedHigh" DECIMAL(10,2),
    "breakdownJson" JSONB NOT NULL,
    "gstPercent" DECIMAL(5,2) NOT NULL,
    "gstAmount" DECIMAL(10,2) NOT NULL,
    "finalPayableAmount" DECIMAL(10,2) NOT NULL,
    "timelineMinDays" INTEGER,
    "timelineMaxDays" INTEGER,
    "bookingEligible" BOOLEAN NOT NULL,
    "eligibilityReason" TEXT NOT NULL,
    "eligibilityMessage" TEXT,
    "convertedOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServicePriceModifier_serviceId_group_idx" ON "ServicePriceModifier"("serviceId", "group");

-- CreateIndex
CREATE INDEX "ServicePriceModifier_categoryId_group_idx" ON "ServicePriceModifier"("categoryId", "group");

-- CreateIndex
CREATE INDEX "Estimate_serviceId_idx" ON "Estimate"("serviceId");

-- CreateIndex
CREATE INDEX "Estimate_cityId_idx" ON "Estimate"("cityId");

-- CreateIndex
CREATE INDEX "Estimate_leadId_idx" ON "Estimate"("leadId");

-- CreateIndex
CREATE INDEX "Estimate_createdAt_idx" ON "Estimate"("createdAt");

-- AddForeignKey
ALTER TABLE "ServicePriceModifier" ADD CONSTRAINT "ServicePriceModifier_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePriceModifier" ADD CONSTRAINT "ServicePriceModifier_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
