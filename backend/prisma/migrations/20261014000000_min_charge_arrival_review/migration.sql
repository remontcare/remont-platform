-- Minimum service charge + cancellation charge rule types, partner arrival evidence and
-- post-arrival review fields. ADDITIVE ONLY: new enum values/types and nullable or
-- defaulted columns; nothing existing is altered or dropped. Existing CommissionRule rows
-- become ruleType=COMMISSION (their current meaning).

-- CreateEnum
CREATE TYPE "ProviderRefundStatus" AS ENUM ('CREATED', 'PENDING', 'PROCESSED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ServiceRuleType" AS ENUM ('COMMISSION', 'MINIMUM_CHARGE', 'CANCELLATION_CHARGE');

-- CreateEnum
CREATE TYPE "ArrivalVerification" AS ENUM ('VERIFIED', 'NOT_VERIFIED_TOO_FAR', 'NOT_VERIFIED_LOW_ACCURACY', 'NOT_VERIFIED_NO_LOCATION', 'NOT_VERIFIED_NO_ADDRESS_COORDINATES', 'NOT_VERIFIED_MOCK_LOCATION', 'NOT_VERIFIED_STALE_LOCATION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RefundRequestStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "RefundRequestStatus" ADD VALUE 'REFUND_PENDING';
ALTER TYPE "RefundRequestStatus" ADD VALUE 'NEEDS_ATTENTION';
ALTER TYPE "RefundRequestStatus" ADD VALUE 'REFUND_FAILED';

-- AlterEnum
ALTER TYPE "SupportIssueType" ADD VALUE 'CUSTOMER_REFUSED_SERVICE';

-- AlterTable
ALTER TABLE "CommissionRule" ADD COLUMN     "minimumAmount" DECIMAL(10,2),
ADD COLUMN     "ruleType" "ServiceRuleType" NOT NULL DEFAULT 'COMMISSION';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "arrivalAccuracyM" DOUBLE PRECISION,
ADD COLUMN     "arrivalDistanceM" DOUBLE PRECISION,
ADD COLUMN     "arrivalLatitude" DOUBLE PRECISION,
ADD COLUMN     "arrivalLongitude" DOUBLE PRECISION,
ADD COLUMN     "arrivalNote" TEXT,
ADD COLUMN     "arrivalVerification" "ArrivalVerification",
ADD COLUMN     "arrivedAt" TIMESTAMP(3),
ADD COLUMN     "minimumChargeAdjustment" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "minimumChargeRuleId" TEXT;

-- AlterTable
ALTER TABLE "RefundRequest" ADD COLUMN     "claimedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "partnerRecoveredAt" TIMESTAMP(3),
ADD COLUMN     "partnerRecovery" DECIMAL(10,2),
ADD COLUMN     "supportCaseId" TEXT;

-- AlterTable
ALTER TABLE "SupportCase" ADD COLUMN     "appealStatement" TEXT,
ADD COLUMN     "appealedAt" TIMESTAMP(3),
ADD COLUMN     "customerStatement" TEXT,
ADD COLUMN     "openedByRole" TEXT,
ADD COLUMN     "orderCancelledByCase" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "partnerCompensatedAt" TIMESTAMP(3),
ADD COLUMN     "partnerCompensation" DECIMAL(10,2),
ADD COLUMN     "partnerRecoveredAt" TIMESTAMP(3),
ADD COLUMN     "partnerRecovery" DECIMAL(10,2),
ADD COLUMN     "penaltyAssessed" DECIMAL(10,2),
ADD COLUMN     "penaltyAssessedAt" TIMESTAMP(3),
ADD COLUMN     "penaltyPendingCollection" DECIMAL(10,2),
ADD COLUMN     "penaltyRetained" DECIMAL(10,2),
ADD COLUMN     "refundedTotal" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ProviderRefund" (
    "id" TEXT NOT NULL,
    "refundRequestId" TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "gateway" TEXT NOT NULL,
    "gatewayPaymentId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerRefundId" TEXT,
    "status" "ProviderRefundStatus" NOT NULL DEFAULT 'CREATED',
    "providerStatus" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundWalletCredit" (
    "id" TEXT NOT NULL,
    "refundRequestId" TEXT NOT NULL,
    "walletTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundWalletCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRefund_refundRequestId_key" ON "ProviderRefund"("refundRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRefund_idempotencyKey_key" ON "ProviderRefund"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRefund_providerRefundId_key" ON "ProviderRefund"("providerRefundId");

-- CreateIndex
CREATE INDEX "ProviderRefund_status_idx" ON "ProviderRefund"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RefundWalletCredit_refundRequestId_key" ON "RefundWalletCredit"("refundRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWebhookEvent_eventId_key" ON "PaymentWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "CommissionRule_ruleType_idx" ON "CommissionRule"("ruleType");

-- CreateIndex
CREATE INDEX "RefundRequest_supportCaseId_idx" ON "RefundRequest"("supportCaseId");

-- AddForeignKey
ALTER TABLE "ProviderRefund" ADD CONSTRAINT "ProviderRefund_refundRequestId_fkey" FOREIGN KEY ("refundRequestId") REFERENCES "RefundRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

