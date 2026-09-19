import { describe, expect, it } from 'vitest';

import { countInfosysSolved, evaluateInfosysDay, type InfosysAssignedProblemRef } from './infosys-completion';

const TRACKING_START = new Date('2026-09-20T00:00:00.000Z');

const twoSum: InfosysAssignedProblemRef = { problemId: 'p1', titleSlug: 'two-sum', position: 1 };
const reverseString: InfosysAssignedProblemRef = {
  problemId: 'p2',
  titleSlug: 'reverse-string',
  position: 2,
};

describe('evaluateInfosysDay', () => {
  it('SOLVED: an accepted submission at or after the tracking start date', () => {
    const [outcome] = evaluateInfosysDay(
      [twoSum],
      [{ titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: new Date('2026-09-21') }],
      TRACKING_START,
    );
    expect(outcome!.status).toBe('SOLVED');
    expect(outcome!.solvedAt).toEqual(new Date('2026-09-21'));
  });

  it('NOT_ATTEMPTED: an accepted submission exists but before the tracking start date (§2, §13)', () => {
    const [outcome] = evaluateInfosysDay(
      [twoSum],
      [{ titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: new Date('2026-09-15') }],
      TRACKING_START,
    );
    expect(outcome!.status).toBe('NOT_ATTEMPTED');
    expect(outcome!.solvedAt).toBeNull();
  });

  it('ATTEMPTED_NOT_SOLVED: only non-accepted submissions in the window', () => {
    const [outcome] = evaluateInfosysDay(
      [twoSum],
      [{ titleSlug: 'two-sum', status: 'WRONG_ANSWER', submittedAt: new Date('2026-09-21') }],
      TRACKING_START,
    );
    expect(outcome!.status).toBe('ATTEMPTED_NOT_SOLVED');
    expect(outcome!.attempts).toBe(1);
  });

  it('NOT_ATTEMPTED: no submissions at all', () => {
    const [outcome] = evaluateInfosysDay([twoSum], [], TRACKING_START);
    expect(outcome!.status).toBe('NOT_ATTEMPTED');
  });

  it('a pre-window wrong answer does not count as an attempt either', () => {
    const [outcome] = evaluateInfosysDay(
      [twoSum],
      [{ titleSlug: 'two-sum', status: 'WRONG_ANSWER', submittedAt: new Date('2026-09-10') }],
      TRACKING_START,
    );
    expect(outcome!.status).toBe('NOT_ATTEMPTED');
    expect(outcome!.attempts).toBe(0);
  });

  it('SOLVED wins even with prior in-window wrong answers (earliest accepted, not first submission)', () => {
    const [outcome] = evaluateInfosysDay(
      [twoSum],
      [
        { titleSlug: 'two-sum', status: 'WRONG_ANSWER', submittedAt: new Date('2026-09-21T10:00:00Z') },
        { titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: new Date('2026-09-22T10:00:00Z') },
      ],
      TRACKING_START,
    );
    expect(outcome!.status).toBe('SOLVED');
    expect(outcome!.solvedAt).toEqual(new Date('2026-09-22T10:00:00Z'));
    expect(outcome!.attempts).toBe(2);
  });

  it('10 submissions, 2 accepted, for the same problem = 1 solved question, not 2 (§7)', () => {
    const [outcome] = evaluateInfosysDay(
      [twoSum],
      Array.from({ length: 8 }, (_, i) => ({
        titleSlug: 'two-sum',
        status: 'WRONG_ANSWER',
        submittedAt: new Date(`2026-09-2${(i % 9) + 1}T00:00:00Z`),
      })).concat([
        { titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: new Date('2026-09-25T00:00:00Z') },
        { titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: new Date('2026-09-26T00:00:00Z') },
      ]),
      TRACKING_START,
    );
    expect(outcome!.status).toBe('SOLVED');
    expect(outcome!.attempts).toBe(10);
    expect(countInfosysSolved([outcome!])).toBe(1);
  });

  it('evaluates each assigned problem independently by canonical slug', () => {
    const outcomes = evaluateInfosysDay(
      [twoSum, reverseString],
      [{ titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: new Date('2026-09-21') }],
      TRACKING_START,
    );
    expect(outcomes.find((o) => o.problemId === 'p1')!.status).toBe('SOLVED');
    expect(outcomes.find((o) => o.problemId === 'p2')!.status).toBe('NOT_ATTEMPTED');
  });

  it('slug matching is case-insensitive', () => {
    const [outcome] = evaluateInfosysDay(
      [twoSum],
      [{ titleSlug: 'TWO-SUM', status: 'ACCEPTED', submittedAt: new Date('2026-09-21') }],
      TRACKING_START,
    );
    expect(outcome!.status).toBe('SOLVED');
  });

  it('a submission exactly at the tracking start instant counts', () => {
    const [outcome] = evaluateInfosysDay(
      [twoSum],
      [{ titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: TRACKING_START }],
      TRACKING_START,
    );
    expect(outcome!.status).toBe('SOLVED');
  });

  it('countInfosysSolved counts distinct SOLVED outcomes across the assigned set', () => {
    const outcomes = evaluateInfosysDay(
      [twoSum, reverseString],
      [
        { titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: new Date('2026-09-21') },
        { titleSlug: 'reverse-string', status: 'ACCEPTED', submittedAt: new Date('2026-09-21') },
      ],
      TRACKING_START,
    );
    expect(countInfosysSolved(outcomes)).toBe(2);
  });
});
