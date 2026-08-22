/**
 * Baseline grading, and the boundary the risk signals must not cross.
 *
 * Half of these tests assert that a signal fires. The other half assert that it does
 * *not* — and those matter more. A system that flags a strong student for being fast is
 * worse than one that flags nobody, because mentors stop reading a queue that is mostly
 * false positives, and the accusation lands on a real person.
 */

import { describe, expect, it } from 'vitest';

import {
  assessRisk,
  attemptExpiry,
  BASELINE_RISK_THRESHOLDS,
  gradeAttempt,
  isTestOpen,
  type BaselineProblemOutcome,
} from './baseline';

const outcome = (over: Partial<BaselineProblemOutcome> = {}): BaselineProblemOutcome => ({
  testProblemId: 'tp-1',
  problemId: 'p-1',
  points: 10,
  accepted: false,
  attempts: 0,
  timeToSolveSeconds: null,
  solvedBeforeTest: false,
  ...over,
});

describe('gradeAttempt', () => {
  it('awards each solved problem its own weight', () => {
    const grade = gradeAttempt([
      outcome({ points: 10, accepted: true, attempts: 2, timeToSolveSeconds: 600 }),
      outcome({ points: 20, accepted: true, attempts: 1, timeToSolveSeconds: 900 }),
      outcome({ points: 20, accepted: false, attempts: 3 }),
      outcome({ points: 10, accepted: false, attempts: 0 }),
    ]);

    expect(grade).toMatchObject({ score: 30, maxScore: 60, solvedCount: 2, percent: 50 });
  });

  it('counts a student who tried and failed as attempted', () => {
    // The distinction between "tried and failed" and "never opened it" is the single
    // most useful thing a baseline report tells a mentor.
    const grade = gradeAttempt([
      outcome({ accepted: false, attempts: 4 }),
      outcome({ accepted: false, attempts: 0 }),
    ]);
    expect(grade.attemptedCount).toBe(1);
    expect(grade.solvedCount).toBe(0);
  });

  it('returns zero percent rather than dividing by zero for a test with no points', () => {
    expect(gradeAttempt([]).percent).toBe(0);
  });
});

describe('assessRisk — signals that should fire', () => {
  it('flags an acceptance that lands seconds after the attempt started', () => {
    const assessment = assessRisk({
      outcomes: [outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 20 })],
      medianHistoricalSolveSeconds: null,
    });

    expect(assessment.signals).toContain('IMMEDIATE_ACCEPTANCE');
    expect(assessment.evidence.join(' ')).toMatch(/fastest 20s/);
  });

  it('flags a problem that was already solved before the test opened', () => {
    const assessment = assessRisk({
      outcomes: [
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 300, solvedBeforeTest: true }),
      ],
      medianHistoricalSolveSeconds: null,
    });

    expect(assessment.signals).toContain('SOLVED_BEFORE_TEST');
    expect(assessment.reviewRecommended).toBe(true);
  });

  it('flags several acceptances landing within a couple of minutes of each other', () => {
    const assessment = assessRisk({
      outcomes: [
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 300 }),
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 340 }),
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 380 }),
      ],
      medianHistoricalSolveSeconds: null,
    });

    expect(assessment.signals).toContain('RAPID_SUCCESSION');
  });

  it('flags a pace far below the student’s own recent median', () => {
    const assessment = assessRisk({
      outcomes: [outcome({ accepted: true, attempts: 2, timeToSolveSeconds: 120 })],
      medianHistoricalSolveSeconds: 1800,
    });

    expect(assessment.signals).toContain('INCONSISTENT_WITH_HISTORY');
  });

  it('sums weights into a triage score and recommends review past the threshold', () => {
    const assessment = assessRisk({
      outcomes: [
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 10, solvedBeforeTest: true }),
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 30 }),
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 50 }),
      ],
      medianHistoricalSolveSeconds: null,
    });

    expect(assessment.score).toBeGreaterThanOrEqual(
      BASELINE_RISK_THRESHOLDS.reviewRequiredScore,
    );
    expect(assessment.reviewRecommended).toBe(true);
    // One evidence line per signal, so a mentor never sees a flag without its reason.
    expect(assessment.evidence).toHaveLength(assessment.signals.length);
  });
});

