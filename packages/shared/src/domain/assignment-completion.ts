/**
 * Assignment completion — the one definition of "did this student solve the day's work".
 *
 * Everything downstream (daily status, streaks, buckets, leaderboards, the email report,
 * the student profile) is derived from this module, so those surfaces can never disagree
 * with one another about a student's day.
 *
 * Three rules encode the business requirement, and each exists because the naive
 * alternative produced wrong numbers in production:
 *
 * 1. **Solved is solved, whenever it happened.** An assignment dated D asks whether the
 *    student can solve its problems; a submission's timestamp is evidence of that
 *    ability, never a condition on it. So the per-problem outcome this module reports
 *    carries **no time filter at all** — not the assignment day, not the lookback, and
 *    emphatically not `assignment.createdAt`. A problem accepted on 5 Sep counts for the
 *    7 Sep assignment that was entered into the tracker on the 11th.
 *
 *    The dated window has not gone away, it has been *separated*: every figure whose
 *    name starts `inWindow` answers the second question — did the student do this work
 *    around the day it was set — over `[D - LOOKBACK_DAYS, D]`. Streaks and the daily
 *    score read those, because solving Two Sum in June cannot make September a day the
 *    student practised. Both numbers sit on the same row and neither is derivable from
 *    the other; collapsing them is what made an entire cohort read 0/4 on problems they
 *    had solved.
 *
 * 2. **Problem identity, not title.** Titles get re-worded and differ in punctuation and
 *    case between the assignment record and the submission mirror. Matching is done on
 *    the stable identifiers — the tracked problem id where we have one, otherwise the
 *    LeetCode `titleSlug`, which is what the provider itself keys submissions by.
 *
 * 3. **Distinct, accepted problems only.** A problem counts once no matter how many
 *    times it was submitted, and only an `ACCEPTED` verdict counts. Anything else
 *    (Wrong Answer, TLE, runtime/compile error, still pending) is an attempt, not a
 *    completion.
 *
 * The functions here are pure: callers resolve the submission window from the database
 * and pass the rows in. Day arithmetic is in program-local time (`Asia/Kolkata`) via
 * `./time`, never UTC calendar days — see `assignmentWindow`.
 */

import { addDays, type DayKey } from './time';

/**
 * How many days *before* the assignment day still count towards it.
 *
 * `2` means an assignment dated 10 Aug accepts solutions submitted on 8, 9 or 10 Aug.
 * This is the documented allowance for assignments published late; it is deliberately
 * not configurable per-assignment, because a report has to be comparable across days.
 */
export const ASSIGNMENT_LOOKBACK_DAYS = 2;

/** Verdicts that count as solving a problem. Everything else is an attempt. */
export type CompletionStatus =
  | 'ACCEPTED'
  | 'ATTEMPTED_NOT_ACCEPTED'
  | 'NOT_ATTEMPTED'
  | 'UNKNOWN';

/** One assigned problem, as stored on the assignment. */
export interface AssignedProblemRef {
  problemId: string;
  /** LeetCode slug, lowercase. The identifier the submission mirror shares with us. */
  titleSlug: string;
  /** 1-based slot (Problem 1 … Problem 4). */
  position: number;
}

/** One row from the submission mirror, narrowed to what completion actually needs. */
export interface CompletionSubmission {
  /** Set only for problems we track; `null` for the rest of a student's LeetCode work. */
  problemId?: string | null;
  titleSlug: string;
  status: CompletionStatus;
  submittedAt: Date;
  /** Program-day bucket of `submittedAt`, precomputed at write time. */
  dayKey: DayKey;
  language?: string | null;
}

/**
 * Per-problem outcome for one student on one assignment day.
 *
 * The unprefixed fields answer "can this student solve this problem", over their whole
 * submission history. The `inWindow` fields answer "did they do it around the day it was
 * set", over `[D - LOOKBACK_DAYS, D]`. A problem can be `ACCEPTED` with
 * `inWindowStatus: 'NOT_ATTEMPTED'` — solved last month, untouched this week — and both
 * statements are true.
 */
