-- CreateEnum
CREATE TYPE "GstPriceType" AS ENUM ('GST_INCLUSIVE', 'GST_EXCLUSIVE');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "productsTaxableAmount" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "gstAmount" DECIMAL(10,2),
ADD COLUMN     "gstInclusive" BOOLEAN,
ADD COLUMN     "gstRatePercent" DECIMAL(5,2),
ADD COLUMN     "taxableValue" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "gstInclusive" BOOLEAN;

-- AlterTable
ALTER TABLE "TaxConfig" ADD COLUMN     "gstApplicable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "priceType" "GstPriceType" NOT NULL DEFAULT 'GST_EXCLUSIVE',
ADD COLUMN     "productCategoryId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "validFrom" TIMESTAMP(3),
ADD COLUMN     "validTo" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "TaxConfig_appliesTo_hsnCode_isActive_idx" ON "TaxConfig"("appliesTo", "hsnCode", "isActive");

-- CreateIndex
CREATE INDEX "TaxConfig_appliesTo_productCategoryId_isActive_idx" ON "TaxConfig"("appliesTo", "productCategoryId", "isActive");

-- AddForeignKey
ALTER TABLE "TaxConfig" ADD CONSTRAINT "TaxConfig_productCategoryId_fkey" FOREIGN KEY ("productCategoryId") REFERENCES "ProductCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

