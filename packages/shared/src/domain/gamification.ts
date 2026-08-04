/**
 * XP, levels and achievements.
 *
 * Gamification is derived, never stored as a source of truth: XP is a pure function of
 * accumulated score and achievements are pure functions of the student's statistics.
 * That means recomputing the scoring formula automatically corrects every level and
 * badge in the system, and no migration is needed when a badge definition changes.
 */

import type { DayKey } from './time';

/**
 * Level thresholds grow super-linearly so early levels arrive quickly (keeping new
 * students engaged) while later ones require sustained work. Level N requires
 * `50 × N × (N - 1)` XP, i.e. 0 / 100 / 300 / 600 / 1000 …
 */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return 50 * level * (level - 1);
}

export function levelForXp(xp: number): number {
  if (xp <= 0) return 1;
  // Invert `xp = 50·L·(L-1)` → L = (1 + sqrt(1 + 4·xp/50)) / 2, then floor.
  const level = Math.floor((1 + Math.sqrt(1 + (4 * xp) / 50)) / 2);
  return Math.max(1, level);
}

export interface LevelProgress {
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  /** 0–100, how far through the current level the student is. */
  progressPercent: number;
}

export function levelProgress(xp: number): LevelProgress {
  const safeXp = Math.max(0, Math.floor(xp));
  const level = levelForXp(safeXp);
  const currentFloor = xpForLevel(level);
  const nextFloor = xpForLevel(level + 1);
  const span = nextFloor - currentFloor;
  const into = safeXp - currentFloor;
  return {
    level,
    xp: safeXp,
    xpIntoLevel: into,
    xpForNextLevel: span,
    progressPercent: span > 0 ? Math.round((into / span) * 10000) / 100 : 0,
  };
}

export type AchievementTier = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM';

export interface AchievementDefinition {
  code: string;
  name: string;
  description: string;
  tier: AchievementTier;
  icon: string;
}

/** Everything an achievement rule is allowed to look at. */
export interface AchievementContext {
  currentStreak: number;
  longestStreak: number;
  totalSolved: number;
  perfectDays: number;
  perfectWeeks: number;
  /** Days completed strictly before 09:00 program-local. */
  earlyFinishes: number;
  /** Perfect days that fell on a Saturday or Sunday. */
  weekendPerfectDays: number;
  /** Best (lowest) rank achieved on any daily leaderboard; `null` if never ranked. */
  bestDailyRank: number | null;
  /** Score delta versus the previous comparable window. */
  scoreImprovement: number;
  hardSolved: number;
  mediumSolved: number;
  distinctTopics: number;
  activeDays: number;
}

interface AchievementRule extends AchievementDefinition {
  earned: (ctx: AchievementContext) => boolean;
  /** Current value and target, so the UI can render "7 / 30" progress on locked badges. */
  progress: (ctx: AchievementContext) => { current: number; target: number };
}

