/**
 * The rules that stop a campus transfer from rewriting history, and that stop one
 * campus's problem set from reaching another campus's students.
 *
 * Every case here is a way the naive implementation ("read `Student.campusId`", or "if
 * there's no batch row, use the batch-less one") gets an answer wrong. Pure functions, so
 * these run without a database and are the cheapest place to pin the behaviour down.
 */

import { describe, expect, it } from 'vitest';

import {
  deriveCampusCode,
  describeScope,
  isLegalScope,
  normaliseCampusCode,
  resolveCampusOnDay,
  scopeApplies,
  scopeSpecificity,
  selectAssignmentForScope,
  type CampusPlacement,
} from './campus';

const VELS = 'campus-vels';
const SRM = 'campus-srm';
const FOUNDATION = 'batch-foundation';
const INTERMEDIATE = 'batch-intermediate';

const placement = (
  toCampusId: string | null,
  effectiveFromDayKey: string,
  changedAt = `${effectiveFromDayKey}T10:00:00Z`,
): CampusPlacement => ({
  toCampusId,
  effectiveFromDayKey,
  changedAt: new Date(changedAt),
});

describe('resolveCampusOnDay', () => {
  it('returns null when the student has no placements at all', () => {
    expect(resolveCampusOnDay([], '2026-08-10')).toBeNull();
  });

  it('returns null for a day before the first placement took effect', () => {
    // Substituting the current campus here would file a day under a campus the student
    // demonstrably was not in yet.
    expect(resolveCampusOnDay([placement(SRM, '2026-08-20')], '2026-08-10')).toBeNull();
  });

  it('returns the campus in force on the day, not the current one', () => {
    const history = [placement(VELS, '2026-01-01'), placement(SRM, '2026-08-20')];

    expect(resolveCampusOnDay(history, '2026-08-10')).toBe(VELS);
    expect(resolveCampusOnDay(history, '2026-08-19')).toBe(VELS);
    // The move is inclusive of its own effective day.
    expect(resolveCampusOnDay(history, '2026-08-20')).toBe(SRM);
    expect(resolveCampusOnDay(history, '2026-08-21')).toBe(SRM);
  });

  it('does not care what order the placements arrive in', () => {
    const forwards = [placement(VELS, '2026-01-01'), placement(SRM, '2026-08-20')];
    const backwards = [...forwards].reverse();

    expect(resolveCampusOnDay(backwards, '2026-08-10')).toBe(
      resolveCampusOnDay(forwards, '2026-08-10'),
    );
    expect(resolveCampusOnDay(backwards, '2026-08-25')).toBe(SRM);
  });

  it('breaks a same-day tie with the later recording', () => {
    // Someone transferred and was transferred back on the same day. The last decision
    // recorded is the one that stands.
    const history = [
      placement(SRM, '2026-08-20', '2026-08-20T09:00:00Z'),
      placement(VELS, '2026-08-20', '2026-08-20T17:00:00Z'),
    ];
    expect(resolveCampusOnDay(history, '2026-08-20')).toBe(VELS);
  });

  it('honours a placement that moved a student out of every campus', () => {
    const history = [placement(VELS, '2026-01-01'), placement(null, '2026-08-20')];
    expect(resolveCampusOnDay(history, '2026-08-25')).toBeNull();
    expect(resolveCampusOnDay(history, '2026-08-01')).toBe(VELS);
  });
});

describe('scope legality and specificity', () => {
  it('rejects a batch without a campus', () => {
    // The batch already names a campus, so the pair could contradict itself.
    expect(isLegalScope({ campusId: null, batchId: FOUNDATION })).toBe(false);
  });

  it('accepts the three widening forms', () => {
    expect(isLegalScope({ campusId: VELS, batchId: FOUNDATION })).toBe(true);
    expect(isLegalScope({ campusId: VELS, batchId: null })).toBe(true);
    expect(isLegalScope({ campusId: null, batchId: null })).toBe(true);
  });

  it('orders campus+batch above campus above everyone', () => {
    expect(scopeSpecificity({ campusId: VELS, batchId: FOUNDATION })).toBeGreaterThan(
      scopeSpecificity({ campusId: VELS, batchId: null }),
    );
    expect(scopeSpecificity({ campusId: VELS, batchId: null })).toBeGreaterThan(
      scopeSpecificity({ campusId: null, batchId: null }),
    );
  });
});

