import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENT_DEFINITIONS,
  evaluateAchievements,
  heatmapIntensity,
  levelForXp,
  levelProgress,
  topBadges,
  xpForLevel,
  type AchievementContext,
} from './gamification';

function ctx(overrides: Partial<AchievementContext> = {}): AchievementContext {
  return {
    currentStreak: 0,
    longestStreak: 0,
    totalSolved: 0,
    perfectDays: 0,
    perfectWeeks: 0,
    earlyFinishes: 0,
    weekendPerfectDays: 0,
    bestDailyRank: null,
    scoreImprovement: 0,
    hardSolved: 0,
    mediumSolved: 0,
    distinctTopics: 0,
    activeDays: 0,
    ...overrides,
  };
}

describe('levels', () => {
  it('starts everyone at level 1 with 0 XP', () => {
    expect(levelForXp(0)).toBe(1);
    expect(xpForLevel(1)).toBe(0);
  });

  it('is the exact inverse of the level threshold formula', () => {
    for (let level = 1; level <= 40; level += 1) {
      const floor = xpForLevel(level);
      expect(levelForXp(floor)).toBe(level);
      // One XP short of the threshold must still be the previous level.
      if (level > 1) expect(levelForXp(floor - 1)).toBe(level - 1);
    }
  });

  it('treats negative XP as level 1 rather than producing NaN', () => {
    expect(levelForXp(-500)).toBe(1);
    expect(levelProgress(-500).level).toBe(1);
    expect(levelProgress(-500).progressPercent).toBe(0);
  });

  it('reports progress through the current level', () => {
    // Level 2 starts at 100 XP, level 3 at 300 — so 200 XP is halfway through level 2.
    const progress = levelProgress(200);
    expect(progress.level).toBe(2);
    expect(progress.xpIntoLevel).toBe(100);
    expect(progress.xpForNextLevel).toBe(200);
    expect(progress.progressPercent).toBe(50);
  });

  it('requires progressively more XP per level', () => {
    const gaps = [1, 2, 3, 4, 5].map((l) => xpForLevel(l + 1) - xpForLevel(l));
    for (let i = 1; i < gaps.length; i += 1) {
      expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]!);
    }
  });
});

describe('achievements', () => {
  it('awards nothing to a brand-new student', () => {
    expect(evaluateAchievements(ctx()).filter((a) => a.earned)).toHaveLength(0);
  });

  it('awards First Blood on the first solve', () => {
    const earned = evaluateAchievements(ctx({ totalSolved: 1 })).filter((a) => a.earned);
    expect(earned.map((a) => a.code)).toContain('FIRST_BLOOD');
  });

  it('awards streak badges from the longest streak, not the current one', () => {
    // A student who once held a 30-day streak keeps the badge after breaking it.
    const result = evaluateAchievements(ctx({ currentStreak: 0, longestStreak: 30 }));
    const codes = result.filter((a) => a.earned).map((a) => a.code);
    expect(codes).toContain('STREAK_7');
    expect(codes).toContain('STREAK_30');
  });

  it('reports partial progress on locked badges', () => {
    const week = evaluateAchievements(ctx({ longestStreak: 3 })).find((a) => a.code === 'STREAK_7')!;
    expect(week.earned).toBe(false);
    expect(week.current).toBe(3);
    expect(week.target).toBe(7);
    expect(week.progressPercent).toBeCloseTo(42.86, 1);
  });

  it('shows 100% for every earned badge, including rank-based ones', () => {
    const earned = evaluateAchievements(ctx({ bestDailyRank: 1 })).filter((a) => a.earned);
    expect(earned.length).toBeGreaterThan(0);
    for (const badge of earned) expect(badge.progressPercent).toBe(100);
  });

  it('awards Podium for a top-3 finish but Champion only for first', () => {
    const third = evaluateAchievements(ctx({ bestDailyRank: 3 }));
    expect(third.find((a) => a.code === 'PODIUM')!.earned).toBe(true);
    expect(third.find((a) => a.code === 'CHAMPION')!.earned).toBe(false);

    const first = evaluateAchievements(ctx({ bestDailyRank: 1 }));
    expect(first.find((a) => a.code === 'CHAMPION')!.earned).toBe(true);
  });

  it('never reports negative progress for a declining student', () => {
    const badge = evaluateAchievements(ctx({ scoreImprovement: -300 })).find(
      (a) => a.code === 'TOP_IMPROVER',
    )!;
    expect(badge.current).toBe(0);
    expect(badge.progressPercent).toBe(0);
  });

  it('exposes definitions matching the evaluated set', () => {
    expect(ACHIEVEMENT_DEFINITIONS).toHaveLength(evaluateAchievements(ctx()).length);
    const codes = new Set(ACHIEVEMENT_DEFINITIONS.map((d) => d.code));
    expect(codes.size).toBe(ACHIEVEMENT_DEFINITIONS.length);
  });
});

describe('topBadges', () => {
  it('returns the most prestigious badges first', () => {
    const badges = topBadges(
      ctx({ totalSolved: 150, longestStreak: 30, bestDailyRank: 1, perfectDays: 20 }),
      3,
    );
    expect(badges).toHaveLength(3);
    expect(badges[0]!.tier).toBe('PLATINUM');
  });

  it('returns nothing when no badge is earned', () => {
    expect(topBadges(ctx())).toEqual([]);
  });
});

describe('heatmapIntensity', () => {
  it('distinguishes "no assignment" from "assigned but nothing solved"', () => {
    expect(heatmapIntensity(0, 0)).toBe(0);
    expect(heatmapIntensity(0, 4)).toBe(1);
  });

  it('scales with completion', () => {
    expect(heatmapIntensity(1, 4)).toBe(2);
    expect(heatmapIntensity(2, 4)).toBe(3);
    expect(heatmapIntensity(4, 4)).toBe(4);
  });
});
