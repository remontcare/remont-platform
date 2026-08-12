-- Smart Order Grouping — purely additive migration.
-- Adds OrderServiceItem, the per-service line-item table the Child Order Engine
-- (MasterOrdersService.checkout) uses to group every service from the same category,
-- same address, same checkout into ONE Order instead of one Order per service.
-- No existing column is dropped, renamed, or made non-nullable-without-default.
-- No existing row is touched. Safe to run against the live database with zero downtime.

-- CreateTable
CREATE TABLE "OrderServiceItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "totalPrice" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "OrderServiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderServiceItem_orderId_idx" ON "OrderServiceItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderServiceItem_serviceId_idx" ON "OrderServiceItem"("serviceId");

-- AddForeignKey
ALTER TABLE "OrderServiceItem" ADD CONSTRAINT "OrderServiceItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderServiceItem" ADD CONSTRAINT "OrderServiceItem_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