describe('scopeApplies', () => {
  const student = { campusId: SRM, batchId: FOUNDATION };

  it('matches an exact campus + batch target', () => {
    expect(scopeApplies({ campusId: SRM, batchId: FOUNDATION }, student)).toBe(true);
  });

  it('matches a whole-campus target', () => {
    expect(scopeApplies({ campusId: SRM, batchId: null }, student)).toBe(true);
  });

  it('matches an everyone target', () => {
    expect(scopeApplies({ campusId: null, batchId: null }, student)).toBe(true);
  });

  it('does not match another campus, even for the same batch level', () => {
    expect(scopeApplies({ campusId: VELS, batchId: FOUNDATION }, student)).toBe(false);
    expect(scopeApplies({ campusId: VELS, batchId: null }, student)).toBe(false);
  });

  it('does not match another batch in the same campus', () => {
    expect(scopeApplies({ campusId: SRM, batchId: INTERMEDIATE }, student)).toBe(false);
  });
});

describe('selectAssignmentForScope', () => {
  const velsFoundation = { id: 'a', campusId: VELS, batchId: FOUNDATION };
  const velsIntermediate = { id: 'b', campusId: VELS, batchId: INTERMEDIATE };
  const srmFoundation = { id: 'c', campusId: SRM, batchId: FOUNDATION };
  const srmIntermediate = { id: 'd', campusId: SRM, batchId: INTERMEDIATE };
  const srmAllBatches = { id: 'e', campusId: SRM, batchId: null };
  const everyone = { id: 'f', campusId: null, batchId: null };

  it('gives four independent scopes on one day their own set', () => {
    // The central §9 requirement: one calendar date, four non-colliding problem sets.
    const day = [velsFoundation, velsIntermediate, srmFoundation, srmIntermediate];

    expect(selectAssignmentForScope(day, { campusId: VELS, batchId: FOUNDATION })?.id).toBe('a');
    expect(selectAssignmentForScope(day, { campusId: VELS, batchId: INTERMEDIATE })?.id).toBe('b');
    expect(selectAssignmentForScope(day, { campusId: SRM, batchId: FOUNDATION })?.id).toBe('c');
    expect(selectAssignmentForScope(day, { campusId: SRM, batchId: INTERMEDIATE })?.id).toBe('d');
  });

  it('never hands a student another campus’s problem set', () => {
    // An SRM Foundation student on a day where only Vels Foundation has work gets
    // nothing — a neutral day — rather than Vels' questions.
    expect(
      selectAssignmentForScope([velsFoundation], { campusId: SRM, batchId: FOUNDATION }),
    ).toBeNull();
  });

  it('prefers the batch-specific row over the campus-wide one', () => {
    expect(
      selectAssignmentForScope([srmAllBatches, srmFoundation], {
        campusId: SRM,
        batchId: FOUNDATION,
      })?.id,
    ).toBe('c');
  });

  it('prefers the campus-wide row over the everyone row', () => {
    expect(
      selectAssignmentForScope([everyone, srmAllBatches], { campusId: SRM, batchId: FOUNDATION })
        ?.id,
    ).toBe('e');
  });

  it('falls through to the everyone row when nothing narrower applies', () => {
    expect(
      selectAssignmentForScope([everyone, velsFoundation], {
        campusId: SRM,
        batchId: INTERMEDIATE,
      })?.id,
    ).toBe('f');
  });

  it('applies a whole-campus row to a student with no batch yet', () => {
    // Placement-pending students still receive campus-wide work.
    expect(
      selectAssignmentForScope([srmAllBatches], { campusId: SRM, batchId: null })?.id,
    ).toBe('e');
  });

  it('does not apply a batch-specific row to a student with no batch', () => {
    expect(
      selectAssignmentForScope([srmFoundation], { campusId: SRM, batchId: null }),
    ).toBeNull();
  });

  it('returns null for a student with no campus and no everyone row', () => {
    expect(
      selectAssignmentForScope([srmFoundation, velsFoundation], {
        campusId: null,
        batchId: null,
      }),
    ).toBeNull();
  });

  it('does not depend on the order rows come back from the database', () => {
    const forwards = [everyone, srmAllBatches, srmFoundation];
    const backwards = [...forwards].reverse();
    const student = { campusId: SRM, batchId: FOUNDATION };
    expect(selectAssignmentForScope(backwards, student)?.id).toBe(
      selectAssignmentForScope(forwards, student)?.id,
    );
  });
});

describe('codes and labels', () => {
  it('normalises campus codes case-insensitively', () => {
    expect(normaliseCampusCode('  srm ')).toBe('SRM');
  });

  it('derives a usable code from an institutional name', () => {
    expect(deriveCampusCode('Vels Institute of Science, Technology & Advanced Studies')).toBe(
      'VELS-INSTITUTE-OF-SCIENC',
    );
    expect(deriveCampusCode('!!!')).toBe('CAMPUS');
  });

  it('describes a fully specified audience', () => {
    expect(describeScope('SRM University', 'Foundation Level')).toBe(
      'SRM University — Foundation Level',
    );
  });

  it('says "all" explicitly rather than leaving a blank half', () => {
    expect(describeScope(null, null)).toBe('All campuses — All batches');
    expect(describeScope('SRM University', null)).toBe('SRM University — All batches');
  });
});
