/**
 * Observability — whether we are entitled to state how a student performed on a day.
 *
 * ## The problem this exists to stop
 *
 * A student imported into the tracker on 8 Sep has no mirrored submissions for 25 Aug.
 * That is not the same fact as "they solved nothing on 25 Aug", but every table in the
 * app renders both as `0`. LeetCode's public endpoint returns only the ~20 most recent
 * submissions per user, so the older history was already unreachable at the moment they
 * were imported — it cannot be fetched later, and it will never become available.
 *
 * Writing `solvedCount: 0` for those days would put a whole mid-term intake on every
 * earlier day's leaderboard at zero, drag every historical completion rate down, and do
 * it with numbers nobody ever observed. `RollupService.recomputeDay` already refuses to
 * write those rows. This module is the other half: it lets the read surfaces *say why*
 * the rows are absent, instead of silently showing a short roster.
 *
 * ## The two dates, and why they are different
 *
 *  * **Roster membership** comes from `StudentCampusHistory` — where a student was on a
 *    given day. A late import is back-dated to the cohort's enrolment, because they
 *    genuinely were an SRM student on 25 Aug even though we were not yet watching.
 *  * **Observation** starts at `Student.createdAt` — the day the tracker began mirroring
 *    their submissions. Before that we have no negative evidence: we cannot distinguish
 *    "did not solve" from "solved, and we never saw it".
 *
 * Keeping them separate is what makes "the assignment existed, and this student was in
 * its audience, and we cannot say how they did" expressible at all.
 *
 * Pure: no I/O, no clock reads. Callers supply both day keys.
 */

import type { DayKey } from './time';

/**
 * Whether a student's performance on a day is knowable from what we persisted.
 *
 * Deliberately only two values. "Partially observed" is not a third state — see
 * `observedSolvedFloor` for why a partial count is reported as evidence *alongside*
 * `NOT_OBSERVED` rather than softening it into a number.
 */
export type Observability =
  /** The tracker was mirroring this student on this day. Solved counts are trustworthy. */
  | 'OBSERVED'
  /**
   * The day predates the tracker's first sight of this student. An assignment may well
   * have existed and they may well have solved it — we have no way to know, and no way
   * to find out, because the upstream window has long since dropped it.
   */
  | 'NOT_OBSERVED';

export interface ObservabilityInput {
  /** `Student.createdAt` as a program-local day: the first day we mirrored anything. */
  observedFromDayKey: DayKey;
  /** The day being reported on. */
  dayKey: DayKey;
}

/**
 * `NOT_OBSERVED` for any day before the tracker first saw this student.
 *
 * `dayKey` strings are zero-padded ISO dates, so lexical comparison is chronological —
 * the same assumption `resolveCampusOnDay` and `computeStreaks` already make.
 */
export function resolveObservability({
  observedFromDayKey,
  dayKey,
}: ObservabilityInput): Observability {
  return observedFromDayKey > dayKey ? 'NOT_OBSERVED' : 'OBSERVED';
}

export function isObserved(input: ObservabilityInput): boolean {
  return resolveObservability(input) === 'OBSERVED';
}

/**
 * A day's headline numbers, with the denominator stated rather than assumed.
 *
 * `evaluated` and `notObserved` are reported separately and never summed into a single
 * "students" figure, because the two answer different questions: how many people the
 * percentage is about, and how many people it silently omits. A mentor who sees
 * "18% complete" over a roster of 142 is owed the fact that it was computed over 99.
 */
export interface ObservedCohort {
  /** On the roster for this day, by placement history. */
  rosterTotal: number;
  /** Of those, how many we have real evidence for. The only valid denominator. */
  evaluated: number;
  /** Of those, how many predate our first sight of them. Never bucketed, never zeroed. */
  notObserved: number;
}

export function summariseCohort(rosterTotal: number, evaluated: number): ObservedCohort {
  const notObserved = Math.max(0, rosterTotal - evaluated);
  return { rosterTotal, evaluated, notObserved };
}

/**
 * Completion percentage over the observed cohort only.
 *
 * Returns `null` rather than `0` when nothing was observed: a day where we watched
 * nobody has no completion rate, and rendering it as 0% would repeat exactly the
 * mistake this module exists to prevent.
 */
export function completionRate(solvedStudents: number, evaluated: number): number | null {
  if (evaluated <= 0) return null;
  return Math.round((solvedStudents / evaluated) * 10000) / 100;
}

/**
 * The most we can *prove* a `NOT_OBSERVED` student solved on a day.
 *
 * When a late-imported student's first sync happens to pull a submission old enough to
 * land inside a past assignment's window, that submission is real evidence and worth
 * showing. It is a floor, never a score: the same 20-row window that surfaced it may
 * equally have hidden three more, so it can prove "at least 2 of 4" and can never prove
 * "exactly 2 of 4".
 *
 * That is why this returns a separate number instead of populating `solvedCount`. Put it
 * in a bucket and it becomes a claim we cannot support — that the student *missed* the
 * others — which is the fabrication in the opposite direction.
 */
export function observedSolvedFloor(distinctSolvedProblems: number): number {
  return Math.max(0, distinctSolvedProblems);
}

/** Mentor-facing wording for a `NOT_OBSERVED` day. One sentence, no jargon. */
export function describeNotObserved(observedFromDayKey: DayKey): string {
  return (
    `Not observed — this student joined the tracker on ${observedFromDayKey}, and ` +
    `LeetCode does not expose submission history far enough back to reconstruct earlier days.`
  );
}

/**
 * The first day the tracker can honestly state a complete number for a student.
 *
 * It is the day their record was created, and the two tempting widenings are both wrong
 * in ways worth recording, because each looks like a fix for the late-assignment problem:
 *
 *  * **Not enrolment.** Placement history can prove a student was in the programme on a
 *    day — first placements are back-dated to enrolment precisely so it can. It cannot
 *    make LeetCode return submissions its ~20-row public window has already dropped.
 *    Scoring an enrolled-but-unobserved student writes `solvedCount: 0` for a day nobody
 *    measured, which is the fabricated history this module exists to prevent.
 *
 *  * **Not "the mirror holds something from that day".** A surviving submission proves we
 *    could see *that* submission; it does not prove we saw everything. A student whose
 *    one mirrored row is an accepted Two Sum may have solved the day's other three
 *    problems in rows the window dropped. Scoring them 1 of 4 asserts three failures that
 *    were never observed. Partial evidence has its own representation — `provenSolvedFloor`
 *    on the `NOT_OBSERVED` row, which says "at least one, and we cannot say more" — and
 *    that is the honest shape for it.
 *
 * So the rule is deliberately narrow, and the interesting work happens on the *other*
 * side of it: `NOT_OBSERVED` rows are reported separately, never summed into a
 * denominator, and carry the floor the evidence supports.
 *
 * Pure, so the rollup (which skips) and the dashboard (which explains the skip) cannot
 * reach different conclusions about the same student.
 */
export function resolveObservedFromDay(input: {
  /** Program day of `Student.createdAt` — when the tracker first held a row. */
  createdAtDayKey: DayKey;
}): DayKey {
  return input.createdAtDayKey;
}
