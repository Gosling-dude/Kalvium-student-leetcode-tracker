import { describe, expect, it } from 'vitest';

import { dayKeyOf, resolvePlacementEffectiveDate } from './seed-students';

describe('dayKeyOf', () => {
  it('renders a UTC instant as its Asia/Kolkata calendar day', () => {
    // 2026-08-11T20:00:00Z is 2026-08-12 01:30 IST — already the next day locally.
    expect(dayKeyOf(new Date('2026-08-11T20:00:00Z'))).toBe('2026-08-12');
  });

  it('does not shift a mid-day UTC instant', () => {
    expect(dayKeyOf(new Date('2026-08-11T10:00:00Z'))).toBe('2026-08-11');
  });
});

describe('resolvePlacementEffectiveDate', () => {
  // The exact bug this guards: a roster sync correcting 41 pre-existing students off a
  // legacy placeholder batch must back-date their placement to enrolment, not to the day
  // the sync happened to run — otherwise every already-existing assignment/report for a
  // date between enrolment and the sync date resolves to "no batch" for these students,
  // which is precisely what produced Mentor View's "0 students" bug.
  it('back-dates a first-ever placement to enrolment, not to today', () => {
    expect(
      resolvePlacementEffectiveDate({
        hasPriorPlacements: false,
        todayDayKey: '2026-08-12',
        enrolmentDayKey: '2026-08-04',
      }),
    ).toBe('2026-08-04');
  });

  it('does not back-date a genuine move between two batches the student was actually placed in', () => {
    expect(
      resolvePlacementEffectiveDate({
        hasPriorPlacements: true,
        todayDayKey: '2026-08-12',
        enrolmentDayKey: '2026-08-04',
      }),
    ).toBe('2026-08-12');
  });

  it('is a no-op when enrolment and today coincide (a brand-new roster row)', () => {
    expect(
      resolvePlacementEffectiveDate({
        hasPriorPlacements: false,
        todayDayKey: '2026-08-12',
        enrolmentDayKey: '2026-08-12',
      }),
    ).toBe('2026-08-12');
  });
});
