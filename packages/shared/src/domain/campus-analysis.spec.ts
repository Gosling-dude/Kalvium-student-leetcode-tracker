/**
 * The category rules, against the reference workbook they were taken from and against the
 * failure this whole exercise started with: a measurement gap reported as a verdict.
 */

import { describe, expect, it } from 'vitest';

import {
  analysisWeeks,
  categoriseStudent,
  MIN_OBSERVED_WEEKS,
  type StudentWeek,
} from './campus-analysis';

/** One week, described by what the student did with what they were set. */
const week = (
  weekNumber: number,
  assigned: number,
  solved: number,
  options: { attempted?: number; observed?: boolean } = {},
): StudentWeek => {
  const attemptedNotSolved = options.attempted ?? 0;
  return {
    weekNumber,
    from: `2026-08-${String(weekNumber).padStart(2, '0')}`,
    to: `2026-08-${String(weekNumber).padStart(2, '0')}`,
    assigned,
    solved,
    attemptedNotSolved,
    notAttempted: Math.max(0, assigned - solved - attemptedNotSolved),
    observed: options.observed ?? true,
  };
};

const categorise = (weeks: StudentWeek[], dataAvailable = true) =>
  categoriseStudent({ weeks, dataAvailable }).category;

describe('categoriseStudent', () => {
  it('calls six strong weeks a consistent solver', () => {
    const weeks = [1, 2, 3, 4, 5, 6].map((n) => week(n, 10, 8));
    expect(categorise(weeks)).toBe('CONSISTENT_SOLVER');
  });

  it('holds the 60% boundary as inclusive, the way the sheet states it', () => {
    expect(categorise([1, 2, 3, 4, 5, 6].map((n) => week(n, 10, 6)))).toBe('CONSISTENT_SOLVER');
    // One week a single question short is no longer "every week".
    const nearly = [1, 2, 3, 4, 5].map((n) => week(n, 10, 6)).concat(week(6, 10, 5));
    expect(categorise(nearly)).not.toBe('CONSISTENT_SOLVER');
  });

  it('calls a student under 20% every week not participating', () => {
    expect(categorise([1, 2, 3, 4, 5, 6].map((n) => week(n, 10, 1)))).toBe('NOT_PARTICIPATING');
  });

  it('does not call a student not participating on the strength of one good week', () => {
    const weeks = [1, 2, 3, 4, 5].map((n) => week(n, 10, 1)).concat(week(6, 10, 7));
    expect(categorise(weeks)).not.toBe('NOT_PARTICIPATING');
  });

  it('checks not-participating before inconsistent, in the sheet’s order', () => {
    // Two strong weeks would satisfy "Inconsistent", but nothing here is strong.
    const weeks = [1, 2, 3, 4, 5, 6].map((n) => week(n, 10, 0));
    expect(categorise(weeks)).toBe('NOT_PARTICIPATING');
  });

  it('calls two strong weeks among weak ones inconsistent', () => {
    const weeks = [week(1, 10, 8), week(2, 10, 8), week(3, 10, 3), week(4, 10, 3), week(5, 10, 3), week(6, 10, 3)];
    expect(categorise(weeks)).toBe('INCONSISTENT');
  });

  it('separates improving from declining on the two halves of the period', () => {
    const rising = [week(1, 10, 1), week(2, 10, 1), week(3, 10, 2), week(4, 10, 4), week(5, 10, 5), week(6, 10, 5)];
    const falling = [week(1, 10, 5), week(2, 10, 5), week(3, 10, 4), week(4, 10, 2), week(5, 10, 1), week(6, 10, 1)];
    expect(categorise(rising)).toBe('IMPROVING');
    expect(categorise(falling)).toBe('DECLINING');
  });

  describe('a gap in measurement is never reported as a gap in effort', () => {
    it('reports DATA_UNAVAILABLE rather than scoring an unreadable profile as zero', () => {
      const weeks = [1, 2, 3, 4, 5, 6].map((n) => week(n, 10, 0));
      // The same rows that would read "Not Participating" if we trusted them.
      expect(categorise(weeks, true)).toBe('NOT_PARTICIPATING');
      expect(categorise(weeks, false)).toBe('DATA_UNAVAILABLE');
    });

    it('reports NOT_OBSERVED for a student who joined too late to have a trend', () => {
      const weeks = [
        week(1, 10, 0, { observed: false }),
        week(2, 10, 0, { observed: false }),
        week(3, 10, 0, { observed: false }),
        week(4, 10, 0, { observed: false }),
        week(5, 10, 8),
        week(6, 10, 9),
      ];
      expect(categorise(weeks)).toBe('NOT_OBSERVED');
    });

    it('judges a late joiner once enough of the period is observed', () => {
      const weeks = [
        week(1, 10, 0, { observed: false }),
        week(2, 10, 0, { observed: false }),
        week(3, 10, 8),
        week(4, 10, 8),
        week(5, 10, 8),
        week(6, 10, 9),
      ];
      expect(categorise(weeks)).toBe('CONSISTENT_SOLVER');
      expect(categoriseStudent({ weeks, dataAvailable: true }).consideredWeeks).toBe(4);
    });

    it('needs MIN_OBSERVED_WEEKS weeks, not one more or one fewer', () => {
      const observedWeeks = (n: number) =>
        [1, 2, 3, 4, 5, 6].map((w) => week(w, 10, 8, { observed: w <= n }));
      expect(categorise(observedWeeks(MIN_OBSERVED_WEEKS - 1))).toBe('NOT_OBSERVED');
      expect(categorise(observedWeeks(MIN_OBSERVED_WEEKS))).not.toBe('NOT_OBSERVED');
    });

    it('ignores weeks with nothing assigned rather than counting them against the student', () => {
      // Week 3 set no work. Solving none of nothing is not a weak week.
      const weeks = [week(1, 10, 8), week(2, 10, 8), week(3, 0, 0), week(4, 10, 8), week(5, 10, 8), week(6, 10, 8)];
      const verdict = categoriseStudent({ weeks, dataAvailable: true });
      expect(verdict.category).toBe('CONSISTENT_SOLVER');
      expect(verdict.consideredWeeks).toBe(5);
    });

    it('does not treat an empty period as anything but unobserved', () => {
      expect(categorise([])).toBe('NOT_OBSERVED');
    });
  });

  it('states the evidence for its verdict', () => {
    const verdict = categoriseStudent({
      weeks: [1, 2, 3, 4, 5, 6].map((n) => week(n, 10, 1)),
      dataAvailable: true,
    });
    expect(verdict.because).toContain('20%');
    expect(verdict.overallPercent).toBeCloseTo(0.1);
  });
});