const RULES: AchievementRule[] = [
  {
    code: 'FIRST_BLOOD',
    name: 'First Blood',
    description: 'Solve your first assigned problem.',
    tier: 'BRONZE',
    icon: 'sparkles',
    earned: (c) => c.totalSolved >= 1,
    progress: (c) => ({ current: Math.min(c.totalSolved, 1), target: 1 }),
  },
  {
    code: 'PERFECT_START',
    name: 'Perfect Start',
    description: 'Complete all four problems on a single day.',
    tier: 'BRONZE',
    icon: 'check-circle',
    earned: (c) => c.perfectDays >= 1,
    progress: (c) => ({ current: Math.min(c.perfectDays, 1), target: 1 }),
  },
  {
    code: 'STREAK_7',
    name: 'Week Warrior',
    description: 'Maintain a 7-day streak.',
    tier: 'SILVER',
    icon: 'flame',
    earned: (c) => c.longestStreak >= 7,
    progress: (c) => ({ current: Math.min(c.longestStreak, 7), target: 7 }),
  },
  {
    code: 'STREAK_30',
    name: 'Unbreakable',
    description: 'Maintain a 30-day streak.',
    tier: 'PLATINUM',
    icon: 'flame',
    earned: (c) => c.longestStreak >= 30,
    progress: (c) => ({ current: Math.min(c.longestStreak, 30), target: 30 }),
  },
  {
    code: 'EARLY_BIRD',
    name: 'Fastest Solver',
    description: 'Finish the full assignment before 09:00 on ten days.',
    tier: 'GOLD',
    icon: 'sunrise',
    earned: (c) => c.earlyFinishes >= 10,
    progress: (c) => ({ current: Math.min(c.earlyFinishes, 10), target: 10 }),
  },
  {
    code: 'WEEKEND_WARRIOR',
    name: 'Weekend Warrior',
    description: 'Complete the assignment on eight weekend days.',
    tier: 'SILVER',
    icon: 'calendar',
    earned: (c) => c.weekendPerfectDays >= 8,
    progress: (c) => ({ current: Math.min(c.weekendPerfectDays, 8), target: 8 }),
  },
  {
    code: 'MOST_CONSISTENT',
    name: 'Most Consistent',
    description: 'Record four perfect weeks.',
    tier: 'GOLD',
    icon: 'target',
    earned: (c) => c.perfectWeeks >= 4,
    progress: (c) => ({ current: Math.min(c.perfectWeeks, 4), target: 4 }),
  },
  {
    code: 'PODIUM',
    name: 'Podium Finish',
    description: 'Reach the top three on a daily leaderboard.',
    tier: 'SILVER',
    icon: 'trophy',
    earned: (c) => c.bestDailyRank !== null && c.bestDailyRank <= 3,
    progress: (c) => ({ current: c.bestDailyRank !== null && c.bestDailyRank <= 3 ? 1 : 0, target: 1 }),
  },
  {
    code: 'CHAMPION',
    name: 'Daily Champion',
    description: 'Finish first on a daily leaderboard.',
    tier: 'GOLD',
    icon: 'crown',
    earned: (c) => c.bestDailyRank === 1,
    progress: (c) => ({ current: c.bestDailyRank === 1 ? 1 : 0, target: 1 }),
  },
  {
    code: 'TOP_IMPROVER',
    name: 'Top Improver',
    description: 'Improve your weekly score by 100 points or more.',
    tier: 'SILVER',
    icon: 'trending-up',
    earned: (c) => c.scoreImprovement >= 100,
    progress: (c) => ({ current: Math.min(Math.max(c.scoreImprovement, 0), 100), target: 100 }),
  },
  {
    code: 'HARD_HITTER',
    name: 'Hard Hitter',
    description: 'Solve 25 Hard problems.',
    tier: 'GOLD',
    icon: 'zap',
    earned: (c) => c.hardSolved >= 25,
    progress: (c) => ({ current: Math.min(c.hardSolved, 25), target: 25 }),
  },
  {
    code: 'CENTURION',
    name: 'Centurion',
    description: 'Solve 100 assigned problems.',
    tier: 'GOLD',
    icon: 'award',
    earned: (c) => c.totalSolved >= 100,
    progress: (c) => ({ current: Math.min(c.totalSolved, 100), target: 100 }),
  },
  {
    code: 'POLYGLOT_TOPICS',
    name: 'Well Rounded',
    description: 'Solve problems across 15 distinct topics.',
    tier: 'SILVER',
    icon: 'layers',
    earned: (c) => c.distinctTopics >= 15,
    progress: (c) => ({ current: Math.min(c.distinctTopics, 15), target: 15 }),
  },
];

export const ACHIEVEMENT_DEFINITIONS: AchievementDefinition[] = RULES.map(
  ({ code, name, description, tier, icon }) => ({ code, name, description, tier, icon }),
);

export interface EvaluatedAchievement extends AchievementDefinition {
  earned: boolean;
  current: number;
  target: number;
  progressPercent: number;
}

export function evaluateAchievements(ctx: AchievementContext): EvaluatedAchievement[] {
  return RULES.map((rule) => {
    const { current, target } = rule.progress(ctx);
    const earned = rule.earned(ctx);
    return {
      code: rule.code,
      name: rule.name,
      description: rule.description,
      tier: rule.tier,
      icon: rule.icon,
      earned,
      current,
      target,
      // An earned badge always reads 100%, even when its rule and its progress metric
      // measure slightly different things (e.g. rank-based badges).
      progressPercent: earned
        ? 100
        : target > 0
          ? Math.round((current / target) * 10000) / 100
          : 0,
    };
  });
}

/** Compact badge summary for leaderboard rows. */
export interface BadgeSummary {
  code: string;
  name: string;
  icon: string;
  tier: AchievementTier;
}

const TIER_ORDER: Record<AchievementTier, number> = {
  PLATINUM: 0,
  GOLD: 1,
  SILVER: 2,
  BRONZE: 3,
};

/** The `limit` most prestigious earned badges, for the leaderboard's Badges column. */
export function topBadges(ctx: AchievementContext, limit = 3): BadgeSummary[] {
  return evaluateAchievements(ctx)
    .filter((a) => a.earned)
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ code, name, icon, tier }) => ({ code, name, icon, tier }));
}

/** A single cell of the contribution-style completion heatmap. */
export interface HeatmapCell {
  dayKey: DayKey;
  solvedCount: number;
  assignedCount: number;
  /** 0 = no assignment, 1 = none solved, 2–4 scale with completion. */
  intensity: 0 | 1 | 2 | 3 | 4;
}

export function heatmapIntensity(solved: number, assigned: number): 0 | 1 | 2 | 3 | 4 {
  if (assigned <= 0) return 0;
  if (solved <= 0) return 1;
  const ratio = solved / assigned;
  if (ratio >= 1) return 4;
  if (ratio >= 0.5) return 3;
  return 2;
}
