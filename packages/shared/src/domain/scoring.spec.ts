import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCORING_CONFIG,
  completionPercentage,
  computeDailyScore,
  computeMonthlyBonus,
  computeWeeklyBonus,
  requiredSolvedForStreak,
  type ScoringConfig,
} from './scoring';

/** Config with every bonus disabled, isolating base points. */
const BARE: ScoringConfig = {
  ...DEFAULT_SCORING_CONFIG,
  difficultyBonus: { EASY: 0, MEDIUM: 0, HARD: 0 },
  earlyCompletion: [],
  streakPointsPerDay: 0,
  perfectDayBonus: 0,
};

describe('computeDailyScore — the spec\'s canonical table', () => {
  it.each([
    [4, 100],
    [3, 75],
    [2, 50],
    [1, 25],
    [0, 0],
  ])('awards %i solved => %i points', (solved, expected) => {
    const result = computeDailyScore(
      {
        solvedCount: solved,
        assignedCount: 4,
        completionMinuteOfDay: null,
        solvedDifficulties: [],
        streakLength: 0,
      },
      BARE,
    );
    expect(result.total).toBe(expected);
  });

  it('never credits more than the number assigned', () => {
    const result = computeDailyScore(
      {
        solvedCount: 9,
        assignedCount: 4,
        completionMinuteOfDay: null,
        solvedDifficulties: [],
        streakLength: 0,
      },
      BARE,
    );
    expect(result.total).toBe(100);
  });

  it('clamps negative solved counts to zero', () => {
    const result = computeDailyScore(
      {
        solvedCount: -3,
        assignedCount: 4,
        completionMinuteOfDay: null,
        solvedDifficulties: [],
        streakLength: 0,
      },
      BARE,
    );
    expect(result.total).toBe(0);
  });
});

describe('early completion bonus', () => {
  it('grants the most demanding tier the student qualifies for', () => {
    const at0800 = computeDailyScore(
      {
        solvedCount: 4,
        assignedCount: 4,
        completionMinuteOfDay: 8 * 60,
        solvedDifficulties: [],
        streakLength: 0,
      },
      { ...BARE, earlyCompletion: DEFAULT_SCORING_CONFIG.earlyCompletion },
    );
    // 100 base + 20 (before 09:00) — not 20+12+5 stacked.
    expect(at0800.total).toBe(120);
    expect(at0800.components.filter((c) => c.key === 'early_completion')).toHaveLength(1);
  });

  it('falls through to a lower tier later in the day', () => {
    const at1300 = computeDailyScore(
      {
        solvedCount: 4,
        assignedCount: 4,
        completionMinuteOfDay: 13 * 60,
        solvedDifficulties: [],
        streakLength: 0,
      },
      { ...BARE, earlyCompletion: DEFAULT_SCORING_CONFIG.earlyCompletion },
    );
    expect(at1300.total).toBe(105);
  });

  it('is withheld when the day was not fully completed', () => {
    // Finishing one easy problem at 06:00 is not an "early finish".
    const partial = computeDailyScore(
      {
        solvedCount: 1,
        assignedCount: 4,
        completionMinuteOfDay: 6 * 60,
        solvedDifficulties: ['EASY'],
        streakLength: 0,
      },
      { ...BARE, earlyCompletion: DEFAULT_SCORING_CONFIG.earlyCompletion },
    );
    expect(partial.components.some((c) => c.key === 'early_completion')).toBe(false);
    expect(partial.total).toBe(25);
  });
});

