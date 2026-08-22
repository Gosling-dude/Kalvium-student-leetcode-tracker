/**
 * `SyncService` — which days a sync recomputes.
 *
 * This is the file the production bug lived in. A sync recomputed `job.dayKey ?? today`
 * and nothing else, so an assignment dated 20 Aug and entered on the 22nd was never
 * evaluated: the day it belonged to was simply never revisited. Every completion rule was
 * already correct; nothing ever asked them about that day.
 *
 * The tests below pin the three sources of "days this sync could have changed" and, just
 * as importantly, the bounds — a sync must widen its reach without turning into a
 * full-history rebuild.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncService } from './sync.service';
import type { StudentSyncResult } from './student-sync.service';

const TODAY = '2026-08-22';

function makeService(staleDays: string[] = []) {
  const rollup = {
    findStaleAssignmentDays: vi.fn(async () => staleDays),
    recomputeDay: vi.fn(async () => ({ students: 0, assigned: 0 })),
    recomputeStudentAggregates: vi.fn(async () => undefined),
    rebuildLeaderboards: vi.fn(async () => undefined),
  };

  const time = {
    today: () => TODAY,
    isValid: (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d),
    addDays: (day: string, n: number) => {
      const date = new Date(`${day}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + n);
      return date.toISOString().slice(0, 10);
    },
    range: (from: string, to: string) => {
      const days: string[] = [];
      for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; ) {
        days.push(d.toISOString().slice(0, 10));
        d = new Date(d.getTime() + 86_400_000);
      }
      return days;
    },
  };

  const cache = { flush: vi.fn(async () => undefined) };

  // Argument order mirrors the constructor exactly; only the three collaborators these
  // tests exercise are real stand-ins, the rest are never reached.
  const service = new SyncService(
    {} as never, // prisma
    cache as never,
    time as never,
    {} as never, // queue
    {} as never, // studentSync
    rollup as never,
    {} as never, // audit
    {} as never, // config
  );

  /** The method is private by design; these tests are what justify reaching for it. */
  const resolve = (
    jobDayKey: string,
    results: Partial<StudentSyncResult>[],
  ): Promise<string[]> =>
    (
      service as unknown as {
        resolveDaysToRecompute: (d: string, r: unknown[]) => Promise<string[]>;
      }
    ).resolveDaysToRecompute(jobDayKey, results);

  return { service, rollup, cache, resolve };
}

const result = (dayKeys: string[]): Partial<StudentSyncResult> => ({
  affectedDayKeys: dayKeys,
  newSubmissions: dayKeys.length,
  status: 'OK',
});

beforeEach(() => vi.clearAllMocks());

describe('resolveDaysToRecompute', () => {
  it('always includes the job day, even when nothing new arrived', async () => {
    const { resolve } = makeService();
    expect(await resolve(TODAY, [])).toEqual([TODAY]);
  });

  /**
   * The regression. Before the fix this returned `['2026-08-22']` and the 20th stayed
   * wrong however many times the mentor pressed Sync.
   */
  it('includes a day whose assignment was entered after the fact', async () => {
    const { resolve } = makeService(['2026-08-20']);
    expect(await resolve(TODAY, [])).toEqual(['2026-08-20', TODAY]);
  });

  it('reaches forward from a submission to the assignments it could satisfy', async () => {
    // A solve on the 18th can satisfy an assignment dated the 18th, 19th or 20th.
    // Recomputing only the 18th — the day the submission landed on — leaves the other
    // two wrong, which is the same class of bug one step removed.
    const { resolve } = makeService();
    expect(await resolve(TODAY, [result(['2026-08-18'])])).toEqual([
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      TODAY,
    ]);
  });

  it('returns oldest first, because streaks read the preceding day', async () => {
    const { resolve } = makeService(['2026-08-15']);
    const days = await resolve(TODAY, [result(['2026-08-19'])]);
    expect(days).toEqual([...days].sort());
  });

  it('de-duplicates days reached by several routes', async () => {
    const { resolve } = makeService(['2026-08-20']);
    const days = await resolve(TODAY, [
      result(['2026-08-18']),
      result(['2026-08-19']),
      result(['2026-08-20']),
    ]);
    expect(days).toEqual([...new Set(days)]);
  });

  it('never recomputes a day in the future', async () => {
    // A submission on the job day itself would otherwise reach two days past it.
    const { resolve } = makeService();
    const days = await resolve(TODAY, [result([TODAY])]);
    expect(days.every((day) => day <= TODAY)).toBe(true);
  });

  it('refuses to reach further back than its bound', async () => {
    // A sync refreshes recent history; rebuilding the whole archive is a deliberate
    // admin operation, not something a routine cron quietly starts doing.
    const { resolve } = makeService();
    const days = await resolve(TODAY, [result(['2026-01-01'])]);
    expect(days).toEqual([TODAY]);
  });

  it('asks for stale days only inside the same bound', async () => {
    const { rollup, resolve } = makeService();
    await resolve(TODAY, []);
    expect(rollup.findStaleAssignmentDays).toHaveBeenCalledWith('2026-08-08', TODAY);
  });

  it('ignores students whose sync failed and mirrored nothing', async () => {
    const { resolve } = makeService();
    expect(
      await resolve(TODAY, [{ affectedDayKeys: [], status: 'USER_NOT_FOUND', newSubmissions: 0 }]),
    ).toEqual([TODAY]);
  });
});

describe('backfillDay', () => {
  it('recomputes the day asked for, then every day it feeds into', async () => {
    // `streakAtDay` on 21 and 22 Aug is a function of what 20 Aug says. Correcting the
    // 20th without them would swap one visible error for two invisible ones.
    const { service, rollup } = makeService();

    const result = await service.backfillDay('2026-08-20');

    expect(rollup.recomputeDay.mock.calls.map((c) => c[0])).toEqual([
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
    ]);
    expect(result.daysRecomputed).toBe(3);
  });

  it('never reaches backwards past the day it was given', async () => {
    // Days before the backfilled one are genuinely unrelated and must be left alone.
    const { service, rollup } = makeService();
    await service.backfillDay('2026-08-20');
    expect(rollup.recomputeDay.mock.calls.every((c) => (c[0] as string) >= '2026-08-20')).toBe(
      true,
    );
  });

  it('rebuilds the leaderboard for every day it recomputed', async () => {
    const { service, rollup } = makeService();
    await service.backfillDay('2026-08-21');
    expect(rollup.rebuildLeaderboards.mock.calls.map((c) => c[0])).toEqual([
      '2026-08-21',
      '2026-08-22',
    ]);
  });

  it('rejects a malformed date rather than silently defaulting to today', async () => {
    const { service } = makeService();
    await expect(service.backfillDay('20-08-2026')).rejects.toThrow();
  });

  it('refuses a future date', async () => {
    // A backfill corrects something that already happened; a future date is a typo.
    const { service } = makeService();
    await expect(service.backfillDay('2027-01-01')).rejects.toThrow();
  });
});
