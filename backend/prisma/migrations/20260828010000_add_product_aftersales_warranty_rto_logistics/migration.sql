-- CreateEnum
CREATE TYPE "ReturnShipmentKind" AS ENUM ('RETURN', 'RTO', 'WARRANTY');

-- CreateEnum
CREATE TYPE "WarrantyDecision" AS ENUM ('APPROVED_REPAIR', 'APPROVED_REPLACEMENT', 'APPROVED_REFUND', 'REJECTED');

-- CreateEnum
CREATE TYPE "WarrantyCaseStatus" AS ENUM ('OPEN', 'SELLER_REVIEW', 'ADMIN_REVIEW', 'RESOLVED', 'REJECTED', 'CLOSED');

-- AlterEnum
ALTER TYPE "SupportIssueType" ADD VALUE 'WARRANTY_CLAIM';

-- AlterEnum
ALTER TYPE "SupportResolutionType" ADD VALUE 'WARRANTY_CLAIM_OPENED';

-- DropForeignKey
ALTER TABLE "ReturnShipment" DROP CONSTRAINT "ReturnShipment_supportCaseId_fkey";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "evidencePhotoRequired" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "evidenceVideoRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replaceable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "replacementConditions" TEXT,
ADD COLUMN     "replacementWindowDays" INTEGER,
ADD COLUMN     "returnConditions" TEXT,
ADD COLUMN     "returnWindowDays" INTEGER,
ADD COLUMN     "returnable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "warrantyAvailable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "warrantyDurationMonths" INTEGER,
ADD COLUMN     "warrantyInstructions" TEXT,
ADD COLUMN     "warrantyType" TEXT;

-- AlterTable
ALTER TABLE "ReturnShipment" ADD COLUMN     "kind" "ReturnShipmentKind" NOT NULL DEFAULT 'RETURN',
ADD COLUMN     "logisticsProviderId" TEXT,
ADD COLUMN     "sellerRecommendation" "ReturnInspectionStatus",
ADD COLUMN     "sellerRecommendationNotes" TEXT,
ADD COLUMN     "sellerRecommendedAt" TIMESTAMP(3),
ALTER COLUMN "supportCaseId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "LogisticsProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adapterKey" TEXT NOT NULL DEFAULT 'MOCK_DEMO',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "supportsCod" BOOLEAN NOT NULL DEFAULT false,
    "environment" TEXT NOT NULL DEFAULT 'SANDBOX',
    "baseCost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "etaDays" INTEGER NOT NULL DEFAULT 5,
    "credentialsJson" JSONB,
    "serviceableCitiesJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogisticsProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarrantyCase" (
    "id" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "productId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "supportCaseId" TEXT NOT NULL,
    "status" "WarrantyCaseStatus" NOT NULL DEFAULT 'OPEN',
    "sellerRecommendation" "WarrantyDecision",
    "sellerRecommendationNotes" TEXT,
    "sellerRecommendedAt" TIMESTAMP(3),
    "finalDecision" "WarrantyDecision",
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "resolutionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "WarrantyCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LogisticsProvider_isActive_idx" ON "LogisticsProvider"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "WarrantyCase_caseNumber_key" ON "WarrantyCase"("caseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WarrantyCase_supportCaseId_key" ON "WarrantyCase"("supportCaseId");

-- CreateIndex
CREATE INDEX "WarrantyCase_orderId_idx" ON "WarrantyCase"("orderId");

-- CreateIndex
CREATE INDEX "WarrantyCase_productId_idx" ON "WarrantyCase"("productId");

-- CreateIndex
CREATE INDEX "WarrantyCase_status_idx" ON "WarrantyCase"("status");

-- CreateIndex
CREATE INDEX "ReturnShipment_logisticsProviderId_idx" ON "ReturnShipment"("logisticsProviderId");

-- AddForeignKey
ALTER TABLE "ReturnShipment" ADD CONSTRAINT "ReturnShipment_supportCaseId_fkey" FOREIGN KEY ("supportCaseId") REFERENCES "SupportCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnShipment" ADD CONSTRAINT "ReturnShipment_logisticsProviderId_fkey" FOREIGN KEY ("logisticsProviderId") REFERENCES "LogisticsProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarrantyCase" ADD CONSTRAINT "WarrantyCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarrantyCase" ADD CONSTRAINT "WarrantyCase_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarrantyCase" ADD CONSTRAINT "WarrantyCase_supportCaseId_fkey" FOREIGN KEY ("supportCaseId") REFERENCES "SupportCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

