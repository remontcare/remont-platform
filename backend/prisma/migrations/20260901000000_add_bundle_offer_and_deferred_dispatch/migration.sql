-- Bundle offer (product + service checked out together) — purely additive: three new
-- columns on Order, all nullable or safely defaulted, so no existing row is touched.
-- No existing column altered, no historical Order row rewritten.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "bundleDiscountPercent" DECIMAL(5,2),
ADD COLUMN "bundleDiscountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN "bundleDispatchDeferred" BOOLEAN NOT NULL DEFAULT false;

-- Seed the admin-configurable default so it's immediately visible/editable on the
-- Admin > Settings > Operations page without requiring a re-run of AdminService.seedData().
-- ON CONFLICT DO NOTHING — a no-op if this key already exists.
INSERT INTO "SiteSetting" ("id", "key", "value", "label", "group")
VALUES ('bundle_discount_percent', 'bundle_discount_percent', '10', 'Bundle Offer — discount % applied to the service when a product is in the same order', 'operations')
ON CONFLICT ("key") DO NOTHING;
