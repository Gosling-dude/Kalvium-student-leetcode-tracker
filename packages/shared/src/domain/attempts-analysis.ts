/**
 * Coding-Hours Attempts Analysis — "this student tried an assigned problem N times and
 * still has no accepted solution", and "this student needed more than one try".
 *
 * The unit is one student x one assigned problem x one assignment day, and the evidence
 * is the submission mirror, never `DailyProblemStatus.attempts` (which is ever-based and
 * would count a June attempt against a September assignment). Four rules:
 *
 * 1. **The assignment period starts on the assignment day D and runs until the same
 *    problem is next assigned to the same student** (exclusive), or indefinitely if it
 *    never is. Submissions before D are not attempts at the assignment. Submissions after
 *    D are: the first version of this feature stopped the period at D itself, which
 *    turned every student who worked on the problem a day later into "0 attempts" — 773
 *    of the 1,798 mirrored submissions to assigned problems on the 23 Sep production
 *    snapshot fell after their assignment day. Ending the period at the next assignment of
 *    the same problem keeps the periods disjoint, so no submission is ever counted against
 *    two assignments.
 *
 * 2. **One LeetCode submission is one attempt.** Rows are de-duplicated on the provider's
 *    submission id before anything is counted.
 *
 * 3. **Failed attempts stop at the first accepted.** Unsolved: every attempt failed.
 *    Solved: only the non-accepted submissions *before* the first accepted count.
 *
 * 4. **No evidence is not a zero.** A pair with no submission in the period is only "Not
 *    Attempted" when the student's LeetCode data is readable. If it is not (no handle, a
 *    profile LeetCode says does not exist, a failing sync) the pair is `NO_DATA`. A pair
 *    whose problem was accepted *before* the period is `SOLVED_BEFORE_ASSIGNMENT` — the
 *    ever-solved Campus Analysis counts it as solved, and calling it "Not Attempted" here
 *    would contradict that screen.
 */

import type { DayKey } from './time';

/** Outcome of one student on one assigned problem, within the assignment period. */
export type AttemptOutcome =
  | 'ATTEMPTED_NOT_SOLVED'
  | 'SOLVED_AFTER_ATTEMPTS'
  | 'SOLVED_FIRST_ATTEMPT'
  | 'SOLVED_BEFORE_ASSIGNMENT'
  | 'NOT_ATTEMPTED'
  | 'NO_DATA';

export const ATTEMPT_OUTCOMES: AttemptOutcome[] = [
  'ATTEMPTED_NOT_SOLVED',
  'SOLVED_AFTER_ATTEMPTS',
  'SOLVED_FIRST_ATTEMPT',
  'SOLVED_BEFORE_ASSIGNMENT',
  'NOT_ATTEMPTED',
  'NO_DATA',
];

export const ATTEMPT_OUTCOME_LABELS: Record<AttemptOutcome, string> = {
  ATTEMPTED_NOT_SOLVED: 'Attempted But Not Solved',
  SOLVED_AFTER_ATTEMPTS: 'Solved After Attempts',
  SOLVED_FIRST_ATTEMPT: 'Solved First Attempt',
  SOLVED_BEFORE_ASSIGNMENT: 'Solved Before Assignment',
  NOT_ATTEMPTED: 'Not Attempted',
  NO_DATA: 'No Readable Data',
};

/** What the table shows: one outcome, or `ALL`. */
export type AttemptView = AttemptOutcome | 'ALL';

export const ATTEMPT_VIEWS: AttemptView[] = ['ALL', ...ATTEMPT_OUTCOMES];

export const ATTEMPT_VIEW_LABELS: Record<AttemptView, string> = {
  ...ATTEMPT_OUTCOME_LABELS,
  ALL: 'All',
};

export const DEFAULT_ATTEMPT_VIEW: AttemptView = 'ATTEMPTED_NOT_SOLVED';

/** The "Minimum Attempts" choices. */
export const MIN_ATTEMPT_OPTIONS = [1, 2, 3, 5, 10] as const;

/** Inclusive program-day bounds; `endDayKey: null` means "still open". */
export interface AttemptWindow {
  startDayKey: DayKey;
  endDayKey: DayKey | null;
}

