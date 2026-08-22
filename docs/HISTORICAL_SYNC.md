# Historical assignments and backfill

What happens when an assignment is entered *after* the date it applies to — and why the
sync has to do more than recompute today.

## The rule

An assignment dated **D** accepts solutions submitted on **D-2 … D** inclusive, in program
time (`Asia/Kolkata`). Assignments are routinely published late, so matching a submission's
day against the assignment's day alone marked genuinely-solved problems as missed.

`assignment.createdAt` is **never** a lower bound on submissions. A student who solved a
problem on 20 Aug solved it on 20 Aug, whether the tracker learned about the assignment
that morning or two days later. Creation time is used in exactly one place — deciding
*which days to recompute* — and never to decide whether a submission counts.

The window is a half-open UTC interval derived from program-local midnights, so a
submission at `2026-08-20 23:30 IST` (= `18:00 UTC`) belongs to 20 Aug and cannot drift
into the 21st.

## The bug this documents

An assignment dated **2026-08-20** was entered on **2026-08-22**. Foundation students had
already solved the problems. Running Sync reported every one of them as having solved
nothing.

The completion rules were correct the whole time. The failure was upstream of them: a sync
recomputed `job.dayKey ?? today` and nothing else, so a day whose assignment appeared
afterwards was simply never re-evaluated. Nothing ever asked the rules about 20 Aug.

## What a sync recomputes now

Three sources, unioned, bounded to 14 days before the job day and never past it:

1. **The job's own day** — always, so a sync stays a reliable way to refresh today.
2. **Days reachable from newly-mirrored submissions.** A submission on 18 Aug can satisfy
   an assignment dated 18, 19 or 20 Aug (`assignmentDaysAffectedBy` — the inverse of the
   lookback). Recomputing only the day the submission landed on leaves the others wrong.
3. **Days whose assignment is newer than their last computation.** One condition covers
   every way a day goes stale: the assignment was added late, its problems were edited, its
   audience was retargeted, or the day was never computed at all. Detected from stored
   state rather than from what a particular sync happened to fetch, so it works even when
   no new submission arrives. It self-clears — one recompute moves `computedAt` past
   `updatedAt` and the day stops being reported.

Days are recomputed oldest-first, because each day's streak reads the one before it.

## Backfilling a specific date

After entering an assignment for a past date:

```
POST /sync/backfill { "dayKey": "2026-08-20" }
```

It resolves that date's assignments, their campus + batch audiences, the eligible students
and the submissions already in the mirror, then rewrites that day's results. It makes no
LeetCode calls, so it cannot create, move or overwrite a submission, and it is safe to run
repeatedly.

It recomputes **from that day through today**. Days *before* it are untouched. Days after
it are not bystanders — `streakAtDay` on 21 Aug is a function of what 20 Aug says — so
leaving them would trade one visibly-wrong number for two quietly-wrong ones.

For a wider correction, `POST /admin/recompute { from, to }` takes an explicit range.

## Audience is never widened by a recompute

Recomputing more days must not credit more students. The audience of an assignment is
`Campus + Batch + Date`, resolved per student against the campus and batch they were in
**on that day** — so an SRM Foundation student who solved Vels Foundation's problems on the
same date scores nothing against their own assignment.

A database `CHECK` constraint (`assignments_batch_implies_campus`) makes the one dangerous
shape impossible: a non-null batch with a null campus would read as "this batch, at every
campus" and hand one campus's problems to another's students. The services already reject
it; the constraint is the backstop for seeds, migrations and psql sessions.

## Performance

The only per-sync addition is one indexed query for stale days
(`daily_statuses_dayKey_computedAt_idx`, index-only, one row per day). Recomputation reuses
the submission mirror and issues no provider calls, so a backfill of a three-day range
completes in well under a second at current roster size.
