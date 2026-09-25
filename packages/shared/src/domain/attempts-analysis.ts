/**
 * Coding-Hours Attempts Analysis — "this student tried an assigned problem N times and
 * still has no accepted solution".
 *
 * The unit is one student x one assigned problem x one assignment day, and the evidence
 * is the submission mirror, never `DailyProblemStatus.attempts` (which is ever-based and
 * would count a June attempt against a September assignment). Three rules:
 *
 * 1. **The assignment period is `[D, D]`.** A submission counts towards an assignment
 *    dated D only if its program day (`Submission.dayKey`, Asia/Kolkata) is D itself.
 *    The start is the assignment day, not the Coding-Hours lookback's `D - 2`: the brief
 *    is explicit that work done *before* a problem was set is not an attempt at it. The
 *    end is the existing Coding-Hours window's own end (`assignmentWindow(D).endDayKey`,
 *    which is D), so this feature adds no new window of its own. A side effect worth
 *    knowing: one student has at most one assignment per day, so a submission can never
 *    be counted against two assignments.
 *
 * 2. **One LeetCode submission is one attempt.** Rows are de-duplicated on the provider's
 *    submission id before anything is counted. The mirror's unique constraint already
 *    guarantees this in the database; the pure function repeats it so the rule holds for
 *    any caller, not just the one that happens to read through that constraint.
 *
 * 3. **Failed attempts stop at the first accepted.** For an unsolved problem every
 *    attempt is a failed attempt. For a solved one, only the non-accepted submissions
 *    *before* the first accepted count — resubmitting a solved problem to improve its
 *    runtime is not struggling with it.
 */

import { assignmentWindow } from './assignment-completion';
import type { DayKey } from './time';

/** Outcome of one student on one assigned problem, within the assignment period. */
export type AttemptOutcome = 'ATTEMPTED_NOT_SOLVED' | 'SOLVED_AFTER_ATTEMPTS' | 'NOT_ATTEMPTED';

export const ATTEMPT_OUTCOME_LABELS: Record<AttemptOutcome, string> = {
  ATTEMPTED_NOT_SOLVED: 'Attempted But Not Solved',
  SOLVED_AFTER_ATTEMPTS: 'Solved After Attempts',
  NOT_ATTEMPTED: 'Not Attempted',
};

/**
 * What the table shows. `ALL_ATTEMPTS` is both attempted outcomes together — every row
 * with at least one submission. The default is the management question.
 */
export type AttemptView = AttemptOutcome | 'ALL_ATTEMPTS';

export const ATTEMPT_VIEWS: AttemptView[] = [
  'ATTEMPTED_NOT_SOLVED',
  'SOLVED_AFTER_ATTEMPTS',
  'ALL_ATTEMPTS',
  'NOT_ATTEMPTED',
];

export const ATTEMPT_VIEW_LABELS: Record<AttemptView, string> = {
  ...ATTEMPT_OUTCOME_LABELS,
  ALL_ATTEMPTS: 'All Attempts',
};

export const DEFAULT_ATTEMPT_VIEW: AttemptView = 'ATTEMPTED_NOT_SOLVED';

/** The "Minimum Attempts" choices. */
export const MIN_ATTEMPT_OPTIONS = [1, 2, 3, 5, 10] as const;

/** The period an assignment dated `dayKey` accepts attempts in — see rule 1 above. */
export function attemptWindow(dayKey: DayKey): { startDayKey: DayKey; endDayKey: DayKey } {
  return { startDayKey: dayKey, endDayKey: assignmentWindow(dayKey).endDayKey };
}

/** One mirrored submission, narrowed to what attempt counting needs. */
export interface AttemptSubmission {
  /** LeetCode's submission id — the identity used to de-duplicate. */
  providerSubmissionId: string;
  /** `ACCEPTED`, `ATTEMPTED_NOT_ACCEPTED` or `UNKNOWN` (no verdict reported). */
  status: string;
  submittedAt: Date;
  /** Program-day bucket of `submittedAt`. */
  dayKey: string;
  language?: string | null;
}

export interface AttemptSummary {
  outcome: AttemptOutcome;
  attempts: number;
  solved: boolean;
  failedAttempts: number;
  firstAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  firstAcceptedAt: Date | null;
  /** The counted submissions, oldest first, de-duplicated. */
  submissions: AttemptSubmission[];
}