function previousDay(dayKey: DayKey): DayKey {
  const date = new Date(`${dayKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10) as DayKey;
}

/**
 * The assignment periods for every day one student was assigned one problem.
 * Each runs from its own day to the day before the next assignment of that problem.
 */
export function attemptWindows(assignmentDayKeys: DayKey[]): Map<DayKey, AttemptWindow> {
  const days = [...new Set(assignmentDayKeys)].sort();
  const windows = new Map<DayKey, AttemptWindow>();
  days.forEach((day, i) => {
    const next = days[i + 1];
    windows.set(day, { startDayKey: day, endDayKey: next ? previousDay(next) : null });
  });
  return windows;
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
  acceptedCount: number;
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
 * (any dates — the window is applied here).
 */
export function summariseAttempts(
  window: AttemptWindow,
  submissions: AttemptSubmission[],
  options: { dataReadable?: boolean } = {},
): AttemptSummary {
  const dataReadable = options.dataReadable ?? true;
  const seen = new Set<string>();
  const counted: AttemptSubmission[] = [];
  let acceptedBefore = false;
  for (const s of submissions) {
    if (s.dayKey < window.startDayKey) {
      if (s.status === 'ACCEPTED') acceptedBefore = true;
      continue;
    }
    if (window.endDayKey !== null && s.dayKey > window.endDayKey) continue;
    if (seen.has(s.providerSubmissionId)) continue;
    seen.add(s.providerSubmissionId);
    counted.push(s);
  }
  counted.sort(compareSubmissions);

  const firstAcceptedIndex = counted.findIndex((s) => s.status === 'ACCEPTED');
  const solved = firstAcceptedIndex !== -1;
  const attempts = counted.length;
  // Everything before the first accepted is, by construction, not accepted.
  const failedAttempts = solved ? firstAcceptedIndex : attempts;

  let outcome: AttemptOutcome;
  if (solved) outcome = failedAttempts > 0 ? 'SOLVED_AFTER_ATTEMPTS' : 'SOLVED_FIRST_ATTEMPT';
  else if (attempts > 0) outcome = 'ATTEMPTED_NOT_SOLVED';
  else if (acceptedBefore) outcome = 'SOLVED_BEFORE_ASSIGNMENT';
  else outcome = dataReadable ? 'NOT_ATTEMPTED' : 'NO_DATA';

  return {
    outcome,
    attempts,
    solved,
    failedAttempts,
    acceptedCount: counted.filter((s) => s.status === 'ACCEPTED').length,
    firstAttemptAt: counted[0]?.submittedAt ?? null,
    lastAttemptAt: counted[attempts - 1]?.submittedAt ?? null,
    firstAcceptedAt: solved ? counted[firstAcceptedIndex]!.submittedAt : null,
    submissions: counted,
  };
}

/** Does a row belong in this view? */
export function matchesAttemptView(outcome: AttemptOutcome, view: AttemptView): boolean {
  return view === 'ALL' || outcome === view;
}

/**
 * The report's order: failed attempts, then attempts, both descending, then student name.
 * Day and slot break the remaining ties so the order is total and the export can match
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
  /** The assignment's day — the start of its period. */
  dayKey: DayKey;
  /** Last day of the period, or null when the problem was not assigned again. */
  windowEndDayKey: DayKey | null;
  position: number;
  outcome: AttemptOutcome;
  attempts: number;
  solved: boolean;
  failedAttempts: number;
  firstAttemptAt: string | null;
  firstAcceptedAt: string | null;
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
  /** Student x problem pairs attempted without an accepted solution. */
  attemptedNotSolved: number;
  /** Distinct students behind `attemptedNotSolved`. */
  studentsAttemptedNotSolved: number;
  /** Student x problem pairs with at least one submission in their period. */
  assignedProblemsAttempted: number;
  totalFailedAttempts: number;
  /** Solved in the period with at least one failed submission before the first accepted. */
  solvedAfterMultipleAttempts: number;
  problemsWith2PlusAttempts: number;
  problemsWith3PlusAttempts: number;
  problemsWith5PlusAttempts: number;
}

export interface AttemptsAnalysisResponse {
  /** Over every row the dimension filters (campus, batch, squad, dates, problem,
   * difficulty, search) select — all outcomes — so switching the table's view does not
   * change the headline. Computed from the same rows the table is cut from. */
  summary: AttemptsManagementSummary;
  /** Distinct assigned problems in scope, for the Problem filter. */
  problems: { titleSlug: string; title: string }[];
  rows: AttemptRow[];
}

export interface AttemptsStudentStats {
  assignedProblems: number;
  attempted: number;
  solved: number;
  attemptedNotSolved: number;
  solvedAfterAttempts: number;
  totalAttempts: number;
  totalFailedAttempts: number;
  /** Attempts on problems solved in their period, per such problem. Null when none. */
  averageAttemptsPerSolvedProblem: number | null;
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
  stats: AttemptsStudentStats;
  /** Every assigned problem in the period, same order as the main table. */
  rows: AttemptDrillDownRow[];
}

/** Headline numbers over a set of rows (which should include every outcome). */
export function summariseAttemptRows(
  rows: Pick<AttemptRow, 'studentId' | 'outcome' | 'attempts' | 'failedAttempts'>[],
): AttemptsManagementSummary {
  const notSolved = rows.filter((r) => r.outcome === 'ATTEMPTED_NOT_SOLVED');
  return {
    attemptedNotSolved: notSolved.length,
    studentsAttemptedNotSolved: new Set(notSolved.map((r) => r.studentId)).size,
    assignedProblemsAttempted: rows.filter((r) => r.attempts > 0).length,
    totalFailedAttempts: rows.reduce((sum, r) => sum + r.failedAttempts, 0),
    solvedAfterMultipleAttempts: rows.filter((r) => r.outcome === 'SOLVED_AFTER_ATTEMPTS').length,
    problemsWith2PlusAttempts: rows.filter((r) => r.attempts >= 2).length,
    problemsWith3PlusAttempts: rows.filter((r) => r.attempts >= 3).length,
    problemsWith5PlusAttempts: rows.filter((r) => r.attempts >= 5).length,
  };
}

/** The drill-down's header numbers, from that student's rows. */
export function summariseStudentAttempts(
  rows: Pick<AttemptRow, 'outcome' | 'attempts' | 'failedAttempts' | 'solved'>[],
): AttemptsStudentStats {
  const solvedRows = rows.filter((r) => r.solved);
  const solvedAttempts = solvedRows.reduce((sum, r) => sum + r.attempts, 0);
  return {
    assignedProblems: rows.length,
    attempted: rows.filter((r) => r.attempts > 0).length,
    solved: solvedRows.length,
    attemptedNotSolved: rows.filter((r) => r.outcome === 'ATTEMPTED_NOT_SOLVED').length,
    solvedAfterAttempts: rows.filter((r) => r.outcome === 'SOLVED_AFTER_ATTEMPTS').length,
    totalAttempts: rows.reduce((sum, r) => sum + r.attempts, 0),
    totalFailedAttempts: rows.reduce((sum, r) => sum + r.failedAttempts, 0),
    averageAttemptsPerSolvedProblem: solvedRows.length === 0 ? null : solvedAttempts / solvedRows.length,
  };
}
