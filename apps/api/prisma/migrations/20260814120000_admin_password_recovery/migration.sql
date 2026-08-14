-- CreateTable
CREATE TABLE "admin_password_reset_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_password_reset_tokens_tokenHash_key" ON "admin_password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "admin_password_reset_tokens_userId_idx" ON "admin_password_reset_tokens"("userId");

-- CreateIndex
CREATE INDEX "admin_password_reset_tokens_expiresAt_idx" ON "admin_password_reset_tokens"("expiresAt");

-- AddForeignKey
ALTER TABLE "admin_password_reset_tokens" ADD CONSTRAINT "admin_password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
