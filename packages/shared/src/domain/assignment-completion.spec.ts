/**
 * Regression suite for the three production defects this module was written to fix:
 *
 *   - assignments published late marked already-solved problems as missed
 *   - re-submitting one problem inflated both the day's count and lifetime "Total Solved"
 *   - non-accepted verdicts were treated as progress
 *
 * Dates use the real Asia/Kolkata program timezone throughout. Several cases pin
 * submissions to times that fall on a *different* UTC day (late evening / just after
 * midnight IST) precisely because that is where naive UTC bucketing goes wrong.
 */

import { describe, expect, it } from 'vitest';

import {
  ASSIGNMENT_LOOKBACK_DAYS,
  assignmentWindow,
  calculateAssignmentCompletion,
  countDistinctSolvedProblems,
  isWithinAssignmentWindow,
  summarizeBucketAttempts,
  summarizeProblemStatuses,
  type AssignedProblemRef,
  type CompletionSubmission,
} from './assignment-completion';

const IST = '+05:30';

/** A submission at a wall-clock time on a program day, as the real UTC instant. */
function submission(
  slug: string,
  status: CompletionSubmission['status'],
  dayKey: string,
  hhmm = '12:00',
  problemId?: string,
): CompletionSubmission {
  return {
    problemId: problemId ?? null,
    titleSlug: slug,
    status,
    submittedAt: new Date(`${dayKey}T${hhmm}:00.000${IST}`),
    dayKey,
    language: 'python3',
  };
}

/** The assignment from the bug report: problems 167, 283, 11 and 26. */
const ASSIGNED: AssignedProblemRef[] = [
  { problemId: 'p167', titleSlug: 'two-sum-ii-input-array-is-sorted', position: 1 },
  { problemId: 'p283', titleSlug: 'move-zeroes', position: 2 },
  { problemId: 'p11', titleSlug: 'container-with-most-water', position: 3 },
  { problemId: 'p26', titleSlug: 'remove-duplicates-from-sorted-array', position: 4 },
];

const ONE: AssignedProblemRef[] = [
  { problemId: 'p167', titleSlug: 'two-sum-ii-input-array-is-sorted', position: 1 },
];

function solvedOn(dayKey: string, submissions: CompletionSubmission[], assigned = ONE): number {
  return calculateAssignmentCompletion(dayKey, assigned, submissions).solvedCount;
}

describe('the lookback window', () => {
  it('spans D-2 through D inclusive', () => {
    expect(assignmentWindow('2026-08-10')).toEqual({
      startDayKey: '2026-08-08',
      endDayKey: '2026-08-10',
    });
  });

  it('defaults to a 2-day lookback', () => {
    expect(ASSIGNMENT_LOOKBACK_DAYS).toBe(2);
  });

  it('crosses a month boundary correctly', () => {
    expect(assignmentWindow('2026-09-01').startDayKey).toBe('2026-08-30');
  });

  it('accepts the boundary days and rejects the day before the window', () => {
    expect(isWithinAssignmentWindow('2026-08-08', '2026-08-10')).toBe(true);
    expect(isWithinAssignmentWindow('2026-08-10', '2026-08-10')).toBe(true);
    expect(isWithinAssignmentWindow('2026-08-07', '2026-08-10')).toBe(false);
    // Later than the assignment day: a future solve is not retroactive credit.
    expect(isWithinAssignmentWindow('2026-08-11', '2026-08-10')).toBe(false);
  });
});

describe('TEST 1-4 — how far back a solve still counts', () => {
  it('TEST 1: assignment 10 Aug, solved 10 Aug -> completed', () => {
    expect(
      solvedOn('2026-08-10', [
        submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-10'),
      ]),
    ).toBe(1);
  });

  it('TEST 2: assignment 10 Aug, solved 9 Aug -> completed', () => {
    expect(
      solvedOn('2026-08-10', [
        submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-09'),
      ]),
    ).toBe(1);
  });

  it('TEST 3: assignment 10 Aug, solved 8 Aug -> completed', () => {
    expect(
      solvedOn('2026-08-10', [
        submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-08'),
      ]),
    ).toBe(1);
  });

  it('TEST 4: assignment 10 Aug, solved 7 Aug -> NOT completed', () => {
    expect(
      solvedOn('2026-08-10', [
        submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-07'),
      ]),
    ).toBe(0);
  });

  it('counts a solve at 23:50 IST on 8 Aug, which is still 8 Aug locally but 18:20 UTC', () => {
    const late = submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-08', '23:50');
    expect(late.submittedAt.toISOString()).toBe('2026-08-08T18:20:00.000Z');
    expect(solvedOn('2026-08-10', [late])).toBe(1);
  });

  it('excludes a solve at 00:10 IST on 8 Aug when the window opens on 9 Aug', () => {
    // 00:10 IST on 8 Aug is 18:40 UTC on 7 Aug — a UTC-based window would wrongly
    // place this outside 8 Aug, or wrongly include it for an 11 Aug assignment.
    const justAfterMidnight = submission(
      'two-sum-ii-input-array-is-sorted',
      'ACCEPTED',
      '2026-08-08',
      '00:10',
    );
    expect(justAfterMidnight.submittedAt.toISOString()).toBe('2026-08-07T18:40:00.000Z');
    expect(solvedOn('2026-08-10', [justAfterMidnight])).toBe(1);
    expect(solvedOn('2026-08-11', [justAfterMidnight])).toBe(0);
  });
});

