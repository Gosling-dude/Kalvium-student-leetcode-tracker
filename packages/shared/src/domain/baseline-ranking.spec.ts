/**
 * Baseline ranking — the board a mentor reads down when deciding who to talk to.
 *
 * Two properties carry the weight:
 *
 *  - Competition ranking. Tied students share a rank and the next distinct student skips
 *    ahead, so "rank 3" always means "two students did better", never "this is the third
 *    row".
 *  - A student who did not sit the test never outranks one who did. Both may score 0, and
 *    the arithmetic alone would let the absent student win on the name tiebreak.
 */

import { describe, expect, it } from 'vitest';

import {
  baselinePercent,
  compareBaselineEntries,
  rankBaselineEntries,
  type BaselineRankableEntry,
} from './baseline';

function entry(over: Partial<BaselineRankableEntry> & { studentId: string }): BaselineRankableEntry {
  return {
    studentName: over.studentId,
    solvedCount: 0,
    score: 0,
    timeTakenSeconds: null,
    performanceKnown: true,
    ...over,
  };
}

describe('rankBaselineEntries', () => {
  it('orders by score, highest first', () => {
    const ranked = rankBaselineEntries([
      entry({ studentId: 'ravi', score: 12, solvedCount: 12 }),
      entry({ studentId: 'rahul', score: 18, solvedCount: 18 }),
      entry({ studentId: 'aman', score: 16, solvedCount: 16 }),
    ]);

    expect(ranked.map((r) => r.entry.studentId)).toEqual(['rahul', 'aman', 'ravi']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('shares a rank on a genuine tie and skips the next one (1,2,2,4)', () => {
    const ranked = rankBaselineEntries([
      entry({ studentId: 'a', score: 20, solvedCount: 20 }),
      entry({ studentId: 'b', score: 15, solvedCount: 15 }),
      entry({ studentId: 'c', score: 15, solvedCount: 15 }),
      entry({ studentId: 'd', score: 10, solvedCount: 10 }),
    ]);

    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 2, 4]);
    expect(ranked.map((r) => r.isTied)).toEqual([false, true, true, false]);
  });

  it('breaks an equal score by problems solved', () => {
    // Same points from fewer, harder problems is not the same performance as more easy
    // ones — but when the points are equal, raw output is the next signal.
    const ranked = rankBaselineEntries([
      entry({ studentId: 'fewer', score: 10, solvedCount: 2 }),
      entry({ studentId: 'more', score: 10, solvedCount: 5 }),
    ]);

    expect(ranked.map((r) => r.entry.studentId)).toEqual(['more', 'fewer']);
  });

  it('breaks an equal score and count by time, fastest first', () => {
    const ranked = rankBaselineEntries([
      entry({ studentId: 'slow', score: 10, solvedCount: 5, timeTakenSeconds: 3000 }),
      entry({ studentId: 'fast', score: 10, solvedCount: 5, timeTakenSeconds: 900 }),
    ]);

    expect(ranked.map((r) => r.entry.studentId)).toEqual(['fast', 'slow']);
    expect(ranked.map((r) => r.isTied)).toEqual([false, false]);
  });

  it('sorts an unrecorded time last rather than first', () => {
    const ranked = rankBaselineEntries([
      entry({ studentId: 'notime', score: 10, solvedCount: 5, timeTakenSeconds: null }),
      entry({ studentId: 'timed', score: 10, solvedCount: 5, timeTakenSeconds: 4000 }),
    ]);

    expect(ranked.map((r) => r.entry.studentId)).toEqual(['timed', 'notime']);
  });

  it('ranks an absent student on what they can actually solve', () => {
    // The rule that changed, and the reason it changed: attendance is not performance. A
    // student who solved three of the four problems last fortnight and never opened the
    // test outranks one who sat it and solved none. Both facts are reported — in separate
    // columns — and neither is allowed to overwrite the other.
    const ranked = rankBaselineEntries([
      entry({ studentId: 'sat-solved-none', studentName: 'Ravi', solvedCount: 0, score: 0 }),
      entry({ studentId: 'absent-solved-three', studentName: 'Aman', solvedCount: 3, score: 3 }),
    ]);

    expect(ranked.map((r) => r.entry.studentId)).toEqual([
      'absent-solved-three',
      'sat-solved-none',
    ]);
  });

  it('never ranks an unmeasured student above a measured one', () => {
    // Both show 0. But one has never synced successfully, so their 0 is an absence of
    // evidence rather than a score — and must not be placed above someone we did measure.
    const ranked = rankBaselineEntries([
      entry({ studentId: 'unmeasured', studentName: 'Aaron', performanceKnown: false }),
      entry({ studentId: 'measured', studentName: 'Zoya', performanceKnown: true }),
    ]);

    expect(ranked.map((r) => r.entry.studentId)).toEqual(['measured', 'unmeasured']);
  });

  it('keeps absent students on the board', () => {
    // A leaderboard built only from attempt rows shrinks the denominator and makes a test
    // half the cohort skipped look like a test everybody took.
    const ranked = rankBaselineEntries([
      entry({ studentId: 'sat', score: 5, solvedCount: 5 }),
      entry({ studentId: 'absent-1', performanceKnown: false }),
      entry({ studentId: 'absent-2', performanceKnown: false }),
    ]);

    expect(ranked).toHaveLength(3);
  });

  it('is deterministic for identical performances', () => {
    const build = (): BaselineRankableEntry[] => [
      entry({ studentId: 'b', studentName: 'Bea', score: 5, solvedCount: 5 }),
      entry({ studentId: 'a', studentName: 'Ada', score: 5, solvedCount: 5 }),
    ];

    const first = rankBaselineEntries(build()).map((r) => r.entry.studentId);
    const second = rankBaselineEntries(build()).map((r) => r.entry.studentId);

    expect(first).toEqual(second);
    expect(first).toEqual(['a', 'b']); // name, then id — never insertion order
  });

  it('ranks an empty board without throwing', () => {
    expect(rankBaselineEntries([])).toEqual([]);
  });

  it('has a total comparator — no pair ever compares equal unless it is the same student', () => {
    const entries = [
      entry({ studentId: 'a', score: 5, solvedCount: 5 }),
      entry({ studentId: 'b', score: 5, solvedCount: 5 }),
      entry({ studentId: 'c', score: 0, performanceKnown: false }),
    ];
    for (const x of entries) {
      for (const y of entries) {
        if (x.studentId === y.studentId) continue;
        expect(compareBaselineEntries(x, y)).not.toBe(0);
      }
    }
  });
});

describe('baselinePercent', () => {
  it('rounds to a whole percentage', () => {
    expect(baselinePercent(18, 20)).toBe(90);
    expect(baselinePercent(15, 20)).toBe(75);
    expect(baselinePercent(1, 3)).toBe(33);
  });

  it('is 0 rather than NaN for a test carrying no points', () => {
    expect(baselinePercent(0, 0)).toBe(0);
  });

  it('is 0 for a student who solved nothing', () => {
    expect(baselinePercent(0, 20)).toBe(0);
  });
});