/** Numeric ids compare numerically, so two submissions in the same second keep LeetCode's order. */
function compareSubmissions(a: AttemptSubmission, b: AttemptSubmission): number {
  const byTime = a.submittedAt.getTime() - b.submittedAt.getTime();
  if (byTime !== 0) return byTime;
  const numeric = /^\d+$/;
  if (numeric.test(a.providerSubmissionId) && numeric.test(b.providerSubmissionId)) {
    const x = BigInt(a.providerSubmissionId);
    const y = BigInt(b.providerSubmissionId);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a.providerSubmissionId.localeCompare(b.providerSubmissionId);
}

/**
 * The one derivation. Pass every mirrored submission the student made to this problem
 * (any dates — the window is applied here) and the assignment's day.
 */
export function summariseAttempts(assignmentDayKey: DayKey, submissions: AttemptSubmission[]): AttemptSummary {
  const { startDayKey, endDayKey } = attemptWindow(assignmentDayKey);

  const seen = new Set<string>();
  const counted: AttemptSubmission[] = [];
  for (const s of submissions) {
    if (s.dayKey < startDayKey || s.dayKey > endDayKey) continue;
    if (seen.has(s.providerSubmissionId)) continue;
    seen.add(s.providerSubmissionId);
    counted.push(s);
  }
  counted.sort(compareSubmissions);

  const firstAcceptedIndex = counted.findIndex((s) => s.status === 'ACCEPTED');
  const solved = firstAcceptedIndex !== -1;
  const attempts = counted.length;

  return {
    outcome: attempts === 0 ? 'NOT_ATTEMPTED' : solved ? 'SOLVED_AFTER_ATTEMPTS' : 'ATTEMPTED_NOT_SOLVED',
    attempts,
    solved,
    // Everything before the first accepted is, by construction, not accepted.
    failedAttempts: solved ? firstAcceptedIndex : attempts,
    firstAttemptAt: counted[0]?.submittedAt ?? null,
    lastAttemptAt: counted[attempts - 1]?.submittedAt ?? null,
    firstAcceptedAt: solved ? counted[firstAcceptedIndex]!.submittedAt : null,
    submissions: counted,
  };
}

/** Does a row belong in this view? */
export function matchesAttemptView(outcome: AttemptOutcome, view: AttemptView): boolean {
  if (view === 'ALL_ATTEMPTS') return outcome !== 'NOT_ATTEMPTED';
  return outcome === view;
}

/**
 * The report's order: failed attempts, then attempts, both descending, then student name.
 * Problem and day break the remaining ties so the order is total and the export can match
 * the page row for row.
 */
export function compareAttemptRows(
  a: { failedAttempts: number; attempts: number; name: string; dayKey: string; position: number },
  b: { failedAttempts: number; attempts: number; name: string; dayKey: string; position: number },
): number {
  return (
    b.failedAttempts - a.failedAttempts ||
    b.attempts - a.attempts ||
    a.name.localeCompare(b.name) ||
    a.dayKey.localeCompare(b.dayKey) ||
    a.position - b.position
  );
}

// ---------------------------------------------------------------------------
// Response contract
// ---------------------------------------------------------------------------

export interface AttemptRow {
  studentId: string;
  name: string;
  campusCode: string | null;
  batch: string | null;
  squad: string | null;
  leetcodeUsername: string | null;
  leetcodeUrl: string | null;
  problemId: string;
  titleSlug: string;
  title: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null;
  /** The assignment's day — also the whole attempt window. */
  dayKey: DayKey;
  position: number;
  outcome: AttemptOutcome;
  attempts: number;
  solved: boolean;
  failedAttempts: number;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
}

export interface AttemptSubmissionDetail {
  providerSubmissionId: string;
  status: string;
  submittedAt: string;
  language: string | null;
}

export interface AttemptDrillDownRow extends AttemptRow {
  submissions: AttemptSubmissionDetail[];
}

export interface AttemptsManagementSummary {
  studentsAttemptedNotSolved: number;
  /** Student x assigned-problem pairs with at least one submission in the period. */
  assignedProblemsAttempted: number;
  totalFailedAttempts: number;
  studentsWith3PlusNoAc: number;
  studentsWith5PlusNoAc: number;
}

export interface AttemptsAnalysisResponse {
  /** Computed over campus/batch/squad/date/problem/difficulty/search — not over the view
   * or minimum-attempts choice, so switching the table does not change the headline. */
  summary: AttemptsManagementSummary;
  /** Distinct assigned problems in scope, for the Problem filter. */
  problems: { titleSlug: string; title: string }[];
  rows: AttemptRow[];
}

export interface AttemptsStudentResponse {
  student: {
    studentId: string;
    name: string;
    campusCode: string | null;
    batch: string | null;
    squad: string | null;
    leetcodeUsername: string | null;
    leetcodeUrl: string | null;
  };
  /** Every attempted assigned problem in the period, same order as the main table. */
  rows: AttemptDrillDownRow[];
}

/** Summary over a set of rows (which should include every outcome). */
export function summariseAttemptRows(rows: Pick<AttemptRow, 'studentId' | 'outcome' | 'attempts' | 'failedAttempts'>[]): AttemptsManagementSummary {
  const notSolved = rows.filter((r) => r.outcome === 'ATTEMPTED_NOT_SOLVED');
  const students = (list: typeof rows) => new Set(list.map((r) => r.studentId)).size;
  return {
    studentsAttemptedNotSolved: students(notSolved),
    assignedProblemsAttempted: rows.filter((r) => r.attempts > 0).length,
    totalFailedAttempts: rows.reduce((sum, r) => sum + r.failedAttempts, 0),
    studentsWith3PlusNoAc: students(notSolved.filter((r) => r.attempts >= 3)),
    studentsWith5PlusNoAc: students(notSolved.filter((r) => r.attempts >= 5)),
  };
}
