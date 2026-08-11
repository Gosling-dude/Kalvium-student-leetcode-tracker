-- Batch as a first-class concept: per-batch assignments, cohorts, belt levels,
-- archival instead of deletion, and an immutable record of historical placement.
--
-- This migration is strictly additive. It creates columns, tables, indexes and two
-- batch rows; it does not drop a table, drop a data-bearing column, or delete a row.
-- The only thing it removes is the unique *index* on `assignments("dayKey")`, which is
-- replaced in the same statement group by a pair of constraints that permit one
-- assignment per (day, batch) while still forbidding two batch-less rows for one day.
-- Dropping an index destroys no data.
--
-- Everything here is written to be re-runnable (IF NOT EXISTS / ON CONFLICT), because
-- the Render build runs `prisma migrate deploy` on every deploy and a partially applied
-- migration must be recoverable by re-running it rather than by hand-editing production.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Postgres forbids *using* a newly added enum value in the transaction that adds it.
-- Nothing below writes 'ARCHIVED' — students are archived at runtime by the roster
-- sync, never by this migration — so adding it here is safe.
ALTER TYPE "StudentStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';

DO $$ BEGIN
  CREATE TYPE "BatchStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BatchChangeSource" AS ENUM ('MANUAL', 'ROSTER_SYNC', 'IMPORT', 'MIGRATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- batches — code, description, status, ordering
-- ---------------------------------------------------------------------------

ALTER TABLE "batches" ADD COLUMN IF NOT EXISTS "code" TEXT;
ALTER TABLE "batches" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "batches" ADD COLUMN IF NOT EXISTS "status" "BatchStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "batches" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Backfill `code` for batches that already exist (production has at least "Batch 2026").
-- Derived from the name and de-duplicated deterministically, so the NOT NULL + UNIQUE
-- constraints below can be applied without inspecting production data first.
WITH slugged AS (
  SELECT
    "id",
    NULLIF(upper(trim(BOTH '-' FROM regexp_replace("name", '[^A-Za-z0-9]+', '-', 'g'))), '') AS base,
    row_number() OVER (
      PARTITION BY NULLIF(upper(trim(BOTH '-' FROM regexp_replace("name", '[^A-Za-z0-9]+', '-', 'g'))), '')
      ORDER BY "createdAt", "id"
    ) AS rn
  FROM "batches"
  WHERE "code" IS NULL
)
UPDATE "batches" b
SET "code" = CASE WHEN s.rn = 1 THEN COALESCE(s.base, 'BATCH') ELSE COALESCE(s.base, 'BATCH') || '-' || s.rn END
FROM slugged s
WHERE b."id" = s."id";

-- Any remaining NULL (a batch whose name held no alphanumerics at all) gets its id.
UPDATE "batches" SET "code" = 'BATCH-' || left("id"::text, 8) WHERE "code" IS NULL;

ALTER TABLE "batches" ALTER COLUMN "code" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "batches_code_key" ON "batches"("code");
CREATE INDEX IF NOT EXISTS "batches_status_idx" ON "batches"("status");

-- The two current batches. `ON CONFLICT DO NOTHING` on both unique keys makes this a
-- no-op when they already exist, which is what keeps the deploy build idempotent.
INSERT INTO "batches" ("id", "name", "code", "description", "status", "sortOrder", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Foundation Level', 'A', 'Batch A — Foundation Level', 'ACTIVE', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Intermediate Level', 'B', 'Batch B — Intermediate Level', 'ACTIVE', 2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- ---------------------------------------------------------------------------
-- students — cohort, belt level, archival
-- ---------------------------------------------------------------------------

ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "cohort" INTEGER;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "maxBeltLevel" INTEGER;
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "archivedReason" TEXT;

CREATE INDEX IF NOT EXISTS "students_cohort_idx" ON "students"("cohort");
CREATE INDEX IF NOT EXISTS "students_status_batchId_idx" ON "students"("status", "batchId");

-- ---------------------------------------------------------------------------
-- student_batch_history — append-only record of placement over time
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "student_batch_history" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "fromBatchId" UUID,
    "toBatchId" UUID,
    "effectiveFromDayKey" TEXT NOT NULL,
    "reason" TEXT,
    "source" "BatchChangeSource" NOT NULL DEFAULT 'MANUAL',
    "changedById" UUID,
    "changedByName" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_batch_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "student_batch_history_studentId_effectiveFromDayKey_idx"
  ON "student_batch_history"("studentId", "effectiveFromDayKey");
CREATE INDEX IF NOT EXISTS "student_batch_history_toBatchId_idx"
  ON "student_batch_history"("toBatchId");
CREATE INDEX IF NOT EXISTS "student_batch_history_changedAt_idx"
  ON "student_batch_history"("changedAt");

DO $$ BEGIN
  ALTER TABLE "student_batch_history"
    ADD CONSTRAINT "student_batch_history_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "student_batch_history"
    ADD CONSTRAINT "student_batch_history_fromBatchId_fkey"
    FOREIGN KEY ("fromBatchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "student_batch_history"
    ADD CONSTRAINT "student_batch_history_toBatchId_fkey"
    FOREIGN KEY ("toBatchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "student_batch_history"
    ADD CONSTRAINT "student_batch_history_changedById_fkey"
    FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- assignments — one problem set per (day, batch)
-- ---------------------------------------------------------------------------

ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "batchId" UUID;

-- Existing rows keep `batchId = NULL` on purpose. NULL means "created before batches
-- existed, applied to everyone", which is what actually happened. Assigning them to a
-- batch now would be the retroactive rewrite of history that §7 forbids; the resolver
-- falls back to these rows for any student whose batch has no assignment that day.

DROP INDEX IF EXISTS "assignments_dayKey_key";

-- One assignment per batch per day. NULLs compare as distinct in a Postgres unique
-- index, so this constraint alone would still allow two legacy batch-less rows on one
-- day — the partial index below is what actually forbids that.
CREATE UNIQUE INDEX IF NOT EXISTS "assignments_dayKey_batchId_key"
  ON "assignments"("dayKey", "batchId");

CREATE UNIQUE INDEX IF NOT EXISTS "assignments_dayKey_legacy_key"
  ON "assignments"("dayKey") WHERE "batchId" IS NULL;

CREATE INDEX IF NOT EXISTS "assignments_batchId_dayKey_idx" ON "assignments"("batchId", "dayKey");

-- RESTRICT, not CASCADE: deleting a batch must never silently delete the assignment
-- history that belongs to it.
DO $$ BEGIN
  ALTER TABLE "assignments"
    ADD CONSTRAINT "assignments_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- daily_statuses — frozen historical batch
-- ---------------------------------------------------------------------------

ALTER TABLE "daily_statuses" ADD COLUMN IF NOT EXISTS "batchId" UUID;

-- Left NULL for existing rows for the same reason as assignments: these days were
-- recorded before batches existed. The rollup fills a NULL in from the student's batch
-- history the next time it recomputes that day, and never overwrites a non-NULL value.

CREATE INDEX IF NOT EXISTS "daily_statuses_dayKey_batchId_idx" ON "daily_statuses"("dayKey", "batchId");

DO $$ BEGIN
  ALTER TABLE "daily_statuses"
    ADD CONSTRAINT "daily_statuses_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- leaderboard_entries — batch at time of ranking
-- ---------------------------------------------------------------------------

ALTER TABLE "leaderboard_entries" ADD COLUMN IF NOT EXISTS "batchId" UUID;

CREATE INDEX IF NOT EXISTS "leaderboard_entries_period_periodKey_batchId_rank_idx"
  ON "leaderboard_entries"("period", "periodKey", "batchId", "rank");

DO $$ BEGIN
  ALTER TABLE "leaderboard_entries"
    ADD CONSTRAINT "leaderboard_entries_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- email_reports — which batch a report covers (NULL = overall)
-- ---------------------------------------------------------------------------

ALTER TABLE "email_reports" ADD COLUMN IF NOT EXISTS "batchId" UUID;

CREATE INDEX IF NOT EXISTS "email_reports_dayKey_batchId_status_idx"
  ON "email_reports"("dayKey", "batchId", "status");

DO $$ BEGIN
  ALTER TABLE "email_reports"
    ADD CONSTRAINT "email_reports_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
