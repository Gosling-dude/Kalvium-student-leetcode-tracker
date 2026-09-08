import { describe, expect, it } from 'vitest';

import {
  completionRate,
  describeNotObserved,
  isObserved,
  observedSolvedFloor,
  resolveObservability,
  summariseCohort,
} from './observability';

describe('resolveObservability', () => {
  it('is NOT_OBSERVED for a day before the tracker first saw the student', () => {
    expect(
      resolveObservability({ observedFromDayKey: '2026-09-08', dayKey: '2026-08-25' }),
    ).toBe('NOT_OBSERVED');
  });

  it('is OBSERVED from the very first day, not the day after', () => {
    expect(
      resolveObservability({ observedFromDayKey: '2026-09-08', dayKey: '2026-09-08' }),
    ).toBe('OBSERVED');
  });

  it('is OBSERVED for every later day', () => {
    expect(
      resolveObservability({ observedFromDayKey: '2026-08-23', dayKey: '2026-09-03' }),
    ).toBe('OBSERVED');
  });

  it('compares dates chronologically across month and year boundaries', () => {
    // Lexical comparison on zero-padded ISO dates is the whole trick; a naive
    // string compare on unpadded dates would call 2026-09-08 earlier than 2026-10-01.
    expect(
      resolveObservability({ observedFromDayKey: '2026-10-01', dayKey: '2026-09-30' }),
    ).toBe('NOT_OBSERVED');
    expect(
      resolveObservability({ observedFromDayKey: '2025-12-31', dayKey: '2026-01-01' }),
    ).toBe('OBSERVED');
  });

  it('isObserved agrees with resolveObservability', () => {
    expect(isObserved({ observedFromDayKey: '2026-09-08', dayKey: '2026-08-25' })).toBe(false);
    expect(isObserved({ observedFromDayKey: '2026-08-01', dayKey: '2026-08-25' })).toBe(true);
  });
});

describe('summariseCohort', () => {
  it('separates the roster from the denominator', () => {
    // The 2026-09-08 SRM state: 142 on the roster, 99 the tracker was watching on 25 Aug.
    expect(summariseCohort(142, 99)).toEqual({
      rosterTotal: 142,
      evaluated: 99,
      notObserved: 43,
    });
  });

  it('reports nothing unobserved when the whole roster was watched', () => {
    expect(summariseCohort(99, 99)).toEqual({
      rosterTotal: 99,
      evaluated: 99,
      notObserved: 0,
    });
  });

  it('never reports a negative unobserved count', () => {
    expect(summariseCohort(10, 12).notObserved).toBe(0);
  });
});

describe('completionRate', () => {
  it('divides by the observed cohort, not the whole roster', () => {
    // 20 of 99 observed students solved everything. Over the 142-strong roster that
    // would read 14.08% — understating the cohort we actually watched.
    expect(completionRate(20, 99)).toBe(20.2);
  });

  it('is null rather than zero when nothing was observed', () => {
    // The bug this guards: a day with no observations has no completion rate. Rendering
    // it as 0% is the same fabrication as a 0-solved row.
    expect(completionRate(0, 0)).toBeNull();
  });

  it('is genuinely zero when we watched people and none of them solved anything', () => {
    expect(completionRate(0, 99)).toBe(0);
  });
});

describe('observedSolvedFloor', () => {
  it('reports proven solves as a floor', () => {
    expect(observedSolvedFloor(2)).toBe(2);
  });

  it('floors at zero', () => {
    expect(observedSolvedFloor(-1)).toBe(0);
  });
});

describe('describeNotObserved', () => {
  it('names the join date so a mentor can see why the row is blank', () => {
    expect(describeNotObserved('2026-09-08')).toContain('2026-09-08');
    expect(describeNotObserved('2026-09-08')).not.toMatch(/\b0\b/);
  });
});
