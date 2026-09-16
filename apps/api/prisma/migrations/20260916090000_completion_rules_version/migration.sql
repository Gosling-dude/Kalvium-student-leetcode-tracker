-- Make "computed under superseded rules" a state the system can see.
--
-- The ever-solved change (20260911090000) could not backfill `solvedCount`: the new
-- figure has to be re-derived from the submission mirror, day by day. Nothing scheduled
-- that work, because nothing could tell the affected days apart from correct ones — their
-- assignments had not changed, only the rule had, and `findStaleAssignmentDays` looks at
-- `assignments.updatedAt`. So 229 student-days went on reporting the old windowed count,
-- and the report that went to management read them.
--
-- `computedVersion` records which rule set produced a row. Existing rows default to 0,
-- which is the honest answer — they predate versioning — and puts them below the current
-- version, so the ordinary stale-day scan now reports them and the ordinary recompute
-- path heals them. No data is changed here: the recompute does that, idempotently, and
-- can be re-run any number of times to the same result.

ALTER TABLE "daily_statuses"
  ADD COLUMN "computedVersion" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "daily_statuses_computedVersion_dayKey_idx"
  ON "daily_statuses" ("computedVersion", "dayKey");
