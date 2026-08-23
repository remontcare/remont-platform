-- Order Help & Support system: purely additive. Never moves money itself -- a resolution
-- that implies a refund creates a RefundRequest and drives it through the existing
-- RefundsService pipeline (see support.module.ts). No existing table/column is touched.

-- CreateEnum
CREATE TYPE "SupportItemType" AS ENUM ('PRODUCT', 'SERVICE');

-- CreateEnum
CREATE TYPE "SupportIssueType" AS ENUM (
  'NOT_DELIVERED', 'DELIVERED_LATE', 'WRONG_PRODUCT', 'DAMAGED_PRODUCT', 'MISSING_ITEM',
  'CANCEL_PRODUCT', 'RETURN_PRODUCT',
  'PARTNER_NOT_ASSIGNED', 'PARTNER_ON_THE_WAY', 'PARTNER_ARRIVED', 'PARTNER_DID_NOT_ARRIVE',
  'SERVICE_STARTED_ISSUE', 'SERVICE_COMPLETED_ISSUE_NOT_FIXED',
  'OTHER_ISSUE'
);

-- CreateEnum
CREATE TYPE "SupportCaseStatus" AS ENUM (
  'OPEN', 'IN_REVIEW', 'WAITING_CUSTOMER', 'WAITING_PARTNER', 'DISPUTE', 'ADMIN_REVIEW',
  'RESOLVED', 'CLOSED'
);

-- CreateEnum
CREATE TYPE "SupportResolutionType" AS ENUM (
  'FULL_REFUND', 'PARTIAL_REFUND', 'REFUND_MINUS_VISIT', 'REFUND_MINUS_DIAGNOSIS', 'NO_REFUND',
  'FREE_REVISIT', 'FREE_REWORK', 'REASSIGN_PARTNER', 'NEW_SERVICE_REQUIRED',
  'CUSTOMER_PAYABLE', 'PARTNER_LIABILITY', 'SPLIT_LIABILITY'
);

-- CreateTable
CREATE TABLE "SupportCase" (
    "id" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "customerId" TEXT NOT NULL,
    "partnerId" TEXT,
    "itemType" "SupportItemType" NOT NULL,
    "issueType" "SupportIssueType" NOT NULL,
    "description" TEXT,
    "evidenceUrls" TEXT[],
    "statusSnapshot" TEXT NOT NULL,
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
    "routeType" TEXT NOT NULL,
    "partnerResponse" TEXT,
    "partnerRespondedAt" TIMESTAMP(3),
    "recommendedResolution" "SupportResolutionType",
    "recommendedAmount" DECIMAL(10,2),
    "recommendationReason" TEXT,
    "policyApplied" TEXT,
    "resolutionType" "SupportResolutionType",
    "resolutionAmount" DECIMAL(10,2),
    "resolutionReason" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "refundRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "SupportCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCaseLog" (
    "id" TEXT NOT NULL,
    "supportCaseId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" "UserRole",
    "action" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportCaseLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportCase_caseNumber_key" ON "SupportCase"("caseNumber");

-- CreateIndex
CREATE INDEX "SupportCase_orderId_idx" ON "SupportCase"("orderId");

-- CreateIndex
CREATE INDEX "SupportCase_customerId_idx" ON "SupportCase"("customerId");

-- CreateIndex
CREATE INDEX "SupportCase_partnerId_idx" ON "SupportCase"("partnerId");

-- CreateIndex
CREATE INDEX "SupportCase_status_idx" ON "SupportCase"("status");

-- CreateIndex
CREATE INDEX "SupportCaseLog_supportCaseId_idx" ON "SupportCaseLog"("supportCaseId");

-- AddForeignKey
ALTER TABLE "SupportCaseLog" ADD CONSTRAINT "SupportCaseLog_supportCaseId_fkey" FOREIGN KEY ("supportCaseId") REFERENCES "SupportCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
