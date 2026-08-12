/**
 * The rules that stop a batch move from rewriting history.
 *
 * Every case here is a way the naive implementation ("read `Student.batchId`") gets a
 * past day wrong. They are pure functions, so these run without a database and are the
 * fastest place to pin the behaviour down.
 */

import { describe, expect, it } from 'vitest';

import {
  deriveBatchCode,
  isRedundantMove,
  normaliseBatchCode,
  resolveBatchOnDay,
  resolveFrozenField,
  selectAssignmentForBatch,
  type BatchPlacement,
} from './batch';

const FOUNDATION = 'batch-a';
const INTERMEDIATE = 'batch-b';

const placement = (
  toBatchId: string | null,
  effectiveFromDayKey: string,
  changedAt = `${effectiveFromDayKey}T10:00:00Z`,
): BatchPlacement => ({
  toBatchId,
  effectiveFromDayKey,
  changedAt: new Date(changedAt),
});

describe('resolveBatchOnDay', () => {
  it('returns null when the student has no placements at all', () => {
    expect(resolveBatchOnDay([], '2026-08-10')).toBeNull();
  });

  it('returns null for a day before the first placement took effect', () => {
    // The student had not been classified yet. Substituting their current batch here
    // would file a day under a batch that did not apply to them at the time.
    const history = [placement(FOUNDATION, '2026-08-12')];
    expect(resolveBatchOnDay(history, '2026-08-10')).toBeNull();
  });

  it('returns the placement in effect on the day itself', () => {
    const history = [placement(FOUNDATION, '2026-08-10')];
    expect(resolveBatchOnDay(history, '2026-08-10')).toBe(FOUNDATION);
  });

  /**
   * The scenario from the spec: Foundation on 10 Aug, moved to Intermediate on 15 Aug.
   * Both answers must remain true forever, from the same history.
   */
  it('keeps a past day on the old batch after the student moves', () => {
    const history = [
      placement(FOUNDATION, '2026-08-01'),
      placement(INTERMEDIATE, '2026-08-15'),
    ];

    expect(resolveBatchOnDay(history, '2026-08-10')).toBe(FOUNDATION);
    expect(resolveBatchOnDay(history, '2026-08-11')).toBe(FOUNDATION);
    // The move is effective from the 15th, inclusive.
    expect(resolveBatchOnDay(history, '2026-08-14')).toBe(FOUNDATION);
    expect(resolveBatchOnDay(history, '2026-08-15')).toBe(INTERMEDIATE);
    expect(resolveBatchOnDay(history, '2026-08-20')).toBe(INTERMEDIATE);
  });

  it('handles a student moved back again', () => {
    const history = [
      placement(FOUNDATION, '2026-08-10'),
      placement(INTERMEDIATE, '2026-08-15'),
      placement(FOUNDATION, '2026-08-20'),
    ];

    expect(resolveBatchOnDay(history, '2026-08-12')).toBe(FOUNDATION);
    expect(resolveBatchOnDay(history, '2026-08-17')).toBe(INTERMEDIATE);
    expect(resolveBatchOnDay(history, '2026-08-25')).toBe(FOUNDATION);
  });

  it('does not depend on the order rows arrive in', () => {
    const ordered = [placement(FOUNDATION, '2026-08-01'), placement(INTERMEDIATE, '2026-08-15')];
    const shuffled = [...ordered].reverse();

    expect(resolveBatchOnDay(shuffled, '2026-08-10')).toBe(
      resolveBatchOnDay(ordered, '2026-08-10'),
    );
    expect(resolveBatchOnDay(shuffled, '2026-08-16')).toBe(
      resolveBatchOnDay(ordered, '2026-08-16'),
    );
  });

  it('breaks a same-day tie with the later recorded change', () => {
    // Two corrections on one day: the one recorded last is the decision that stands.
    const history = [
      placement(FOUNDATION, '2026-08-10', '2026-08-10T09:00:00Z'),
      placement(INTERMEDIATE, '2026-08-10', '2026-08-10T15:00:00Z'),
    ];
    expect(resolveBatchOnDay(history, '2026-08-10')).toBe(INTERMEDIATE);
  });

  it('reports "no batch" when the student was moved out of every batch', () => {
    const history = [placement(FOUNDATION, '2026-08-01'), placement(null, '2026-08-15')];
    expect(resolveBatchOnDay(history, '2026-08-10')).toBe(FOUNDATION);
    expect(resolveBatchOnDay(history, '2026-08-16')).toBeNull();
  });
});

