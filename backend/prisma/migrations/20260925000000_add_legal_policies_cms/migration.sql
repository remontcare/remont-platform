-- CreateEnum
CREATE TYPE "LegalPolicyStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LegalPolicyVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "LegalPolicy" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "publicPath" TEXT NOT NULL,
    "policyType" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'General',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "LegalPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "currentVersionId" TEXT,
    "currentVersion" TEXT,
    "effectiveDate" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "publishedByName" TEXT,
    "createdById" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "showInFooter" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalPolicyVersion" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "major" INTEGER NOT NULL,
    "minor" INTEGER NOT NULL,
    "status" "LegalPolicyVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "changeNote" TEXT,
    "effectiveDate" TIMESTAMP(3),
    "restoredFromVersionId" TEXT,
    "createdById" TEXT,
    "publishedById" TEXT,
    "publishedByName" TEXT,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalPolicySection" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalPolicySection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyAcceptance" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "userId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegalPolicy_slug_key" ON "LegalPolicy"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "LegalPolicy_publicPath_key" ON "LegalPolicy"("publicPath");

-- CreateIndex
CREATE INDEX "LegalPolicy_status_sortOrder_idx" ON "LegalPolicy"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "LegalPolicyVersion_policyId_status_idx" ON "LegalPolicyVersion"("policyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LegalPolicyVersion_policyId_version_key" ON "LegalPolicyVersion"("policyId", "version");

-- CreateIndex
CREATE INDEX "LegalPolicySection_versionId_sortOrder_idx" ON "LegalPolicySection"("versionId", "sortOrder");

-- CreateIndex
CREATE INDEX "PolicyAcceptance_policyId_versionId_idx" ON "PolicyAcceptance"("policyId", "versionId");

-- CreateIndex
CREATE INDEX "PolicyAcceptance_userId_idx" ON "PolicyAcceptance"("userId");

-- CreateIndex
CREATE INDEX "PolicyAcceptance_subjectType_subjectId_idx" ON "PolicyAcceptance"("subjectType", "subjectId");

-- AddForeignKey
ALTER TABLE "LegalPolicyVersion" ADD CONSTRAINT "LegalPolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "LegalPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalPolicySection" ADD CONSTRAINT "LegalPolicySection_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "LegalPolicyVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyAcceptance" ADD CONSTRAINT "PolicyAcceptance_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "LegalPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

