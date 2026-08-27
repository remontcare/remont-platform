-- CreateEnum
CREATE TYPE "DeliveryTier" AS ENUM ('INSTANT', 'SAME_DAY', 'NEXT_DAY', 'STANDARD');

-- AlterTable
ALTER TABLE "ProductVendor" ADD COLUMN     "isOpen" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "offersInstantDelivery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offersSameDayDelivery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "operatingHoursClose" TEXT,
ADD COLUMN     "operatingHoursOpen" TEXT,
ADD COLUMN     "processingTimeMinutes" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryCharge" DECIMAL(10,2),
ADD COLUMN     "deliveryTier" "DeliveryTier";

