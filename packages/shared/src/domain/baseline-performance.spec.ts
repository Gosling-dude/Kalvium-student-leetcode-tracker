/**
 * General performance — the rule that decides whether a student can solve a problem,
 * separately from whether they sat a test.
 *
 * This exists because an entire cohort read 0/4 on a baseline whose problems many of them
 * had demonstrably solved. The reason was structural: "solved" was read off participation
 * records, so a student who never clicked Start scored zero no matter what they had done.
 */

import { describe, expect, it } from 'vitest';

import {
  computeGeneralPerformance,
  countSolved,
  isPerformanceKnown,
  type BaselineSubmissionEvidence,
} from './baseline';

const SLUGS = [
  'valid-parentheses',
  'best-time-to-buy-and-sell-stock',
  'maximum-subarray',
  'merge-intervals',
];

function sub(
  titleSlug: string,
  status: string,
  iso: string,
): BaselineSubmissionEvidence {
  return { titleSlug, status, submittedAt: new Date(iso) };
}

describe('computeGeneralPerformance', () => {
  it('credits a solution written long before the test existed', () => {
    // The brief's own scenario: test on 22 Aug, solutions from the 15th, 20th and 25th.
    const performance = computeGeneralPerformance(SLUGS, [
      sub('valid-parentheses', 'ACCEPTED', '2026-08-15T10:00:00Z'),
      sub('maximum-subarray', 'ACCEPTED', '2026-08-20T10:00:00Z'),
      sub('merge-intervals', 'ACCEPTED', '2026-08-25T10:00:00Z'),
    ]);

    expect(countSolved(performance)).toBe(3);
    expect(performance.map((p) => p.solved)).toEqual([true, false, true, true]);
  });

  it('counts a problem once however many times it was submitted', () => {
    const performance = computeGeneralPerformance(['two-sum'], [
      sub('two-sum', 'WRONG_ANSWER', '2026-08-01T10:00:00Z'),
      sub('two-sum', 'WRONG_ANSWER', '2026-08-01T10:05:00Z'),
      sub('two-sum', 'ACCEPTED', '2026-08-01T10:10:00Z'),
      sub('two-sum', 'ACCEPTED', '2026-08-02T10:00:00Z'),
      sub('two-sum', 'ACCEPTED', '2026-08-03T10:00:00Z'),
    ]);

    expect(countSolved(performance)).toBe(1);
    expect(performance[0]!.attempts).toBe(5);
  });

  it('records the first and latest accepted submission', () => {
    const performance = computeGeneralPerformance(['two-sum'], [
      sub('two-sum', 'ACCEPTED', '2026-08-03T10:00:00Z'),
      sub('two-sum', 'ACCEPTED', '2026-08-01T10:00:00Z'),
      sub('two-sum', 'ACCEPTED', '2026-08-02T10:00:00Z'),
    ]);

    // Insertion order is deliberately scrambled — the rule sorts, it does not trust input.
    expect(performance[0]!.firstAcceptedAt?.toISOString()).toBe('2026-08-01T10:00:00.000Z');
    expect(performance[0]!.latestAcceptedAt?.toISOString()).toBe('2026-08-03T10:00:00.000Z');
  });

  it('does not count an unaccepted verdict as solved', () => {
    const performance = computeGeneralPerformance(['two-sum'], [
      sub('two-sum', 'WRONG_ANSWER', '2026-08-01T10:00:00Z'),
      sub('two-sum', 'TIME_LIMIT_EXCEEDED', '2026-08-01T10:05:00Z'),
    ]);

    expect(performance[0]!.solved).toBe(false);
    expect(performance[0]!.attempts).toBe(2);
    expect(performance[0]!.firstAcceptedAt).toBeNull();
  });

  it('separates "tried and failed" from "never touched it"', () => {
    const performance = computeGeneralPerformance(['tried', 'untouched'], [
      sub('tried', 'WRONG_ANSWER', '2026-08-01T10:00:00Z'),
    ]);

    expect(performance[0]).toMatchObject({ solved: false, attempts: 1 });
    expect(performance[1]).toMatchObject({ solved: false, attempts: 0 });
  });

  it('matches on the slug regardless of case', () => {
    const performance = computeGeneralPerformance(['Valid-Parentheses'], [
      sub('valid-parentheses', 'ACCEPTED', '2026-08-01T10:00:00Z'),
    ]);

    expect(performance[0]!.solved).toBe(true);
  });

  it('ignores submissions for problems outside the set', () => {
    // Students solve far more than any one test asks about; credit is for the set only.
    const performance = computeGeneralPerformance(['two-sum'], [
      sub('binary-search', 'ACCEPTED', '2026-08-01T10:00:00Z'),
      sub('merge-sort', 'ACCEPTED', '2026-08-01T10:00:00Z'),
    ]);

    expect(countSolved(performance)).toBe(0);
  });

  it('returns a row per problem even with no submissions at all', () => {
    const performance = computeGeneralPerformance(SLUGS, []);

    expect(performance).toHaveLength(4);
    expect(countSolved(performance)).toBe(0);
  });
});

describe('isPerformanceKnown', () => {
  it('is false for a student who has never synced successfully', () => {
    // We hold nothing for them. That is not the same as them having solved nothing, and
    // reporting it as 0 is the false zero the sync design exists to prevent.
    expect(isPerformanceKnown({ syncStatus: 'NEVER_SYNCED', lastSuccessAt: null })).toBe(false);
    expect(isPerformanceKnown({ syncStatus: 'PROFILE_MISSING', lastSuccessAt: null })).toBe(false);
    expect(isPerformanceKnown({ syncStatus: 'USER_NOT_FOUND', lastSuccessAt: null })).toBe(false);
  });

  it('is true once a sync has succeeded, even if the latest one failed', () => {
    // Mirrored submissions survive an outage — they are the last thing we genuinely knew,
    // so the number stands and the sync status explains its age.
    expect(
      isPerformanceKnown({ syncStatus: 'PROVIDER_ERROR', lastSuccessAt: new Date('2026-08-25') }),
    ).toBe(true);
    expect(
      isPerformanceKnown({ syncStatus: 'RATE_LIMITED', lastSuccessAt: new Date('2026-08-25') }),
    ).toBe(true);
  });

  it('is true for a healthy sync', () => {
    expect(isPerformanceKnown({ syncStatus: 'OK', lastSuccessAt: new Date('2026-08-26') })).toBe(true);
  });
});
