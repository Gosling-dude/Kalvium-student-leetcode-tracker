import { describe, expect, it } from 'vitest';

import {
  assertInfosysQuestionTotalsReconcile,
  categoriseInfosysStudent,
  type InfosysStudentWeek,
} from './infosys-analysis';

function week(
  weekNumber: number,
  assigned: number,
  solved: number,
  attemptedNotSolved: number,
): InfosysStudentWeek {
  const notAttempted = assigned - solved - attemptedNotSolved;
  return {
    weekNumber,
    from: `2026-0${weekNumber}-01`,
    to: `2026-0${weekNumber}-07`,
    assigned,
    solved,
    attemptedNotSolved,
    notAttempted,
  };
}

describe('categoriseInfosysStudent', () => {
  it('PROFILE_NOT_LINKED wins regardless of weeks (never a computed zero, §6)', () => {
    const verdict = categoriseInfosysStudent({
      weeks: [week(1, 4, 0, 0)],
      profileState: 'PROFILE_NOT_LINKED',
    });
    expect(verdict.category).toBe('PROFILE_NOT_LINKED');
  });

  it('DATA_UNAVAILABLE wins over any weekly figures', () => {
    const verdict = categoriseInfosysStudent({
      weeks: [week(1, 4, 4, 0)],
      profileState: 'DATA_UNAVAILABLE',
    });
    expect(verdict.category).toBe('DATA_UNAVAILABLE');
  });

  it('DATA_UNAVAILABLE when no questions have been assigned yet', () => {
    const verdict = categoriseInfosysStudent({ weeks: [], profileState: 'OK' });
    expect(verdict.category).toBe('DATA_UNAVAILABLE');
  });

  it('CONSISTENT_SOLVER: >=60% solved every observed week', () => {
    const verdict = categoriseInfosysStudent({
      weeks: [week(1, 4, 4, 0), week(2, 4, 3, 0), week(3, 4, 3, 1)],
      profileState: 'OK',
    });
    expect(verdict.category).toBe('CONSISTENT_SOLVER');
  });

  it('NOT_PARTICIPATING: under 20% attempted every week', () => {
    const verdict = categoriseInfosysStudent({
      weeks: [week(1, 4, 0, 0), week(2, 4, 0, 0), week(3, 4, 0, 0)],
      profileState: 'OK',
    });
    expect(verdict.category).toBe('NOT_PARTICIPATING');
  });

  it('TRYING_BUT_STRUGGLING: high attempt rate, low solve rate, every week', () => {
    const verdict = categoriseInfosysStudent({
      // 4/4 attempted (100%), 0/4 solved (0%) each week.
      weeks: [week(1, 4, 0, 4), week(2, 4, 0, 4), week(3, 4, 0, 4)],
      profileState: 'OK',
    });
    expect(verdict.category).toBe('TRYING_BUT_STRUGGLING');
  });

  it('INCONSISTENT: strong in some weeks, not all, and not struggling-shaped', () => {
    const verdict = categoriseInfosysStudent({
      weeks: [week(1, 4, 4, 0), week(2, 4, 0, 0), week(3, 4, 4, 0)],
      profileState: 'OK',
    });
    expect(verdict.category).toBe('INCONSISTENT');
  });

  it('IMPROVING: second half solves a higher share than the first, no week hits the strong-week bar', () => {
    const verdict = categoriseInfosysStudent({
      weeks: [week(1, 4, 1, 1), week(2, 4, 1, 1), week(3, 4, 2, 1), week(4, 4, 2, 1)],
      profileState: 'OK',
    });
    expect(verdict.strongWeeks).toBe(0);
    expect(verdict.category).toBe('IMPROVING');
  });

  it('DECLINING: second half solves a lower share than the first, no week hits the strong-week bar', () => {
    const verdict = categoriseInfosysStudent({
      weeks: [week(1, 4, 2, 1), week(2, 4, 2, 1), week(3, 4, 1, 1), week(4, 4, 1, 1)],
      profileState: 'OK',
    });
    expect(verdict.strongWeeks).toBe(0);
    expect(verdict.category).toBe('DECLINING');
  });

  it('weeks with nothing assigned are excluded from consideration', () => {
    const verdict = categoriseInfosysStudent({
      weeks: [week(1, 0, 0, 0), week(2, 4, 4, 0), week(3, 4, 4, 0), week(4, 4, 3, 1)],
      profileState: 'OK',
    });
    expect(verdict.consideredWeeks).toBe(3);
    expect(verdict.category).toBe('CONSISTENT_SOLVER');
  });

  it('category order: CONSISTENT_SOLVER is checked before NOT_PARTICIPATING', () => {
    // Every week is both "all >=60%" and cannot also be "<20% attempted" — sanity check
    // that a fully-solved record never falls through to a later branch.
    const verdict = categoriseInfosysStudent({
      weeks: [week(1, 4, 4, 0)],
      profileState: 'OK',
    });
    expect(verdict.category).toBe('CONSISTENT_SOLVER');
  });
});

describe('assertInfosysQuestionTotalsReconcile', () => {
  it('passes when the partition holds', () => {
    expect(
      assertInfosysQuestionTotalsReconcile({
        weekNumber: 1,
        assigned: 4,
        solved: 2,
        attemptedNotSolved: 1,
        notAttempted: 1,
      }),
    ).toBeNull();
  });

  it('reports the mismatch when it does not (the exact bug class §9 warns about)', () => {
    const message = assertInfosysQuestionTotalsReconcile({
      weekNumber: 1,
      assigned: 4,
      solved: 2,
      attemptedNotSolved: 1,
      notAttempted: 5, // e.g. students x questions instead of distinct questions
    });
    expect(message).toContain('Week 1');
    expect(message).toContain('but 4 were assigned');
  });
});
