-- CreateEnum
CREATE TYPE "ProductFulfillmentStage" AS ENUM ('AWAITING_SELLER', 'SELLER_ACCEPTED', 'SELLER_REJECTED', 'PROCESSING', 'READY_FOR_PICKUP', 'HANDED_TO_LOGISTICS');

-- CreateEnum
CREATE TYPE "CodSettlementStatus" AS ENUM ('NOT_APPLICABLE', 'COD_EXPECTED', 'COD_COLLECTED', 'COD_SETTLEMENT_PENDING', 'COD_SETTLED', 'COD_RECONCILED');

-- CreateEnum
CREATE TYPE "ReturnInspectionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- AlterEnum
ALTER TYPE "ShipmentStatus" ADD VALUE 'OUT_FOR_DELIVERY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SupportResolutionType" ADD VALUE 'RETURN_PICKUP_INITIATED';
ALTER TYPE "SupportResolutionType" ADD VALUE 'REPLACEMENT';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "productFulfillmentAt" TIMESTAMP(3),
ADD COLUMN     "productFulfillmentStage" "ProductFulfillmentStage",
ADD COLUMN     "replacementOfOrderId" TEXT,
ADD COLUMN     "sellerRejectionReason" TEXT;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "codAmount" DECIMAL(10,2),
ADD COLUMN     "codCollectedAt" TIMESTAMP(3),
ADD COLUMN     "codCollectedBy" TEXT,
ADD COLUMN     "codHandedOverAt" TIMESTAMP(3),
ADD COLUMN     "codReconciledAt" TIMESTAMP(3),
ADD COLUMN     "codReconciledBy" TEXT,
ADD COLUMN     "codSettledAt" TIMESTAMP(3),
ADD COLUMN     "codSettledBy" TEXT,
ADD COLUMN     "codSettlementStatus" "CodSettlementStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryOtp" TEXT,
ADD COLUMN     "deliveryOtpVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deliveryPartnerId" TEXT,
ADD COLUMN     "partnerAssignedAt" TIMESTAMP(3),
ADD COLUMN     "partnerNotes" TEXT;

-- AlterTable
ALTER TABLE "SupportCase" ADD COLUMN     "requestedRemedy" TEXT;

-- CreateTable
CREATE TABLE "ReturnShipment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "supportCaseId" TEXT NOT NULL,
    "provider" "ShipmentProvider" NOT NULL DEFAULT 'MOCK_DEMO',
    "providerRef" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'CREATED',
    "isDemo" BOOLEAN NOT NULL DEFAULT true,
    "deliveryPartnerId" TEXT,
    "estimatedPickup" TIMESTAMP(3),
    "pickupOtp" TEXT,
    "pickupOtpVerified" BOOLEAN NOT NULL DEFAULT false,
    "inspectionStatus" "ReturnInspectionStatus" NOT NULL DEFAULT 'PENDING',
    "inspectionNotes" TEXT,
    "inspectedAt" TIMESTAMP(3),
    "inspectedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnShipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReturnShipment_supportCaseId_key" ON "ReturnShipment"("supportCaseId");

-- CreateIndex
CREATE INDEX "ReturnShipment_orderId_idx" ON "ReturnShipment"("orderId");

-- CreateIndex
CREATE INDEX "ReturnShipment_deliveryPartnerId_idx" ON "ReturnShipment"("deliveryPartnerId");

-- CreateIndex
CREATE INDEX "Shipment_deliveryPartnerId_idx" ON "Shipment"("deliveryPartnerId");

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_deliveryPartnerId_fkey" FOREIGN KEY ("deliveryPartnerId") REFERENCES "DeliveryPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnShipment" ADD CONSTRAINT "ReturnShipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnShipment" ADD CONSTRAINT "ReturnShipment_supportCaseId_fkey" FOREIGN KEY ("supportCaseId") REFERENCES "SupportCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnShipment" ADD CONSTRAINT "ReturnShipment_deliveryPartnerId_fkey" FOREIGN KEY ("deliveryPartnerId") REFERENCES "DeliveryPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

