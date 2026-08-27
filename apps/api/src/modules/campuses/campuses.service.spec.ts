/**
 * `CampusesService` — resolution, scope validation and transfers.
 *
 * Three properties, each of which fails in a way that is invisible until it has already
 * corrupted a report:
 *
 *  - **A filter never widens silently.** An unknown campus is a 400. Returning "no
 *    filter" would answer "show me SRM" with "here is everyone", which reads as correct.
 *  - **A campus + batch pair is validated together.** `campus=SRM&batch=A` must find SRM's
 *    Foundation and never Vels', and a batch from the wrong campus is rejected outright.
 *  - **A transfer writes both halves.** Moving campus necessarily moves batch, and both
 *    history rows land in one transaction — a transfer with only one of them recorded is
 *    a student who reads as SRM on one screen and Vels on another.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MentorScopeService } from './mentor-scope.service';
import { CampusesService } from './campuses.service';

const VELS = { id: '11111111-1111-4111-8111-111111111111', code: 'VELS', name: 'Vels Institute', status: 'ACTIVE', sortOrder: 1 };
const SRM = { id: '22222222-2222-4222-8222-222222222222', code: 'SRM', name: 'SRM University', status: 'ACTIVE', sortOrder: 2 };

const VELS_A = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  code: 'A',
  name: 'Foundation Level',
  campusId: VELS.id,
  status: 'ACTIVE',
};
const SRM_A = {
  id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  code: 'A',
  name: 'Foundation Level',
  campusId: SRM.id,
  status: 'ACTIVE',
};
const SRM_B = {
  id: 'cccccccc-3333-4333-8333-cccccccccccc',
  code: 'B',
  name: 'Intermediate Level',
  campusId: SRM.id,
  status: 'ACTIVE',
};

const CAMPUSES = [VELS, SRM];
const BATCHES = [VELS_A, SRM_A, SRM_B];

function makeService() {
  const prisma = {
    campus: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; code?: string } }) =>
        CAMPUSES.find((c) => (where.id ? c.id === where.id : c.code === where.code)) ?? null,
      ),
      findMany: vi.fn(async () => CAMPUSES),
      count: vi.fn(async ({ where }: { where: { id: string } }) =>
        CAMPUSES.some((c) => c.id === where.id) ? 1 : 0,
      ),
    },
    batch: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { id?: string; campusId_code?: { campusId: string; code: string } };
        }) => {
          if (where.id) return BATCHES.find((b) => b.id === where.id) ?? null;
          const key = where.campusId_code!;
          return (
            BATCHES.find((b) => b.campusId === key.campusId && b.code === key.code) ?? null
          );
        },
      ),
      findMany: vi.fn(async ({ where }: { where?: { code?: string; campusId?: string } }) =>
        BATCHES.filter(
          (b) =>
            (!where?.code || b.code === where.code) &&
            (!where?.campusId || b.campusId === where.campusId),
        ).map((b) => ({ ...b, campus: { name: 'x', code: b.campusId === VELS.id ? 'VELS' : 'SRM' } })),
      ),
    },
    student: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
    studentCampusHistory: { findMany: vi.fn(async () => []), create: vi.fn() },
    studentBatchHistory: { create: vi.fn() },
    dailyStatus: { groupBy: vi.fn(async () => []) },
    $transaction: vi.fn(async (operations: unknown[]) => operations),
  };

  const time = { today: vi.fn().mockReturnValue('2026-08-22') };
  const cache = { delByPrefix: vi.fn().mockResolvedValue(undefined) };

  const service = new CampusesService(
    prisma as never,
    time as never,
    cache as never,
    new MentorScopeService(prisma as never),
  );
  return { service, prisma };
}

beforeEach(() => vi.clearAllMocks());

describe('resolveSelector', () => {
  it('treats absent, empty and "all" as no filter', async () => {
    const { service } = makeService();
    expect(await service.resolveSelector(undefined)).toBeNull();
    expect(await service.resolveSelector('')).toBeNull();
    expect(await service.resolveSelector('  ')).toBeNull();
    expect(await service.resolveSelector('all')).toBeNull();
  });

  it('resolves a code case-insensitively', async () => {
    const { service } = makeService();
    expect(await service.resolveSelector('srm')).toBe(SRM.id);
    expect(await service.resolveSelector(' SRM ')).toBe(SRM.id);
  });

  /**
   * The negative case that matters. Returning null here would turn "show me SRM" into
   * "show me every campus" — a wrong answer presented as the right one, and precisely the
   * cross-campus leak §12 exists to prevent.
   */
  it('rejects an unknown campus rather than falling back to every campus', async () => {
    const { service } = makeService();
    await expect(service.resolveSelector('NOWHERE')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s a well-formed uuid that is not a campus', async () => {
    const { service } = makeService();
    await expect(
      service.resolveSelector('11111111-2222-3333-4444-555555555555'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('resolveScope', () => {
  it('resolves a bare batch code inside the named campus', async () => {
    const { service } = makeService();
    const scope = await service.resolveScope({ campus: 'SRM', batch: 'A' });
    expect(scope).toMatchObject({ campusId: SRM.id, batchId: SRM_A.id });
  });

  it('resolves the same code to a different batch at a different campus', async () => {
    // The whole point of campus-scoped codes: `A` is not one batch any more.
    const { service } = makeService();
    const vels = await service.resolveScope({ campus: 'VELS', batch: 'A' });
    const srm = await service.resolveScope({ campus: 'SRM', batch: 'A' });
    expect(vels.batchId).toBe(VELS_A.id);
    expect(srm.batchId).toBe(SRM_A.id);
  });

  /**
   * "Not assigned" is a third state, not a batch. It resolves to a flag rather than an
   * id, because `batchId: null` already means "every batch" and the two must not collide.
   */
  it('resolves "none" to the unassigned flag, never to a batch id', async () => {
    const { service } = makeService();
    const scope = await service.resolveScope({ campus: 'SRM', batch: 'none' });
    expect(scope).toMatchObject({ campusId: SRM.id, batchId: null, onlyUnassigned: true });
  });

  it('does not set the unassigned flag for a real batch or for "all"', async () => {
    const { service } = makeService();
    expect((await service.resolveScope({ campus: 'SRM', batch: 'A' })).onlyUnassigned).toBe(false);
    expect((await service.resolveScope({ campus: 'SRM' })).onlyUnassigned).toBe(false);
    expect((await service.resolveScope({})).onlyUnassigned).toBe(false);
  });

  it('no longer recognises a placement-pending batch code', async () => {
    // The batch is gone; a stale link asking for it must fail loudly rather than
    // silently resolving to some other batch.
    const { service } = makeService();
    await expect(service.resolveScope({ campus: 'SRM', batch: 'PENDING' })).rejects.toThrow();
  });

  it('rejects a batch that belongs to another campus', async () => {
    const { service } = makeService();
    await expect(
      service.resolveScope({ campus: 'SRM', batch: VELS_A.id }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('infers the campus from an unambiguous batch id', async () => {
    const { service } = makeService();
    const scope = await service.resolveScope({ batch: SRM_A.id });
    expect(scope.campusId).toBe(SRM.id);
  });

  it('refuses a bare code with no campus while it names a batch at both', async () => {
    const { service } = makeService();
    await expect(service.resolveScope({ batch: 'A' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('widens cleanly when neither half is given', async () => {
    const { service } = makeService();
    expect(await service.resolveScope({})).toMatchObject({ campusId: null, batchId: null });
  });

  it('carries the names through, so callers never re-fetch them to render a label', async () => {
    const { service } = makeService();
    const scope = await service.resolveScope({ campus: 'SRM', batch: 'A' });
    expect(scope.campusName).toBe('SRM University');
    expect(scope.batchName).toBe('Foundation Level');
  });
});

describe('transferStudent', () => {
  const student = {
    id: 'student-1',
    name: 'Asha',
    campusId: VELS.id,
    batchId: VELS_A.id,
  };

  it('writes the campus move, the batch move and the student update together', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(student);

    await service.transferStudent({
      studentId: student.id,
      toCampusId: SRM.id,
      toBatchId: SRM_A.id,
      reason: 'Relocated',
      changedById: 'user-1',
      changedByName: 'Admin',
    });

    // One transaction, three operations. Splitting them is how a student ends up at SRM
    // with a Vels batch, or with a campus change nothing recorded.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.student.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { campusId: SRM.id, batchId: SRM_A.id } }),
    );
    expect(prisma.studentCampusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromCampusId: VELS.id, toCampusId: SRM.id }),
      }),
    );
    expect(prisma.studentBatchHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromBatchId: VELS_A.id, toBatchId: SRM_A.id }),
      }),
    );
  });

  it('takes effect from today, never back-dated over settled days', async () => {
    // Back-dating would re-file already-scored days under the new campus, which is the
    // historical rewrite §17 forbids.
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(student);

    await service.transferStudent({
      studentId: student.id,
      toCampusId: SRM.id,
      toBatchId: SRM_A.id,
    });

    expect(prisma.studentCampusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ effectiveFromDayKey: '2026-08-22' }),
      }),
    );
  });

  it('leaves the student unassigned when no batch is named', async () => {
    // Honest: they have not been re-assessed at the new campus, so no level is claimed —
    // and carrying the old campus's level across would state something nobody decided.
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(student);

    await service.transferStudent({ studentId: student.id, toCampusId: SRM.id });

    expect(prisma.student.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { campusId: SRM.id, batchId: null } }),
    );
  });

  it('refuses a destination batch belonging to a different campus', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(student);

    await expect(
      service.transferStudent({
        studentId: student.id,
        toCampusId: SRM.id,
        toBatchId: VELS_A.id,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a no-op transfer instead of writing an empty history row', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(student);

    await expect(
      service.transferStudent({
        studentId: student.id,
        toCampusId: VELS.id,
        toBatchId: VELS_A.id,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s an unknown student before touching anything', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(null);

    await expect(
      service.transferStudent({ studentId: 'nope', toCampusId: SRM.id }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('campusOnDayForStudents', () => {
  it('asks only for placements effective by the requested day', async () => {
    const { service, prisma } = makeService();
    await service.campusOnDayForStudents(['s1'], '2026-08-10');

    expect(prisma.studentCampusHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studentId: { in: ['s1'] }, effectiveFromDayKey: { lte: '2026-08-10' } },
      }),
    );
  });

  it('resolves every student in one query rather than one query each', async () => {
    // At 500+ students a per-student lookup turns one rollup into hundreds of round
    // trips, which is exactly the N+1 §27 rules out.
    const { service, prisma } = makeService();
    await service.campusOnDayForStudents(['s1', 's2', 's3'], '2026-08-10');
    expect(prisma.studentCampusHistory.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns an empty map for no students, without querying at all', async () => {
    const { service, prisma } = makeService();
    expect(await service.campusOnDayForStudents([], '2026-08-10')).toEqual(new Map());
    expect(prisma.studentCampusHistory.findMany).not.toHaveBeenCalled();
  });

  it('omits a student with no placement rather than guessing their current campus', async () => {
    const { service, prisma } = makeService();
    prisma.studentCampusHistory.findMany.mockResolvedValue([
      {
        studentId: 's1',
        toCampusId: VELS.id,
        effectiveFromDayKey: '2026-01-01',
        changedAt: new Date('2026-01-01'),
      },
    ]);

    const resolved = await service.campusOnDayForStudents(['s1', 's2'], '2026-08-10');
    expect(resolved.get('s1')).toBe(VELS.id);
    expect(resolved.has('s2')).toBe(false);
  });
});
