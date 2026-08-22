/**
 * Baseline tests — grading, and the evidence behind "review recommended".
 *
 * Two things live here, both pure, both deliberately separate from `domain/scoring.ts`.
 *
 * **Grading.** A baseline score is the sum of the points on the problems a student got
 * accepted inside their own attempt window. It shares no code with the daily assignment
 * formula and produces no value that any daily surface reads (§25). If the two ever need
 * to diverge — and they will, because one measures practice and the other measures
 * capability — they can, without a shared abstraction forcing a compromise.
 *
 * **Risk signals.** The programme wants to know when a result may not reflect the
 * student's own work. What this module will *not* do is conclude that. Every signal below
 * is a timestamp fact the submission mirror can demonstrate, each is reported with the
 * evidence that produced it, and the strongest verdict the system is allowed to reach is
 * "review recommended" (§23). That restraint is not politeness: solving four easy
 * problems in nine minutes is genuinely what a strong student looks like, and a system
 * that called that cheating would be wrong often enough to be worse than useless.
 *
 * Consequently there is no similarity or plagiarism signal at all. The public LeetCode
 * API exposes no submitted source, so any such claim would be fabricated. If an
 * authenticated provider ever supplies code, a signal can be added here — with its
 * evidence — rather than inferred from timing.
 */

export const BASELINE_TEST_STATUSES = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'CLOSED'] as const;
export type BaselineTestStatus = (typeof BASELINE_TEST_STATUSES)[number];

export const BASELINE_TEST_STATUS_LABELS: Record<BaselineTestStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  CLOSED: 'Closed',
};

export const BASELINE_ATTEMPT_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'EXPIRED',
] as const;
export type BaselineAttemptStatus = (typeof BASELINE_ATTEMPT_STATUSES)[number];

export const BASELINE_REVIEW_STATUSES = ['NOT_REVIEWED', 'REVIEW_REQUIRED', 'REVIEWED'] as const;
export type BaselineReviewStatus = (typeof BASELINE_REVIEW_STATUSES)[number];

export const BASELINE_REVIEW_STATUS_LABELS: Record<BaselineReviewStatus, string> = {
  NOT_REVIEWED: 'Not reviewed',
  REVIEW_REQUIRED: 'Review recommended',
  REVIEWED: 'Reviewed',
};

export const BASELINE_RISK_SIGNALS = [
  'IMMEDIATE_ACCEPTANCE',
  'RAPID_SUCCESSION',
  'NO_FAILED_ATTEMPTS',
  'INCONSISTENT_WITH_HISTORY',
  'SOLVED_BEFORE_TEST',
] as const;
export type BaselineRiskSignal = (typeof BASELINE_RISK_SIGNALS)[number];

/**
 * Copy for each signal, written as an observation rather than an allegation.
 *
 * Every string is phrased so it stays true even when the innocent explanation is the
 * right one — "accepted 41s after starting" is a fact whether the student had seen the
 * problem before or is simply very quick.
 */
export const BASELINE_RISK_SIGNAL_LABELS: Record<BaselineRiskSignal, string> = {
  IMMEDIATE_ACCEPTANCE: 'Accepted almost immediately after the attempt began',
  RAPID_SUCCESSION: 'Several problems accepted within a very short window',
  NO_FAILED_ATTEMPTS: 'Every problem accepted on the first submission',
  INCONSISTENT_WITH_HISTORY: 'Much faster than this student’s own recent pace',
  SOLVED_BEFORE_TEST: 'An accepted submission exists from before the test opened',
};

/** How much each signal contributes to the triage score. */
const RISK_WEIGHTS: Record<BaselineRiskSignal, number> = {
  SOLVED_BEFORE_TEST: 40,
  IMMEDIATE_ACCEPTANCE: 30,
  RAPID_SUCCESSION: 20,
  INCONSISTENT_WITH_HISTORY: 15,
  NO_FAILED_ATTEMPTS: 10,
};

/**
 * Thresholds, gathered here so they are tunable in one place and visible in review.
 *
 * The numbers are deliberately conservative. `immediateAcceptanceSeconds` is 90 because
 * reading a Medium, writing it and getting it accepted inside 90 seconds is implausible
 * even for a strong student, whereas a 5-minute threshold would flag half of any good
 * cohort. Flagging too eagerly trains mentors to ignore the flag.
 */