describe('TEST 5 — only accepted verdicts count', () => {
  it('a Wrong Answer on 9 Aug is not a completion', () => {
    const result = calculateAssignmentCompletion('2026-08-10', ONE, [
      submission('two-sum-ii-input-array-is-sorted', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-09'),
    ]);
    expect(result.solvedCount).toBe(0);
    expect(result.problems[0]!.status).toBe('ATTEMPTED_NOT_ACCEPTED');
    // It is still recorded as an attempt — "tried and failed" is not "did nothing".
    expect(result.problems[0]!.attempts).toBe(1);
  });

  it('a failed attempt followed by an accepted one does count', () => {
    expect(
      solvedOn('2026-08-10', [
        submission('two-sum-ii-input-array-is-sorted', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-09'),
        submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-10'),
      ]),
    ).toBe(1);
  });

  it('neither UNKNOWN nor NOT_ATTEMPTED counts', () => {
    expect(
      solvedOn('2026-08-10', [
        submission('two-sum-ii-input-array-is-sorted', 'UNKNOWN', '2026-08-10'),
        submission('two-sum-ii-input-array-is-sorted', 'NOT_ATTEMPTED', '2026-08-10'),
      ]),
    ).toBe(0);
  });
});

describe('TEST 6 — the same problem counts once', () => {
  it('five accepted submissions for one problem is one solve', () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-10', `1${i}:00`),
    );
    const result = calculateAssignmentCompletion('2026-08-10', ONE, five);
    expect(result.solvedCount).toBe(1);
    expect(result.problems[0]!.attempts).toBe(5);
  });

  it('keeps the earliest accepted time, not the latest', () => {
    const result = calculateAssignmentCompletion('2026-08-10', ONE, [
      submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-10', '18:00'),
      submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-10', '09:00'),
    ]);
    expect(result.problems[0]!.solvedAt?.toISOString()).toBe('2026-08-10T03:30:00.000Z'); // 09:00 IST
  });

  it('does not let a duplicate of one problem stand in for another', () => {
    const result = calculateAssignmentCompletion('2026-08-10', ASSIGNED, [
      submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-10'),
      submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-10', '13:00'),
      submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-10', '14:00'),
    ]);
    expect(result.solvedCount).toBe(1);
  });
});

