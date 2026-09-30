-- AlterTable
ALTER TABLE "super_admins" ADD COLUMN     "ipWhitelist" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "ipWhitelistEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "super_admin_sessions" (
    "id" TEXT NOT NULL,
    "superAdminId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT,
    "deviceInfo" TEXT,
    "location" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "super_admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "super_admin_sessions_tokenHash_key" ON "super_admin_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "super_admin_sessions_superAdminId_idx" ON "super_admin_sessions"("superAdminId");

-- CreateIndex
CREATE INDEX "super_admin_sessions_tokenHash_idx" ON "super_admin_sessions"("tokenHash");

-- AddForeignKey
ALTER TABLE "super_admin_sessions" ADD CONSTRAINT "super_admin_sessions_superAdminId_fkey" FOREIGN KEY ("superAdminId") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
