import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from './scoring';
import { computeStreaks, flameTier, type StreakDay } from './streak';

/** Build a run of consecutive assigned days from a solved-count pattern. */
function days(startDay: string, solved: number[], assigned = 4): StreakDay[] {
  const [y, m, d] = startDay.split('-').map(Number);
  return solved.map((solvedCount, i) => {
    const date = new Date(Date.UTC(y!, m! - 1, d! + i));
    const dayKey = date.toISOString().slice(0, 10);
    return { dayKey, solvedCount, assignedCount: assigned };
  });
}

const LENIENT: ScoringConfig = {
  ...DEFAULT_SCORING_CONFIG,
  streakQualification: 'AT_LEAST_ONE',
};

describe('computeStreaks — current streak', () => {
  it('counts an unbroken run ending today', () => {
    const result = computeStreaks(days('2026-08-01', [4, 4, 4, 4]), '2026-08-04');
    expect(result.current).toBe(4);
    expect(result.longest).toBe(4);
    expect(result.currentStartedOn).toBe('2026-08-01');
  });

  it('resets after a missed day', () => {
    const result = computeStreaks(days('2026-08-01', [4, 4, 0, 4, 4]), '2026-08-05');
    expect(result.current).toBe(2);
    expect(result.longest).toBe(2);
    expect(result.brokenOn).toBe('2026-08-03');
  });

  it('treats today as in progress rather than as a break', () => {
    // Solved on the 1st-3rd, nothing yet today. The streak is 3, not 0 — the day
    // is not over and the student has not failed anything yet.
    const result = computeStreaks(days('2026-08-01', [4, 4, 4, 0]), '2026-08-04');
    expect(result.current).toBe(3);
  });

  it('includes today once it qualifies', () => {
    const result = computeStreaks(days('2026-08-01', [4, 4, 4, 4]), '2026-08-04');
    expect(result.current).toBe(4);
  });

  it('reports a broken streak as 0 once the missed day is in the past', () => {
    const result = computeStreaks(days('2026-08-01', [4, 4, 4, 0, 0]), '2026-08-05');
    // The 4th is a concluded failure, so nothing is running.
    expect(result.current).toBe(0);
    expect(result.currentStartedOn).toBeNull();
    expect(result.longest).toBe(3);
  });

  it('ignores days after the reference day', () => {
    const result = computeStreaks(days('2026-08-01', [4, 4, 4, 4, 4]), '2026-08-03');
    expect(result.current).toBe(3);
  });
});

describe('computeStreaks — non-assignment days are neutral', () => {
  it('does not break a streak on a day with no assignment', () => {
    // Mentors skipped the 3rd entirely. Nobody should lose a streak for that.
    const input: StreakDay[] = [
      { dayKey: '2026-08-01', solvedCount: 4, assignedCount: 4 },
      { dayKey: '2026-08-02', solvedCount: 4, assignedCount: 4 },
      { dayKey: '2026-08-03', solvedCount: 0, assignedCount: 0 },
      { dayKey: '2026-08-04', solvedCount: 4, assignedCount: 4 },
    ];
    const result = computeStreaks(input, '2026-08-04');
    expect(result.current).toBe(3);
    expect(result.brokenOn).toBeNull();
  });

  it('returns an empty result when nothing was ever assigned', () => {
    const result = computeStreaks(
      [{ dayKey: '2026-08-01', solvedCount: 0, assignedCount: 0 }],
      '2026-08-01',
    );
    expect(result.current).toBe(0);
    expect(result.longest).toBe(0);
  });

  it('handles an empty history', () => {
    expect(computeStreaks([], '2026-08-04').current).toBe(0);
  });
});

describe('computeStreaks — qualification mode', () => {
  it('requires the whole assignment by default', () => {
    const result = computeStreaks(days('2026-08-01', [3, 3, 3]), '2026-08-03');
    expect(result.current).toBe(0);
  });

  it('accepts partial completion under AT_LEAST_ONE', () => {
    const result = computeStreaks(days('2026-08-01', [3, 1, 2]), '2026-08-03', LENIENT);
    expect(result.current).toBe(3);
  });

  it('adapts the bar to short assignment days', () => {
    const input: StreakDay[] = [
      { dayKey: '2026-08-01', solvedCount: 4, assignedCount: 4 },
      { dayKey: '2026-08-02', solvedCount: 2, assignedCount: 2 },
    ];
    expect(computeStreaks(input, '2026-08-02').current).toBe(2);
  });
});

describe('computeStreaks — longest', () => {
  it('finds the best historical run even when the current one is shorter', () => {
    const result = computeStreaks(
      days('2026-08-01', [4, 4, 4, 4, 4, 0, 4, 4]),
      '2026-08-08',
    );
    expect(result.longest).toBe(5);
    expect(result.current).toBe(2);
  });

  it('tolerates unsorted input', () => {
    const shuffled = [...days('2026-08-01', [4, 4, 4])].reverse();
    expect(computeStreaks(shuffled, '2026-08-03').current).toBe(3);
  });

  it('counts total qualifying days', () => {
    const result = computeStreaks(days('2026-08-01', [4, 0, 4, 4, 0]), '2026-08-05');
    expect(result.totalQualifyingDays).toBe(3);
  });
});

describe('computeStreaks — weekly and monthly', () => {
  it('counts consecutive weeks containing a qualifying day', () => {
    // 2026-07-20 (Mon, W30), 2026-07-27 (Mon, W31), 2026-08-03 (Mon, W32).
    const input: StreakDay[] = [
      { dayKey: '2026-07-20', solvedCount: 4, assignedCount: 4 },
      { dayKey: '2026-07-27', solvedCount: 4, assignedCount: 4 },
      { dayKey: '2026-08-03', solvedCount: 4, assignedCount: 4 },
    ];
    expect(computeStreaks(input, '2026-08-04').weekly).toBe(3);
  });

  it('breaks the weekly streak on a fully missed week', () => {
    const input: StreakDay[] = [
      { dayKey: '2026-07-20', solvedCount: 4, assignedCount: 4 },
      { dayKey: '2026-07-27', solvedCount: 0, assignedCount: 4 },
      { dayKey: '2026-08-03', solvedCount: 4, assignedCount: 4 },
    ];
    expect(computeStreaks(input, '2026-08-04').weekly).toBe(1);
  });

  it('counts consecutive months', () => {
    const input: StreakDay[] = [
      { dayKey: '2026-06-10', solvedCount: 4, assignedCount: 4 },
      { dayKey: '2026-07-10', solvedCount: 4, assignedCount: 4 },
      { dayKey: '2026-08-01', solvedCount: 4, assignedCount: 4 },
    ];
    expect(computeStreaks(input, '2026-08-04').monthly).toBe(3);
  });
});

describe('flameTier', () => {
  it('maps streak lengths to visual tiers', () => {
    expect(flameTier(0)).toBe('none');
    expect(flameTier(1)).toBe('spark');
    expect(flameTier(5)).toBe('flame');
    expect(flameTier(10)).toBe('blaze');
    expect(flameTier(20)).toBe('inferno');
    expect(flameTier(45)).toBe('legendary');
  });
});
