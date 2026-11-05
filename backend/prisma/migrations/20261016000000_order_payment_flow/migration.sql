-- Order/payment flow: cart payment share per job, deferred partner earnings, unpaid-wallet release,
-- OTP attempt limits/expiry, verification of partner-reported cash. Additive only (nullable/defaulted).
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cartPaidAmount" DECIMAL(10,2),
ADD COLUMN     "earningsPostedAt" TIMESTAMP(3),
ADD COLUMN     "earningsStatus" TEXT,
ADD COLUMN     "endOtpExpiresAt" TIMESTAMP(3),
ADD COLUMN     "endOtpFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extraOtpFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "startOtpExpiresAt" TIMESTAMP(3),
ADD COLUMN     "startOtpFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "walletReleasedAt" TIMESTAMP(3);
-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN     "verificationMethod" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedBy" TEXT;
