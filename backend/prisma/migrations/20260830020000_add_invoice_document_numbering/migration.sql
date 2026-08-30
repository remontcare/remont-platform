-- Phase 5 (C-07 numbering race, C-08 legal document separation, L-01 financial year) —
-- purely additive: two new nullable+unique columns on Invoice, one new counter table. No
-- existing column altered, no historical Invoice row touched/renumbered.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "vendorDocumentNumber" TEXT,
ADD COLUMN "remontDocumentNumber" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_vendorDocumentNumber_key" ON "Invoice"("vendorDocumentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_remontDocumentNumber_key" ON "Invoice"("remontDocumentNumber");

-- CreateTable
CREATE TABLE "InvoiceNumberSequence" (
    "id" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceNumberSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — this is the exact uniqueness the atomic
-- `INSERT ... ON CONFLICT ("series", "financialYear") DO UPDATE` in
-- nextInvoiceDocumentNumber() (backend/src/common/index.ts) targets; the database, not
-- application code, is what makes concurrent allocation for the same series+FY safe.
CREATE UNIQUE INDEX "InvoiceNumberSequence_series_financialYear_key" ON "InvoiceNumberSequence"("series", "financialYear");
