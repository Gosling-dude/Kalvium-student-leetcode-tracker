-- Separate "can this student solve the assigned problem" from "did they do it that week".
--
-- `solvedCount` / `status` keep their names and become the ever-solved figures, because
-- that is what every existing reader of them actually means to ask. The windowed figures
-- move into new columns, which only the streak and the daily score read.
--
-- Existing rows are backfilled with `inWindowSolvedCount = solvedCount`: every row
-- written before this migration was computed *under* the window, so its stored count is
-- already the in-window count. That makes the migration lossless — no historical streak
-- changes — and the next recompute raises `solvedCount` where a solve outside the window
-- exists. Nothing is deleted and nothing is invented.

ALTER TABLE "daily_statuses"
  ADD COLUMN "inWindowSolvedCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "daily_statuses" SET "inWindowSolvedCount" = "solvedCount";

ALTER TABLE "daily_problem_statuses"
  ADD COLUMN "inWindowStatus" "ProblemStatus" NOT NULL DEFAULT 'NOT_ATTEMPTED',
  ADD COLUMN "solvedInWindowAt" TIMESTAMP(3),
  ADD COLUMN "attemptsInWindow" INTEGER NOT NULL DEFAULT 0;

UPDATE "daily_problem_statuses"
SET "inWindowStatus" = "status",
    "solvedInWindowAt" = "solvedAt",
    "attemptsInWindow" = "attempts";

-- The window is a subset of all time, so its count can never exceed the total. Stated as
-- a constraint rather than left to the service, because a future writer that sets one
-- column and forgets the other produces a row that is silently self-contradictory.
ALTER TABLE "daily_statuses"
  ADD CONSTRAINT "daily_statuses_in_window_not_above_solved"
  CHECK ("inWindowSolvedCount" <= "solvedCount");
