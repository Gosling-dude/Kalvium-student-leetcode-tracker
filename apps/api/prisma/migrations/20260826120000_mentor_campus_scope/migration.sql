-- Mentor → campus access grants.
--
-- Until now `Squad.mentorId` recorded who ran a squad and nothing read it for
-- authorization: every MENTOR could list every student at every campus. This table is the
-- access rule, granted at campus level because that is how the programme is organised.
--
-- Safety: additive (one new table, no column dropped, no row rewritten), and the backfill
-- below grants every existing mentor every existing campus. The rule therefore arrives
-- enforcing exactly the behaviour that is already live — nobody loses access on deploy —
-- and narrowing a mentor to their own campus becomes a deliberate admin action instead of
-- a surprise at 09:00 the morning after a release.
--
-- A mentor with no rows here sees no students, which is the correct failure direction for
-- an access rule. ADMIN is never consulted.

CREATE TABLE "mentor_campuses" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentor_campuses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mentor_campuses_userId_campusId_key" ON "mentor_campuses"("userId", "campusId");
CREATE INDEX "mentor_campuses_userId_idx" ON "mentor_campuses"("userId");
CREATE INDEX "mentor_campuses_campusId_idx" ON "mentor_campuses"("campusId");

ALTER TABLE "mentor_campuses" ADD CONSTRAINT "mentor_campuses_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mentor_campuses" ADD CONSTRAINT "mentor_campuses_campusId_fkey"
    FOREIGN KEY ("campusId") REFERENCES "campuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve today's access. `ON CONFLICT DO NOTHING` keeps this a no-op if it is ever
-- re-run against a database where an admin has already granted something.
INSERT INTO "mentor_campuses" ("id", "userId", "campusId")
SELECT gen_random_uuid(), u."id", c."id"
FROM "users" u
CROSS JOIN "campuses" c
WHERE u."role" = 'MENTOR'
ON CONFLICT ("userId", "campusId") DO NOTHING;
