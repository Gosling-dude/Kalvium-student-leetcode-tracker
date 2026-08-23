-- A student with no LeetCode handle is a roster gap, not a failed read.
--
-- Both were previously recorded as NEVER_SYNCED, so every sync run counted 21 students
-- with no handle as failures, marked itself COMPLETED_WITH_ERRORS, and the dashboard
-- reported "22 students' data could not be read this sync" about students the sync had
-- never attempted. PROFILE_MISSING separates the two.

ALTER TYPE "SyncStatus" ADD VALUE IF NOT EXISTS 'PROFILE_MISSING' BEFORE 'NEVER_SYNCED';

-- Students the sync deliberately skipped, counted apart from genuine failures.
ALTER TABLE "sync_jobs" ADD COLUMN IF NOT EXISTS "skippedStudents" INTEGER NOT NULL DEFAULT 0;
