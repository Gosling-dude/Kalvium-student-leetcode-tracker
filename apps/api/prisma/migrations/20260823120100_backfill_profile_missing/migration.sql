-- Reclassify existing rows. Separate migration because Postgres will not let a new enum
-- value be used in the same transaction that added it.
--
-- Only rows that are *already* NEVER_SYNCED and whose student has no handle move: a
-- student who has a handle keeps NEVER_SYNCED (the sync simply has not reached them),
-- and no student, batch, campus, submission or leaderboard row is touched.

UPDATE "student_sync_states" ss
SET "status" = 'PROFILE_MISSING',
    "lastError" = 'No LeetCode username is linked to this student'
FROM "students" s
WHERE s."id" = ss."studentId"
  AND ss."status" = 'NEVER_SYNCED'
  AND s."leetcodeUsername" IS NULL;

-- The same correction for the per-student rows of past sync runs, so the job history
-- reads the way the run actually behaved.
UPDATE "sync_job_items" i
SET "status" = 'PROFILE_MISSING'
FROM "students" s
WHERE s."id" = i."studentId"
  AND i."status" = 'NEVER_SYNCED'
  AND i."processedAt" IS NOT NULL
  AND s."leetcodeUsername" IS NULL;
