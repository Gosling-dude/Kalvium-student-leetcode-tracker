-- Correct the DSA streak rule for existing deployments.
--
-- The shipped default in `@dsa/shared` moved from ALL_ASSIGNED to AT_LEAST_ONE: a day
-- counts towards the streak as soon as the student clears one assigned problem. But the
-- formula is stored data, not code — `ScoringConfigService.merge` layers the stored row
-- *over* the defaults, so a row that still carries the literal string "ALL_ASSIGNED"
-- keeps overriding the new default and the fix would never take effect in production.
--
-- Only rows that still hold the old default are touched. A deployment where an admin
-- deliberately chose CUSTOM (or re-selected ALL_ASSIGNED after this ships) is left
-- alone: this migration corrects an inherited default, it does not overrule a choice.
UPDATE "scoring_configs"
SET "config" = jsonb_set("config", '{streakQualification}', '"AT_LEAST_ONE"'::jsonb, true),
    "updatedAt" = NOW()
WHERE "config" ->> 'streakQualification' = 'ALL_ASSIGNED';