describe('assessRisk — signals that must NOT fire', () => {
  it('says nothing at all about a student who solved nothing', () => {
    // Flagging them would put exactly the people who need help into the review queue.
    const assessment = assessRisk({
      outcomes: [outcome({ accepted: false, attempts: 5 }), outcome({ accepted: false })],
      medianHistoricalSolveSeconds: 600,
    });

    expect(assessment.signals).toEqual([]);
    expect(assessment.score).toBe(0);
    expect(assessment.reviewRecommended).toBe(false);
  });

  it('does not flag a strong student working at a normal pace', () => {
    const assessment = assessRisk({
      outcomes: [
        outcome({ accepted: true, attempts: 2, timeToSolveSeconds: 480 }),
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 1200 }),
        outcome({ accepted: true, attempts: 3, timeToSolveSeconds: 2100 }),
      ],
      medianHistoricalSolveSeconds: 1500,
    });

    expect(assessment.signals).toEqual([]);
    expect(assessment.reviewRecommended).toBe(false);
  });

  it('does not raise NO_FAILED_ATTEMPTS on a short run of clean solves', () => {
    // Two first-try solves is an ordinary morning, not a pattern.
    const assessment = assessRisk({
      outcomes: [
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 900 }),
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 1800 }),
      ],
      medianHistoricalSolveSeconds: null,
    });

    expect(assessment.signals).not.toContain('NO_FAILED_ATTEMPTS');
  });

  it('skips the history comparison entirely when there is no history', () => {
    // Absent history must mean "not evaluated", never "assume the worst".
    const assessment = assessRisk({
      outcomes: [outcome({ accepted: true, attempts: 2, timeToSolveSeconds: 60 })],
      medianHistoricalSolveSeconds: null,
    });

    expect(assessment.signals).not.toContain('INCONSISTENT_WITH_HISTORY');
  });

  it('never produces a signal without evidence to show for it', () => {
    const assessment = assessRisk({
      outcomes: [
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 15 }),
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 45 }),
        outcome({ accepted: true, attempts: 1, timeToSolveSeconds: 70 }),
      ],
      medianHistoricalSolveSeconds: 900,
    });
    expect(assessment.evidence.length).toBe(assessment.signals.length);
    expect(assessment.evidence.every((line) => line.trim().length > 0)).toBe(true);
  });
});

describe('attemptExpiry', () => {
  const started = new Date('2026-08-22T10:00:00Z');

  it('gives the student their full duration when the test stays open', () => {
    expect(attemptExpiry(started, 60, new Date('2026-08-22T23:00:00Z')).toISOString()).toBe(
      '2026-08-22T11:00:00.000Z',
    );
  });

  it('clamps to the test close time for a late starter', () => {
    // Starting ten minutes before close gives ten minutes, not a full hour past it.
    expect(attemptExpiry(started, 60, new Date('2026-08-22T10:10:00Z')).toISOString()).toBe(
      '2026-08-22T10:10:00.000Z',
    );
  });

  it('uses the duration alone when the test has no close time', () => {
    expect(attemptExpiry(started, 30, null).toISOString()).toBe('2026-08-22T10:30:00.000Z');
  });
});

describe('isTestOpen', () => {
  const now = new Date('2026-08-22T10:00:00Z');

  it('is closed unless the test is ACTIVE', () => {
    for (const status of ['DRAFT', 'SCHEDULED', 'CLOSED'] as const) {
      expect(isTestOpen({ status, opensAt: null, closesAt: null }, now)).toBe(false);
    }
  });

  it('is closed before the window opens, even when marked ACTIVE', () => {
    expect(
      isTestOpen(
        { status: 'ACTIVE', opensAt: new Date('2026-08-22T14:00:00Z'), closesAt: null },
        now,
      ),
    ).toBe(false);
  });

  it('is closed after the window passes, even if nobody closed the test', () => {
    expect(
      isTestOpen(
        { status: 'ACTIVE', opensAt: null, closesAt: new Date('2026-08-22T09:00:00Z') },
        now,
      ),
    ).toBe(false);
  });

  it('is open inside the window', () => {
    expect(
      isTestOpen(
        {
          status: 'ACTIVE',
          opensAt: new Date('2026-08-22T09:00:00Z'),
          closesAt: new Date('2026-08-22T18:00:00Z'),
        },
        now,
      ),
    ).toBe(true);
  });
});