describe('analysisWeeks', () => {
  it('reproduces the reference workbook’s six weeks exactly', () => {
    const weeks = analysisWeeks('2026-08-06', '2026-09-13');
    expect(weeks).toEqual([
      { weekNumber: 1, from: '2026-08-06', to: '2026-08-09' },
      { weekNumber: 2, from: '2026-08-10', to: '2026-08-16' },
      { weekNumber: 3, from: '2026-08-17', to: '2026-08-23' },
      { weekNumber: 4, from: '2026-08-24', to: '2026-08-30' },
      { weekNumber: 5, from: '2026-08-31', to: '2026-09-06' },
      { weekNumber: 6, from: '2026-09-07', to: '2026-09-13' },
    ]);
  });

  it('clips the last week to the period rather than running past it', () => {
    const weeks = analysisWeeks('2026-08-06', '2026-09-10');
    expect(weeks[weeks.length - 1]).toEqual({ weekNumber: 6, from: '2026-09-07', to: '2026-09-10' });
  });

  it('handles a period inside a single week', () => {
    expect(analysisWeeks('2026-08-11', '2026-08-13')).toEqual([
      { weekNumber: 1, from: '2026-08-11', to: '2026-08-13' },
    ]);
  });

  it('returns nothing for an inverted or invalid period', () => {
    expect(analysisWeeks('2026-09-13', '2026-08-06')).toEqual([]);
    expect(analysisWeeks('not-a-date', '2026-08-06')).toEqual([]);
  });
});
