-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MENTOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "ProblemStatus" AS ENUM ('ACCEPTED', 'ATTEMPTED_NOT_ACCEPTED', 'NOT_ATTEMPTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DROPPED', 'PAUSED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('OK', 'NEVER_SYNCED', 'USER_NOT_FOUND', 'PROFILE_PRIVATE', 'RATE_LIMITED', 'PROVIDER_ERROR', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('MANUAL', 'CRON', 'RETRY', 'IMPORT', 'API');

-- CreateEnum
CREATE TYPE "SyncMode" AS ENUM ('FULL', 'INCREMENTAL', 'RETRY_FAILED', 'SINGLE_STUDENT');

-- CreateEnum
CREATE TYPE "LeaderboardPeriod" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'ALL_TIME');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SLACK', 'DISCORD', 'WHATSAPP', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "NotificationEvent" AS ENUM ('ASSIGNMENT_MISSED', 'STREAK_BROKEN', 'LEADERBOARD_UPDATED', 'SYNC_COMPLETED', 'SYNC_FAILED', 'ACHIEVEMENT_UNLOCKED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'MENTOR',
    "avatarUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batches" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "batchId" UUID,
    "mentorId" UUID,
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "leetcodeUsername" TEXT NOT NULL,
    "leetcodeDisplayName" TEXT,
    "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
    "avatarUrl" TEXT,
    "batchId" UUID,
    "groupId" UUID,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "totalSolved" INTEGER NOT NULL DEFAULT 0,
    "totalScore" INTEGER NOT NULL DEFAULT 0,
    "easySolved" INTEGER NOT NULL DEFAULT 0,
    "mediumSolved" INTEGER NOT NULL DEFAULT 0,
    "hardSolved" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "problems" (
    "id" UUID NOT NULL,
    "titleSlug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "questionId" TEXT,
    "questionFrontendId" TEXT,
    "difficulty" "Difficulty" NOT NULL,
    "acceptanceRate" DOUBLE PRECISION,
    "isPaidOnly" BOOLEAN NOT NULL DEFAULT false,
    "topicTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "companyTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "url" TEXT NOT NULL,
    "metadataFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "problems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" UUID NOT NULL,
    "dayKey" TEXT NOT NULL,
    "title" TEXT,
    "topic" TEXT,
    "notes" TEXT,
    "difficulty" "Difficulty",
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_problems" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "problemId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "assignment_problems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "problemId" UUID,
    "providerSubmissionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'leetcode',
    "titleSlug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ProblemStatus" NOT NULL DEFAULT 'ACCEPTED',
    "language" TEXT,
    "runtime" TEXT,
    "memory" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "dayKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_sync_states" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "lastSubmissionAt" TIMESTAMP(3),
    "lastProviderSubmissionId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "status" "SyncStatus" NOT NULL DEFAULT 'NEVER_SYNCED',
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "totalSyncs" INTEGER NOT NULL DEFAULT 0,
    "providerTotalSolved" INTEGER,
    "providerEasySolved" INTEGER,
    "providerMediumSolved" INTEGER,
    "providerHardSolved" INTEGER,
    "providerRanking" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_statuses" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "dayKey" TEXT NOT NULL,
    "assignmentId" UUID,
    "assignedCount" INTEGER NOT NULL DEFAULT 0,
    "solvedCount" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER NOT NULL DEFAULT 0,
    "scoreBreakdown" JSONB,
    "completedAt" TIMESTAMP(3),
    "completionMinute" INTEGER,
    "firstSolvedAt" TIMESTAMP(3),
    "lastSolvedAt" TIMESTAMP(3),
    "isPerfect" BOOLEAN NOT NULL DEFAULT false,
    "streakAtDay" INTEGER NOT NULL DEFAULT 0,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'NEVER_SYNCED',
    "isOverridden" BOOLEAN NOT NULL DEFAULT false,
    "overrideNote" TEXT,
    "overriddenById" UUID,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_problem_statuses" (
    "id" UUID NOT NULL,
    "dailyStatusId" UUID NOT NULL,
    "problemId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "ProblemStatus" NOT NULL DEFAULT 'NOT_ATTEMPTED',
    "solvedAt" TIMESTAMP(3),
    "language" TEXT,
    "runtime" TEXT,
    "memory" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "daily_problem_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_entries" (
    "id" UUID NOT NULL,
    "period" "LeaderboardPeriod" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "studentId" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "previousRank" INTEGER,
    "score" INTEGER NOT NULL DEFAULT 0,
    "solvedCount" INTEGER NOT NULL DEFAULT 0,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "completionMinute" INTEGER,
    "consistency" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isTied" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_leaderboard_entries" (
    "id" UUID NOT NULL,
    "period" "LeaderboardPeriod" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "groupId" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "previousRank" INTEGER,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "averageCompletion" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalSolved" INTEGER NOT NULL DEFAULT 0,
    "averageStreak" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "averageScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isTied" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_leaderboard_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring_configs" (
    "id" UUID NOT NULL,
    "version" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scoring_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" UUID NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'QUEUED',
    "mode" "SyncMode" NOT NULL DEFAULT 'INCREMENTAL',
    "trigger" "SyncTrigger" NOT NULL DEFAULT 'MANUAL',
    "dayKey" TEXT,
    "totalStudents" INTEGER NOT NULL DEFAULT 0,
    "processedStudents" INTEGER NOT NULL DEFAULT 0,
    "succeededStudents" INTEGER NOT NULL DEFAULT 0,
    "failedStudents" INTEGER NOT NULL DEFAULT 0,
    "newSubmissions" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "error" TEXT,
    "errorDetail" JSONB,
    "triggeredById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_job_items" (
    "id" UUID NOT NULL,
    "syncJobId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'NEVER_SYNCED',
    "newSubmissions" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "durationMs" INTEGER,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_job_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_achievements" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "student_achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentor_notes" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "authorId" UUID,
    "body" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mentor_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "actorName" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_logs" (
    "id" UUID NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "context" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channel_configs" (
    "id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "events" "NotificationEvent"[] DEFAULT ARRAY[]::"NotificationEvent"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_channel_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "event" "NotificationEvent" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "studentId" UUID,
    "recipient" TEXT,
    "payload" JSONB,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_isActive_idx" ON "users"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_prefix_idx" ON "api_keys"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "batches_name_key" ON "batches"("name");

-- CreateIndex
CREATE INDEX "batches_isActive_idx" ON "batches"("isActive");

-- CreateIndex
CREATE INDEX "groups_mentorId_idx" ON "groups"("mentorId");

-- CreateIndex
CREATE UNIQUE INDEX "groups_batchId_name_key" ON "groups"("batchId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "students_email_key" ON "students"("email");

-- CreateIndex
CREATE UNIQUE INDEX "students_leetcodeUsername_key" ON "students"("leetcodeUsername");

-- CreateIndex
CREATE INDEX "students_groupId_idx" ON "students"("groupId");

-- CreateIndex
CREATE INDEX "students_batchId_idx" ON "students"("batchId");

-- CreateIndex
CREATE INDEX "students_status_idx" ON "students"("status");

-- CreateIndex
CREATE INDEX "students_name_idx" ON "students"("name");

-- CreateIndex
CREATE UNIQUE INDEX "problems_titleSlug_key" ON "problems"("titleSlug");

-- CreateIndex
CREATE INDEX "problems_difficulty_idx" ON "problems"("difficulty");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_dayKey_key" ON "assignments"("dayKey");

-- CreateIndex
CREATE INDEX "assignments_dayKey_idx" ON "assignments"("dayKey");

-- CreateIndex
CREATE INDEX "assignment_problems_problemId_idx" ON "assignment_problems"("problemId");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_problems_assignmentId_position_key" ON "assignment_problems"("assignmentId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_problems_assignmentId_problemId_key" ON "assignment_problems"("assignmentId", "problemId");

-- CreateIndex
CREATE INDEX "submissions_studentId_dayKey_idx" ON "submissions"("studentId", "dayKey");

-- CreateIndex
CREATE INDEX "submissions_studentId_titleSlug_idx" ON "submissions"("studentId", "titleSlug");

-- CreateIndex
CREATE INDEX "submissions_studentId_submittedAt_idx" ON "submissions"("studentId", "submittedAt");

-- CreateIndex
CREATE INDEX "submissions_titleSlug_idx" ON "submissions"("titleSlug");

-- CreateIndex
CREATE INDEX "submissions_dayKey_idx" ON "submissions"("dayKey");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_studentId_provider_providerSubmissionId_key" ON "submissions"("studentId", "provider", "providerSubmissionId");

-- CreateIndex
CREATE UNIQUE INDEX "student_sync_states_studentId_key" ON "student_sync_states"("studentId");

-- CreateIndex
CREATE INDEX "student_sync_states_status_idx" ON "student_sync_states"("status");

-- CreateIndex
CREATE INDEX "student_sync_states_lastSyncedAt_idx" ON "student_sync_states"("lastSyncedAt");

-- CreateIndex
CREATE INDEX "daily_statuses_dayKey_idx" ON "daily_statuses"("dayKey");

-- CreateIndex
CREATE INDEX "daily_statuses_dayKey_solvedCount_idx" ON "daily_statuses"("dayKey", "solvedCount");

-- CreateIndex
CREATE INDEX "daily_statuses_studentId_idx" ON "daily_statuses"("studentId");

-- CreateIndex
CREATE INDEX "daily_statuses_dayKey_score_idx" ON "daily_statuses"("dayKey", "score");

-- CreateIndex
CREATE UNIQUE INDEX "daily_statuses_studentId_dayKey_key" ON "daily_statuses"("studentId", "dayKey");

-- CreateIndex
CREATE INDEX "daily_problem_statuses_problemId_idx" ON "daily_problem_statuses"("problemId");

-- CreateIndex
CREATE INDEX "daily_problem_statuses_status_idx" ON "daily_problem_statuses"("status");

-- CreateIndex
CREATE UNIQUE INDEX "daily_problem_statuses_dailyStatusId_problemId_key" ON "daily_problem_statuses"("dailyStatusId", "problemId");

-- CreateIndex
CREATE INDEX "leaderboard_entries_period_periodKey_rank_idx" ON "leaderboard_entries"("period", "periodKey", "rank");

-- CreateIndex
CREATE INDEX "leaderboard_entries_studentId_idx" ON "leaderboard_entries"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "leaderboard_entries_period_periodKey_studentId_key" ON "leaderboard_entries"("period", "periodKey", "studentId");

-- CreateIndex
CREATE INDEX "group_leaderboard_entries_period_periodKey_rank_idx" ON "group_leaderboard_entries"("period", "periodKey", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "group_leaderboard_entries_period_periodKey_groupId_key" ON "group_leaderboard_entries"("period", "periodKey", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "scoring_configs_version_key" ON "scoring_configs"("version");

-- CreateIndex
CREATE INDEX "scoring_configs_isActive_idx" ON "scoring_configs"("isActive");

-- CreateIndex
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs"("status");

-- CreateIndex
CREATE INDEX "sync_jobs_createdAt_idx" ON "sync_jobs"("createdAt");

-- CreateIndex
CREATE INDEX "sync_jobs_dayKey_idx" ON "sync_jobs"("dayKey");

-- CreateIndex
CREATE INDEX "sync_job_items_syncJobId_status_idx" ON "sync_job_items"("syncJobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sync_job_items_syncJobId_studentId_key" ON "sync_job_items"("syncJobId", "studentId");

-- CreateIndex
CREATE INDEX "student_achievements_code_idx" ON "student_achievements"("code");

-- CreateIndex
CREATE UNIQUE INDEX "student_achievements_studentId_code_key" ON "student_achievements"("studentId", "code");

-- CreateIndex
CREATE INDEX "mentor_notes_studentId_idx" ON "mentor_notes"("studentId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "system_logs_level_idx" ON "system_logs"("level");

-- CreateIndex
CREATE INDEX "system_logs_context_idx" ON "system_logs"("context");

-- CreateIndex
CREATE INDEX "system_logs_createdAt_idx" ON "system_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_channel_configs_channel_key" ON "notification_channel_configs"("channel");

-- CreateIndex
CREATE INDEX "notification_logs_channel_status_idx" ON "notification_logs"("channel", "status");

-- CreateIndex
CREATE INDEX "notification_logs_createdAt_idx" ON "notification_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_problems" ADD CONSTRAINT "assignment_problems_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_problems" ADD CONSTRAINT "assignment_problems_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "problems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "problems"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_sync_states" ADD CONSTRAINT "student_sync_states_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_statuses" ADD CONSTRAINT "daily_statuses_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_statuses" ADD CONSTRAINT "daily_statuses_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_problem_statuses" ADD CONSTRAINT "daily_problem_statuses_dailyStatusId_fkey" FOREIGN KEY ("dailyStatusId") REFERENCES "daily_statuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_problem_statuses" ADD CONSTRAINT "daily_problem_statuses_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "problems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard_entries" ADD CONSTRAINT "leaderboard_entries_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_leaderboard_entries" ADD CONSTRAINT "group_leaderboard_entries_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_job_items" ADD CONSTRAINT "sync_job_items_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "sync_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_achievements" ADD CONSTRAINT "student_achievements_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentor_notes" ADD CONSTRAINT "mentor_notes_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentor_notes" ADD CONSTRAINT "mentor_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;
