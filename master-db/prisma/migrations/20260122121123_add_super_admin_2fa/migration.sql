-- AlterTable
ALTER TABLE "super_admins" ADD COLUMN     "lastTwoFactorAt" TIMESTAMP(3),
ADD COLUMN     "recoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twoFactorSecret" TEXT,
ADD COLUMN     "twoFactorVerified" BOOLEAN NOT NULL DEFAULT false;
