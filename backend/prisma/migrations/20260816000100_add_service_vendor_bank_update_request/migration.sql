-- Bank fields on ServiceVendor (same names as ProductVendor's equivalent columns)
ALTER TABLE "ServiceVendor" ADD COLUMN "bankAccountHolder" TEXT;
ALTER TABLE "ServiceVendor" ADD COLUMN "bankName" TEXT;
ALTER TABLE "ServiceVendor" ADD COLUMN "bankAccountNumber" TEXT;
ALTER TABLE "ServiceVendor" ADD COLUMN "bankIfsc" TEXT;
ALTER TABLE "ServiceVendor" ADD COLUMN "bankBranch" TEXT;

-- VendorBankUpdateRequest
CREATE TABLE "VendorBankUpdateRequest" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,

    CONSTRAINT "VendorBankUpdateRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VendorBankUpdateRequest_vendorId_idx" ON "VendorBankUpdateRequest"("vendorId");

ALTER TABLE "VendorBankUpdateRequest" ADD CONSTRAINT "VendorBankUpdateRequest_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "ServiceVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
