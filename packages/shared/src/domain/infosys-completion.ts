/**
 * Turns one student's raw submissions into per-problem Infosys outcomes.
 *
 * The one rule this file exists to enforce (§2, §13 of the program brief): a submission
 * before the Infosys tracking start date is never counted, full stop. Unlike Coding
 * Hours' `calculateAssignmentCompletion` — which deliberately does *not* date-filter its
 * input, because "ever solved" is the whole point there — this function is handed
 * submissions the caller has already restricted to `submittedAt >= trackingStartDate`,
 * and it re-checks that floor itself rather than trusting the caller, because this is
 * the one cutoff in the whole feature that must never have an exception. Two ways to
 * silently widen it were already tried and reverted for a different feature in this
 * codebase (see `observed-from-is-createdat-only` in project memory) — the fix there was
 * the same shape as here: make the check redundant rather than clever.
 */

export type InfosysQuestionOutcome = 'SOLVED' | 'ATTEMPTED_NOT_SOLVED' | 'NOT_ATTEMPTED';

export interface InfosysRawSubmission {
  titleSlug: string;
  /** `'ACCEPTED'` or anything else — only acceptance is distinguished here. */
  status: string;
  submittedAt: Date;
}

export interface InfosysAssignedProblemRef {
  problemId: string;
  titleSlug: string;
  position: number;
}

export interface InfosysProblemOutcome {
  problemId: string;
  position: number;
  status: InfosysQuestionOutcome;
  /** Earliest accepted submission at or after the tracking start date. */
  solvedAt: Date | null;
  /** Submissions at or after the tracking start date, accepted or not. */
  attempts: number;
}

/**
 * One student, one day's assigned problems, evaluated against their submissions.
 *
 * `submissions` should already be restricted to this student and to the assigned
 * slugs — this function does not filter by student or by slug, only by the tracking
 * window, which it enforces itself regardless of what the caller already did.
 */
export function evaluateInfosysDay(
  assigned: InfosysAssignedProblemRef[],
  submissions: InfosysRawSubmission[],
  trackingStartDate: Date,
): InfosysProblemOutcome[] {
  const inWindow = submissions.filter((s) => s.submittedAt.getTime() >= trackingStartDate.getTime());

  return assigned.map((problem) => {
    const slug = problem.titleSlug.toLowerCase();
    const relevant = inWindow.filter((s) => s.titleSlug.toLowerCase() === slug);
    const accepted = relevant.filter((s) => s.status === 'ACCEPTED');

    if (accepted.length > 0) {
      const solvedAt = accepted.reduce(
        (earliest, s) => (s.submittedAt.getTime() < earliest.getTime() ? s.submittedAt : earliest),
        accepted[0]!.submittedAt,
      );
      return {
        problemId: problem.problemId,
        position: problem.position,
        status: 'SOLVED',
        solvedAt,
        attempts: relevant.length,
      };
    }

    if (relevant.length > 0) {
      return {
        problemId: problem.problemId,
        position: problem.position,
        status: 'ATTEMPTED_NOT_SOLVED',
        solvedAt: null,
        attempts: relevant.length,
      };
    }

    return {
      problemId: problem.problemId,
      position: problem.position,
      status: 'NOT_ATTEMPTED',
      solvedAt: null,
      attempts: 0,
    };
  });
}

/** Distinct problems solved across a set of outcomes — the building block for every
 * "total solved" figure Infosys reports (§13: distinct problems, never duplicate
 * submissions, never a repeated assignment counted twice — both already impossible
 * here, since `assigned` is deduplicated upstream by `InfosysAssignmentProblem`'s
 * `@@unique([infosysAssignmentId, problemId])` and this returns one outcome per
 * assigned problem row). */
export function countSolved(outcomes: InfosysProblemOutcome[]): number {
  return outcomes.filter((o) => o.status === 'SOLVED').length;
}
