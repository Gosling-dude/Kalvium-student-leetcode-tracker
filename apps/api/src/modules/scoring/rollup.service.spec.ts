/**
 * `RollupService.recomputeDay` — who gets a row for a given day.
 *
 * The production bug this file pins:
 *
 *   99 SRM students were imported on **2026-08-23**. The sync that followed pulled their
 *   LeetCode history, which reached back into the recompute lookback window, so every day
 *   from 2026-08-09 onward was recomputed. `recomputeDay` wrote a `DailyStatus` for every
 *   ACTIVE student with no enrolment cutoff, so all 99 got a scored zero on all 14 days —
 *   1,386 rows for days they were not in the programme.
 *
 * The leaderboard made it visible. `campusOnDayForStudents` correctly answers "no campus"
 * for a day before the student enrolled, so those rows carried a null `campusId` — and a
 * null campus reads as *every* campus, so 99 zero-score students appeared on the global
 * board for weeks in which SRM did not yet exist, while the SRM board (which filters on
 * `campusId`) showed none of them.
 *
 * Enrolment is `createdAt`, the definition `computeStreaks` was already using one line
 * below the bug — the streak maths knew these days were not misses; the row-writing did
 * not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RollupService } from './rollup.service';

const DAY = '2026-08-15';

/** 2026-08-06 — the Vels cohort, enrolled well before `DAY`. */
const ENROLLED_EARLIER = new Date('2026-08-06T11:50:43.519Z');
/** `DAY` itself — enrolment on the very day being recomputed still counts as enrolled. */
const ENROLLED_ON_THE_DAY = new Date('2026-08-15T09:00:00.000Z');
/** 2026-08-23 — the SRM intake, imported eight days after `DAY`. */
const ENROLLED_LATER = new Date('2026-08-23T01:29:00.086Z');

type Student = { id: string; createdAt: Date };

function makeService(students: Student[]) {
  const prisma = {
    assignment: { findMany: vi.fn(async () => []) },
    student: {
      findMany: vi.fn(async () =>
        students.map((s) => ({
          ...s,
          leetcodeUsername: null,
          campusId: null,
          batchId: null,
          syncState: { status: 'OK' },
        })),
      ),
    },
    dailyStatus: { findMany: vi.fn(async () => []) },
  };

  const time = {
    dayKeyOf: (date: Date) => date.toISOString().slice(0, 10),
    addDays: (day: string, n: number) => {
      const date = new Date(`${day}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + n);
      return date.toISOString().slice(0, 10);
    },
    minuteOfDay: () => 0,
  };

  const service = new RollupService(
    prisma as never,
    { delByPrefix: vi.fn(async () => undefined) } as never,
    time as never,
    { getActive: vi.fn(async () => undefined) } as never,
    {} as never, // metrics — only reached by recomputeStudentAggregates
    { batchOnDayForStudents: vi.fn(async () => new Map()) } as never,
    { campusOnDayForStudents: vi.fn(async () => new Map()) } as never,
  );

  // The write itself is not under test — which students reach it is.
  const persist = vi
    .spyOn(service as never as { persistDailyStatus: (a: unknown) => Promise<void> }, 'persistDailyStatus')
    .mockResolvedValue(undefined);

  return { service, persist };
}

/** The `studentId`s `persistDailyStatus` was actually called with. */
function scoredStudentIds(persist: { mock: { calls: unknown[][] } }): string[] {
  return persist.mock.calls.map((call) => (call[0] as { studentId: string }).studentId);
}

describe('RollupService.recomputeDay — enrolment cutoff', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes no row for a student who had not enrolled on that day', async () => {
    const { service, persist } = makeService([
      { id: 'vels-1', createdAt: ENROLLED_EARLIER },
      { id: 'srm-1', createdAt: ENROLLED_LATER },
    ]);

    await service.recomputeDay(DAY);

    expect(scoredStudentIds(persist)).toEqual(['vels-1']);
  });

  it('counts a student enrolled on the day itself', async () => {
    const { service, persist } = makeService([{ id: 'joined-today', createdAt: ENROLLED_ON_THE_DAY }]);

    await service.recomputeDay(DAY);

    expect(scoredStudentIds(persist)).toEqual(['joined-today']);
  });

  it('reports only the students it scored, so a whole unenrolled cohort is not counted', async () => {
    const srm = Array.from({ length: 99 }, (_, i) => ({
      id: `srm-${i}`,
      createdAt: ENROLLED_LATER,
    }));
    const { service, persist } = makeService([
      { id: 'vels-1', createdAt: ENROLLED_EARLIER },
      ...srm,
    ]);

    const result = await service.recomputeDay(DAY);

    // The 1,386-row bug in one assertion: 100 active students, one of them enrolled.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.students).toBe(1);
  });

  it('still scores everyone when the whole roster predates the day', async () => {
    const { service, persist } = makeService([
      { id: 'vels-1', createdAt: ENROLLED_EARLIER },
      { id: 'vels-2', createdAt: ENROLLED_EARLIER },
    ]);

    const result = await service.recomputeDay(DAY);

    expect(scoredStudentIds(persist)).toEqual(['vels-1', 'vels-2']);
    expect(result.students).toBe(2);
  });
});
