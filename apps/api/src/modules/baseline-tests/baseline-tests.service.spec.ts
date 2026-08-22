/**
 * `BaselineTestsService` — eligibility, grading, isolation and the review boundary.
 *
 * Four properties, and the last two are the ones this feature exists to get right:
 *
 *  - **Eligibility is campus + batch scoped**, resolved from the student's own record.
 *    A student can never see, start or enumerate another campus's test.
 *  - **Grading reads the submission mirror**, inside the attempt's window, and nothing
 *    else. It writes to no daily-assignment table (§25, §39).
 *  - **The student projection has no risk fields at all** — not omitted, absent.
 *  - **The system says "review recommended", never "cheated"**, and every flag it raises
 *    arrives with the evidence that produced it (§23).
 */

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BaselineTestsService } from './baseline-tests.service';

const SRM = 'campus-srm';
const VELS = 'campus-vels';
const SRM_FOUNDATION = 'batch-srm-a';
const VELS_FOUNDATION = 'batch-vels-a';

const NOW = new Date('2026-08-22T10:00:00Z');

function testProblem(id: string, position: number, slug: string, points = 10) {
  return {
    id,
    testId: 'test-1',
    problemId: `problem-${slug}`,
    position,
    points,
    difficulty: 'EASY',
    problem: { id: `problem-${slug}`, title: slug, titleSlug: slug, url: `https://x/${slug}` },
  };
}

function baselineTest(over: Record<string, unknown> = {}) {
  return {
    id: 'test-1',
    name: 'Baseline Test #1',
    dayKey: '2026-08-22',
    description: null,
    instructions: 'Solve independently.',
    adminNotes: 'Watch for the usual suspects',
    campusId: SRM,
    batchId: SRM_FOUNDATION,
    campus: { name: 'SRM University', code: 'SRM' },
    batch: { name: 'Foundation Level', code: 'A' },
    durationMinutes: 60,
    opensAt: new Date('2026-08-22T09:00:00Z'),
    closesAt: new Date('2026-08-22T18:00:00Z'),
    status: 'ACTIVE',
    createdById: 'user-1',
    createdBy: { name: 'Admin' },
    createdAt: NOW,
    updatedAt: NOW,
    problems: [
      testProblem('tp-1', 1, 'two-sum'),
      testProblem('tp-2', 2, 'valid-parentheses'),
      testProblem('tp-3', 3, 'merge-intervals', 20),
    ],
    attempts: [],
    _count: { problems: 3, attempts: 0 },
    ...over,
  };
}

