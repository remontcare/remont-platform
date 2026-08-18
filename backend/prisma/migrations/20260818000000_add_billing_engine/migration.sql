-- Billing/GST engine: additive-only migration. No existing column/table is renamed,
-- dropped, or has its type changed. Every new Invoice/Order/ServiceVendor/ProductVendor
-- column is nullable (or defaults to 0 for new numeric fields), so existing rows and
-- existing running code are unaffected.

-- CreateEnum
CREATE TYPE "BillingTransactionType" AS ENUM ('PLATFORM_SERVICE', 'DIRECT_PROJECT', 'MARKETPLACE_PRODUCT');

-- AlterTable: Order — billing classification, snapshotted once at confirmation time
ALTER TABLE "Order" ADD COLUMN "billingTransactionType" "BillingTransactionType";

-- AlterTable: ServiceVendor — partner GST registration (optional; most partners have none)
ALTER TABLE "ServiceVendor" ADD COLUMN "gstin" TEXT;

-- AlterTable: ProductVendor — registered state, needed as place-of-supply when Remont
-- invoices its marketplace commission to the seller
ALTER TABLE "ProductVendor" ADD COLUMN "state" TEXT;

-- AlterTable: Service / Product — HSN/SAC code + per-item GST rate override for invoice
-- line items. Different services/products legitimately carry different GST slabs even
-- within the same catalog, so this is per-row, not a single blanket rate.
ALTER TABLE "Service" ADD COLUMN "hsnSac" TEXT;
ALTER TABLE "Product" ADD COLUMN "hsnSac" TEXT;
ALTER TABLE "Product" ADD COLUMN "gstOverridePercent" DECIMAL(5,2);

-- AlterTable: Invoice — transaction classification, IGST support, visible round-off,
-- and a frozen line-item snapshot for the PDF table
ALTER TABLE "Invoice" ADD COLUMN "transactionType" "BillingTransactionType";
ALTER TABLE "Invoice" ADD COLUMN "placeOfSupply" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "supplierState" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "supplierGstin" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "customerIgst" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN "remontIgst" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN "roundOff" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN "discount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN "lineItemsSnapshot" JSONB;
