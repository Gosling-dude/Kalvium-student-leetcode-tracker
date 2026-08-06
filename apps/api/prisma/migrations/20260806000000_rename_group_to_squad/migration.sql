-- Rename the "group" concept to "squad" across the schema.
--
-- Hand-written rather than generated: `prisma migrate diff` renders a model rename as
-- DROP TABLE + CREATE TABLE, which would discard every squad and every squad
-- leaderboard snapshot. RENAME preserves the rows and the foreign keys.
--
-- Index and constraint names are renamed too. Prisma compares them by name when it
-- diffs the schema, so leaving them as `groups_*` would make every future
-- `migrate dev` report drift and try to "fix" it.

-- Tables ---------------------------------------------------------------------
ALTER TABLE "groups" RENAME TO "squads";
ALTER TABLE "group_leaderboard_entries" RENAME TO "squad_leaderboard_entries";

-- Columns --------------------------------------------------------------------
ALTER TABLE "students" RENAME COLUMN "groupId" TO "squadId";
ALTER TABLE "squad_leaderboard_entries" RENAME COLUMN "groupId" TO "squadId";

-- Primary keys ---------------------------------------------------------------
ALTER TABLE "squads" RENAME CONSTRAINT "groups_pkey" TO "squads_pkey";
ALTER TABLE "squad_leaderboard_entries"
  RENAME CONSTRAINT "group_leaderboard_entries_pkey" TO "squad_leaderboard_entries_pkey";

-- Foreign keys ---------------------------------------------------------------
ALTER TABLE "squads" RENAME CONSTRAINT "groups_batchId_fkey" TO "squads_batchId_fkey";
ALTER TABLE "squads" RENAME CONSTRAINT "groups_mentorId_fkey" TO "squads_mentorId_fkey";
ALTER TABLE "students" RENAME CONSTRAINT "students_groupId_fkey" TO "students_squadId_fkey";
ALTER TABLE "squad_leaderboard_entries"
  RENAME CONSTRAINT "group_leaderboard_entries_groupId_fkey" TO "squad_leaderboard_entries_squadId_fkey";

-- Indexes --------------------------------------------------------------------
ALTER INDEX "groups_mentorId_idx" RENAME TO "squads_mentorId_idx";
ALTER INDEX "groups_batchId_name_key" RENAME TO "squads_batchId_name_key";
ALTER INDEX "students_groupId_idx" RENAME TO "students_squadId_idx";
ALTER INDEX "group_leaderboard_entries_period_periodKey_rank_idx"
  RENAME TO "squad_leaderboard_entries_period_periodKey_rank_idx";
ALTER INDEX "group_leaderboard_entries_period_periodKey_groupId_key"
  RENAME TO "squad_leaderboard_entries_period_periodKey_squadId_key";
