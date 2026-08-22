-- Campus as a first-class concept: Campus → Batch → Student.
--
-- This migration is strictly additive with respect to data. It creates enums, tables,
-- columns, indexes and rows; it never drops a table, never drops a data-bearing column,
-- and never deletes a row. The only things it removes are three *indexes* on `batches`
-- ("code"/"name" global uniqueness) and one on `assignments`, each replaced in the same
-- statement group by a campus-scoped equivalent. Dropping an index destroys no data.
--
-- Everything is written to be re-runnable (IF NOT EXISTS / ON CONFLICT / DO $$ ... $$),
-- because deploy runs `prisma migrate deploy` on every push and a partially applied
-- migration must be recoverable by re-running it rather than by hand-editing production.
--
-- The one judgement call worth stating explicitly: **every pre-existing row is
-- backfilled to VELS.** That is not a reinterpretation of history (§38). Vels was the
-- only campus that had ever existed when those rows were written, so "all students",
-- "Foundation" and "the 4 Aug leaderboard" already meant the Vels ones. Leaving them
-- campus-less would have been the rewrite: a NULL campus reads as "every campus", which
-- would silently extend July's Vels assignments to SRM students who were not enrolled.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "CampusStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- campuses
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "campuses" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "status" "CampusStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campuses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "campuses_name_key" ON "campuses"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "campuses_code_key" ON "campuses"("code");
CREATE INDEX IF NOT EXISTS "campuses_status_idx" ON "campuses"("status");
CREATE INDEX IF NOT EXISTS "campuses_sortOrder_idx" ON "campuses"("sortOrder");

