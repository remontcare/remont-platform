-- Phase 6 (C-06) — purely additive: one new table for the formal GST credit-note record
-- issued against an already-issued (immutable) Invoice on a post-invoice refund. No
-- existing column touched, no historical Invoice/Order row modified.

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "creditNoteNumber" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "refundRequestId" TEXT,
    "reason" TEXT NOT NULL,
    "taxableValueReversed" DECIMAL(10,2) NOT NULL,
    "cgstReversed" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sgstReversed" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "igstReversed" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalReversed" DECIMAL(10,2) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_creditNoteNumber_key" ON "CreditNote"("creditNoteNumber");

-- CreateIndex
CREATE INDEX "CreditNote_orderId_idx" ON "CreditNote"("orderId");

-- CreateIndex
CREATE INDEX "CreditNote_refundRequestId_idx" ON "CreditNote"("refundRequestId");

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
