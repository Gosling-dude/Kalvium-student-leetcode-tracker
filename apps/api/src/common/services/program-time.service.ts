/**
 * The single source of truth for "what day is it".
 *
 * `@dsa/shared` provides the pure timezone maths; this service binds it to the
 * configured `PROGRAM_TIMEZONE` so that no caller anywhere else has to remember to pass
 * a timezone — and, more importantly, so that no caller can pass the *wrong* one.
 *
 * Rule for the codebase: outside this class, never construct a day boundary from
 * `new Date()`. Streak and completion bugs caused by mixed timezones are invisible
 * until a mentor reports that a student "lost" a day.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  addDays,
  dayBoundsUtc,
  dayOfWeek,
  dayRange,
  diffDays,
  endOfMonth,
  endOfWeek,
  formatLocalTime,
  isValidDayKey,
  minutesIntoDay,
  startOfMonth,
  startOfWeek,
  toDayKey,
  toMonthKey,
  toWeekKey,
  type DayKey,
} from '@dsa/shared';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';

@Injectable()
export class ProgramTimeService {
  readonly timezone: string;

  constructor(@Inject(CONFIG_TOKEN) config: AppConfig) {
    this.timezone = config.program.timezone;
  }

  /** The current program day. */
  today(now: Date = new Date()): DayKey {
    return toDayKey(now, this.timezone);
  }

  yesterday(now: Date = new Date()): DayKey {
    return addDays(this.today(now), -1);
  }

  /** The program day an instant belongs to — the bucket used for every submission. */
  dayKeyOf(date: Date): DayKey {
    return toDayKey(date, this.timezone);
  }

  /** Half-open `[start, end)` UTC bounds for a program day. */
  bounds(dayKey: DayKey): { start: Date; end: Date } {
    return dayBoundsUtc(dayKey, this.timezone);
  }

  /** Minute-of-day in program time — the leaderboard's completion-time tiebreaker. */
  minuteOfDay(date: Date): number {
    return minutesIntoDay(date, this.timezone);
  }

  /** Program-local `HH:mm`, as shown in mentor tables. */
  localTime(date: Date | null | undefined): string | null {
    return date ? formatLocalTime(date, this.timezone) : null;
  }

  isValid(dayKey: string): boolean {
    return isValidDayKey(dayKey);
  }

  addDays(dayKey: DayKey, days: number): DayKey {
    return addDays(dayKey, days);
  }

  diffDays(from: DayKey, to: DayKey): number {
    return diffDays(from, to);
  }

  range(from: DayKey, to: DayKey): DayKey[] {
    return dayRange(from, to);
  }

  /** The last `count` days ending at `end` (inclusive). */
  lastNDays(count: number, end: DayKey = this.today()): DayKey[] {
    return dayRange(addDays(end, -(count - 1)), end);
  }

  weekKey(dayKey: DayKey): string {
    return toWeekKey(dayKey);
  }

  monthKey(dayKey: DayKey): string {
    return toMonthKey(dayKey);
  }

  weekBounds(dayKey: DayKey): { from: DayKey; to: DayKey } {
    return { from: startOfWeek(dayKey), to: endOfWeek(dayKey) };
  }

  monthBounds(dayKey: DayKey): { from: DayKey; to: DayKey } {
    return { from: startOfMonth(dayKey), to: endOfMonth(dayKey) };
  }

  /** 0 = Sunday … 6 = Saturday. Used by the Weekend Warrior achievement. */
  dayOfWeek(dayKey: DayKey): number {
    return dayOfWeek(dayKey);
  }

  isWeekend(dayKey: DayKey): boolean {
    const dow = dayOfWeek(dayKey);
    return dow === 0 || dow === 6;
  }
}
