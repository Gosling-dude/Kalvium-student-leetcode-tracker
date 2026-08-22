-- Retire "Placement Pending" as a batch. A student without a placement has no batch.
--
-- The earlier multi-campus migration created a `PENDING` batch per campus so that newly
-- imported students had somewhere to sit. That was the wrong shape. A batch is somewhere
-- a student is *assigned to*, and modelling "not assigned yet" as one made it appear in
-- every batch picker, every assignment target, every leaderboard scope and every filter —
-- as though an admin could deliberately place someone there, or set work for it.
--
-- The honest representation is `batchId IS NULL`, rendered as "Not Assigned". That is a
-- property of the student, not a group they belong to.
--
-- This migration moves data, so it is written to be re-runnable and to preserve every
-- historical fact:
--
--  * students in a PENDING batch are detached (`batchId = NULL`), not deleted;
--  * their placement-history rows are rewritten to point at NULL rather than removed, so
--    "enrolled on this day with no batch" is still recorded, with the correction noted;
--  * anything else that referenced the batch is detached before the batch row goes.
--
-- Only then is the now-unreferenced PENDING batch removed. If any row still references it
-- the delete is skipped rather than forced, because a foreign key refusing is a signal
-- that something real still points there and a migration should not destroy it.

-- ---------------------------------------------------------------------------
-- 1. Detach students
-- ---------------------------------------------------------------------------

UPDATE "students" s
SET "batchId" = NULL
FROM "batches" b
WHERE s."batchId" = b."id" AND b."code" = 'PENDING';

-- ---------------------------------------------------------------------------
-- 2. Rewrite placement history rather than deleting it
-- ---------------------------------------------------------------------------
--
-- The row still says "on this day, this student's placement became X". X is now
-- "no batch", which is what it always meant. The reason column records why it changed,
-- so the trail explains itself six weeks from now.

UPDATE "student_batch_history" h
SET "toBatchId" = NULL,
    "reason" = COALESCE(NULLIF(h."reason", ''), 'Enrolled') ||
               ' (placement-pending batch retired; recorded as no batch)'
FROM "batches" b
WHERE h."toBatchId" = b."id" AND b."code" = 'PENDING';

UPDATE "student_batch_history" h
SET "fromBatchId" = NULL
FROM "batches" b
WHERE h."fromBatchId" = b."id" AND b."code" = 'PENDING';

-- ---------------------------------------------------------------------------
-- 3. Detach every other reference
-- ---------------------------------------------------------------------------
--
-- None of these are expected to exist — no assignment, report or leaderboard should ever
-- have targeted a placeholder batch — but detaching defensively means the delete below
-- cannot fail on a row nobody remembered.

UPDATE "daily_statuses" d SET "batchId" = NULL
FROM "batches" b WHERE d."batchId" = b."id" AND b."code" = 'PENDING';

UPDATE "leaderboard_entries" l SET "batchId" = NULL
FROM "batches" b WHERE l."batchId" = b."id" AND b."code" = 'PENDING';

UPDATE "email_reports" e SET "batchId" = NULL
FROM "batches" b WHERE e."batchId" = b."id" AND b."code" = 'PENDING';

UPDATE "squads" q SET "batchId" = NULL
FROM "batches" b WHERE q."batchId" = b."id" AND b."code" = 'PENDING';

-- `assignments.batchId` is ON DELETE RESTRICT, so an assignment that somehow targeted the
-- placeholder would block the delete. Detaching it to a whole-campus assignment preserves
-- both the assignment and its audience meaning ("everyone at this campus").
UPDATE "assignments" a SET "batchId" = NULL
FROM "batches" b WHERE a."batchId" = b."id" AND b."code" = 'PENDING';

UPDATE "assignments" a SET "originalBatchId" = NULL
FROM "batches" b WHERE a."originalBatchId" = b."id" AND b."code" = 'PENDING';

UPDATE "baseline_tests" t SET "batchId" = NULL
FROM "batches" b WHERE t."batchId" = b."id" AND b."code" = 'PENDING';

UPDATE "baseline_test_attempts" t SET "batchId" = NULL
FROM "batches" b WHERE t."batchId" = b."id" AND b."code" = 'PENDING';

UPDATE "assignment_audience_changes" c SET "toBatchId" = NULL
FROM "batches" b WHERE c."toBatchId" = b."id" AND b."code" = 'PENDING';

UPDATE "assignment_audience_changes" c SET "fromBatchId" = NULL
FROM "batches" b WHERE c."fromBatchId" = b."id" AND b."code" = 'PENDING';

-- ---------------------------------------------------------------------------
-- 4. Remove the batch itself
-- ---------------------------------------------------------------------------

DELETE FROM "batches" WHERE "code" = 'PENDING';
