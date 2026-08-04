/**
 * Streak computation.
 *
 * Two real-world rules shape this module and neither is obvious from the spec:
 *
 * 1. **Days without an assignment are neutral.** If mentors skip a Sunday, nobody's
 *    streak should break. Streaks run over the sequence of *assigned* days, not the
 *    calendar — so consecutiveness means "adjacent assigned days", not "adjacent dates".
 *
 * 2. **Today is in progress until the day ends.** A student who has not yet solved
 *    today's problems at 10:00 has not broken their streak. The current streak is
 *    therefore measured from the most recent *concluded* day, with today counted only
 *    when it already qualifies.
 */

import type { DayKey } from './time';
import { toMonthKey, toWeekKey } from './time';
import type { ScoringConfig } from './scoring';
import { DEFAULT_SCORING_CONFIG, requiredSolvedForStreak } from './scoring';

export interface StreakDay {
  dayKey: DayKey;
  solvedCount: number;
  /** Number of problems assigned that day. `0` marks a non-assignment day. */
  assignedCount: number;
}

export interface StreakResult {
  current: number;
  longest: number;
  /** The most recent day that ended a streak, or `null` if none ever broke. */
  brokenOn: DayKey | null;
  /** First day of the currently running streak, or `null` when the current streak is 0. */
  currentStartedOn: DayKey | null;
  /** Consecutive ISO weeks (ending with the reference week) containing ≥1 qualifying day. */
  weekly: number;
  /** Consecutive months (ending with the reference month) containing ≥1 qualifying day. */
  monthly: number;
  /** Days in the streak sequence that qualified, for consistency reporting. */
  totalQualifyingDays: number;
}

const EMPTY_RESULT: StreakResult = {
  current: 0,
  longest: 0,
  brokenOn: null,
  currentStartedOn: null,
  weekly: 0,
  monthly: 0,
  totalQualifyingDays: 0,
};

function qualifies(day: StreakDay, config: ScoringConfig): boolean {
  if (day.assignedCount <= 0) return false;
  return day.solvedCount >= requiredSolvedForStreak(day.assignedCount, config);
}

/**
 * @param days       Any order; only days with `assignedCount > 0` participate.
 * @param referenceDay The program day to measure "current" from — normally today.
 */
export function computeStreaks(
  days: StreakDay[],
  referenceDay: DayKey,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): StreakResult {
  const assignedDays = days
    .filter((d) => d.assignedCount > 0)
    .sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));

  if (assignedDays.length === 0) return { ...EMPTY_RESULT };

  const qualified = assignedDays.map((day) => ({ day, ok: qualifies(day, config) }));
  const totalQualifyingDays = qualified.reduce((n, entry) => n + (entry.ok ? 1 : 0), 0);

  // Longest run of consecutive qualifying assigned days, anywhere in history.
  let longest = 0;
  let run = 0;
  let brokenOn: DayKey | null = null;
  for (const entry of qualified) {
    if (entry.ok) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      // Only count it as a break if a streak was actually running.
      if (run > 0) brokenOn = entry.day.dayKey;
      run = 0;
    }
  }

  // Current streak: walk backwards from the newest assigned day at or before the
  // reference day. Skip the reference day itself when it has not qualified yet —
  // it is still in progress, not a break.
  let index = qualified.length - 1;
  while (index >= 0 && qualified[index]!.day.dayKey > referenceDay) index -= 1;

  if (index >= 0 && qualified[index]!.day.dayKey === referenceDay && !qualified[index]!.ok) {
    index -= 1;
  }

  let current = 0;
  let currentStartedOn: DayKey | null = null;
  while (index >= 0 && qualified[index]!.ok) {
    current += 1;
    currentStartedOn = qualified[index]!.day.dayKey;
    index -= 1;
  }

  return {
    current,
    longest,
    brokenOn,
    currentStartedOn,
    weekly: computePeriodStreak(qualified, referenceDay, toWeekKey),
    monthly: computePeriodStreak(qualified, referenceDay, toMonthKey),
    totalQualifyingDays,
  };
}

/**
 * Consecutive periods (weeks or months), counting back from the reference period,
 * in which the student had at least one qualifying day. As with daily streaks, the
 * in-progress current period is skipped rather than treated as a break, and periods
 * with no assignments at all are neutral.
 */
function computePeriodStreak(
  qualified: { day: StreakDay; ok: boolean }[],
  referenceDay: DayKey,
  keyOf: (dayKey: DayKey) => string,
): number {
  const periods = new Map<string, { assigned: number; qualifying: number }>();
  for (const entry of qualified) {
    const key = keyOf(entry.day.dayKey);
    const bucket = periods.get(key) ?? { assigned: 0, qualifying: 0 };
    bucket.assigned += 1;
    if (entry.ok) bucket.qualifying += 1;
    periods.set(key, bucket);
  }

  const referenceKey = keyOf(referenceDay);
  const orderedKeys = [...periods.keys()]
    .filter((key) => key <= referenceKey)
    .sort()
    .reverse();

  if (orderedKeys.length === 0) return 0;

  let index = 0;
  // The current period is still running; don't let a quiet Monday zero out the streak.
  if (orderedKeys[0] === referenceKey && periods.get(referenceKey)!.qualifying === 0) {
    index = 1;
  }

  let streak = 0;
  for (; index < orderedKeys.length; index += 1) {
    const bucket = periods.get(orderedKeys[index]!)!;
    if (bucket.qualifying > 0) streak += 1;
    else break;
  }
  return streak;
}

/** Flame tier used by the UI to pick an icon treatment for a streak length. */
export type FlameTier = 'none' | 'spark' | 'flame' | 'blaze' | 'inferno' | 'legendary';

export function flameTier(streak: number): FlameTier {
  if (streak <= 0) return 'none';
  if (streak < 3) return 'spark';
  if (streak < 7) return 'flame';
  if (streak < 15) return 'blaze';
  if (streak < 30) return 'inferno';
  return 'legendary';
}
