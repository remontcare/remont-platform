-- Extra work decision lifecycle (status/approver/rejection) + order-scoped Authorized Person.
-- Additive only: existing rows keep working; already-approved items are backfilled to APPROVED.

-- AlterTable
ALTER TABLE "ExtraWorkItem" ADD COLUMN     "approvedByType" TEXT,
ADD COLUMN     "approvedByUserId" TEXT,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedByType" TEXT,
ADD COLUMN     "rejectedByUserId" TEXT,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "OrderAuthorizedPerson" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "relationship" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "permissions" TEXT[] DEFAULT ARRAY['VIEW_ORDER', 'DECIDE_EXTRA_WORK']::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderAuthorizedPerson_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderAuthorizedPerson_orderId_key" ON "OrderAuthorizedPerson"("orderId");

-- CreateIndex
CREATE INDEX "OrderAuthorizedPerson_phone_status_idx" ON "OrderAuthorizedPerson"("phone", "status");

-- AddForeignKey
ALTER TABLE "OrderAuthorizedPerson" ADD CONSTRAINT "OrderAuthorizedPerson_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: items approved before this column existed are APPROVED (customerApproved stays the billing flag).
UPDATE "ExtraWorkItem" SET "status" = 'APPROVED' WHERE "customerApproved" = true;
