-- Records when a student's provider profile statistics were last fetched.
--
-- Why this is needed: `StudentSyncService.refreshProfile()` existed but was never
-- called from anywhere, so `providerTotalSolved` was NULL for every student. That is
-- the authoritative lifetime solved count, and without it "Total Solved" fell back to
-- the submission mirror alone — which only ever contains what the provider's 20-row
-- window happened to expose, producing values like 3 or 20 for students who have
-- actually solved hundreds.
--
-- The sync now refreshes the profile, and this column throttles how often: profile
-- totals move slowly, so re-reading them on all eight daily sync cycles would multiply
-- provider calls for no benefit. NULL means "never fetched", which the sync treats as
-- due immediately — so existing students self-heal on the next cycle without a backfill.
ALTER TABLE "student_sync_states"
  ADD COLUMN IF NOT EXISTS "providerProfileFetchedAt" TIMESTAMP(3);

-- Finds the students whose profile is stale or missing, which is the query the sync
-- runs for every student on every cycle.
CREATE INDEX IF NOT EXISTS "student_sync_states_providerProfileFetchedAt_idx"
  ON "student_sync_states" ("providerProfileFetchedAt");