export interface ProblemCompletion {
  problemId: string;
  titleSlug: string;
  position: number;
  /** Ever-solved outcome. `ACCEPTED` whenever an accepted submission exists, at any time. */
  status: CompletionStatus;
  /** Earliest accepted submission for this problem, at any time. */
  solvedAt: Date | null;
  /** The program day that accepted submission landed on — may be long before `D`. */
  solvedOnDayKey: DayKey | null;
  language: string | null;
  /** Submissions seen for this problem at any time, accepted or not. */
  attempts: number;

  /** The same outcome restricted to the lookback window — the practice measure. */
  inWindowStatus: CompletionStatus;
  /** Earliest accepted submission *inside* the window; null when solved only outside it. */
  solvedInWindowAt: Date | null;
  /** Submissions seen inside the window, accepted or not. */
  attemptsInWindow: number;
}

export interface AssignmentCompletionResult {
  dayKey: DayKey;
  /** Inclusive window the `inWindow` figures were measured over. */
  windowStartDayKey: DayKey;
  windowEndDayKey: DayKey;
  assignedCount: number;
  /**
   * Distinct assigned problems the student has **ever** solved.
   *
   * This is the assignment-analysis figure: a problem accepted before the assignment was
   * entered into the tracker counts here, which is the entire point.
   */
  solvedCount: number;
  /**
   * Distinct assigned problems solved inside `[D - LOOKBACK_DAYS, D]`.
   *
   * The practice measure, and the only one streaks and the daily score may read. Always
   * `<= solvedCount`.
   */
  inWindowSolvedCount: number;
  /** True when every assigned problem has been solved, at any time. */
  isComplete: boolean;
  problems: ProblemCompletion[];
  /** Earliest / latest accepted submission inside the window; null when there is none. */
  firstSolvedAt: Date | null;
  lastSolvedAt: Date | null;
  /**
   * When the whole assignment was finished **inside the window**; `null` otherwise.
   *
   * Deliberately not the ever-solved equivalent: this drives `completionMinute`, the
   * leaderboard's earliest-finish tiebreak, and a minute-of-day taken from a submission
   * three months earlier describes nothing about this day.
   */
  completedAt: Date | null;
  /** When the whole assignment became complete counting solutions from any time. */
  everCompletedAt: Date | null;
}

/**
 * The inclusive program-day window an assignment accepts submissions from.
 *
 * Returned as day keys rather than timestamps so callers can use the indexed `dayKey`
 * column directly. `assignmentWindowBounds` gives the matching UTC instants when a
 * timestamp comparison is also wanted.
 */
export function assignmentWindow(
  dayKey: DayKey,
  lookbackDays: number = ASSIGNMENT_LOOKBACK_DAYS,
): { startDayKey: DayKey; endDayKey: DayKey } {
  return { startDayKey: addDays(dayKey, -Math.abs(lookbackDays)), endDayKey: dayKey };
}

/**
 * The assignment days a submission made on `submissionDayKey` could contribute to.
 *
 * The inverse of `assignmentWindow`, and the reason it exists separately: after a sync
 * mirrors a submission, *something* has to decide which days' results are now stale. A
 * submission on 18 Aug can satisfy an assignment dated 18, 19 or 20 Aug, so recomputing
 * only the day the submission landed on leaves the other two wrong.
 *
 * Returned oldest-first and inclusive of `submissionDayKey` itself.
 */
export function assignmentDaysAffectedBy(
  submissionDayKey: DayKey,
  lookbackDays: number = ASSIGNMENT_LOOKBACK_DAYS,
): DayKey[] {
  const span = Math.abs(lookbackDays);
  const days: DayKey[] = [];
  for (let offset = 0; offset <= span; offset += 1) {
    days.push(addDays(submissionDayKey, offset));
  }
  return days;
}

/** True when `submissionDayKey` falls inside the lookback window for `dayKey`. */
export function isWithinAssignmentWindow(
  submissionDayKey: DayKey,
  dayKey: DayKey,
  lookbackDays: number = ASSIGNMENT_LOOKBACK_DAYS,
): boolean {
  const { startDayKey, endDayKey } = assignmentWindow(dayKey, lookbackDays);
  return submissionDayKey >= startDayKey && submissionDayKey <= endDayKey;
}

