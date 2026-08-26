-- CreateEnum
CREATE TYPE "AiFeatureType" AS ENUM ('WEB_SEARCH', 'IMAGE_SEARCH', 'IMAGE_GENERATION');

-- CreateEnum
CREATE TYPE "AiFeatureStatus" AS ENUM ('SUCCESS', 'FAILED', 'REFUNDED');

-- AlterEnum
ALTER TYPE "TransactionReason" ADD VALUE 'AI_FEATURE_CHARGE';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "countryOfOrigin" TEXT,
ADD COLUMN     "heightCm" DECIMAL(8,2),
ADD COLUMN     "lengthCm" DECIMAL(8,2),
ADD COLUMN     "manufacturer" TEXT,
ADD COLUMN     "modelNumber" TEXT,
ADD COLUMN     "warranty" TEXT,
ADD COLUMN     "weightKg" DECIMAL(8,3),
ADD COLUMN     "widthCm" DECIMAL(8,2);

-- CreateTable
CREATE TABLE "AiFeatureUsage" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "productId" TEXT,
    "feature" "AiFeatureType" NOT NULL,
    "costCharged" DECIMAL(10,2) NOT NULL,
    "walletTransactionId" TEXT,
    "status" "AiFeatureStatus" NOT NULL,
    "resultJson" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiFeatureUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiFeatureUsage_sellerId_idx" ON "AiFeatureUsage"("sellerId");

-- CreateIndex
CREATE INDEX "AiFeatureUsage_productId_idx" ON "AiFeatureUsage"("productId");

-- AddForeignKey
ALTER TABLE "AiFeatureUsage" ADD CONSTRAINT "AiFeatureUsage_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "ProductVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFeatureUsage" ADD CONSTRAINT "AiFeatureUsage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

