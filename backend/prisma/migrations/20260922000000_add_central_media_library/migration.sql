-- CreateEnum
CREATE TYPE "MediaStorageProvider" AS ENUM ('R2', 'CLOUDINARY');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('UPLOADING', 'SCANNING', 'PROCESSING', 'READY', 'REJECTED', 'DELETED');

-- CreateEnum
CREATE TYPE "MediaEntityType" AS ENUM ('PRODUCT', 'SELLER_PROFILE', 'SERVICE', 'CATEGORY', 'SUBCATEGORY', 'BRAND', 'BANNER', 'MARKETING', 'PROJECT', 'BLOG', 'CMS', 'PARTNER_PROFILE', 'CUSTOMER_UPLOAD', 'LEAD', 'GENERAL');

-- CreateEnum
CREATE TYPE "MediaSource" AS ENUM ('UPLOAD', 'AI_GENERATED', 'MIGRATION');

-- CreateTable
CREATE TABLE "Media" (
    "id" TEXT NOT NULL,
    "storageProvider" "MediaStorageProvider" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT,
    "originalFormat" TEXT,
    "originalSize" INTEGER,
    "mimeType" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "checksum" TEXT NOT NULL,
    "mediaType" "MediaType" NOT NULL DEFAULT 'IMAGE',
    "source" "MediaSource" NOT NULL DEFAULT 'UPLOAD',
    "entityType" "MediaEntityType" NOT NULL,
    "entityId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "cloudinaryPublicId" TEXT,
    "deliveryUrl" TEXT,
    "variants" JSONB,
    "variantUrls" TEXT[],
    "status" "MediaStatus" NOT NULL DEFAULT 'PROCESSING',
    "uploadedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Media_storageKey_key" ON "Media"("storageKey");

-- CreateIndex
CREATE INDEX "Media_entityType_entityId_idx" ON "Media"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Media_uploadedBy_idx" ON "Media"("uploadedBy");

-- CreateIndex
CREATE INDEX "Media_status_createdAt_idx" ON "Media"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Media_checksum_idx" ON "Media"("checksum");

-- CreateIndex
CREATE INDEX "Media_variantUrls_idx" ON "Media" USING GIN ("variantUrls");

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