function makeService(options: {
  tests?: ReturnType<typeof baselineTest>[];
  students?: Record<string, { id: string; campusId: string | null; batchId: string | null }>;
  submissions?: {
    titleSlug: string;
    status: string;
    submittedAt: Date;
    language?: string | null;
  }[];
  attempt?: Record<string, unknown> | null;
} = {}) {
  const tests = options.tests ?? [baselineTest()];
  const students = options.students ?? {
    's-srm': { id: 's-srm', campusId: SRM, batchId: SRM_FOUNDATION },
    's-vels': { id: 's-vels', campusId: VELS, batchId: VELS_FOUNDATION },
  };
  const submissions = options.submissions ?? [];
  const attempts: Record<string, unknown>[] = options.attempt ? [options.attempt] : [];
  const problemResults: Record<string, unknown>[] = [];

  const prisma = {
    baselineTest: {
      findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const status = where?.status as { in?: string[] } | string | undefined;
        return tests.filter((t) => {
          if (typeof status === 'string') return t.status === status;
          if (status?.in) return status.in.includes(t.status);
          return true;
        });
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        tests.find((t) => t.id === where.id) ?? null,
      ),
      create: vi.fn(async () => tests[0]),
      update: vi.fn(async () => tests[0]),
      delete: vi.fn(async () => tests[0]),
    },
    baselineTestProblem: { deleteMany: vi.fn(), createMany: vi.fn() },
    baselineTestAttempt: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const key = where.testId_studentId as { testId: string; studentId: string } | undefined;
        if (key) {
          return (
            attempts.find(
              (a) => a.testId === key.testId && a.studentId === key.studentId,
            ) ?? null
          );
        }
        const found = attempts.find((a) => a.id === where.id);
        if (!found) return null;
        return { ...found, test: tests.find((t) => t.id === found.testId) };
      }),
      findMany: vi.fn(async () => attempts),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'attempt-1', results: [], riskFlags: [], reviewStatus: 'NOT_REVIEWED', ...data };
        attempts.push(row);
        return row;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(attempts[0]!, data);
        return attempts[0];
      }),
      groupBy: vi.fn(async () => []),
    },
    baselineTestProblemResult: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        problemResults.splice(0, problemResults.length, ...data);
        if (attempts[0]) attempts[0].results = data;
        return { count: data.length };
      }),
    },
    student: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => students[where.id] ?? null),
      findMany: vi.fn(async () => Object.values(students)),
      groupBy: vi.fn(async () => [
        { campusId: SRM, batchId: SRM_FOUNDATION, _count: { _all: 41 } },
        { campusId: VELS, batchId: VELS_FOUNDATION, _count: { _all: 15 } },
      ]),
    },
    submission: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const range = where.submittedAt as { gte?: Date; lte?: Date; lt?: Date } | undefined;
        return submissions.filter((s) => {
          if (where.status && s.status !== where.status) return false;
          if (range?.gte && s.submittedAt < range.gte) return false;
          if (range?.lte && s.submittedAt > range.lte) return false;
          if (range?.lt && s.submittedAt >= range.lt) return false;
          return true;
        });
      }),
    },
    dailyStatus: { findMany: vi.fn(async () => []) },
    problem: { findUnique: vi.fn(async () => null), upsert: vi.fn() },
    $transaction: vi.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: typeof prisma) => Promise<unknown>)(prisma);
    }),
  };

  const time = {
    isValid: (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d),
    today: () => '2026-08-22',
    addDays: (day: string, n: number) => {
      const date = new Date(`${day}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + n);
      return date.toISOString().slice(0, 10);
    },
  };
  const campuses = {
    resolveScope: vi.fn(async () => ({
      campusId: SRM,
      batchId: SRM_FOUNDATION,
      campusName: 'SRM University',
      campusCode: 'SRM',
      batchName: 'Foundation Level',
      batchCode: 'A',
    })),
  };
  const provider = { fetchProblemMetadata: vi.fn() };

  const service = new BaselineTestsService(
    prisma as never,
    time as never,
    campuses as never,
    provider as never,
  );
  return { service, prisma, attempts };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW);
});

describe('student eligibility — no cross-campus visibility', () => {
  it('lists a test targeting the student’s own campus and batch', async () => {
    const { service } = makeService();
    const tests = await service.listForStudent('s-srm');
    expect(tests).toHaveLength(1);
    expect(tests[0]?.id).toBe('test-1');
  });

  it('hides a test targeting another campus entirely', async () => {
    // Not "shows it as locked" — the student must not learn it exists (§22).
    const { service } = makeService();
    expect(await service.listForStudent('s-vels')).toHaveLength(0);
  });

  it('404s a fetch by id for another campus’s test', async () => {
    const { service } = makeService();
    await expect(service.getForStudent('s-vels', 'test-1')).rejects.toThrow(NotFoundException);
  });

  it('refuses to start another campus’s test, with the same 404 as a bad id', async () => {
    const { service } = makeService();
    await expect(service.startAttempt('s-vels', 'test-1')).rejects.toThrow(NotFoundException);
  });

  it('hides a DRAFT test from everyone it targets', async () => {
    const { service } = makeService({ tests: [baselineTest({ status: 'DRAFT' })] });
    expect(await service.listForStudent('s-srm')).toHaveLength(0);
  });

  it('shows a scheduled test but withholds its problems until the attempt starts', async () => {
    const { service } = makeService({ tests: [baselineTest({ status: 'SCHEDULED' })] });
    const [test] = await service.listForStudent('s-srm');
    expect(test?.problemCount).toBe(3);
    // The questions themselves stay hidden — otherwise a scheduled test leaks its
    // contents a day early.
    expect(test?.problems).toEqual([]);
    expect(test?.canStart).toBe(false);
  });
});

describe('the student projection carries no mentor-only data', () => {
  it('omits admin notes and every risk field', async () => {
    const { service } = makeService();
    const [test] = await service.listForStudent('s-srm');

    expect(test).not.toHaveProperty('adminNotes');
    expect(test).not.toHaveProperty('riskFlags');
    expect(test).not.toHaveProperty('riskScore');
    expect(test).not.toHaveProperty('reviewStatus');
    // Nor anything about how anyone else did.
    expect(test).not.toHaveProperty('startedCount');
    expect(test).not.toHaveProperty('reviewRequiredCount');
  });
});

describe('starting an attempt', () => {
  it('freezes the campus and batch the student sat it in', async () => {
    const { service, prisma } = makeService();
    await service.startAttempt('s-srm', 'test-1');

    expect(prisma.baselineTestAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ campusId: SRM, batchId: SRM_FOUNDATION }),
      }),
    );
  });

  it('clamps the window to the test close time for a late starter', async () => {
    const { service, prisma } = makeService({
      tests: [baselineTest({ closesAt: new Date('2026-08-22T10:15:00Z') })],
    });
    await service.startAttempt('s-srm', 'test-1');

    const call = prisma.baselineTestAttempt.create.mock.calls[0]![0] as {
      data: { expiresAt: Date };
    };
    expect(call.data.expiresAt.toISOString()).toBe('2026-08-22T10:15:00.000Z');
  });

  it('resumes rather than restarting, so a refresh cannot reset the clock', async () => {
    const { service, prisma } = makeService({
      attempt: {
        id: 'attempt-1',
        testId: 'test-1',
        studentId: 's-srm',
        status: 'IN_PROGRESS',
        startedAt: NOW,
        results: [],
        riskFlags: [],
      },
    });

    await service.startAttempt('s-srm', 'test-1');
    expect(prisma.baselineTestAttempt.create).not.toHaveBeenCalled();
  });

  it('refuses to start a closed test', async () => {
    const { service } = makeService({ tests: [baselineTest({ status: 'CLOSED' })] });
    await expect(service.startAttempt('s-srm', 'test-1')).rejects.toThrow(ForbiddenException);
  });

  it('refuses to start before the window opens', async () => {
    const { service } = makeService({
      tests: [baselineTest({ opensAt: new Date('2026-08-22T14:00:00Z') })],
    });
    await expect(service.startAttempt('s-srm', 'test-1')).rejects.toThrow(ForbiddenException);
  });
});

describe('grading from the submission mirror', () => {
  const attemptRow = {
    id: 'attempt-1',
    testId: 'test-1',
    studentId: 's-srm',
    status: 'IN_PROGRESS',
    startedAt: new Date('2026-08-22T09:30:00Z'),
    submittedAt: null,
    expiresAt: new Date('2026-08-22T10:30:00Z'),
    reviewStatus: 'NOT_REVIEWED',
    results: [],
    riskFlags: [],
  };

  it('awards points only for problems accepted inside the window', async () => {
    const { service, prisma } = makeService({
      attempt: { ...attemptRow },
      submissions: [
        { titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: new Date('2026-08-22T09:45:00Z') },
        {
          titleSlug: 'valid-parentheses',
          status: 'ATTEMPTED_NOT_ACCEPTED',
          submittedAt: new Date('2026-08-22T09:50:00Z'),
        },
      ],
    });

    await service.gradeTest('test-1');

    const update = prisma.baselineTestAttempt.update.mock.calls.at(-1)![0] as {
      data: { score: number; maxScore: number; solvedCount: number; attemptedCount: number };
    };
    expect(update.data.score).toBe(10);
    expect(update.data.maxScore).toBe(40);
    expect(update.data.solvedCount).toBe(1);
    // Tried-and-failed counts as attempted — the distinction a baseline exists to surface.
    expect(update.data.attemptedCount).toBe(2);
  });

  it('writes a per-problem result for every problem, including untouched ones', async () => {
    const { service, prisma } = makeService({ attempt: { ...attemptRow } });
    await service.gradeTest('test-1');

    const created = prisma.baselineTestProblemResult.createMany.mock.calls[0]![0] as {
      data: { status: string }[];
    };
    expect(created.data).toHaveLength(3);
    expect(created.data.every((row) => row.status === 'NOT_ATTEMPTED')).toBe(true);
  });

  it('never writes to any daily-assignment table', async () => {
    // The structural guarantee behind §25: a baseline result cannot move a streak, a
    // completion percentage or a leaderboard position, because nothing here can reach them.
    const { service, prisma } = makeService({
      attempt: { ...attemptRow },
      submissions: [
        { titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: new Date('2026-08-22T09:45:00Z') },
      ],
    });

    await service.gradeTest('test-1');

    expect(prisma.dailyStatus).not.toHaveProperty('update');
    expect(prisma.dailyStatus).not.toHaveProperty('upsert');
    // The only daily-side read is the historical pace lookup, which is read-only.
    expect(prisma.dailyStatus.findMany).toHaveBeenCalled();
  });
});

describe('risk signals stay observations, never verdicts', () => {
  const attemptRow = {
    id: 'attempt-1',
    testId: 'test-1',
    studentId: 's-srm',
    status: 'IN_PROGRESS',
    startedAt: new Date('2026-08-22T09:30:00Z'),
    submittedAt: null,
    expiresAt: new Date('2026-08-22T10:30:00Z'),
    reviewStatus: 'NOT_REVIEWED',
    results: [],
    riskFlags: [],
  };

  it('flags an acceptance that lands seconds after the attempt began', async () => {
    const { service, prisma } = makeService({
      attempt: { ...attemptRow },
      submissions: [
        { titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: new Date('2026-08-22T09:30:30Z') },
      ],
    });

    await service.gradeTest('test-1');
    const update = prisma.baselineTestAttempt.update.mock.calls.at(-1)![0] as {
      data: { riskFlags: string[]; riskScore: number; reviewStatus?: string };
    };

    expect(update.data.riskFlags).toContain('IMMEDIATE_ACCEPTANCE');
    expect(update.data.reviewStatus).toBe('REVIEW_REQUIRED');
  });

  it('raises nothing at all for a student who solved nothing', async () => {
    const { service, prisma } = makeService({ attempt: { ...attemptRow } });
    await service.gradeTest('test-1');

    const update = prisma.baselineTestAttempt.update.mock.calls.at(-1)![0] as {
      data: { riskFlags: string[]; riskScore: number; reviewStatus?: string };
    };
    expect(update.data.riskFlags).toEqual([]);
    expect(update.data.riskScore).toBe(0);
    expect(update.data.reviewStatus).toBeUndefined();
  });

  it('does not flag a normal working pace', async () => {
    const { service, prisma } = makeService({
      attempt: { ...attemptRow },
      submissions: [
        { titleSlug: 'two-sum', status: 'ATTEMPTED_NOT_ACCEPTED', submittedAt: new Date('2026-08-22T09:40:00Z') },
        { titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: new Date('2026-08-22T09:52:00Z') },
      ],
    });

    await service.gradeTest('test-1');
    const update = prisma.baselineTestAttempt.update.mock.calls.at(-1)![0] as {
      data: { riskFlags: string[] };
    };
    expect(update.data.riskFlags).toEqual([]);
  });

  it('never downgrades a review a human has already recorded', async () => {
    const { service, prisma } = makeService({
      attempt: { ...attemptRow, reviewStatus: 'REVIEWED' },
      submissions: [
        { titleSlug: 'two-sum', status: 'ACCEPTED', submittedAt: new Date('2026-08-22T09:30:10Z') },
      ],
    });

    await service.gradeTest('test-1');
    const update = prisma.baselineTestAttempt.update.mock.calls.at(-1)![0] as {
      data: { reviewStatus?: string };
    };
    // Signals still fire, but a mentor's conclusion is not undone by a re-grade (§23).
    expect(update.data.reviewStatus).toBeUndefined();
  });
});
