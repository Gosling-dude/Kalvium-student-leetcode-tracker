/**
 * Weighted scoring engine.
 *
 * The formula is data, not code: every weight lives in a `ScoringConfig` row that the
 * admin panel edits and the compute path reads at run time. Changing how points are
 * awarded must never require a redeploy, and recomputing history with a new formula
 * must be a pure function of stored facts — which is why nothing here touches a clock,
 * a database, or a network.
 */

import type { Difficulty } from '../types/enums';

export interface EarlyCompletionTier {
  /** Award this bonus when the day was completed strictly before this minute-of-day. */
  beforeMinuteOfDay: number;
  bonus: number;
  label: string;
}

export interface ConsistencyTier {
  /** Minimum qualifying days in the period required to earn `bonus`. */
  minQualifyingDays: number;
  bonus: number;
  label: string;
}

/** How much of a day's assignment a student must clear for the day to "qualify" for streaks. */
export type StreakQualificationMode = 'ALL_ASSIGNED' | 'AT_LEAST_ONE' | 'CUSTOM';

export interface ScoringConfig {
  /** Points for each accepted assigned problem. 25 × 4 problems = the canonical 100. */
  pointsPerSolved: number;
  /** Extra points for clearing the entire day's assignment. */
  perfectDayBonus: number;
  /** Additive bonus per solved problem, by problem difficulty. */
  difficultyBonus: Record<Difficulty, number>;
  /** Checked in order; the first matching (i.e. most demanding) tier wins. */
  earlyCompletion: EarlyCompletionTier[];
  /** Streak reward: `pointsPerDay × streakLength`, capped. */
  streakPointsPerDay: number;
  streakBonusCap: number;
  weeklyConsistency: ConsistencyTier[];
  monthlyConsistency: ConsistencyTier[];
  perfectWeekBonus: number;
  perfectMonthBonus: number;
  streakQualification: StreakQualificationMode;
  /** Used only when `streakQualification === 'CUSTOM'`. */
  streakCustomMinSolved: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  pointsPerSolved: 25,
  perfectDayBonus: 0,
  difficultyBonus: { EASY: 0, MEDIUM: 2, HARD: 5 },
  earlyCompletion: [
    { beforeMinuteOfDay: 9 * 60, bonus: 20, label: 'Early Bird (before 09:00)' },
    { beforeMinuteOfDay: 12 * 60, bonus: 12, label: 'Morning Finisher (before 12:00)' },
    { beforeMinuteOfDay: 18 * 60, bonus: 5, label: 'Ahead of Evening (before 18:00)' },
  ],
  streakPointsPerDay: 2,
  streakBonusCap: 30,
  weeklyConsistency: [
    { minQualifyingDays: 5, bonus: 40, label: 'Consistent Week (5+ days)' },
    { minQualifyingDays: 3, bonus: 15, label: 'Steady Week (3+ days)' },
  ],
  monthlyConsistency: [
    { minQualifyingDays: 20, bonus: 150, label: 'Consistent Month (20+ days)' },
    { minQualifyingDays: 12, bonus: 60, label: 'Active Month (12+ days)' },
  ],
  perfectWeekBonus: 100,
  perfectMonthBonus: 400,
  streakQualification: 'ALL_ASSIGNED',
  streakCustomMinSolved: 4,
};

/** One labelled line item, so the UI can show a student *why* they scored what they did. */
export interface ScoreComponent {
  key: string;
  label: string;
  points: number;
}

export interface DailyScoreInput {
  solvedCount: number;
  assignedCount: number;
  /**
   * Minute-of-day of the last accepted submission that completed the assignment,
   * or `null` when the day was not fully completed. Early bonuses require full
   * completion — finishing one easy problem at 06:00 is not an early finish.
   */
  completionMinuteOfDay: number | null;
  /** Difficulty of each *solved* assigned problem. */
  solvedDifficulties: Difficulty[];
  /** Streak length *including* this day, used for the streak bonus. */
  streakLength: number;
}

export interface DailyScoreResult {
  total: number;
  base: number;
  bonus: number;
  components: ScoreComponent[];
  isPerfectDay: boolean;
}

function clampNonNegative(n: number): number {
  return n > 0 ? n : 0;
}

