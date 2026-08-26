-- Let a student exist before their email is known, and carry a register number.
--
-- Why: a roster can arrive without email addresses. Refusing to store those students means
-- the programme has people it cannot see, and inventing addresses for them is worse — the
-- conventions in use are inconsistent, so a derived address creates a student who can never
-- log in and whom the later correct import duplicates instead of updating.
--
-- Safety: additive only.
--   * DROP NOT NULL widens what the column accepts. Every existing row already satisfies
--     the looser constraint, so no row is read, rewritten or lost.
--   * The unique index is untouched — Postgres allows many NULLs under one, so real
--     addresses stay distinct while unknown ones coexist.
--   * ADD COLUMN with no default and no NOT NULL is a metadata-only change; it does not
--     rewrite the table.
--
-- No data is modified by this migration. Verify with a row count before and after.

ALTER TABLE "students" ALTER COLUMN "email" DROP NOT NULL;

ALTER TABLE "students" ADD COLUMN "registerNumber" TEXT;

-- Nullable-unique: a second stable identity for import matching when email is unknown.
-- Many students legitimately have no register number, and Postgres does not treat NULLs
-- as equal, so they do not collide.
CREATE UNIQUE INDEX "students_registerNumber_key" ON "students"("registerNumber");
