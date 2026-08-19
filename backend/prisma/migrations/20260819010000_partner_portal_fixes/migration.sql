-- Partner Portal audit fixes: additive only, no existing column/table touched.
ALTER TABLE "ServiceVendor" ADD COLUMN "experienceYears" TEXT;

-- Address/city correction request queue — mirrors VendorBankUpdateRequest's shape exactly.
CREATE TABLE "VendorCityUpdateRequest" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "requestedCity" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,

    CONSTRAINT "VendorCityUpdateRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VendorCityUpdateRequest_vendorId_idx" ON "VendorCityUpdateRequest"("vendorId");
CREATE INDEX "VendorCityUpdateRequest_status_idx" ON "VendorCityUpdateRequest"("status");

ALTER TABLE "VendorCityUpdateRequest" ADD CONSTRAINT "VendorCityUpdateRequest_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "ServiceVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- New wallet-credit ledger entry type for the partner "Add Money" flow.
ALTER TYPE "LedgerEntryType" ADD VALUE 'TOP_UP';
