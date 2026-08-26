-- Backfill placement history for students who carry a batch/campus that was never recorded
-- as a placement.
--
-- Why these rows are missing: the spreadsheet importer set `students."batchId"` (and, on
-- re-import, `"campusId"`) directly without writing to the history tables. Every
-- historical query reads the history — `batchOnDayForStudents` has no fallback to
-- `Student.batchId`, deliberately, because falling back would re-file already-closed days
-- under a batch the student joined later. The consequence was that a student onboarded by
-- spreadsheet resolved to "no batch on any day": batch-targeted assignments never selected
-- for them, and their `DailyStatus` rows carried a null batch.
--
-- The importer now writes these rows itself. This migration repairs the students who were
-- already imported before that fix.
--
-- Safety:
--   * Purely additive. No UPDATE, no DELETE, no schema change — INSERT only.
--   * Only touches students with **zero** existing rows in the table, so a student whose
--     placement history is already correct is never given a competing row, and re-running
--     the migration is a no-op.
--   * Back-dated to enrolment (`students."createdAt"` in Asia/Kolkata, matching
--     `ProgramTimeService.dayKeyOf`) rather than today, because this is a first placement:
--     the roster is stating what has been true all along, not making a change now. Dating
--     it today would instead leave every day before today still resolving to "no batch".
--   * `source = 'MIGRATION'` so these are distinguishable from placements a person made.
--
-- Recomputing the affected days is a separate, explicit admin action (`POST /admin/recompute`
-- with force) — a migration must not rewrite scored days as a side effect.

INSERT INTO "student_batch_history"
  ("id", "studentId", "fromBatchId", "toBatchId", "effectiveFromDayKey", "reason", "source", "changedAt")
SELECT
  gen_random_uuid(),
  s."id",
  NULL,
  s."batchId",
  to_char(s."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'),
  'Backfilled: batch was set without a recorded placement (spreadsheet import)',
  'MIGRATION',
  s."createdAt"
FROM "students" s
WHERE s."batchId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "student_batch_history" h WHERE h."studentId" = s."id");

INSERT INTO "student_campus_history"
  ("id", "studentId", "fromCampusId", "toCampusId", "effectiveFromDayKey", "reason", "source", "changedAt")
SELECT
  gen_random_uuid(),
  s."id",
  NULL,
  s."campusId",
  to_char(s."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'),
  'Backfilled: campus was set without a recorded placement (spreadsheet import)',
  'MIGRATION',
  s."createdAt"
FROM "students" s
WHERE s."campusId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "student_campus_history" h WHERE h."studentId" = s."id");
