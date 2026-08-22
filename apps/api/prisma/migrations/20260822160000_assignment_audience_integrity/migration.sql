-- Make the one illegal audience shape impossible, and index the staleness lookup that
-- historical backfill depends on.
--
-- Additive and re-runnable. It adds two constraints and one index; it changes no data.

-- ---------------------------------------------------------------------------
-- A batch always implies its campus
-- ---------------------------------------------------------------------------
--
-- `campus_id IS NULL` means "every campus". Combined with a non-null `batch_id` that
-- reads as "this one batch, at every campus" — which is meaningless (a batch belongs to
-- exactly one campus) and actively dangerous: the audience resolver would hand a Vels
-- batch's problem set to SRM students, which is the cross-campus leak the design exists
-- to prevent (§14).
--
-- `AssignmentsService` and `BaselineTestsService` both reject the shape already. This is
-- the backstop for everything that does not go through them: a migration, a seed script,
-- a psql session, or a future code path whose author never read those services. A
-- constraint that lives in the database cannot be forgotten by new code.
--
-- NOT VALID would let existing rows escape the check; these tables are small and any row
-- in this state is already a bug, so the constraint is added validating.

DO $$ BEGIN
  ALTER TABLE "assignments"
    ADD CONSTRAINT "assignments_batch_implies_campus"
    CHECK ("campusId" IS NOT NULL OR "batchId" IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "baseline_tests"
    ADD CONSTRAINT "baseline_tests_batch_implies_campus"
    CHECK ("campusId" IS NOT NULL OR "batchId" IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- The staleness lookup behind historical backfill
-- ---------------------------------------------------------------------------
--
-- `RollupService.findStaleAssignmentDays` asks, per assignment day, for the newest
-- `computedAt` among that day's statuses — which is how a sync discovers that an
-- assignment was entered after its own date and the day was never re-evaluated.
--
-- Without this the aggregate reads every status row for the day and fetches `computedAt`
-- from the heap. At 123 students that is invisible; at 1000 students across a year it is
-- ~365k heap lookups on every sync. Ordering by `computedAt` descending lets the planner
-- take the first row per day and stop.
CREATE INDEX IF NOT EXISTS "daily_statuses_dayKey_computedAt_idx"
  ON "daily_statuses"("dayKey", "computedAt" DESC);