describe('the worked example from the bug report', () => {
  // 167 accepted 8 Aug, 283 accepted 10 Aug, 11 wrong answer 9 Aug, 26 accepted 5 Aug.
  const submissions = [
    submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-08', '14:20'),
    submission('move-zeroes', 'ACCEPTED', '2026-08-10', '10:05'),
    submission('container-with-most-water', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-09', '17:40'),
    submission('remove-duplicates-from-sorted-array', 'ACCEPTED', '2026-08-05', '11:00'),
  ];

  const result = calculateAssignmentCompletion('2026-08-10', ASSIGNED, submissions);

  it('scores 2 of 4', () => {
    expect(result.solvedCount).toBe(2);
    expect(result.assignedCount).toBe(4);
    expect(result.isComplete).toBe(false);
  });

  it('167 is completed from a solve two days earlier', () => {
    const p = result.problems.find((x) => x.problemId === 'p167')!;
    expect(p.status).toBe('ACCEPTED');
    expect(p.solvedOnDayKey).toBe('2026-08-08');
  });

  it('283 is completed on the day itself', () => {
    expect(result.problems.find((x) => x.problemId === 'p283')!.status).toBe('ACCEPTED');
  });

  it('11 is not completed — wrong answer', () => {
    expect(result.problems.find((x) => x.problemId === 'p11')!.status).toBe(
      'ATTEMPTED_NOT_ACCEPTED',
    );
  });

  it('26 is not completed — solved 5 Aug, outside the window', () => {
    const p = result.problems.find((x) => x.problemId === 'p26')!;
    expect(p.status).toBe('NOT_ATTEMPTED');
    expect(p.attempts).toBe(0);
  });

  it('reports no completedAt, because the day was not fully cleared', () => {
    expect(result.completedAt).toBeNull();
  });
});

describe('problem identity', () => {
  it('matches on problem id even when the slug was renamed on LeetCode', () => {
    const result = calculateAssignmentCompletion('2026-08-10', ONE, [
      submission('two-sum-ii-renamed-upstream', 'ACCEPTED', '2026-08-10', '12:00', 'p167'),
    ]);
    expect(result.solvedCount).toBe(1);
  });

  it('matches on slug when the submission was never linked to a tracked problem', () => {
    expect(
      solvedOn('2026-08-10', [
        submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-10'),
      ]),
    ).toBe(1);
  });

  it('is case-insensitive about slugs', () => {
    expect(
      solvedOn('2026-08-10', [
        submission('Two-Sum-II-Input-Array-Is-Sorted', 'ACCEPTED', '2026-08-10'),
      ]),
    ).toBe(1);
  });

  it('ignores problems that were not assigned', () => {
    const result = calculateAssignmentCompletion('2026-08-10', ONE, [
      submission('some-other-problem', 'ACCEPTED', '2026-08-10'),
    ]);
    expect(result.solvedCount).toBe(0);
  });
});

describe('full completion', () => {
  it('marks the day complete and timestamps it with the last problem finished', () => {
    const result = calculateAssignmentCompletion('2026-08-10', ASSIGNED, [
      submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-08', '10:00'),
      submission('move-zeroes', 'ACCEPTED', '2026-08-09', '11:00'),
      submission('container-with-most-water', 'ACCEPTED', '2026-08-10', '09:00'),
      submission('remove-duplicates-from-sorted-array', 'ACCEPTED', '2026-08-10', '16:45'),
    ]);
    expect(result.solvedCount).toBe(4);
    expect(result.isComplete).toBe(true);
    expect(result.completedAt?.toISOString()).toBe('2026-08-10T11:15:00.000Z'); // 16:45 IST
  });

  it('returns an all-unattempted shape when there are no submissions at all', () => {
    const result = calculateAssignmentCompletion('2026-08-10', ASSIGNED, []);
    expect(result.solvedCount).toBe(0);
    expect(result.problems).toHaveLength(4);
    expect(result.problems.every((p) => p.status === 'NOT_ATTEMPTED')).toBe(true);
    expect(result.firstSolvedAt).toBeNull();
  });

  it('handles an empty assignment without claiming completion', () => {
    const result = calculateAssignmentCompletion('2026-08-10', [], []);
    expect(result.assignedCount).toBe(0);
    expect(result.isComplete).toBe(false);
  });
});

describe('summarizeProblemStatuses — solved / attempted-not-solved / not-attempted', () => {
  it('SOLVED: an accepted submission classifies the problem as solved', () => {
    const result = calculateAssignmentCompletion('2026-08-10', ONE, [
      submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-10'),
    ]);
    expect(summarizeProblemStatuses(result.problems)).toEqual({
      solvedCount: 1,
      attemptedNotSolvedCount: 0,
      notAttemptedCount: 0,
    });
  });

  it('ATTEMPTED_NOT_SOLVED: one failed submission and nothing else', () => {
    const result = calculateAssignmentCompletion('2026-08-10', ONE, [
      submission('two-sum-ii-input-array-is-sorted', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-10'),
    ]);
    expect(summarizeProblemStatuses(result.problems)).toEqual({
      solvedCount: 0,
      attemptedNotSolvedCount: 1,
      notAttemptedCount: 0,
    });
  });

  it('ATTEMPTED_NOT_SOLVED: several failed submissions for the same problem still count as one attempted-not-solved problem', () => {
    const result = calculateAssignmentCompletion('2026-08-10', ONE, [
      submission('two-sum-ii-input-array-is-sorted', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-10', '09:00'),
      submission('two-sum-ii-input-array-is-sorted', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-10', '10:00'),
      submission('two-sum-ii-input-array-is-sorted', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-10', '11:00'),
    ]);
    expect(summarizeProblemStatuses(result.problems)).toEqual({
      solvedCount: 0,
      attemptedNotSolvedCount: 1,
      notAttemptedCount: 0,
    });
    expect(result.problems[0]!.attempts).toBe(3);
  });

  it('SOLVED: failed submissions followed by an accepted one resolve to solved, not attempted', () => {
    const result = calculateAssignmentCompletion('2026-08-10', ONE, [
      submission('two-sum-ii-input-array-is-sorted', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-09'),
      submission('two-sum-ii-input-array-is-sorted', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-09', '15:00'),
      submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-10'),
    ]);
    expect(summarizeProblemStatuses(result.problems)).toEqual({
      solvedCount: 1,
      attemptedNotSolvedCount: 0,
      notAttemptedCount: 0,
    });
  });

  it('NOT_ATTEMPTED: no submission at all is never inferred as an attempt', () => {
    const result = calculateAssignmentCompletion('2026-08-10', ONE, []);
    expect(summarizeProblemStatuses(result.problems)).toEqual({
      solvedCount: 0,
      attemptedNotSolvedCount: 0,
      notAttemptedCount: 1,
    });
  });

  it('mixed 4-question assignment: partitions solved/attempted/not-attempted, summing to assignedCount', () => {
    // 167 solved, 283 solved, 11 wrong answer, 26 never touched.
    const submissions = [
      submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-08', '14:20'),
      submission('move-zeroes', 'ACCEPTED', '2026-08-10', '10:05'),
      submission('container-with-most-water', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-09', '17:40'),
    ];
    const result = calculateAssignmentCompletion('2026-08-10', ASSIGNED, submissions);
    const counts = summarizeProblemStatuses(result.problems);
    expect(counts).toEqual({ solvedCount: 2, attemptedNotSolvedCount: 1, notAttemptedCount: 1 });
    expect(counts.solvedCount + counts.attemptedNotSolvedCount + counts.notAttemptedCount).toBe(
      result.assignedCount,
    );
  });

  it('historical assignment: a late-published day still classifies correctly from submissions inside the lookback window', () => {
    // Assignment published for 10 Aug but the student worked on 8-9 Aug, before it went
    // live — the lookback window (§ the lookback window) is what makes this "attempted"
    // and "solved" readable instead of everything showing as not-attempted.
    const result = calculateAssignmentCompletion('2026-08-10', ASSIGNED, [
      submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-08'),
      submission('move-zeroes', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-09'),
      submission('move-zeroes', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-09', '16:00'),
    ]);
    const counts = summarizeProblemStatuses(result.problems);
    expect(counts).toEqual({ solvedCount: 1, attemptedNotSolvedCount: 1, notAttemptedCount: 2 });
  });
});

describe('summarizeBucketAttempts — did students attempt and fail, or never try', () => {
  it('splits students who touched a remaining problem from those who never submitted anything', () => {
    const counts = summarizeBucketAttempts([
      { attemptedNotSolvedCount: 1, notAttemptedCount: 0 }, // tried and failed
      { attemptedNotSolvedCount: 0, notAttemptedCount: 1 }, // never touched it
      { attemptedNotSolvedCount: 2, notAttemptedCount: 1 }, // tried some, ignored the rest — counts as "attempted"
    ]);
    expect(counts).toEqual({ studentsAttemptedCount: 2, studentsNotAttemptedCount: 1 });
  });

  it('excludes a student with nothing remaining from both sides', () => {
    const counts = summarizeBucketAttempts([{ attemptedNotSolvedCount: 0, notAttemptedCount: 0 }]);
    expect(counts).toEqual({ studentsAttemptedCount: 0, studentsNotAttemptedCount: 0 });
  });
});

describe('TEST 11 — lifetime distinct solved', () => {
  it('counts one problem solved ten times as 1', () => {
    const ten = Array.from({ length: 10 }, (_, i) =>
      submission('two-sum', 'ACCEPTED', '2026-08-10', `0${i % 10}:00`),
    );
    expect(countDistinctSolvedProblems(ten)).toBe(1);
  });

  it('counts three distinct problems as 3', () => {
    expect(
      countDistinctSolvedProblems([
        submission('two-sum-ii-input-array-is-sorted', 'ACCEPTED', '2026-08-10'),
        submission('move-zeroes', 'ACCEPTED', '2026-08-10'),
        submission('container-with-most-water', 'ACCEPTED', '2026-08-10'),
      ]),
    ).toBe(3);
  });

  it('ignores problems that were only ever attempted', () => {
    expect(
      countDistinctSolvedProblems([
        submission('two-sum', 'ACCEPTED', '2026-08-10'),
        submission('never-solved', 'ATTEMPTED_NOT_ACCEPTED', '2026-08-10'),
      ]),
    ).toBe(1);
  });

  it('is not confused by slug casing', () => {
    expect(
      countDistinctSolvedProblems([
        submission('Two-Sum', 'ACCEPTED', '2026-08-10'),
        submission('two-sum', 'ACCEPTED', '2026-08-10'),
      ]),
    ).toBe(1);
  });

  it('counts across all of history, not just the assignment window', () => {
    expect(
      countDistinctSolvedProblems([
        submission('problem-a', 'ACCEPTED', '2024-01-01'),
        submission('problem-b', 'ACCEPTED', '2026-08-10'),
      ]),
    ).toBe(2);
  });
});
