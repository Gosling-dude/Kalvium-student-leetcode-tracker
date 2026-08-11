-- Daily email reporting & follow-up (blockers + email approval workflow).
--
-- Purely additive: two new tables, two new enums, one new value appended to the
-- existing NotificationEvent enum. Nothing here alters or drops an existing column,
-- so it is safe to run against a database with live data.

-- CreateEnum
CREATE TYPE "BlockerCategory" AS ENUM ('CONCEPTUAL_DIFFICULTY', 'UNABLE_TO_UNDERSTAND_PROBLEM', 'UNABLE_TO_IDENTIFY_PATTERN', 'CODING_IMPLEMENTATION_ISSUE', 'ENVIRONMENT_SETUP_ISSUE', 'LEETCODE_ISSUE', 'TIME_MANAGEMENT', 'INTERNET_DEVICE_ISSUE', 'PERSONAL_REASON', 'NO_BLOCKER', 'OTHER');

-- CreateEnum
CREATE TYPE "EmailReportStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "NotificationEvent" ADD VALUE 'DAILY_REPORT_PENDING_APPROVAL';

-- CreateTable
CREATE TABLE "blockers" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "dayKey" TEXT NOT NULL,
    "solvedCount" INTEGER NOT NULL,
    "assignedCount" INTEGER NOT NULL,
    "category" "BlockerCategory" NOT NULL DEFAULT 'NO_BLOCKER',
    "description" TEXT,
    "actionTaken" TEXT,
    "followUpRequired" BOOLEAN NOT NULL DEFAULT false,
    "followUpDate" TEXT,
    "mentorNotes" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "recordedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blockers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_reports" (
    "id" UUID NOT NULL,
    "dayKey" TEXT NOT NULL,
    "status" "EmailReportStatus" NOT NULL DEFAULT 'DRAFT',
    "fromEmail" TEXT NOT NULL,
    "toRecipients" TEXT[],
    "ccRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "generatedById" UUID,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "failedError" TEXT,
    "supersedesId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blockers_dayKey_idx" ON "blockers"("dayKey");

-- CreateIndex
CREATE INDEX "blockers_studentId_idx" ON "blockers"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "blockers_studentId_dayKey_key" ON "blockers"("studentId", "dayKey");

-- CreateIndex
CREATE INDEX "email_reports_dayKey_idx" ON "email_reports"("dayKey");

-- CreateIndex
CREATE INDEX "email_reports_status_idx" ON "email_reports"("status");

-- CreateIndex
CREATE INDEX "email_reports_dayKey_status_idx" ON "email_reports"("dayKey", "status");

-- AddForeignKey
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_reports" ADD CONSTRAINT "email_reports_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_reports" ADD CONSTRAINT "email_reports_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

