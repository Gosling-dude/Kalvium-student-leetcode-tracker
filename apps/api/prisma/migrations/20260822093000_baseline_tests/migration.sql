-- Baseline tests — weekly independent-capability assessments.
--
-- Deliberately its own tables, its own scoring and its own migration. Nothing here
-- touches `daily_statuses`, `submissions`, `students` aggregates or `leaderboard_entries`
-- (§25, §39): a baseline result must never move a streak, a daily completion percentage
-- or a leaderboard position, and the cleanest way to guarantee that is for the baseline
-- schema to have no write path into any of them.
--
-- The one thing baseline grading shares with the rest of the system is the submission
-- mirror it *reads*. Grading an attempt is a range query over `submissions` inside the
-- test window, so the existing LeetCode sync stays the single ingestion path.
--
-- Additive and re-runnable, like every migration in this directory.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "BaselineTestStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BaselineAttemptStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BaselineReviewStatus" AS ENUM ('NOT_REVIEWED', 'REVIEW_REQUIRED', 'REVIEWED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Every member names something the submission mirror can demonstrate with a timestamp.
-- There is no 'PLAGIARISM' / 'CHEATED' member on purpose: the public LeetCode API exposes
-- no submitted source, so a similarity verdict would be fabricated (§23).
DO $$ BEGIN
  CREATE TYPE "BaselineRiskSignal" AS ENUM (
    'IMMEDIATE_ACCEPTANCE',
    'RAPID_SUCCESSION',
    'NO_FAILED_ATTEMPTS',
    'INCONSISTENT_WITH_HISTORY',
    'SOLVED_BEFORE_TEST'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- baseline_tests
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "baseline_tests" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT,
    "adminNotes" TEXT,
    "campusId" UUID,
    "batchId" UUID,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "status" "BaselineTestStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "baseline_tests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "baseline_tests_dayKey_idx" ON "baseline_tests"("dayKey");
CREATE INDEX IF NOT EXISTS "baseline_tests_status_idx" ON "baseline_tests"("status");
CREATE INDEX IF NOT EXISTS "baseline_tests_campusId_batchId_dayKey_idx"
  ON "baseline_tests"("campusId", "batchId", "dayKey");
CREATE INDEX IF NOT EXISTS "baseline_tests_status_dayKey_idx" ON "baseline_tests"("status", "dayKey");

DO $$ BEGIN
  ALTER TABLE "baseline_tests" ADD CONSTRAINT "baseline_tests_campusId_fkey"
    FOREIGN KEY ("campusId") REFERENCES "campuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "baseline_tests" ADD CONSTRAINT "baseline_tests_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "baseline_tests" ADD CONSTRAINT "baseline_tests_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- baseline_test_problems
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "baseline_test_problems" (
    "id" UUID NOT NULL,
    "testId" UUID NOT NULL,
    "problemId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 10,
    "difficulty" "Difficulty" NOT NULL,

    CONSTRAINT "baseline_test_problems_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "baseline_test_problems_testId_position_key"
  ON "baseline_test_problems"("testId", "position");
CREATE UNIQUE INDEX IF NOT EXISTS "baseline_test_problems_testId_problemId_key"
  ON "baseline_test_problems"("testId", "problemId");
CREATE INDEX IF NOT EXISTS "baseline_test_problems_problemId_idx"
  ON "baseline_test_problems"("problemId");

DO $$ BEGIN
  ALTER TABLE "baseline_test_problems" ADD CONSTRAINT "baseline_test_problems_testId_fkey"
    FOREIGN KEY ("testId") REFERENCES "baseline_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "baseline_test_problems" ADD CONSTRAINT "baseline_test_problems_problemId_fkey"
    FOREIGN KEY ("problemId") REFERENCES "problems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- baseline_test_attempts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "baseline_test_attempts" (
    "id" UUID NOT NULL,
    "testId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID,
    "batchId" UUID,
    "status" "BaselineAttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "solvedCount" INTEGER NOT NULL DEFAULT 0,
    "attemptedCount" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER NOT NULL DEFAULT 0,
    "maxScore" INTEGER NOT NULL DEFAULT 0,
    "timeTakenSeconds" INTEGER,
    "riskFlags" "BaselineRiskSignal"[] NOT NULL DEFAULT ARRAY[]::"BaselineRiskSignal"[],
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "reviewStatus" "BaselineReviewStatus" NOT NULL DEFAULT 'NOT_REVIEWED',
    "reviewNote" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "gradedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "baseline_test_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "baseline_test_attempts_testId_studentId_key"
  ON "baseline_test_attempts"("testId", "studentId");
CREATE INDEX IF NOT EXISTS "baseline_test_attempts_testId_status_idx"
  ON "baseline_test_attempts"("testId", "status");
CREATE INDEX IF NOT EXISTS "baseline_test_attempts_studentId_idx"
  ON "baseline_test_attempts"("studentId");
CREATE INDEX IF NOT EXISTS "baseline_test_attempts_testId_campusId_batchId_idx"
  ON "baseline_test_attempts"("testId", "campusId", "batchId");
CREATE INDEX IF NOT EXISTS "baseline_test_attempts_testId_reviewStatus_idx"
  ON "baseline_test_attempts"("testId", "reviewStatus");

DO $$ BEGIN
  ALTER TABLE "baseline_test_attempts" ADD CONSTRAINT "baseline_test_attempts_testId_fkey"
    FOREIGN KEY ("testId") REFERENCES "baseline_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "baseline_test_attempts" ADD CONSTRAINT "baseline_test_attempts_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "baseline_test_attempts" ADD CONSTRAINT "baseline_test_attempts_campusId_fkey"
    FOREIGN KEY ("campusId") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "baseline_test_attempts" ADD CONSTRAINT "baseline_test_attempts_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "baseline_test_attempts" ADD CONSTRAINT "baseline_test_attempts_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- baseline_test_problem_results
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "baseline_test_problem_results" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "testProblemId" UUID NOT NULL,
    "problemId" UUID NOT NULL,
    "status" "ProblemStatus" NOT NULL DEFAULT 'NOT_ATTEMPTED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "points" INTEGER NOT NULL DEFAULT 0,
    "firstSubmissionAt" TIMESTAMP(3),
    "solvedAt" TIMESTAMP(3),
    "timeToSolveSeconds" INTEGER,
    "language" TEXT,

    CONSTRAINT "baseline_test_problem_results_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "baseline_test_problem_results_attemptId_testProblemId_key"
  ON "baseline_test_problem_results"("attemptId", "testProblemId");
CREATE INDEX IF NOT EXISTS "baseline_test_problem_results_problemId_idx"
  ON "baseline_test_problem_results"("problemId");
CREATE INDEX IF NOT EXISTS "baseline_test_problem_results_status_idx"
  ON "baseline_test_problem_results"("status");

DO $$ BEGIN
  ALTER TABLE "baseline_test_problem_results" ADD CONSTRAINT "baseline_test_problem_results_attemptId_fkey"
    FOREIGN KEY ("attemptId") REFERENCES "baseline_test_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "baseline_test_problem_results" ADD CONSTRAINT "baseline_test_problem_results_testProblemId_fkey"
    FOREIGN KEY ("testProblemId") REFERENCES "baseline_test_problems"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "baseline_test_problem_results" ADD CONSTRAINT "baseline_test_problem_results_problemId_fkey"
    FOREIGN KEY ("problemId") REFERENCES "problems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- submissions — the index baseline grading reads through
-- ---------------------------------------------------------------------------

-- Grading is "every submission by these students, for these slugs, inside this window".
-- Without a (studentId, submittedAt) → slug path that degrades into a per-student scan
-- once a second campus triples the mirror (§27). The existing
-- `submissions_studentId_submittedAt_idx` covers the range; this adds the slug so the
-- lookup stays index-only.
CREATE INDEX IF NOT EXISTS "submissions_studentId_submittedAt_titleSlug_idx"
  ON "submissions"("studentId", "submittedAt", "titleSlug");

-- `updatedAt` is maintained by Prisma's `@updatedAt`, not by the database, and no other
-- table in this schema carries a DB-side default for it. Dropping it keeps the deployed
-- database byte-identical to what `prisma migrate diff` expects, so drift checks stay
-- meaningful. No-op on a database created by the corrected CREATE TABLE above.
ALTER TABLE "campuses" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "baseline_tests" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "baseline_test_attempts" ALTER COLUMN "updatedAt" DROP DEFAULT;