describe('difficulty and streak bonuses', () => {
  it('adds a per-problem difficulty weighting', () => {
    const result = computeDailyScore(
      {
        solvedCount: 3,
        assignedCount: 4,
        completionMinuteOfDay: null,
        solvedDifficulties: ['EASY', 'MEDIUM', 'HARD'],
        streakLength: 0,
      },
      { ...BARE, difficultyBonus: { EASY: 0, MEDIUM: 2, HARD: 5 } },
    );
    expect(result.total).toBe(75 + 0 + 2 + 5);
  });

  it('caps the streak bonus', () => {
    const result = computeDailyScore(
      {
        solvedCount: 4,
        assignedCount: 4,
        completionMinuteOfDay: null,
        solvedDifficulties: [],
        streakLength: 100,
      },
      { ...BARE, streakPointsPerDay: 2, streakBonusCap: 30 },
    );
    expect(result.total).toBe(130);
  });

  it('withholds the streak bonus on a zero day', () => {
    const result = computeDailyScore(
      {
        solvedCount: 0,
        assignedCount: 4,
        completionMinuteOfDay: null,
        solvedDifficulties: [],
        streakLength: 12,
      },
      { ...BARE, streakPointsPerDay: 2, streakBonusCap: 30 },
    );
    expect(result.total).toBe(0);
  });
});

describe('score breakdown', () => {
  it('reports components that sum to the total', () => {
    const result = computeDailyScore(
      {
        solvedCount: 4,
        assignedCount: 4,
        completionMinuteOfDay: 7 * 60,
        solvedDifficulties: ['EASY', 'MEDIUM', 'MEDIUM', 'HARD'],
        streakLength: 5,
      },
      DEFAULT_SCORING_CONFIG,
    );
    const sum = result.components.reduce((n, c) => n + c.points, 0);
    expect(sum).toBe(result.total);
    expect(result.base + result.bonus).toBe(result.total);
    expect(result.isPerfectDay).toBe(true);
  });
});

describe('period bonuses', () => {
  it('awards the perfect-week bonus instead of, not on top of, a consistency tier', () => {
    const result = computeWeeklyBonus({ assignedDays: 5, qualifyingDays: 5 });
    expect(result.total).toBe(DEFAULT_SCORING_CONFIG.perfectWeekBonus);
    expect(result.components).toHaveLength(1);
  });

  it('awards a consistency tier for a strong but imperfect week', () => {
    const result = computeWeeklyBonus({ assignedDays: 7, qualifyingDays: 5 });
    expect(result.total).toBe(40);
  });

  it('awards nothing for a week below every tier', () => {
    expect(computeWeeklyBonus({ assignedDays: 7, qualifyingDays: 2 }).total).toBe(0);
  });

  it('does not hand out free points for a week with no assignments', () => {
    // Vacuously "perfect" — a holiday week must not pay out.
    expect(computeWeeklyBonus({ assignedDays: 0, qualifyingDays: 0 }).total).toBe(0);
  });

  it('awards the perfect-month bonus', () => {
    expect(computeMonthlyBonus({ assignedDays: 22, qualifyingDays: 22 }).total).toBe(
      DEFAULT_SCORING_CONFIG.perfectMonthBonus,
    );
  });
});

describe('requiredSolvedForStreak', () => {
  it('defaults to requiring the whole assignment', () => {
    expect(requiredSolvedForStreak(4, DEFAULT_SCORING_CONFIG)).toBe(4);
  });

  it('honours AT_LEAST_ONE', () => {
    expect(
      requiredSolvedForStreak(4, { ...DEFAULT_SCORING_CONFIG, streakQualification: 'AT_LEAST_ONE' }),
    ).toBe(1);
  });

  it('never demands more than were assigned', () => {
    // A 2-problem day must remain completable under a CUSTOM bar of 4.
    expect(
      requiredSolvedForStreak(2, {
        ...DEFAULT_SCORING_CONFIG,
        streakQualification: 'CUSTOM',
        streakCustomMinSolved: 4,
      }),
    ).toBe(2);
  });
});

describe('completionPercentage', () => {
  it('computes percentages to two decimal places', () => {
    expect(completionPercentage(3, 4)).toBe(75);
    expect(completionPercentage(1, 3)).toBe(33.33);
  });

  it('returns 0 rather than NaN when nothing was assigned', () => {
    expect(completionPercentage(0, 0)).toBe(0);
  });

  it('caps at 100', () => {
    expect(completionPercentage(7, 4)).toBe(100);
  });
});
