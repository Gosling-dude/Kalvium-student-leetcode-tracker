/**
 * Program-timezone day bucketing.
 *
 * Every date boundary in this application is load-bearing: "today's assignment",
 * streak continuity, completion time, and weekly/monthly percentages all depend on
 * agreeing about when a day starts and ends. LeetCode returns epoch seconds, servers
 * run in UTC, and mentors think in local time. A submission at 23:50 IST belongs to a
 * different day depending on which of those you pick.
 *
 * The rule for this codebase: **never call `new Date()` to derive a day boundary
 * anywhere else.** All day bucketing goes through this module, parameterised by a
 * single configured IANA timezone (`PROGRAM_TIMEZONE`, default `Asia/Kolkata`).
 */

/** `YYYY-MM-DD` in program-local time. The canonical key for a program day. */
export type DayKey = string;
/** `YYYY-Www` ISO week key, e.g. `2026-W32`. */
export type WeekKey = string;
/** `YYYY-MM` month key. */
export type MonthKey = string;

export const DEFAULT_PROGRAM_TIMEZONE = 'Asia/Kolkata';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Cache of `Intl.DateTimeFormat` instances — constructing them is comparatively costly. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
}

/** Decompose an instant into its wall-clock reading in `timeZone`. */
export function wallClockIn(date: Date, timeZone: string): WallClock {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Some ICU versions render midnight as hour "24" under hour12:false.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * Offset of `timeZone` from UTC at the given instant, in milliseconds.
 * Positive east of Greenwich (Asia/Kolkata => +19_800_000).
 */
export function timezoneOffsetMs(date: Date, timeZone: string): number {
  const wc = wallClockIn(date, timeZone);
  const asIfUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
  // Drop sub-second precision from the instant before differencing, otherwise the
  // milliseconds component leaks into what should be a whole-second offset.
  const flooredInstant = Math.floor(date.getTime() / 1000) * 1000;
  return asIfUtc - flooredInstant;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The program day an instant falls into. */
export function toDayKey(date: Date, timeZone: string): DayKey {
  const wc = wallClockIn(date, timeZone);
  return `${wc.year}-${pad2(wc.month)}-${pad2(wc.day)}`;
}

/** The program day containing "now". */
export function todayKey(timeZone: string, now: Date = new Date()): DayKey {
  return toDayKey(now, timeZone);
}

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDayKey(value: string): boolean {
  const match = DAY_KEY_PATTERN.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Reject impossible calendar dates such as 2026-02-30.
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

export function parseDayKey(dayKey: DayKey): { year: number; month: number; day: number } {
  const match = DAY_KEY_PATTERN.exec(dayKey);
  if (!match) throw new Error(`Invalid day key: "${dayKey}" (expected YYYY-MM-DD)`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * The UTC instant at which a program day begins.
 *
 * Resolved iteratively because the offset itself depends on the instant: we guess
 * using the offset at the naive UTC reading, then correct. Two passes converge for
 * every real-world zone, including DST transition days.
 */
export function startOfDayUtc(dayKey: DayKey, timeZone: string): Date {
  const { year, month, day } = parseDayKey(dayKey);
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  let instant = naive - timezoneOffsetMs(new Date(naive), timeZone);
  instant = naive - timezoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** The UTC instant at which a program day ends (exclusive — i.e. the next day's start). */
export function endOfDayUtc(dayKey: DayKey, timeZone: string): Date {
  return startOfDayUtc(addDays(dayKey, 1), timeZone);
}

/** Half-open `[start, end)` UTC bounds for a program day. */
export function dayBoundsUtc(
  dayKey: DayKey,
  timeZone: string,
): { start: Date; end: Date } {
  return { start: startOfDayUtc(dayKey, timeZone), end: endOfDayUtc(dayKey, timeZone) };
}

/** Shift a day key by whole days. Calendar-safe across month and year ends. */
export function addDays(dayKey: DayKey, days: number): DayKey {
  const { year, month, day } = parseDayKey(dayKey);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function diffDays(from: DayKey, to: DayKey): number {
  const a = parseDayKey(from);
  const b = parseDayKey(to);
  const aMs = Date.UTC(a.year, a.month - 1, a.day);
  const bMs = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((bMs - aMs) / MS_PER_DAY);
}

/** Inclusive list of day keys from `start` to `end`. */
export function dayRange(start: DayKey, end: DayKey): DayKey[] {
  const span = diffDays(start, end);
  if (span < 0) return [];
  const out: DayKey[] = [];
  for (let i = 0; i <= span; i += 1) out.push(addDays(start, i));
  return out;
}

/** Minutes elapsed in the program day at this instant (0 – 1439). Used for completion times. */
export function minutesIntoDay(date: Date, timeZone: string): number {
  const wc = wallClockIn(date, timeZone);
  return wc.hour * 60 + wc.minute;
}

/** Render an instant as program-local `HH:mm`. */
export function formatLocalTime(date: Date, timeZone: string): string {
  const wc = wallClockIn(date, timeZone);
  return `${pad2(wc.hour)}:${pad2(wc.minute)}`;
}

/** Day of week for a day key: 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(dayKey: DayKey): number {
  const { year, month, day } = parseDayKey(dayKey);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** ISO-8601 week key (`YYYY-Www`). Weeks start Monday; week 1 contains the first Thursday. */
export function toWeekKey(dayKey: DayKey): WeekKey {
  const { year, month, day } = parseDayKey(dayKey);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Shift to the Thursday of this ISO week — its calendar year is the ISO year.
  const isoDow = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 4 - isoDow);
  const isoYear = date.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date.getTime() - jan1.getTime()) / MS_PER_DAY + 1) / 7);
  return `${isoYear}-W${pad2(week)}`;
}

/** Monday of the ISO week containing `dayKey`. */
export function startOfWeek(dayKey: DayKey): DayKey {
  const dow = dayOfWeek(dayKey);
  const isoDow = dow === 0 ? 7 : dow;
  return addDays(dayKey, 1 - isoDow);
}

/** Sunday of the ISO week containing `dayKey`. */
export function endOfWeek(dayKey: DayKey): DayKey {
  return addDays(startOfWeek(dayKey), 6);
}

export function toMonthKey(dayKey: DayKey): MonthKey {
  const { year, month } = parseDayKey(dayKey);
  return `${year}-${pad2(month)}`;
}

export function startOfMonth(dayKey: DayKey): DayKey {
  const { year, month } = parseDayKey(dayKey);
  return `${year}-${pad2(month)}-01`;
}

export function endOfMonth(dayKey: DayKey): DayKey {
  const { year, month } = parseDayKey(dayKey);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad2(month)}-${pad2(lastDay)}`;
}

/** Convert LeetCode's epoch-seconds timestamps (returned as strings) to a `Date`. */
export function fromEpochSeconds(seconds: number | string): Date {
  const value = typeof seconds === 'string' ? Number.parseInt(seconds, 10) : seconds;
  if (!Number.isFinite(value)) throw new Error(`Invalid epoch timestamp: ${seconds}`);
  return new Date(value * 1000);
}

export function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** Milliseconds until the next occurrence of `hh:mm` program-local. Used to schedule crons. */
export function msUntilLocalTime(
  hour: number,
  minute: number,
  timeZone: string,
  now: Date = new Date(),
): number {
  const today = toDayKey(now, timeZone);
  const candidate = startOfDayUtc(today, timeZone).getTime() + (hour * 60 + minute) * MS_PER_MINUTE;
  if (candidate > now.getTime()) return candidate - now.getTime();
  const tomorrow = startOfDayUtc(addDays(today, 1), timeZone).getTime();
  return tomorrow + (hour * 60 + minute) * MS_PER_MINUTE - now.getTime();
}
