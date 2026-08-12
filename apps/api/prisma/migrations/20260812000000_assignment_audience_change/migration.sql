-- "Change Assignment Target" (§9): an admin needs to reconfigure which batch(es) an
-- existing assignment — usually a pre-batch legacy row with batchId = NULL — currently
-- applies to, without rewriting what already happened.
--
-- Strictly additive: one nullable column, one new table, no data touched. Re-runnable
-- (IF NOT EXISTS everywhere) for the same reason as the batch-architecture migration —
-- the Render build runs `prisma migrate deploy` on every deploy.

-- ---------------------------------------------------------------------------
-- assignments — originalBatchId, frozen the first time it is set
-- ---------------------------------------------------------------------------

ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "originalBatchId" UUID;

-- Backfill: every assignment that already exists was, at the time it was created,
-- targeted at whatever its current `batchId` says. This is the one and only time
-- `originalBatchId` is set from `batchId` — after this it is never touched by anything
-- except a brand-new assignment's creation.
UPDATE "assignments" SET "originalBatchId" = "batchId" WHERE "originalBatchId" IS NULL;

DO $$ BEGIN
  ALTER TABLE "assignments"
    ADD CONSTRAINT "assignments_originalBatchId_fkey"
    FOREIGN KEY ("originalBatchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- assignment_audience_changes — append-only retarget log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "assignment_audience_changes" (
    "id"            UUID NOT NULL,
    "assignmentId"  UUID NOT NULL,
    "fromBatchId"   UUID,
    "toBatchId"     UUID,
    "reason"        TEXT,
    "changedById"   UUID,
    "changedByName" TEXT,
    "changedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_audience_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "assignment_audience_changes_assignmentId_changedAt_idx"
  ON "assignment_audience_changes"("assignmentId", "changedAt");

DO $$ BEGIN
  ALTER TABLE "assignment_audience_changes"
    ADD CONSTRAINT "assignment_audience_changes_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assignment_audience_changes"
    ADD CONSTRAINT "assignment_audience_changes_fromBatchId_fkey"
    FOREIGN KEY ("fromBatchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assignment_audience_changes"
    ADD CONSTRAINT "assignment_audience_changes_toBatchId_fkey"
    FOREIGN KEY ("toBatchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "assignment_audience_changes"
    ADD CONSTRAINT "assignment_audience_changes_changedById_fkey"
    FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
