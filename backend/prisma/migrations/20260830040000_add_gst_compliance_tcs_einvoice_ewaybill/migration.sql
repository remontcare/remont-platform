-- Phase 7 (C-10 TCS, e-Invoice, e-Way Bill) — purely additive: new tables, one new enum
-- value on the existing ProductLedgerEntryType, two new nullable/defaulted columns
-- (ServiceCategory.gstSection95Status, ProductVendor.eInvoiceEnabled). No existing column
-- altered, no historical Order/Invoice/ProductVendorLedgerEntry row modified. Every new
-- flag defaults to inert (TCS rate unconfigured = 0, eInvoiceEnabled = false,
-- gstSection95Status = null/undetermined), so this migration changes zero computed
-- financial outcomes for any existing or newly-placed order until an admin/CA explicitly
-- configures otherwise.

-- AlterEnum
ALTER TYPE "ProductLedgerEntryType" ADD VALUE 'TCS';

-- AlterTable
ALTER TABLE "ServiceCategory" ADD COLUMN "gstSection95Status" TEXT;

-- AlterTable
ALTER TABLE "ProductVendor" ADD COLUMN "eInvoiceEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TcsRecord" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "taxPeriod" TEXT NOT NULL,
    "taxableBase" DECIMAL(10,2) NOT NULL,
    "tcsRatePercent" DECIMAL(5,2) NOT NULL,
    "cgstAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "reversedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'COLLECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TcsRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TcsRecord_orderId_key" ON "TcsRecord"("orderId");

-- CreateIndex
CREATE INDEX "TcsRecord_sellerId_financialYear_taxPeriod_idx" ON "TcsRecord"("sellerId", "financialYear", "taxPeriod");

-- CreateEnum
CREATE TYPE "EInvoiceStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SUBMITTED', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "EInvoiceRecord" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "status" "EInvoiceStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "irn" TEXT,
    "ackNumber" TEXT,
    "ackDate" TIMESTAMP(3),
    "signedInvoiceData" TEXT,
    "qrPayload" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EInvoiceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EInvoiceRecord_invoiceId_key" ON "EInvoiceRecord"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "EInvoiceRecord_irn_key" ON "EInvoiceRecord"("irn");

-- CreateEnum
CREATE TYPE "EWayBillStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'GENERATED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "EWayBillRecord" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "status" "EWayBillStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "ewbNumber" TEXT,
    "ewbDate" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "consignmentValue" DECIMAL(10,2),
    "transporterName" TEXT,
    "transporterGstin" TEXT,
    "vehicleNumber" TEXT,
    "transportMode" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EWayBillRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EWayBillRecord_orderId_key" ON "EWayBillRecord"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "EWayBillRecord_ewbNumber_key" ON "EWayBillRecord"("ewbNumber");

-- CreateIndex
CREATE INDEX "EWayBillRecord_orderId_idx" ON "EWayBillRecord"("orderId");

-- AddForeignKey
ALTER TABLE "EInvoiceRecord" ADD CONSTRAINT "EInvoiceRecord_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
