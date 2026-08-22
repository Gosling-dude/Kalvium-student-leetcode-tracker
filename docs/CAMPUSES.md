# Campuses

`Campus → Batch → Student`. This document covers what changed when the programme grew
past one campus, why each choice was made, and how to onboard the next one.

## The model

```
Campus (VELS, SRM)
  └── Batch        A / B / PENDING — unique per campus, not globally
        └── Student
```

Three things follow from that shape, and every design decision below is downstream of one
of them.

**Batches belong to campuses.** `VELS/A` and `SRM/A` are two different rows that happen to
share a code and a name. A single global "Foundation" would make `Assignment.batchId`
ambiguous — an assignment targeting Foundation could not say *which campus's*, and a
campus filter would have to be re-derived from the students rather than read off the row.
So `Batch.code` and `Batch.name` are unique per campus, and every lookup carries a campus.

**Null widens, it does not mean "unknown".** On `Assignment`, `BaselineTest` and
`EmailReport`:

| `campusId` | `batchId` | Audience |
|---|---|---|
| set | set | one batch at one campus |
| set | null | every batch at that campus |
| null | null | everyone, everywhere |
| null | set | **illegal** — rejected; a batch already names its campus |

**Current placement never answers a question about the past.** `Student.campusId` is where
someone is *now*. Where they were on a given day comes from `StudentCampusHistory` via
`resolveCampusOnDay`, and every already-scored day carries its own frozen
`DailyStatus.campusId`. A transfer therefore takes effect from today forward and cannot
rewrite a settled report.

## Resolution: which assignment applies to whom

`selectAssignmentForScope` (in `@dsa/shared`) is the single definition, used by the rollup,
the dashboard, the daily report and the student portal alike. Three tiers, most specific
first:

1. the row for this student's campus **and** batch;
2. the row for this student's campus, targeting all its batches;
3. the campus-less, batch-less row — "everyone".

A row belonging to a *different* campus or batch is never a candidate at any tier. That is
the property that keeps an SRM student from ever being evaluated against Vels' problems.

## What the migration did

`20260822090000_multi_campus` is additive: it creates enums, tables, columns, indexes and
rows, and never drops a table, drops a data-bearing column, or deletes a row. The only
removals are three indexes (`batches.code`/`batches.name` global uniqueness, and the old
assignment uniqueness), each replaced in the same statement group.

**Every pre-existing row was backfilled to VELS.** This is not a reinterpretation of
history. Vels was the only campus that had ever existed when those rows were written, so
"all students", "Foundation" and "the 4 Aug leaderboard" already meant the Vels ones.
Leaving them campus-less would have been the rewrite: a null campus reads as "every
campus", which would silently extend July's Vels assignments to SRM students who were not
enrolled.

Existing `LeaderboardEntry.rank` values were copied into the new `globalRank`, because at
the time they *were* global ranks.

## Leaderboards

Three scopes, two stored columns, one shared ranking function:

* **`globalRank`** — every active student across every campus, ranked together.
* **`rank`** — the student's position within their own campus.
* **campus + batch** — re-numbered in memory from the campus's snapshot rows.

Neither stored column is derived from the other. Interleaving per-campus positions is not
the same ordering as ranking everyone together, and a global list cannot be read as a
campus list without re-numbering it. Both are computed from the same underlying scores in
`RollupService.buildLeaderboard`, which is what lets a Vels student and an SRM student sit
at #1 and #2 globally while each also leads their own campus.

Every leaderboard row carries `globalRank` whatever the scope, so narrowing a filter never
makes someone's overall standing disappear.

## Roster import

Two scripts, deliberately different, and the difference matters:

| | `db:seed:students` | `db:import:roster` |
|---|---|---|
| Semantics | **synchronise** — the CSV is the complete truth for its campus | **add** — an intake list of people who joined |
| Missing from the file | archived | untouched |
| Use for | the ongoing authoritative roster | onboarding a new campus |

`db:seed:students` archives everyone at its campus who is not in the CSV. Before campuses
that was right; unscoped it is now catastrophic, because running Vels' roster would
archive the entire SRM cohort. It therefore requires a campus — `--campus=<code>` or the
`ROSTER_CAMPUS` environment variable — and refuses to guess when several exist.

### Onboarding a campus

```bash
# 1. Create the campus and its standard batches (Foundation / Intermediate / Pending).
#    The API does this in one call: POST /campuses { name, code }

# 2. Dry run. Reconcile the numbers against the source by hand before writing anything.
npm run db:import:roster -- --campus=SRM --file=apps/api/prisma/private/roster.csv --dry-run

# 3. Import. Idempotent — a second run reports every student as unchanged.
npm run db:import:roster -- --campus=SRM --file=apps/api/prisma/private/roster.csv

# 4. Sync, so LeetCode history is pulled for the students who have a usable handle.
```

The dry run prints a full reconciliation: source rows, unique students, duplicate rows
folded away, valid and invalid profiles, new versus existing, handle conflicts, and
off-domain addresses — plus a line per profile needing verification.

### Data-quality rules

The one rule everything follows is that **a gap beats a guess**. A student whose LeetCode
value is not a profile imports with `leetcodeUsername = null` and appears in the
"profile needs verification" list, where a human fixes it in seconds. A student whose
handle was *invented* looks fine, syncs as `USER_NOT_FOUND` forever, and reads to their
mentor as "solved nothing".

Accepted: a `/u/<handle>/` URL, a bare handle, a profile URL embedded in pasted text, and
LeetCode's own `handle - LeetCode Profile` page title (flagged for confirmation).
Rejected: `/settings/`, `/problemset/`, `/onboarding/`, the bare homepage, a link to
another host, and anything with a stray character in the handle — `Ananya _sharma`
could be repaired two different ways, so it is not repaired at all.

Roster files live in `apps/api/prisma/private/` and are gitignored: they hold real names,
addresses and handles, and this repository is public.

### Placement

An intake roster carries identity, squad and a handle. It says nothing about belt level or
diagnostic results, so every imported student lands with **no batch at all** — `batchId`
is null, displayed as "Not Assigned". Cohort and belt are left null for the same reason.
Foundation and Intermediate are assigned later, by an admin, from real assessment data.
Nothing in the system invents a level.

"Not assigned" is deliberately *not* modelled as a batch. A placeholder batch appears in
every batch picker, every assignment target and every leaderboard scope, reading as
somewhere a student can be placed and work can be set — which is exactly what it is not.
It is a property of the student: they have no batch yet.

Unassigned students still receive campus-wide assignments, because a whole-campus row
applies to everyone at that campus. They do not receive Foundation or Intermediate work:
that is set for a level, and they have not been placed into one.

Assigning a batch later is an ordinary batch move from nothing — the same operation, the
same `StudentBatchHistory` row, the same audit trail.

## Adding a third campus

1. `POST /campuses { name, code }`. Foundation and Intermediate are created with it.
2. Import its roster with `db:import:roster`.
3. Nothing else. Every filter, leaderboard, report and picker reads campuses from the
   database, and no campus name or code is hard-coded anywhere in the application.