/** The identity two records must agree on to be the same problem. */
function matchesAssigned(submission: CompletionSubmission, assigned: AssignedProblemRef): boolean {
  // Prefer the tracked problem id — it survives a slug rename on LeetCode's side.
  if (submission.problemId && submission.problemId === assigned.problemId) return true;
  return submission.titleSlug.toLowerCase() === assigned.titleSlug.toLowerCase();
}

/**
 * Evaluate one student's assignment day.
 *
 * `submissions` may contain anything — other problems, other days, other verdicts — and
 * callers are expected to pass the student's **whole** history for the assigned slugs,
 * not a pre-windowed slice. Anything narrower silently caps `solvedCount` back to the
 * window and reintroduces the bug this function exists to fix; the window is applied
 * here, to the `inWindow` figures only.
 */
export function calculateAssignmentCompletion(
  dayKey: DayKey,
  assignedProblems: AssignedProblemRef[],
  submissions: CompletionSubmission[],
  lookbackDays: number = ASSIGNMENT_LOOKBACK_DAYS,
): AssignmentCompletionResult {
  const { startDayKey, endDayKey } = assignmentWindow(dayKey, lookbackDays);

  const problems: ProblemCompletion[] = assignedProblems
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((assigned) => ({
      problemId: assigned.problemId,
      titleSlug: assigned.titleSlug.toLowerCase(),
      position: assigned.position,
      status: 'NOT_ATTEMPTED' as CompletionStatus,
      solvedAt: null,
      solvedOnDayKey: null,
      language: null,
      attempts: 0,
      inWindowStatus: 'NOT_ATTEMPTED' as CompletionStatus,
      solvedInWindowAt: null,
      attemptsInWindow: 0,
    }));

  // Oldest first, so "earliest accepted submission wins" falls out of the iteration
  // order instead of needing a comparison at every step.
  const ordered = submissions
    .slice()
    .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());

  for (const submission of ordered) {
    const assignedIndex = assignedProblems.findIndex((assigned) =>
      matchesAssigned(submission, assigned),
    );
    if (assignedIndex === -1) continue;

    const slot = problems.find(
      (p) => p.problemId === assignedProblems[assignedIndex]!.problemId,
    );
    if (!slot) continue;

    const inWindow = submission.dayKey >= startDayKey && submission.dayKey <= endDayKey;

    slot.attempts += 1;
    if (inWindow) slot.attemptsInWindow += 1;

    if (submission.status === 'ACCEPTED') {
      // Already solved: a re-solve is the same problem, so it must not move the
      // completion time forward or add to the count.
      if (slot.status !== 'ACCEPTED') {
        slot.status = 'ACCEPTED';
        slot.solvedAt = submission.submittedAt;
        slot.solvedOnDayKey = submission.dayKey;
        slot.language = submission.language ?? null;
      }
      if (inWindow && slot.inWindowStatus !== 'ACCEPTED') {
        slot.inWindowStatus = 'ACCEPTED';
        slot.solvedInWindowAt = submission.submittedAt;
        // A problem first solved outside the window but re-solved inside it should
        // report the language the student actually used most recently in the window.
        slot.language = submission.language ?? slot.language;
      }
    } else {
      if (slot.status === 'NOT_ATTEMPTED') {
        slot.status = 'ATTEMPTED_NOT_ACCEPTED';
        slot.language = slot.language ?? submission.language ?? null;
      }
      if (inWindow && slot.inWindowStatus === 'NOT_ATTEMPTED') {
        slot.inWindowStatus = 'ATTEMPTED_NOT_ACCEPTED';
      }
    }
  }

  const accepted = problems.filter((p) => p.status === 'ACCEPTED');
  const acceptedInWindow = problems.filter((p) => p.inWindowStatus === 'ACCEPTED');

  const windowSolveTimes = acceptedInWindow
    .map((p) => p.solvedInWindowAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  const everSolveTimes = accepted
    .map((p) => p.solvedAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  const assignedCount = problems.length;
  const solvedCount = accepted.length;
  const inWindowSolvedCount = acceptedInWindow.length;
  const isComplete = assignedCount > 0 && solvedCount >= assignedCount;
  const completedInWindow = assignedCount > 0 && inWindowSolvedCount >= assignedCount;

  return {
    dayKey,
    windowStartDayKey: startDayKey,
    windowEndDayKey: endDayKey,
    assignedCount,
    solvedCount,
    inWindowSolvedCount,
    isComplete,
    problems,
    firstSolvedAt: windowSolveTimes[0] ?? null,
    lastSolvedAt: windowSolveTimes[windowSolveTimes.length - 1] ?? null,
    completedAt: completedInWindow
      ? (windowSolveTimes[windowSolveTimes.length - 1] ?? null)
      : null,
    everCompletedAt: isComplete ? (everSolveTimes[everSolveTimes.length - 1] ?? null) : null,
  };
}

/**
 * Solved / attempted-not-solved / not-attempted counts for one student's assigned
 * problems on a day — the one place that turns a list of per-problem outcomes into the
 * three numbers a mentor actually asks for (§ submission-attempt tracking).
 *
 * `attemptedNotSolvedCount` is never inferred from the *absence* of an accepted
 * submission — it is a straight count of problems whose stored status is
 * `ATTEMPTED_NOT_ACCEPTED`, which `calculateAssignmentCompletion` only ever sets when a
 * real (non-accepted) submission was observed for that problem. A problem with no
 * submission at all keeps its default `NOT_ATTEMPTED` and is counted there instead.
 * `X + Z + W` therefore always equals the number of problems passed in.
 */
export interface ProblemStatusCounts {
  solvedCount: number;
  attemptedNotSolvedCount: number;
  notAttemptedCount: number;
}

export function summarizeProblemStatuses(
  problems: { status: CompletionStatus }[],
): ProblemStatusCounts {
  let solvedCount = 0;
  let attemptedNotSolvedCount = 0;
  let notAttemptedCount = 0;

  for (const problem of problems) {
    if (problem.status === 'ACCEPTED') solvedCount += 1;
    else if (problem.status === 'ATTEMPTED_NOT_ACCEPTED') attemptedNotSolvedCount += 1;
    // `NOT_ATTEMPTED` and the (never actually persisted by this module) `UNKNOWN` verdict
    // both mean "no evidence of an attempt" and are counted together.
    else notAttemptedCount += 1;
  }

  return { solvedCount, attemptedNotSolvedCount, notAttemptedCount };
}

/**
 * Within one "solved N" bucket, how many students actually touched their remaining
 * problems versus never submitted anything for them.
 *
 * A student who has fully completed the assignment (`attemptedNotSolvedCount` and
 * `notAttemptedCount` both zero, because nothing remains) counts toward neither side —
 * the question "did they attempt what's left" does not apply to them.
 */
export function summarizeBucketAttempts(
  rows: Pick<ProblemStatusCounts, 'attemptedNotSolvedCount' | 'notAttemptedCount'>[],
): { studentsAttemptedCount: number; studentsNotAttemptedCount: number } {
  let studentsAttemptedCount = 0;
  let studentsNotAttemptedCount = 0;

  for (const row of rows) {
    if (row.attemptedNotSolvedCount > 0) studentsAttemptedCount += 1;
    else if (row.notAttemptedCount > 0) studentsNotAttemptedCount += 1;
  }

  return { studentsAttemptedCount, studentsNotAttemptedCount };
}

/**
 * Lifetime distinct problems solved, from the local submission mirror.
 *
 * Counts *problems*, not submissions: ten accepted attempts at one problem is one solve.
 * Identity falls back to the slug because `problemId` is only populated for problems the
 * programme tracks, while students solve far more than we assign.
 *
 * Note for callers: the mirror is a floor, not the truth. LeetCode's public submission
 * list only exposes the 20 most recent entries, so anything a student solved before we
 * started syncing them is not in here. `StudentMetricsService` reconciles this against
 * the provider's own lifetime total.
 */
export function countDistinctSolvedProblems(
  submissions: Pick<CompletionSubmission, 'problemId' | 'titleSlug' | 'status'>[],
): number {
  const solved = new Set<string>();
  for (const submission of submissions) {
    if (submission.status !== 'ACCEPTED') continue;
    solved.add(submission.titleSlug.toLowerCase());
  }
  return solved.size;
}
