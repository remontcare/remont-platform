-- CreateEnum
CREATE TYPE "ShipmentProvider" AS ENUM ('MOCK_DEMO');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('CREATED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" "ShipmentProvider" NOT NULL,
    "providerRef" TEXT NOT NULL,
    "tier" "DeliveryTier" NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'CREATED',
    "isDemo" BOOLEAN NOT NULL DEFAULT true,
    "estimatedDelivery" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_orderId_key" ON "Shipment"("orderId");

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

