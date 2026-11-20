-- Section 9(5) is driven by the existing ServiceCategory.gstSection95Status (APPLICABLE only).
-- The duplicate section95Applicable flag is retired: default false, no longer read; column kept
-- (never dropped). Additive/default-only change.
ALTER TABLE "ServiceCategory" ALTER COLUMN "section95Applicable" SET DEFAULT false;