export const BASELINE_RISK_THRESHOLDS = {
  /** Accepted this fast after the attempt started. */
  immediateAcceptanceSeconds: 90,
  /** Two consecutive accepted problems closer together than this. */
  rapidSuccessionSeconds: 120,
  /** How many such consecutive pairs it takes to raise the signal. */
  rapidSuccessionPairs: 2,
  /** Multiple of the student's own median solve time below which pace looks inconsistent. */
  historyPaceRatio: 0.25,
  /** Minimum problems solved before `NO_FAILED_ATTEMPTS` means anything. */
  noFailedAttemptsMinimum: 3,
  /** At or above this score, the attempt is marked `REVIEW_REQUIRED`. */
  reviewRequiredScore: 30,
} as const;

/** One graded problem inside an attempt — the input to both grading and signals. */
export interface BaselineProblemOutcome {
  testProblemId: string;
  problemId: string;
  points: number;
  accepted: boolean;
  /** Submissions observed for this problem inside the window, accepted or not. */
  attempts: number;
  /** Seconds from attempt start to the accepted submission; null when not accepted. */
  timeToSolveSeconds: number | null;
  /** True when an accepted submission for this problem exists from before the test opened. */
  solvedBeforeTest: boolean;
}

export interface BaselineGrade {
  score: number;
  maxScore: number;
  solvedCount: number;
  attemptedCount: number;
  /** 0–100, rounded to two decimals. 0 when the test carries no points. */
  percent: number;
}

export function gradeAttempt(outcomes: readonly BaselineProblemOutcome[]): BaselineGrade {
  let score = 0;
  let maxScore = 0;
  let solvedCount = 0;
  let attemptedCount = 0;

  for (const outcome of outcomes) {
    maxScore += outcome.points;
    if (outcome.accepted) {
      score += outcome.points;
      solvedCount += 1;
    }
    // "Attempted" counts anyone who submitted at all — including the students who tried
    // and failed, who are the ones a baseline test most needs to make visible.
    if (outcome.attempts > 0) attemptedCount += 1;
  }

  return {
    score,
    maxScore,
    solvedCount,
    attemptedCount,
    percent: maxScore > 0 ? Math.round((score / maxScore) * 10000) / 100 : 0,
  };
}

export interface RiskAssessmentInput {
  outcomes: readonly BaselineProblemOutcome[];
  /**
   * The student's own median seconds-to-solve on comparable problems, from their history.
   * Null when there is not enough history to compare against — in which case the
   * `INCONSISTENT_WITH_HISTORY` signal is simply not evaluated, rather than assumed.
   */
  medianHistoricalSolveSeconds: number | null;
}

export interface RiskAssessment {
  signals: BaselineRiskSignal[];
  /** 0–100 triage ordering for mentors. Never shown to students (§23, §35). */
  score: number;
  /** One evidence line per signal, safe to show a mentor verbatim. */
  evidence: string[];
  reviewRecommended: boolean;
}

/**
 * Derive the signals for one attempt.
 *
 * Returns an empty assessment for an attempt with nothing accepted: a student who solved
 * nothing cannot have solved it suspiciously, and flagging them would put exactly the
 * people who need help into the review queue.
 */
