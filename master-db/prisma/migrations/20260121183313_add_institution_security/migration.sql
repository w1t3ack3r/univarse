-- CreateEnum
CREATE TYPE "InstitutionStatus" AS ENUM ('PENDING', 'PROVISIONED', 'ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED');

-- AlterTable
ALTER TABLE "institutions" ADD COLUMN     "deletionCancelledAt" TIMESTAMP(3),
ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3),
ADD COLUMN     "deletionScheduledAt" TIMESTAMP(3),
ADD COLUMN     "deletionWarningsSent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "keyCreatedAt" TIMESTAMP(3),
ADD COLUMN     "keyRotatedAt" TIMESTAMP(3),
ADD COLUMN     "status" "InstitutionStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "tenantSecretKey" TEXT;
