-- Email send reliability + submission query indexes.
--
-- 1. `SENDING` closes the gap between "approved" and "sent". The send path claims a
--    report by moving APPROVED -> SENDING in a single conditional UPDATE, so two
--    concurrent clicks cannot both reach the provider, and a crash mid-send leaves an
--    honest SENDING row rather than a false SENT.
--
--    Postgres requires the new enum value to be committed before it can be used in the
--    same session, so this runs as its own statement ahead of everything else.
ALTER TYPE "EmailReportStatus" ADD VALUE IF NOT EXISTS 'SENDING' AFTER 'APPROVED';

-- 2. Indexes for the two aggregates that now run over the whole cohort.
--
--    (studentId, status, titleSlug) covers COUNT(DISTINCT "titleSlug") per student for
--    accepted rows — the lifetime "Total Solved" figure.
CREATE INDEX IF NOT EXISTS "submissions_studentId_status_titleSlug_idx"
  ON "submissions" ("studentId", "status", "titleSlug");

--    (dayKey, titleSlug) covers assignment completion, which scans the 3-day lookback
--    window narrowed to the day's assigned slugs, for every student in one query.
CREATE INDEX IF NOT EXISTS "submissions_dayKey_titleSlug_idx"
  ON "submissions" ("dayKey", "titleSlug");
