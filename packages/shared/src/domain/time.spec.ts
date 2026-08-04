import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayBoundsUtc,
  dayOfWeek,
  dayRange,
  diffDays,
  endOfMonth,
  endOfWeek,
  formatLocalTime,
  fromEpochSeconds,
  isValidDayKey,
  minutesIntoDay,
  startOfDayUtc,
  startOfWeek,
  timezoneOffsetMs,
  toDayKey,
  toMonthKey,
  toWeekKey,
} from './time';

const IST = 'Asia/Kolkata';
const UTC = 'UTC';
const NY = 'America/New_York';

describe('timezoneOffsetMs', () => {
  it('returns +5:30 for Asia/Kolkata', () => {
    expect(timezoneOffsetMs(new Date('2026-08-04T00:00:00Z'), IST)).toBe(5.5 * 3600 * 1000);
  });

  it('returns 0 for UTC', () => {
    expect(timezoneOffsetMs(new Date('2026-08-04T00:00:00Z'), UTC)).toBe(0);
  });

  it('tracks DST transitions in zones that observe them', () => {
    const winter = timezoneOffsetMs(new Date('2026-01-15T12:00:00Z'), NY);
    const summer = timezoneOffsetMs(new Date('2026-07-15T12:00:00Z'), NY);
    expect(winter).toBe(-5 * 3600 * 1000);
    expect(summer).toBe(-4 * 3600 * 1000);
  });

  it('is unaffected by sub-second components of the instant', () => {
    expect(timezoneOffsetMs(new Date('2026-08-04T00:00:00.750Z'), IST)).toBe(5.5 * 3600 * 1000);
  });
});

describe('toDayKey', () => {
  it('buckets a late-evening IST submission into the correct local day', () => {
    // 23:50 IST on the 4th is 18:20Z on the 4th — same day either way.
    expect(toDayKey(new Date('2026-08-04T18:20:00Z'), IST)).toBe('2026-08-04');
  });

  it('rolls a post-18:30Z instant into the next IST day', () => {
    // 19:00Z is 00:30 IST the following morning. This is the case that silently
    // corrupts streaks when the timezone is ignored.
    expect(toDayKey(new Date('2026-08-04T19:00:00Z'), IST)).toBe('2026-08-05');
    expect(toDayKey(new Date('2026-08-04T19:00:00Z'), UTC)).toBe('2026-08-04');
  });

  it('handles the exact IST midnight boundary', () => {
    expect(toDayKey(new Date('2026-08-04T18:29:59Z'), IST)).toBe('2026-08-04');
    expect(toDayKey(new Date('2026-08-04T18:30:00Z'), IST)).toBe('2026-08-05');
  });
});

describe('startOfDayUtc / dayBoundsUtc', () => {
  it('resolves IST midnight to 18:30Z the previous day', () => {
    expect(startOfDayUtc('2026-08-05', IST).toISOString()).toBe('2026-08-04T18:30:00.000Z');
  });

  it('produces half-open bounds exactly 24h apart in a non-DST zone', () => {
    const { start, end } = dayBoundsUtc('2026-08-05', IST);
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
  });

  it('produces a 23-hour day across a spring-forward DST transition', () => {
    // US DST began 2026-03-08; that local day is only 23 hours long.
    const { start, end } = dayBoundsUtc('2026-03-08', NY);
    expect(end.getTime() - start.getTime()).toBe(23 * 3600 * 1000);
  });

  it('round-trips: the day key of a day start is that day', () => {
    for (const key of ['2026-01-01', '2026-03-08', '2026-08-05', '2026-12-31']) {
      expect(toDayKey(startOfDayUtc(key, IST), IST)).toBe(key);
      expect(toDayKey(startOfDayUtc(key, NY), NY)).toBe(key);
    }
  });
});

describe('day key arithmetic', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('handles leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(isValidDayKey('2028-02-29')).toBe(true);
    expect(isValidDayKey('2026-02-29')).toBe(false);
  });

  it('rejects malformed and impossible keys', () => {
    expect(isValidDayKey('2026-13-01')).toBe(false);
    expect(isValidDayKey('2026-02-30')).toBe(false);
    expect(isValidDayKey('26-01-01')).toBe(false);
    expect(isValidDayKey('not-a-date')).toBe(false);
  });

  it('computes signed day differences', () => {
    expect(diffDays('2026-08-01', '2026-08-05')).toBe(4);
    expect(diffDays('2026-08-05', '2026-08-01')).toBe(-4);
    expect(diffDays('2026-08-05', '2026-08-05')).toBe(0);
  });

  it('builds inclusive ranges and returns empty for reversed input', () => {
    expect(dayRange('2026-08-01', '2026-08-04')).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
    ]);
    expect(dayRange('2026-08-04', '2026-08-01')).toEqual([]);
  });
});

describe('minutesIntoDay / formatLocalTime', () => {
  it('measures elapsed minutes in program-local time', () => {
    // 03:30Z == 09:00 IST
    expect(minutesIntoDay(new Date('2026-08-04T03:30:00Z'), IST)).toBe(9 * 60);
    expect(formatLocalTime(new Date('2026-08-04T03:30:00Z'), IST)).toBe('09:00');
  });

  it('reports 0 at local midnight rather than 1440', () => {
    expect(minutesIntoDay(new Date('2026-08-04T18:30:00Z'), IST)).toBe(0);
    expect(formatLocalTime(new Date('2026-08-04T18:30:00Z'), IST)).toBe('00:00');
  });
});

describe('week and month keys', () => {
  it('computes ISO week keys with Monday-based weeks', () => {
    expect(toWeekKey('2026-08-04')).toBe('2026-W32');
    expect(startOfWeek('2026-08-04')).toBe('2026-08-03');
    expect(endOfWeek('2026-08-04')).toBe('2026-08-09');
  });

  it('treats Sunday as the last day of the ISO week, not the first', () => {
    expect(startOfWeek('2026-08-09')).toBe('2026-08-03');
    expect(dayOfWeek('2026-08-09')).toBe(0);
  });

  it('keeps a week together across a year boundary', () => {
    // 2026-12-31 (Thu) and 2027-01-01 (Fri) are in the same ISO week.
    expect(toWeekKey('2026-12-31')).toBe(toWeekKey('2027-01-01'));
  });

  it('computes month keys and month ends including February', () => {
    expect(toMonthKey('2026-08-04')).toBe('2026-08');
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(endOfMonth('2026-08-01')).toBe('2026-08-31');
  });
});

describe('fromEpochSeconds', () => {
  it('parses LeetCode string timestamps', () => {
    // A real value observed from the live endpoint.
    expect(fromEpochSeconds('1785643611').toISOString()).toBe('2026-08-02T04:06:51.000Z');
    // ...and the same instant buckets into the 2nd in IST (09:36 local).
    expect(toDayKey(fromEpochSeconds('1785643611'), IST)).toBe('2026-08-02');
  });

  it('rejects garbage', () => {
    expect(() => fromEpochSeconds('abc')).toThrow();
  });
});
