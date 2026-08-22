# Batches

Two levels run at each campus — `A` (Foundation Level) and `B` (Intermediate Level).
Nothing in the schema or the code below it assumes that number.

A student who has not yet been placed into a level has **no batch**: `batchId` is null,
displayed as "Not Assigned". That is a property of the student, not a third batch — a
placeholder batch would show up in every picker and every assignment target as somewhere
work could be set. Adding `C` is a row in the
`batches` table plus nothing else: every filter, report, export and email discovers
batches from the database.

> **Batches are campus-scoped.** Since multi-campus support landed, `Batch.code` and
> `Batch.name` are unique *per campus*, not globally: `VELS/A` and `SRM/A` are two
> different batches that share a code and a name. Every lookup therefore carries a campus,
> and a bare code with no campus is rejected as ambiguous rather than resolved to whichever
> row came back first. See [CAMPUSES.md](CAMPUSES.md) for the full picture — this document
> covers what is true *within* one campus.

## The two questions that must not be confused

| | Where it lives | When it changes |
| --- | --- | --- |
| **Current batch** | `students.batchId` | whenever an admin moves the student |
| **Historical batch** | `daily_statuses.batchId`, resolved via `student_batch_history` | never |

Everything about *today* — the dashboard, today's assignment, the live leaderboard,
today's email — reads the current batch. Everything about a *past day* reads the
historical one.

Deriving a past day's batch from `students.batchId` is the bug this design exists to
prevent: the moment anyone is moved, every report about every earlier day would silently
change to match. See `resolveBatchOnDay` in `@dsa/shared` and its specs.

## Assignments are per batch

`assignments` is keyed on `(dayKey, batchId)`, not `dayKey`. Foundation and Intermediate
can be given entirely different problems on the same date, and each batch's set can be
edited without touching the other's.

`batchId IS NULL` has one specific meaning: **this assignment predates batches and
applied to everyone**. Those rows are never retro-assigned to a batch — that would be
exactly the historical rewrite this design forbids. Resolution is therefore two-tier:

1. the assignment for the student's batch that day, if one exists;
2. otherwise the batch-less row for that day.

A *different* batch's assignment is never a candidate. A Foundation student on a day when
only Intermediate was given work has nothing assigned — a neutral day, not a missed one.

A partial unique index (`assignments_dayKey_legacy_key`) enforces at most one batch-less
row per day, because Postgres treats NULLs as distinct and the composite unique index
alone would not.

## How a day is frozen

`RollupService.recomputeDay` resolves each student's batch *for that day* from their
placement history, evaluates them against that batch's problem set, and writes the result
with `batchId` stamped on the `DailyStatus` row.

That column is written once and then never updated:

```ts
const batchId = existing?.batchId ?? input.batchId;
```

So recomputing 10 August after a 15 August move still reports 10 August under the batch
the student was actually in. Both the resolver and the write-once rule point the same
way; the second is what holds even if a placement row is later corrected or back-dated.

## Moving a student

`POST /students/:id/move-batch` (ADMIN/MENTOR only) updates `students.batchId` and
appends one `student_batch_history` row. It touches nothing else — no submission, daily
status, streak, leaderboard entry, LeetCode record or email.

Placements are effective from a program day, defaulting to today. A move made now does
not reach backwards; days already closed keep the batch they were completed under.

`student_batch_history` is append-only. Moving a student back and forth produces three
rows, not one edited row, so the audit trail survives.

## Archiving, not deleting

A student who falls off the authoritative roster becomes `status = ARCHIVED`. They
disappear from active counts, the dashboard, the daily tracker, current leaderboards, new
assignments and daily emails — and from `GET /students` unless asked for explicitly.

Nothing is removed. Their submissions are the only copy that exists (LeetCode exposes 20
recent entries and nothing more), and their past results stay true after they leave.

`StudentsService.remove` will only hard-delete a student with *no* history in any
referencing table; anything else is archived instead, and the response says which
happened.

## Batch filtering

Filtering is enforced in the database, not the client. Every batch-scoped endpoint takes
`?batch=` accepting an id, a code (`A`) or an alias (`foundation`), resolved by
`BatchesService.resolveSelector`.

An unknown batch is a `400`, never a silently unfiltered query — quietly widening a
filter would show a mentor another batch's students under their own batch's heading.

Historical surfaces filter on `daily_statuses.batchId` / `leaderboard_entries.batchId`
(what was true then); current surfaces filter on `students.batchId` (what is true now).

## Nothing assumes four problems

Every completion figure is computed against the assignment a batch actually received.
Buckets are sized per batch, so a day where Foundation has 4 problems and Intermediate
has 5 reads correctly for both rather than being flattened into one denominator.

## Reports and email

A daily report is either overall or scoped to one batch. Foundation and Intermediate
reports are generated, approved and sent independently, each with the batch in the
subject line, and the duplicate-send guard is scoped per batch so sending one does not
look like a duplicate of the other.

The nightly automation generates one report per active batch and leaves each
`PENDING_APPROVAL`. It never sends anything.
