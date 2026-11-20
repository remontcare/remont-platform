-- Admin per-document KYC review for partner applications. Nullable and additive: existing
-- rows keep working (null = nothing reviewed yet), no backfill.
ALTER TABLE "PartnerRegistration" ADD COLUMN "documentReview" JSONB;