export function assessRisk(input: RiskAssessmentInput): RiskAssessment {
  const signals: BaselineRiskSignal[] = [];
  const evidence: string[] = [];
  const accepted = input.outcomes.filter((outcome) => outcome.accepted);

  if (accepted.length === 0) {
    return { signals: [], score: 0, evidence: [], reviewRecommended: false };
  }

  const preSolved = input.outcomes.filter((outcome) => outcome.solvedBeforeTest);
  if (preSolved.length > 0) {
    signals.push('SOLVED_BEFORE_TEST');
    evidence.push(
      `${preSolved.length} of ${input.outcomes.length} problems already had an accepted ` +
        'submission before the test opened.',
    );
  }

  const immediate = accepted.filter(
    (outcome) =>
      outcome.timeToSolveSeconds !== null &&
      outcome.timeToSolveSeconds <= BASELINE_RISK_THRESHOLDS.immediateAcceptanceSeconds,
  );
  if (immediate.length > 0) {
    signals.push('IMMEDIATE_ACCEPTANCE');
    const fastest = Math.min(...immediate.map((o) => o.timeToSolveSeconds ?? 0));
    evidence.push(
      `${immediate.length} problem(s) accepted within ` +
        `${BASELINE_RISK_THRESHOLDS.immediateAcceptanceSeconds}s of starting (fastest ${fastest}s).`,
    );
  }

  const solveTimes = accepted
    .map((outcome) => outcome.timeToSolveSeconds)
    .filter((seconds): seconds is number => seconds !== null)
    .sort((a, b) => a - b);

  let closePairs = 0;
  for (let i = 1; i < solveTimes.length; i += 1) {
    const current = solveTimes[i];
    const previous = solveTimes[i - 1];
    if (current === undefined || previous === undefined) continue;
    if (current - previous <= BASELINE_RISK_THRESHOLDS.rapidSuccessionSeconds) {
      closePairs += 1;
    }
  }
  if (closePairs >= BASELINE_RISK_THRESHOLDS.rapidSuccessionPairs) {
    signals.push('RAPID_SUCCESSION');
    evidence.push(
      `${closePairs} consecutive accepted problems were less than ` +
        `${BASELINE_RISK_THRESHOLDS.rapidSuccessionSeconds}s apart.`,
    );
  }

  if (
    accepted.length >= BASELINE_RISK_THRESHOLDS.noFailedAttemptsMinimum &&
    accepted.every((outcome) => outcome.attempts === 1)
  ) {
    signals.push('NO_FAILED_ATTEMPTS');
    evidence.push(
      `All ${accepted.length} accepted problems passed on the first submission, with no ` +
        'failed attempt recorded.',
    );
  }

  if (input.medianHistoricalSolveSeconds !== null && solveTimes.length > 0) {
    const median = solveTimes[Math.floor(solveTimes.length / 2)] ?? Number.POSITIVE_INFINITY;
    const bound =
      input.medianHistoricalSolveSeconds * BASELINE_RISK_THRESHOLDS.historyPaceRatio;
    if (median < bound) {
      signals.push('INCONSISTENT_WITH_HISTORY');
      evidence.push(
        `Median solve time ${median}s is under ${Math.round(bound)}s — well below this ` +
          `student's own recent median of ${Math.round(input.medianHistoricalSolveSeconds)}s.`,
      );
    }
  }

  const score = Math.min(
    100,
    signals.reduce((total, signal) => total + RISK_WEIGHTS[signal], 0),
  );

  return {
    signals,
    score,
    evidence,
    reviewRecommended: score >= BASELINE_RISK_THRESHOLDS.reviewRequiredScore,
  };
}

/**
 * When an attempt's individual window closes.
 *
 * The student's own duration, clamped to the test's close time: starting 10 minutes
 * before a test closes gives you 10 minutes, not the full hour. Returns `closesAt` when
 * the duration would overrun it, and the duration bound otherwise.
 */
export function attemptExpiry(
  startedAt: Date,
  durationMinutes: number,
  closesAt: Date | null,
): Date {
  const byDuration = new Date(startedAt.getTime() + durationMinutes * 60_000);
  if (closesAt && closesAt.getTime() < byDuration.getTime()) return closesAt;
  return byDuration;
}

/**
 * Whether a test is open for new attempts right now.
 *
 * `ACTIVE` alone is not enough — a test can be marked active while its `opensAt` is still
 * in the future, and a window that has passed must not accept a new start even if nobody
 * has closed the test yet.
 */
export function isTestOpen(
  test: { status: BaselineTestStatus; opensAt: Date | null; closesAt: Date | null },
  now: Date,
): boolean {
  if (test.status !== 'ACTIVE') return false;
  if (test.opensAt && now.getTime() < test.opensAt.getTime()) return false;
  if (test.closesAt && now.getTime() > test.closesAt.getTime()) return false;
  return true;
}