export function computeDailyScore(
  input: DailyScoreInput,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): DailyScoreResult {
  const components: ScoreComponent[] = [];

  const solved = clampNonNegative(Math.min(input.solvedCount, input.assignedCount));
  const isPerfectDay = input.assignedCount > 0 && solved >= input.assignedCount;

  const base = solved * config.pointsPerSolved;
  components.push({
    key: 'base',
    label: `${solved} × ${config.pointsPerSolved} pts solved`,
    points: base,
  });

  let bonus = 0;

  if (isPerfectDay && config.perfectDayBonus > 0) {
    bonus += config.perfectDayBonus;
    components.push({
      key: 'perfect_day',
      label: 'Completed full assignment',
      points: config.perfectDayBonus,
    });
  }

  const difficultyPoints = input.solvedDifficulties.reduce(
    (sum, difficulty) => sum + (config.difficultyBonus[difficulty] ?? 0),
    0,
  );
  if (difficultyPoints > 0) {
    bonus += difficultyPoints;
    components.push({
      key: 'difficulty',
      label: 'Difficulty weighting',
      points: difficultyPoints,
    });
  }

  if (isPerfectDay && input.completionMinuteOfDay !== null) {
    // Tiers are evaluated most-demanding-first so the earliest matching tier wins.
    const tiers = [...config.earlyCompletion].sort(
      (a, b) => a.beforeMinuteOfDay - b.beforeMinuteOfDay,
    );
    const tier = tiers.find((t) => input.completionMinuteOfDay! < t.beforeMinuteOfDay);
    if (tier && tier.bonus > 0) {
      bonus += tier.bonus;
      components.push({ key: 'early_completion', label: tier.label, points: tier.bonus });
    }
  }

  if (solved > 0 && input.streakLength > 0 && config.streakPointsPerDay > 0) {
    const streakPoints = Math.min(
      input.streakLength * config.streakPointsPerDay,
      config.streakBonusCap,
    );
    bonus += streakPoints;
    components.push({
      key: 'streak',
      label: `${input.streakLength}-day streak`,
      points: streakPoints,
    });
  }

  return {
    total: base + bonus,
    base,
    bonus,
    components,
    isPerfectDay,
  };
}

export interface PeriodBonusInput {
  /** Days in the period that had an assignment. Days without one are not counted against anyone. */
  assignedDays: number;
  /** Days the student met the streak qualification bar. */
  qualifyingDays: number;
}

/** Weekly consistency / perfect-week bonuses, applied on top of summed daily scores. */
export function computeWeeklyBonus(
  input: PeriodBonusInput,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): { total: number; components: ScoreComponent[] } {
  return computePeriodBonus(input, config.weeklyConsistency, config.perfectWeekBonus, 'week');
}

/** Monthly consistency / perfect-month bonuses. */
export function computeMonthlyBonus(
  input: PeriodBonusInput,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): { total: number; components: ScoreComponent[] } {
  return computePeriodBonus(input, config.monthlyConsistency, config.perfectMonthBonus, 'month');
}

function computePeriodBonus(
  input: PeriodBonusInput,
  tiers: ConsistencyTier[],
  perfectBonus: number,
  period: 'week' | 'month',
): { total: number; components: ScoreComponent[] } {
  const components: ScoreComponent[] = [];
  let total = 0;

  // A period with no assignments is vacuously perfect; awarding a bonus for it would
  // hand out free points on holiday weeks, so require at least one assigned day.
  const isPerfect = input.assignedDays > 0 && input.qualifyingDays >= input.assignedDays;

  if (isPerfect && perfectBonus > 0) {
    total += perfectBonus;
    components.push({
      key: `perfect_${period}`,
      label: `Perfect ${period}`,
      points: perfectBonus,
    });
  } else {
    // Consistency tiers are a consolation for a non-perfect period — checked
    // most-demanding-first so a student earns each tier only once.
    const ordered = [...tiers].sort((a, b) => b.minQualifyingDays - a.minQualifyingDays);
    const tier = ordered.find((t) => input.qualifyingDays >= t.minQualifyingDays);
    if (tier && tier.bonus > 0) {
      total += tier.bonus;
      components.push({
        key: `consistency_${period}`,
        label: tier.label,
        points: tier.bonus,
      });
    }
  }

  return { total, components };
}

/** The number of solved problems a day needs to qualify for streaks under `config`. */
export function requiredSolvedForStreak(assignedCount: number, config: ScoringConfig): number {
  switch (config.streakQualification) {
    case 'AT_LEAST_ONE':
      return Math.min(1, assignedCount);
    case 'CUSTOM':
      return Math.min(config.streakCustomMinSolved, assignedCount);
    case 'ALL_ASSIGNED':
    default:
      return assignedCount;
  }
}

/** Completion percentage, guarding the zero-assignment case. */
export function completionPercentage(solved: number, assigned: number): number {
  if (assigned <= 0) return 0;
  return Math.round((Math.min(solved, assigned) / assigned) * 10000) / 100;
}
