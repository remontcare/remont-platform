ALTER TABLE "ServiceCategory" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "ServiceCategory" ADD COLUMN "videoUrl" TEXT;

ALTER TABLE "SubCategory" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "SubCategory" ADD COLUMN "videoUrl" TEXT;

ALTER TABLE "Service" ADD COLUMN "videoUrl" TEXT;
