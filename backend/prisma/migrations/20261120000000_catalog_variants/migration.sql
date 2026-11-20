-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "variantGroupId" TEXT,
ADD COLUMN     "variantOptions" JSONB,
ADD COLUMN     "variantSortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "variantGroupId" TEXT,
ADD COLUMN     "variantOptions" JSONB,
ADD COLUMN     "variantSortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "itemName" TEXT,
ADD COLUMN     "variantGroupId" TEXT,
ADD COLUMN     "variantOptions" JSONB;

-- AlterTable
ALTER TABLE "OrderServiceItem" ADD COLUMN     "itemName" TEXT,
ADD COLUMN     "variantGroupId" TEXT,
ADD COLUMN     "variantOptions" JSONB;

-- CreateTable
CREATE TABLE "CatalogVariantGroup" (
    "id" TEXT NOT NULL,
    "entityType" "CatalogEntityType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "optionNames" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogVariantGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogVariantGroup_entityType_isActive_idx" ON "CatalogVariantGroup"("entityType", "isActive");

-- CreateIndex
CREATE INDEX "Service_variantGroupId_idx" ON "Service"("variantGroupId");

-- CreateIndex
CREATE INDEX "Product_variantGroupId_idx" ON "Product"("variantGroupId");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_variantGroupId_fkey" FOREIGN KEY ("variantGroupId") REFERENCES "CatalogVariantGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_variantGroupId_fkey" FOREIGN KEY ("variantGroupId") REFERENCES "CatalogVariantGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

