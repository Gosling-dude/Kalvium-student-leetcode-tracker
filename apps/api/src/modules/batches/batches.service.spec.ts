/**
 * Batch resolution, movement and archival guarantees.
 *
 * The properties worth protecting, each of which is a way the feature could quietly
 * corrupt data rather than fail loudly:
 *
 *  - An unknown batch filter is rejected, never silently widened to "all batches" —
 *    a widened filter shows one batch's students under another batch's heading.
 *  - Moving a student writes exactly one history row and touches nothing else.
 *  - A move is effective from today, so closed days keep the batch they were completed
 *    under (§7).
 *  - Redundant and archived-destination moves are refused before anything is written.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BatchesService } from './batches.service';

const FOUNDATION = { id: 'batch-a', code: 'A', name: 'Foundation Level', status: 'ACTIVE' };
const INTERMEDIATE = { id: 'batch-b', code: 'B', name: 'Intermediate Level', status: 'ACTIVE' };

function makeService() {
  const prisma = {
    batch: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([FOUNDATION, INTERMEDIATE]),
      count: vi.fn().mockResolvedValue(1),
    },
    student: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    studentBatchHistory: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      // Default: the student already has placement history, so an unqualified move is a
      // genuine move and stays effective today. First-placement cases override this.
      count: vi.fn().mockResolvedValue(1),
    },
    $transaction: vi.fn(async (operations: unknown[]) => operations),
  };

  const time = {
    today: vi.fn().mockReturnValue('2026-08-15'),
    dayKeyOf: vi.fn((date: Date) => date.toISOString().slice(0, 10)),
  };
  const cache = { delByPrefix: vi.fn().mockResolvedValue(undefined) };

  const service = new BatchesService(
    prisma as never,
    time as never,
    cache as never,
  );

  return { service, prisma, time, cache };
}

describe('resolveSelector', () => {
  it('treats an absent, empty or "all" selector as no filter', async () => {
    const { service } = makeService();
    expect(await service.resolveSelector(undefined)).toBeNull();
    expect(await service.resolveSelector('')).toBeNull();
    expect(await service.resolveSelector('  ')).toBeNull();
    expect(await service.resolveSelector('all')).toBeNull();
  });

  it('resolves a code within a campus, case-insensitively', async () => {
    const { service, prisma } = makeService();
    prisma.batch.findUnique.mockResolvedValue(FOUNDATION);

    expect(await service.resolveSelector('a', 'campus-vels')).toBe('batch-a');
    // Codes are unique *per campus* now, so the lookup must carry the campus.
    expect(prisma.batch.findUnique).toHaveBeenCalledWith({
      where: { campusId_code: { campusId: 'campus-vels', code: 'A' } },
    });
  });

  it('resolves the friendly aliases used in URLs', async () => {
    const { service, prisma } = makeService();
    prisma.batch.findUnique.mockResolvedValue(INTERMEDIATE);

    await service.resolveSelector('intermediate', 'campus-vels');
    expect(prisma.batch.findUnique).toHaveBeenCalledWith({
      where: { campusId_code: { campusId: 'campus-vels', code: 'B' } },
    });
  });

  it('resolves a bare code with no campus while exactly one batch matches', async () => {
    const { service, prisma } = makeService();
    prisma.batch.findMany.mockResolvedValue([{ ...FOUNDATION, campus: { code: 'VELS' } }]);

    expect(await service.resolveSelector('A')).toBe('batch-a');
  });

  /**
   * The campus-era ambiguity case. Both campuses have an `A`, so answering with either
   * one would silently target the wrong campus's students — worse than refusing.
   */
  it('refuses a bare code that names a batch at more than one campus', async () => {
    const { service, prisma } = makeService();
    prisma.batch.findMany.mockResolvedValue([
      { ...FOUNDATION, campus: { code: 'VELS' } },
      { id: 'batch-srm-a', code: 'A', campus: { code: 'SRM' } },
    ]);

    await expect(service.resolveSelector('A')).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * The important negative case. Returning null here would turn "show me Foundation"
   * into "show me everyone" — a wrong answer presented as the right one.
   */
  it('rejects an unknown batch instead of falling back to all batches', async () => {
    const { service, prisma } = makeService();
    prisma.batch.findUnique.mockResolvedValue(null);
    prisma.batch.findMany.mockResolvedValue([]);

    await expect(
      service.resolveSelector('Z', 'campus-vels'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a well-formed uuid that is not a batch', async () => {
    const { service, prisma } = makeService();
    prisma.batch.findUnique.mockResolvedValue(null);

    await expect(
      service.resolveSelector('11111111-2222-3333-4444-555555555555'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('batchOnDayForStudents', () => {
  it('asks only for placements effective by the requested day', async () => {
    const { service, prisma } = makeService();
    await service.batchOnDayForStudents(['s1'], '2026-08-10');

    expect(prisma.studentBatchHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studentId: { in: ['s1'] }, effectiveFromDayKey: { lte: '2026-08-10' } },
      }),
    );
  });

  it('resolves each student independently', async () => {
    const { service, prisma } = makeService();
    prisma.studentBatchHistory.findMany.mockResolvedValue([
      {
        studentId: 's1',
        toBatchId: 'batch-a',
        effectiveFromDayKey: '2026-08-01',
        changedAt: new Date('2026-08-01'),
      },
      {
        studentId: 's2',
        toBatchId: 'batch-b',
        effectiveFromDayKey: '2026-08-01',
        changedAt: new Date('2026-08-01'),
      },
      {
        studentId: 's1',
        toBatchId: 'batch-b',
        effectiveFromDayKey: '2026-08-15',
        changedAt: new Date('2026-08-15'),
      },
    ]);

    const onTheTenth = await service.batchOnDayForStudents(['s1', 's2'], '2026-08-10');
    expect(onTheTenth.get('s1')).toBe('batch-a');
    expect(onTheTenth.get('s2')).toBe('batch-b');
  });

  it('omits students who had no placement yet, rather than guessing', async () => {
    const { service, prisma } = makeService();
    prisma.studentBatchHistory.findMany.mockResolvedValue([]);

    const resolved = await service.batchOnDayForStudents(['s1'], '2026-08-10');
    expect(resolved.get('s1')).toBeUndefined();
  });

  it('does not query at all for an empty student list', async () => {
    const { service, prisma } = makeService();
    const resolved = await service.batchOnDayForStudents([], '2026-08-10');

    expect(resolved.size).toBe(0);
    expect(prisma.studentBatchHistory.findMany).not.toHaveBeenCalled();
  });
});

describe('moveStudent', () => {
  const student = {
    id: 's1',
    name: 'Abishek R V',
    batchId: 'batch-a',
    createdAt: new Date('2026-07-01T00:00:00Z'),
  };

  beforeEach(() => vi.clearAllMocks());

  it('updates the current batch and records one history row', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(student);
    prisma.batch.findUnique.mockResolvedValue(INTERMEDIATE);

    await service.moveStudent({
      studentId: 's1',
      toBatchId: 'batch-b',
      reason: 'Consistently ahead',
      changedById: 'user-1',
      changedByName: 'Mentor',
    });

    expect(prisma.student.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { batchId: 'batch-b' },
    });

    expect(prisma.studentBatchHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        studentId: 's1',
        fromBatchId: 'batch-a',
        toBatchId: 'batch-b',
        // Effective today, never back-dated: yesterday's results keep their batch (§7).
        effectiveFromDayKey: '2026-08-15',
        reason: 'Consistently ahead',
        source: 'MANUAL',
        changedById: 'user-1',
        changedByName: 'Mentor',
      }),
    });
  });

  /**
   * The production defect this suite now pins.
   *
   * Alliance published a batch-scoped assignment for 31 Aug, then split its 46
   * previously-unclassified students into Foundation and Intermediate the next morning.
   * Every placement was written `effectiveFromDayKey = today`, so 31 Aug still resolved to
   * "no batch" for all of them — and `selectAssignmentForScope` cannot pair a
   * batch-targeted assignment with a student who has no batch. The whole cohort scored
   * `assignedCount = 0` on a day they had genuinely been assigned work.
   *
   * A first classification is a statement about who the student has been since enrolment,
   * not a change made today, so it is back-dated. Genuine moves are unaffected — the test
   * below this one holds them to today.
   */
  it("back-dates a student's first placement to their enrolment day", async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue({
      id: 's1',
      name: 'A Sri Harish',
      batchId: null,
      campusId: 'campus-alliance',
      createdAt: new Date('2026-08-26T12:57:00Z'),
    });
    prisma.batch.findUnique.mockResolvedValue({
      ...FOUNDATION,
      campusId: 'campus-alliance',
      campus: { name: 'Alliance University' },
    });
    // No history at all — this is the very first thing recorded about their batch.
    prisma.studentBatchHistory.count.mockResolvedValue(0);

    await service.moveStudent({ studentId: 's1', toBatchId: 'batch-a' });

    expect(prisma.studentBatchHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        studentId: 's1',
        fromBatchId: null,
        toBatchId: 'batch-a',
        effectiveFromDayKey: '2026-08-26',
      }),
    });
  });

  /**
   * `Student.batchId` is deliberately not the test for "has this student been classified
   * before" — an import can stamp that column without ever writing a history row, and a
   * student carrying a stale `batchId` with no history is exactly the case that must still
   * back-date. Prior placements are read from the history table itself.
   */
  it('treats a stamped batchId with no history as a first placement', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue({
      id: 's1',
      name: 'Imported Student',
      batchId: 'batch-a',
      campusId: 'campus-alliance',
      createdAt: new Date('2026-08-26T12:57:00Z'),
    });
    prisma.batch.findUnique.mockResolvedValue({
      ...INTERMEDIATE,
      campusId: 'campus-alliance',
      campus: { name: 'Alliance University' },
    });
    prisma.studentBatchHistory.count.mockResolvedValue(0);

    await service.moveStudent({ studentId: 's1', toBatchId: 'batch-b' });

    expect(prisma.studentBatchHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ effectiveFromDayKey: '2026-08-26' }),
    });
  });

  /**
   * The other half of the rule, and the one §7 protects: once a student has been placed,
   * moving them is a decision about today. Back-dating it would re-file already-scored
   * days under a batch they were not in at the time.
   */
  it('keeps a genuine move effective today, never back-dated', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(student);
    prisma.batch.findUnique.mockResolvedValue(INTERMEDIATE);
    prisma.studentBatchHistory.count.mockResolvedValue(1);

    await service.moveStudent({ studentId: 's1', toBatchId: 'batch-b' });

    expect(prisma.studentBatchHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ effectiveFromDayKey: '2026-08-15' }),
    });
  });

  /** An explicitly supplied day always wins — the importer and the repair script rely on it. */
  it('honours an explicit effectiveFromDayKey over both defaults', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(student);
    prisma.batch.findUnique.mockResolvedValue(INTERMEDIATE);
    prisma.studentBatchHistory.count.mockResolvedValue(0);

    await service.moveStudent({
      studentId: 's1',
      toBatchId: 'batch-b',
      effectiveFromDayKey: '2026-08-01',
    });

    expect(prisma.studentBatchHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ effectiveFromDayKey: '2026-08-01' }),
    });
  });

  /**
   * The move must not reach into submissions, daily statuses, streaks or leaderboards.
   * Those tables are absent from the mock entirely, so touching one would throw.
   */
  it('writes only the student row and the history row', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(student);
    prisma.batch.findUnique.mockResolvedValue(INTERMEDIATE);

    await service.moveStudent({ studentId: 's1', toBatchId: 'batch-b' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.student.update).toHaveBeenCalledTimes(1);
    expect(prisma.studentBatchHistory.create).toHaveBeenCalledTimes(1);
  });

  it('stores an omitted reason as null rather than an empty string', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(student);
    prisma.batch.findUnique.mockResolvedValue(INTERMEDIATE);

    await service.moveStudent({ studentId: 's1', toBatchId: 'batch-b', reason: '   ' });

    expect(prisma.studentBatchHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: null }),
    });
  });

  it('refuses a move to the batch the student is already in', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(student);
    prisma.batch.findUnique.mockResolvedValue(FOUNDATION);

    await expect(
      service.moveStudent({ studentId: 's1', toBatchId: 'batch-a' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.student.update).not.toHaveBeenCalled();
  });

  it('refuses a move into an archived batch', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(student);
    prisma.batch.findUnique.mockResolvedValue({ ...INTERMEDIATE, status: 'ARCHIVED' });

    await expect(
      service.moveStudent({ studentId: 's1', toBatchId: 'batch-b' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.student.update).not.toHaveBeenCalled();
  });

  it('fails clearly for an unknown student or batch', async () => {
    const { service, prisma } = makeService();

    prisma.student.findUnique.mockResolvedValue(null);
    await expect(
      service.moveStudent({ studentId: 'nope', toBatchId: 'batch-b' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    prisma.student.findUnique.mockResolvedValue(student);
    prisma.batch.findUnique.mockResolvedValue(null);
    await expect(
      service.moveStudent({ studentId: 's1', toBatchId: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
