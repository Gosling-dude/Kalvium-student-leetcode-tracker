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
 * 1. **Backwards lookback.** Assignments are frequently published *after* students have
 *    already started working — sometimes a day or two late. Matching a submission's day
 *    against the assignment's day (`submission.dayKey === assignment.dayKey`) therefore
 *    marked genuinely-solved problems as missed. Completion instead looks back over a
 *    window ending on the assignment day: `[D - LOOKBACK_DAYS, D]`.
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

/** Per-problem outcome for one student on one assignment day. */
export interface ProblemCompletion {
  problemId: string;
  titleSlug: string;
  position: number;
  status: CompletionStatus;
  /** Earliest accepted submission for this problem inside the window. */
  solvedAt: Date | null;
  /** The program day the accepted submission actually landed on — may precede `D`. */
  solvedOnDayKey: DayKey | null;
  language: string | null;
  /** Submissions seen for this problem inside the window, accepted or not. */
  attempts: number;
}

export interface AssignmentCompletionResult {
  dayKey: DayKey;
  /** Inclusive window actually searched. */
  windowStartDayKey: DayKey;
  windowEndDayKey: DayKey;
  assignedCount: number;
  /** Distinct assigned problems with an accepted submission in the window. */
  solvedCount: number;
  /** True only when every assigned problem was solved. Not the streak rule. */
  isComplete: boolean;
  problems: ProblemCompletion[];
  firstSolvedAt: Date | null;
  lastSolvedAt: Date | null;
  /** When the *whole* assignment was finished; `null` if it was not. */
  completedAt: Date | null;
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
 * `submissions` may contain anything — other problems, other days, other verdicts. This
 * function filters to the window and the assigned set itself, so callers can hand over a
 * batch query result unsorted and unfiltered without risking a double-count.
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
    }));

  // Oldest first, so "earliest accepted submission wins" falls out of the iteration
  // order instead of needing a comparison at every step.
  const ordered = submissions
    .filter((s) => s.dayKey >= startDayKey && s.dayKey <= endDayKey)
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

    slot.attempts += 1;

    if (submission.status === 'ACCEPTED') {
      // Already solved: a re-solve is the same problem, so it must not move the
      // completion time forward or add to the count.
      if (slot.status !== 'ACCEPTED') {
        slot.status = 'ACCEPTED';
        slot.solvedAt = submission.submittedAt;
        slot.solvedOnDayKey = submission.dayKey;
        slot.language = submission.language ?? null;
      }
    } else if (slot.status === 'NOT_ATTEMPTED') {
      slot.status = 'ATTEMPTED_NOT_ACCEPTED';
      slot.language = submission.language ?? null;
    }
  }

  const accepted = problems.filter((p) => p.status === 'ACCEPTED');
  const solvedTimes = accepted
    .map((p) => p.solvedAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  const assignedCount = problems.length;
  const solvedCount = accepted.length;
  const isComplete = assignedCount > 0 && solvedCount >= assignedCount;

  return {
    dayKey,
    windowStartDayKey: startDayKey,
    windowEndDayKey: endDayKey,
    assignedCount,
    solvedCount,
    isComplete,
    problems,
    firstSolvedAt: solvedTimes[0] ?? null,
    lastSolvedAt: solvedTimes[solvedTimes.length - 1] ?? null,
    completedAt: isComplete ? (solvedTimes[solvedTimes.length - 1] ?? null) : null,
  };
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
