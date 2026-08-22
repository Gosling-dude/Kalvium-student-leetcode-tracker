/**
 * Campus — the outermost organisational scope, and the rules for resolving it.
 *
 * The module is the campus twin of `domain/batch.ts`, and it exists for the same reason:
 * two concepts are easy to conflate and must not be.
 *
 *  * **Current campus** (`Student.campusId`) — where a student is *now*. Changes on a
 *    transfer. Drives current views: the dashboard, today's assignment, live leaderboards,
 *    today's email, baseline eligibility.
 *
 *  * **Historical campus** (`resolveCampusOnDay` over `StudentCampusHistory`) — where a
 *    student was on a *given day*. Never changes once that day has passed.
 *
 * A student who was at Vels on 10 Aug and transfers to SRM on 20 Aug must still appear
 * under Vels in every report about 10 Aug, and must have been evaluated against Vels'
 * 10 Aug problems (§17). Deriving a past day's campus from `Student.campusId` rewrites
 * history the moment anyone transfers, which is the bug this prevents.
 *
 * Pure: no I/O, no clock reads. Callers load the placement rows and pass them in.
 */

import type { DayKey } from './time';

/** Campus codes are compared case-insensitively at the edges and stored uppercase. */
export function normaliseCampusCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * A campus code derived from a name, for callers that only supply a name.
 *
 * Same contract as `deriveBatchCode`: returns a *candidate*, because `code` is
 * `NOT NULL UNIQUE` and resolving a collision is the caller's job.
 */
export function deriveCampusCode(name: string): string {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 24) || 'CAMPUS';
}

/**
 * One placement, as stored in `StudentCampusHistory`.
 *
 * `toCampusId` is the campus the student is in *from* `effectiveFromDayKey` onwards, and
 * may be null (left the programme entirely). `changedAt` breaks ties when two placements
 * share an effective day — the later record wins, because it was recorded later.
 */
export interface CampusPlacement {
  toCampusId: string | null;
  effectiveFromDayKey: DayKey;
  changedAt: Date;
}

/**
 * The campus a student was in on `dayKey`, given their full placement history.
 *
 * Returns the newest placement effective on or before the day. `null` means the student
 * had no campus then — either they predate campuses, or their earliest placement starts
 * after `dayKey`. Both are genuine "no campus" answers, and callers must not substitute
 * the current campus for them.
 *
 * `placements` may arrive in any order.
 */
export function resolveCampusOnDay(
  placements: readonly CampusPlacement[],
  dayKey: DayKey,
): string | null {
  let winner: CampusPlacement | null = null;

  for (const placement of placements) {
    // `dayKey` strings are zero-padded ISO dates, so lexical order is chronological.
    if (placement.effectiveFromDayKey > dayKey) continue;

    if (
      winner === null ||
      placement.effectiveFromDayKey > winner.effectiveFromDayKey ||
      (placement.effectiveFromDayKey === winner.effectiveFromDayKey &&
        placement.changedAt.getTime() >= winner.changedAt.getTime())
    ) {
      winner = placement;
    }
  }

  return winner?.toCampusId ?? null;
}

/**
 * The audience of an assignment or a baseline test.
 *
 * `null` widens rather than meaning "unknown":
 *
 *  * `{ campusId: X, batchId: Y }` — one batch at one campus.
 *  * `{ campusId: X, batchId: null }` — every batch at campus X.
 *  * `{ campusId: null, batchId: null }` — everyone, everywhere.
 *
 * `{ campusId: null, batchId: Y }` is not a legal audience and `isLegalScope` rejects it:
 * a batch already names its campus, so the pair could contradict itself.
 */
export interface AudienceScope {
  campusId: string | null;
  batchId: string | null;
}

export function isLegalScope(scope: AudienceScope): boolean {
  return !(scope.campusId === null && scope.batchId !== null);
}

/**
 * How specific an audience is. Higher wins when several rows could apply to one student.
 *
 * The ordering *is* the resolution rule: a batch-specific set always beats a
 * campus-wide one, which always beats an everyone set. Expressed as a number so both
 * `selectAssignmentForScope` and the SQL-side ordering can agree on one definition.
 */
export function scopeSpecificity(scope: AudienceScope): number {
  if (scope.campusId !== null && scope.batchId !== null) return 2;
  if (scope.campusId !== null) return 1;
  return 0;
}

/** Whether a student in `student`'s campus/batch falls inside `scope`. */
export function scopeApplies(scope: AudienceScope, student: AudienceScope): boolean {
  if (scope.campusId !== null && scope.campusId !== student.campusId) return false;
  if (scope.batchId !== null && scope.batchId !== student.batchId) return false;
  return true;
}

/**
 * Which of a day's assignments applies to a student, given the campus and batch they
 * were in *that day*.
 *
 * Resolution is three-tier, most specific first:
 *
 *  1. the row for this student's campus **and** batch;
 *  2. the row for this student's campus, targeting all its batches;
 *  3. the campus-less, batch-less row — "everyone".
 *
 * Tier 3 is not a fallback for "nothing was set today". It is how an assignment
 * deliberately aimed at every campus keeps applying to every campus, and it is also what
 * a pre-campus legacy row would mean if one still existed. (The campus migration
 * backfills every historical row to Vels precisely so that July's Vels problems do not
 * silently start applying to SRM — see the migration's header.)
 *
 * A row belonging to a *different* campus or batch is never a candidate at any tier: an
 * SRM student is never evaluated against Vels' problem set, which is the whole point of
 * campus scoping (§9).
 *
 * Returns `null` when no tier matches — "nothing was assigned to this student that day",
 * a neutral day rather than a missed one.
 */
export function selectAssignmentForScope<T extends AudienceScope>(
  assignments: readonly T[],
  student: AudienceScope,
): T | null {
  let best: T | null = null;
  let bestSpecificity = -1;

  for (const assignment of assignments) {
    if (!scopeApplies(assignment, student)) continue;
    const specificity = scopeSpecificity(assignment);
    if (specificity > bestSpecificity) {
      best = assignment;
      bestSpecificity = specificity;
    }
  }

  return best;
}

/**
 * The human label for an audience, e.g. `SRM University — Foundation Level`.
 *
 * Used verbatim in the create-assignment preview, the assignment history table and the
 * email subject line, so all three describe a target the same way. Names are passed in
 * rather than looked up: this module never learns what a campus is called (§1).
 */
export function describeScope(
  campusName: string | null,
  batchName: string | null,
  labels: { allCampuses?: string; allBatches?: string } = {},
): string {
  const campus = campusName ?? labels.allCampuses ?? 'All campuses';
  const batch = batchName ?? labels.allBatches ?? 'All batches';
  return `${campus} — ${batch}`;
}
