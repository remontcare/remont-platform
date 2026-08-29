-- CreateEnum
CREATE TYPE "ProductFeeType" AS ENUM ('COMMISSION', 'MARKETING', 'GATEWAY', 'OTHER');

-- CreateEnum
CREATE TYPE "ProductFeeScope" AS ENUM ('PRODUCT_CATEGORY', 'PRODUCT');

-- CreateEnum
CREATE TYPE "ProductLedgerEntryType" AS ENUM ('GROSS_SALE', 'COMMISSION', 'GST_ON_FEES', 'DELIVERY_COST', 'MARKETING_FEE', 'GATEWAY_FEE', 'OTHER_FEE', 'RETURN_ADJUSTMENT', 'RTO_ADJUSTMENT', 'HOLD', 'HOLD_RELEASE', 'PAYOUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ProductHoldType" AS ENUM ('RETURN_WINDOW_HOLD', 'ADMIN_MANUAL');

-- CreateEnum
CREATE TYPE "ProductHoldStatus" AS ENUM ('HELD', 'RELEASED', 'FORFEITED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "productFeeBreakdown" JSONB;

-- AlterTable
ALTER TABLE "ProductVendor" ADD COLUMN     "pendingPayout" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalEarnings" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "actualDeliveryCost" DECIMAL(10,2),
ADD COLUMN     "logisticsProviderId" TEXT;

-- CreateTable
CREATE TABLE "ProductFeeRule" (
    "id" TEXT NOT NULL,
    "feeType" "ProductFeeType" NOT NULL,
    "scope" "ProductFeeScope" NOT NULL,
    "productCategoryId" TEXT,
    "productId" TEXT,
    "commissionType" "CommissionType" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "slabJson" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductFeeRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVendorLedgerEntry" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" "ProductLedgerEntryType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "orderId" TEXT,
    "settlementId" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVendorLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVendorHold" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" "ProductHoldType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "remaining" DECIMAL(12,2) NOT NULL,
    "orderId" TEXT,
    "status" "ProductHoldStatus" NOT NULL DEFAULT 'HELD',
    "releaseDueAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVendorHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVendorSettlement" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "mode" "SettlementMode" NOT NULL,
    "referenceNumber" TEXT,
    "notes" TEXT,
    "paidBy" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVendorSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductFeeRule_feeType_productCategoryId_idx" ON "ProductFeeRule"("feeType", "productCategoryId");

-- CreateIndex
CREATE INDEX "ProductFeeRule_feeType_productId_idx" ON "ProductFeeRule"("feeType", "productId");

-- CreateIndex
CREATE INDEX "ProductVendorLedgerEntry_vendorId_createdAt_idx" ON "ProductVendorLedgerEntry"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductVendorLedgerEntry_orderId_idx" ON "ProductVendorLedgerEntry"("orderId");

-- CreateIndex
CREATE INDEX "ProductVendorHold_vendorId_status_idx" ON "ProductVendorHold"("vendorId", "status");

-- CreateIndex
CREATE INDEX "ProductVendorHold_status_releaseDueAt_idx" ON "ProductVendorHold"("status", "releaseDueAt");

-- CreateIndex
CREATE INDEX "ProductVendorSettlement_vendorId_idx" ON "ProductVendorSettlement"("vendorId");

-- CreateIndex
CREATE INDEX "ProductVendorSettlement_paidAt_idx" ON "ProductVendorSettlement"("paidAt");

-- CreateIndex
CREATE INDEX "Shipment_logisticsProviderId_idx" ON "Shipment"("logisticsProviderId");

-- AddForeignKey
ALTER TABLE "ProductFeeRule" ADD CONSTRAINT "ProductFeeRule_productCategoryId_fkey" FOREIGN KEY ("productCategoryId") REFERENCES "ProductCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductFeeRule" ADD CONSTRAINT "ProductFeeRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_logisticsProviderId_fkey" FOREIGN KEY ("logisticsProviderId") REFERENCES "LogisticsProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVendorLedgerEntry" ADD CONSTRAINT "ProductVendorLedgerEntry_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "ProductVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVendorLedgerEntry" ADD CONSTRAINT "ProductVendorLedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVendorHold" ADD CONSTRAINT "ProductVendorHold_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "ProductVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVendorHold" ADD CONSTRAINT "ProductVendorHold_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVendorSettlement" ADD CONSTRAINT "ProductVendorSettlement_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "ProductVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

