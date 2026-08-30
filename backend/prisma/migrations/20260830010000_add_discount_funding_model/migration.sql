-- Phase 3 (discount/GST/settlement audit, C-02/C-03/M-04) — discount funding attribution
-- model. Purely additive: new enum, one new nullable-everywhere column on Coupon with a
-- safe default, and one new table with a nullable FK back to Order — no existing column is
-- altered, no historical Order/Invoice/Coupon/ProductVendorLedgerEntry row is rewritten.
-- Coupon.fundedBy defaults to PLATFORM, so every existing coupon keeps today's exact
-- checkout/GST/settlement behaviour unchanged; only a coupon an admin explicitly flips to
-- SELLER engages the new taxable-value-reduction path (see common/index.ts's
-- applySellerFundedDiscountToProductGst()/buildDiscountAllocationData()).

-- CreateEnum
CREATE TYPE "DiscountFundingSource" AS ENUM ('PLATFORM', 'SELLER');

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN "fundedBy" "DiscountFundingSource" NOT NULL DEFAULT 'PLATFORM';

-- CreateTable
CREATE TABLE "OrderDiscountAllocation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "couponId" TEXT,
    "sellerId" TEXT,
    "customerDiscountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "fundingSource" "DiscountFundingSource" NOT NULL DEFAULT 'PLATFORM',
    "fundedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "taxableValueReduced" BOOLEAN NOT NULL DEFAULT false,
    "taxableValueAdjustment" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "settlementImpact" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "gstTreatment" TEXT NOT NULL,
    "accountingTreatment" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDiscountAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderDiscountAllocation_orderId_key" ON "OrderDiscountAllocation"("orderId");

-- CreateIndex
CREATE INDEX "OrderDiscountAllocation_couponId_idx" ON "OrderDiscountAllocation"("couponId");

-- CreateIndex
CREATE INDEX "OrderDiscountAllocation_sellerId_idx" ON "OrderDiscountAllocation"("sellerId");

-- AddForeignKey
ALTER TABLE "OrderDiscountAllocation" ADD CONSTRAINT "OrderDiscountAllocation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDiscountAllocation" ADD CONSTRAINT "OrderDiscountAllocation_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