describe('selectAssignmentForBatch', () => {
  const foundationSet = { id: 'a-set', batchId: FOUNDATION };
  const intermediateSet = { id: 'b-set', batchId: INTERMEDIATE };
  const legacySet = { id: 'legacy', batchId: null };

  it("picks the student's own batch set", () => {
    expect(selectAssignmentForBatch([foundationSet, intermediateSet], FOUNDATION)).toBe(
      foundationSet,
    );
    expect(selectAssignmentForBatch([foundationSet, intermediateSet], INTERMEDIATE)).toBe(
      intermediateSet,
    );
  });

  /** The rule the whole feature exists to guarantee (§4). */
  it("never falls back to another batch's questions", () => {
    // Intermediate has work today; Foundation does not. A Foundation student has nothing
    // assigned — they must not be measured against Intermediate's problems.
    expect(selectAssignmentForBatch([intermediateSet], FOUNDATION)).toBeNull();
  });

  it('falls back to a pre-batch assignment that applied to everyone', () => {
    expect(selectAssignmentForBatch([legacySet], FOUNDATION)).toBe(legacySet);
    expect(selectAssignmentForBatch([legacySet], INTERMEDIATE)).toBe(legacySet);
    expect(selectAssignmentForBatch([legacySet], null)).toBe(legacySet);
  });

  it('prefers the batch-specific set over the legacy one', () => {
    expect(selectAssignmentForBatch([legacySet, foundationSet], FOUNDATION)).toBe(foundationSet);
  });

  it('gives a batchless student only the legacy set', () => {
    expect(selectAssignmentForBatch([foundationSet, intermediateSet], null)).toBeNull();
    expect(selectAssignmentForBatch([foundationSet, legacySet], null)).toBe(legacySet);
  });

  it('returns null when nothing was assigned', () => {
    expect(selectAssignmentForBatch([], FOUNDATION)).toBeNull();
  });
});

describe('isRedundantMove', () => {
  it('rejects moving a student to the batch they are already in', () => {
    expect(isRedundantMove(FOUNDATION, FOUNDATION)).toBe(true);
  });

  it('allows a genuine move, including a first placement', () => {
    expect(isRedundantMove(FOUNDATION, INTERMEDIATE)).toBe(false);
    expect(isRedundantMove(null, FOUNDATION)).toBe(false);
  });
});

describe('batch codes', () => {
  it('normalises case and surrounding whitespace', () => {
    expect(normaliseBatchCode(' a ')).toBe('A');
    expect(normaliseBatchCode('foundation')).toBe('FOUNDATION');
  });

  it('derives a usable code from a batch name', () => {
    expect(deriveBatchCode('Foundation Level')).toBe('FOUNDATION-LEVEL');
    expect(deriveBatchCode('Batch 2026')).toBe('BATCH-2026');
    expect(deriveBatchCode('  A (Foundation)  ')).toBe('A-FOUNDATION');
  });

  it('never returns an empty code', () => {
    expect(deriveBatchCode('!!!')).toBe('BATCH');
    expect(deriveBatchCode('')).toBe('BATCH');
  });
});

describe('resolveFrozenField', () => {
  it('keeps the existing value once a day is closed (the default, unforced path)', () => {
    expect(resolveFrozenField('legacy-assignment', 'sliding-window-assignment')).toBe(
      'legacy-assignment',
    );
  });

  it('adopts the incoming value the first time a day is computed', () => {
    expect(resolveFrozenField(null, 'sliding-window-assignment')).toBe(
      'sliding-window-assignment',
    );
    expect(resolveFrozenField(undefined, 'sliding-window-assignment')).toBe(
      'sliding-window-assignment',
    );
  });

  it('force bypasses the freeze even when a value already exists', () => {
    expect(resolveFrozenField('legacy-assignment', 'sliding-window-assignment', true)).toBe(
      'sliding-window-assignment',
    );
  });

  it('force is a no-op when there was nothing frozen yet', () => {
    expect(resolveFrozenField(null, 'sliding-window-assignment', true)).toBe(
      'sliding-window-assignment',
    );
  });
});