-- The two campuses that exist today. Names are data, not constants in the codebase.
INSERT INTO "campuses" ("id", "name", "code", "description", "status", "sortOrder", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Vels Institute of Science, Technology & Advanced Studies', 'VELS',
   'Founding campus of the Kalvium DSA programme.', 'ACTIVE', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'SRM University', 'SRM',
   'Second campus, onboarded August 2026.', 'ACTIVE', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- ---------------------------------------------------------------------------
-- batches — campus ownership, campus-scoped uniqueness
-- ---------------------------------------------------------------------------

ALTER TABLE "batches" ADD COLUMN IF NOT EXISTS "campusId" UUID;

UPDATE "batches"
SET "campusId" = (SELECT "id" FROM "campuses" WHERE "code" = 'VELS')
WHERE "campusId" IS NULL;

ALTER TABLE "batches" ALTER COLUMN "campusId" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "batches"
    ADD CONSTRAINT "batches_campusId_fkey"
    FOREIGN KEY ("campusId") REFERENCES "campuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Global uniqueness on code/name is what made a shared "Foundation" row unavoidable.
-- Replaced by campus-scoped uniqueness so VELS/A and SRM/A can coexist (§8).
DROP INDEX IF EXISTS "batches_code_key";
DROP INDEX IF EXISTS "batches_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "batches_campusId_code_key" ON "batches"("campusId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "batches_campusId_name_key" ON "batches"("campusId", "name");
CREATE INDEX IF NOT EXISTS "batches_campusId_status_sortOrder_idx"
  ON "batches"("campusId", "status", "sortOrder");

-- SRM's batches. Foundation/Intermediate mirror Vels' levels; PENDING is where students
-- sit until the diagnostic assessment places them, which is a real state and not a
-- guess (§7) — the roster supplies no belt level, so no placement is invented.
INSERT INTO "batches" ("id", "campusId", "name", "code", "description", "status", "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."id", v.name, v.code, v.description, 'ACTIVE', v."sortOrder", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campuses" c
CROSS JOIN (VALUES
  ('Foundation Level', 'A', 'Batch A — Foundation Level', 1),
  ('Intermediate Level', 'B', 'Batch B — Intermediate Level', 2),
  ('Placement Pending', 'PENDING', 'Awaiting the initial diagnostic assessment. No belt level has been determined yet.', 99)
) AS v(name, code, description, "sortOrder")
WHERE c."code" = 'SRM'
ON CONFLICT ("campusId", "code") DO NOTHING;

-- ---------------------------------------------------------------------------
-- squads — campus ownership
-- ---------------------------------------------------------------------------

ALTER TABLE "squads" ADD COLUMN IF NOT EXISTS "campusId" UUID;

UPDATE "squads" s
SET "campusId" = b."campusId"
FROM "batches" b
WHERE s."batchId" = b."id" AND s."campusId" IS NULL;

-- Batch-less squads predate campuses and belong to the founding campus.
UPDATE "squads"
SET "campusId" = (SELECT "id" FROM "campuses" WHERE "code" = 'VELS')
WHERE "campusId" IS NULL;

DO $$ BEGIN
  ALTER TABLE "squads"
    ADD CONSTRAINT "squads_campusId_fkey"
    FOREIGN KEY ("campusId") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "squads_campusId_name_key" ON "squads"("campusId", "name");
CREATE INDEX IF NOT EXISTS "squads_campusId_idx" ON "squads"("campusId");

-- ---------------------------------------------------------------------------
-- students — current campus
-- ---------------------------------------------------------------------------

ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "campusId" UUID;

-- Every student on the roster before this migration is a Vels student, including the
-- archived ones: archival records that they left the programme, not that they were
-- never in it, and their history must keep reading under the campus they were in.
UPDATE "students"
SET "campusId" = (SELECT "id" FROM "campuses" WHERE "code" = 'VELS')
WHERE "campusId" IS NULL;

DO $$ BEGIN
  ALTER TABLE "students"
    ADD CONSTRAINT "students_campusId_fkey"
    FOREIGN KEY ("campusId") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "students_campusId_idx" ON "students"("campusId");
CREATE INDEX IF NOT EXISTS "students_status_campusId_idx" ON "students"("status", "campusId");
CREATE INDEX IF NOT EXISTS "students_status_campusId_batchId_idx"
  ON "students"("status", "campusId", "batchId");

-- ---------------------------------------------------------------------------
-- student_campus_history — append-only record of campus over time
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "student_campus_history" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "fromCampusId" UUID,
    "toCampusId" UUID,
    "effectiveFromDayKey" TEXT NOT NULL,
    "reason" TEXT,
    "source" "BatchChangeSource" NOT NULL DEFAULT 'MANUAL',
    "changedById" UUID,
    "changedByName" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_campus_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "student_campus_history_studentId_effectiveFromDayKey_idx"
  ON "student_campus_history"("studentId", "effectiveFromDayKey");
CREATE INDEX IF NOT EXISTS "student_campus_history_toCampusId_idx"
  ON "student_campus_history"("toCampusId");
CREATE INDEX IF NOT EXISTS "student_campus_history_changedAt_idx"
  ON "student_campus_history"("changedAt");

DO $$ BEGIN
  ALTER TABLE "student_campus_history"
    ADD CONSTRAINT "student_campus_history_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "student_campus_history"
    ADD CONSTRAINT "student_campus_history_fromCampusId_fkey"
    FOREIGN KEY ("fromCampusId") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "student_campus_history"
    ADD CONSTRAINT "student_campus_history_toCampusId_fkey"
    FOREIGN KEY ("toCampusId") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "student_campus_history"
    ADD CONSTRAINT "student_campus_history_changedById_fkey"
    FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One founding placement per existing student.
--
-- `effectiveFromDayKey = '1970-01-01'` is deliberate. It is not a claim about an
-- enrolment date; it is the statement "for the entire span this system has records of,
-- this student was at Vels", which is true and is exactly what the resolver needs so
-- that *every* historical day resolves to Vels rather than to "no campus". Using a
-- computed enrolment day would need the program timezone inside SQL and would leave any
-- day before it unresolvable.
INSERT INTO "student_campus_history" ("id", "studentId", "fromCampusId", "toCampusId", "effectiveFromDayKey", "reason", "source", "changedAt")
SELECT
  gen_random_uuid(),
  s."id",
  NULL,
  (SELECT "id" FROM "campuses" WHERE "code" = 'VELS'),
  '1970-01-01',
  'Founding campus, recorded when multi-campus support was introduced.',
  'MIGRATION',
  CURRENT_TIMESTAMP
FROM "students" s
WHERE NOT EXISTS (SELECT 1 FROM "student_campus_history" h WHERE h."studentId" = s."id");

-- ---------------------------------------------------------------------------
-- assignments — campus + batch audience
-- ---------------------------------------------------------------------------

ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "campusId" UUID;
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "originalCampusId" UUID;

-- Every existing assignment becomes a Vels assignment — including the batch-less legacy
-- rows. Those said "everyone", and at the time everyone *was* Vels; leaving them NULL
-- would newly extend them to SRM, which is precisely the retroactive reinterpretation
-- §38 forbids. `batchId` is untouched, so a legacy row still means "all Vels batches".
UPDATE "assignments"
SET "campusId" = (SELECT "id" FROM "campuses" WHERE "code" = 'VELS')
WHERE "campusId" IS NULL;

-- `originalCampusId` mirrors `originalBatchId`'s contract: frozen at creation, first
-- write wins. For pre-campus rows the original audience was Vels, same as the current one.
UPDATE "assignments"
SET "originalCampusId" = "campusId"
WHERE "originalCampusId" IS NULL;

DO $$ BEGIN
  ALTER TABLE "assignments"
    ADD CONSTRAINT "assignments_campusId_fkey"
    FOREIGN KEY ("campusId") REFERENCES "campuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assignments"
    ADD CONSTRAINT "assignments_originalCampusId_fkey"
    FOREIGN KEY ("originalCampusId") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One assignment per (day, campus, batch). Postgres treats NULLs as distinct in a unique
-- index, so this composite alone cannot forbid two "all batches in SRM" rows on one day,
-- nor two "everyone everywhere" rows. The two partial indexes below cover those cases —
-- one per NULL shape — so every legal audience has exactly one row per day.
DROP INDEX IF EXISTS "assignments_dayKey_batchId_key";
DROP INDEX IF EXISTS "assignments_dayKey_legacy_key";

CREATE UNIQUE INDEX IF NOT EXISTS "assignments_dayKey_campusId_batchId_key"
  ON "assignments"("dayKey", "campusId", "batchId");

CREATE UNIQUE INDEX IF NOT EXISTS "assignments_dayKey_campus_allbatches_key"
  ON "assignments"("dayKey", "campusId") WHERE "batchId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "assignments_dayKey_global_key"
  ON "assignments"("dayKey") WHERE "campusId" IS NULL AND "batchId" IS NULL;

CREATE INDEX IF NOT EXISTS "assignments_campusId_dayKey_idx" ON "assignments"("campusId", "dayKey");
CREATE INDEX IF NOT EXISTS "assignments_campusId_batchId_dayKey_idx"
  ON "assignments"("campusId", "batchId", "dayKey");

-- ---------------------------------------------------------------------------
-- assignment_audience_changes — campus half of a retarget
-- ---------------------------------------------------------------------------

ALTER TABLE "assignment_audience_changes" ADD COLUMN IF NOT EXISTS "fromCampusId" UUID;
ALTER TABLE "assignment_audience_changes" ADD COLUMN IF NOT EXISTS "toCampusId" UUID;

DO $$ BEGIN
  ALTER TABLE "assignment_audience_changes"
    ADD CONSTRAINT "assignment_audience_changes_fromCampusId_fkey"
    FOREIGN KEY ("fromCampusId") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assignment_audience_changes"
    ADD CONSTRAINT "assignment_audience_changes_toCampusId_fkey"
    FOREIGN KEY ("toCampusId") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- daily_statuses — frozen historical campus
-- ---------------------------------------------------------------------------

ALTER TABLE "daily_statuses" ADD COLUMN IF NOT EXISTS "campusId" UUID;

-- Backfilled to Vels rather than left NULL: every one of these rows records a day on
-- which Vels was the only campus, so Vels is the historically correct value, and the
-- rollup's "write once, never overwrite" rule then protects it forever.
UPDATE "daily_statuses"
SET "campusId" = (SELECT "id" FROM "campuses" WHERE "code" = 'VELS')
WHERE "campusId" IS NULL;

DO $$ BEGIN
  ALTER TABLE "daily_statuses"
    ADD CONSTRAINT "daily_statuses_campusId_fkey"
    FOREIGN KEY ("campusId") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "daily_statuses_dayKey_campusId_idx"
  ON "daily_statuses"("dayKey", "campusId");
CREATE INDEX IF NOT EXISTS "daily_statuses_dayKey_campusId_batchId_idx"
  ON "daily_statuses"("dayKey", "campusId", "batchId");

-- ---------------------------------------------------------------------------
-- leaderboard_entries — campus at time of ranking, plus the global rank
-- ---------------------------------------------------------------------------

ALTER TABLE "leaderboard_entries" ADD COLUMN IF NOT EXISTS "campusId" UUID;
ALTER TABLE "leaderboard_entries" ADD COLUMN IF NOT EXISTS "globalRank" INTEGER;

UPDATE "leaderboard_entries"
SET "campusId" = (SELECT "id" FROM "campuses" WHERE "code" = 'VELS')
WHERE "campusId" IS NULL;

-- Existing snapshots were computed over the whole active roster, which was entirely Vels,
-- so their `rank` *was* the global rank. Copying it keeps historical snapshots readable
-- without recomputation; every snapshot written from now on computes `globalRank`
-- independently over all campuses (§14).
UPDATE "leaderboard_entries" SET "globalRank" = "rank" WHERE "globalRank" IS NULL;

DO $$ BEGIN
  ALTER TABLE "leaderboard_entries"
    ADD CONSTRAINT "leaderboard_entries_campusId_fkey"
    FOREIGN KEY ("campusId") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "leaderboard_entries_period_periodKey_globalRank_idx"
  ON "leaderboard_entries"("period", "periodKey", "globalRank");
CREATE INDEX IF NOT EXISTS "leaderboard_entries_period_periodKey_campusId_rank_idx"
  ON "leaderboard_entries"("period", "periodKey", "campusId", "rank");
CREATE INDEX IF NOT EXISTS "leaderboard_entries_period_periodKey_campusId_batchId_rank_idx"
  ON "leaderboard_entries"("period", "periodKey", "campusId", "batchId", "rank");

-- ---------------------------------------------------------------------------
-- email_reports — which campus a report covers (NULL = all campuses)
-- ---------------------------------------------------------------------------

ALTER TABLE "email_reports" ADD COLUMN IF NOT EXISTS "campusId" UUID;

-- Sent emails are immutable records of what went out, and what went out described the
-- Vels programme. Stamping them Vels makes that explicit instead of letting them read as
-- "all campuses" — a claim they never made.
UPDATE "email_reports"
SET "campusId" = (SELECT "id" FROM "campuses" WHERE "code" = 'VELS')
WHERE "campusId" IS NULL;

DO $$ BEGIN
  ALTER TABLE "email_reports"
    ADD CONSTRAINT "email_reports_campusId_fkey"
    FOREIGN KEY ("campusId") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "email_reports_dayKey_campusId_batchId_status_idx"
  ON "email_reports"("dayKey", "campusId", "batchId", "status");
