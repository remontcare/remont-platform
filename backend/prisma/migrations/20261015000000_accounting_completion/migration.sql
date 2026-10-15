-- Accounting completion: section 9(5) invoicing, invoice versions/reissue, cancellation credit notes,
-- purchase (input tax) records, gateway fees. Additive only: new columns are defaulted or nullable.
-- AlterTable
ALTER TABLE "ServiceCategory" ADD COLUMN     "section95Applicable" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "section95" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "taxReviewRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'REFUND',
ADD COLUMN     "originalInvoiceNumber" TEXT;

-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN     "gatewayFee" DECIMAL(10,2),
ADD COLUMN     "gatewayFeeTax" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "InvoiceVersion" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "vendorDocumentNumber" TEXT,
    "remontDocumentNumber" TEXT,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "supersededBy" TEXT NOT NULL,
    "creditNoteId" TEXT,
    "supersededAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRecord" (
    "id" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "supplierGstin" TEXT,
    "supplierState" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "description" TEXT,
    "hsnSac" TEXT,
    "taxableValue" DECIMAL(12,2) NOT NULL,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalValue" DECIMAL(12,2) NOT NULL,
    "itcEligible" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceVersion_invoiceId_idx" ON "InvoiceVersion"("invoiceId");

-- CreateIndex
CREATE INDEX "PurchaseRecord_invoiceDate_idx" ON "PurchaseRecord"("invoiceDate");

-- AddForeignKey
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "InvoiceVersion_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
