/**
 * InfosysRollupService against a real database — the scenarios the program brief
 * singles out by number, because this is the one place the tracking-window rule
 * (§2, §13) actually gets enforced against real rows, not just pure-function input.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InfosysRollupService } from './infosys-rollup.service';

const prisma = new PrismaClient();
const RUN = `e2e-infosysrollup-${Date.now()}`;
const CODE = `IR${Date.now().toString(36).toUpperCase()}`;

const time = {
  bounds: (dayKey: string) => ({
    start: new Date(`${dayKey}T00:00:00.000Z`),
    end: new Date(`${dayKey}T23:59:59.999Z`),
  }),
} as never;

const service = new InfosysRollupService(prisma as never, time);

let campusId: string;
let problemA: string;
let problemB: string;
let studentLinked: string;
let studentNoProfile: string;
let studentDataUnavailable: string;

async function makeProblem(slug: string): Promise<string> {
  const p = await prisma.problem.create({
    data: { titleSlug: slug, title: slug, difficulty: 'EASY', url: `https://leetcode.com/problems/${slug}/` },
  });
  return p.id;
}

const usedDayKeys = new Set<string>();

async function makeAssignment(dayKey: string, problemIds: string[]): Promise<void> {
  usedDayKeys.add(dayKey);
  await prisma.infosysAssignment.create({
    data: {
      dayKey,
      problems: {
        create: problemIds.map((problemId, i) => ({ problemId, position: i + 1 })),
      },
    },
  });
}

beforeAll(async () => {
  const campus = await prisma.campus.create({ data: { name: `${RUN} Campus`, code: CODE } });
  campusId = campus.id;

  problemA = await makeProblem(`${RUN}-two-sum`);
  problemB = await makeProblem(`${RUN}-reverse-string`);

  const [linked, noProfile, dataUnavailable] = await Promise.all([
    prisma.student.create({
      data: {
        name: `${RUN} Linked`,
        leetcodeUsername: `${RUN}-linked`.toLowerCase(),
        syncState: { create: { status: 'OK' } },
        infosysEnrollment: { create: { campusId } },
      },
    }),
    prisma.student.create({
      data: {
        name: `${RUN} No Profile`,
        infosysEnrollment: { create: { campusId } },
      },
    }),
    prisma.student.create({
      data: {
        name: `${RUN} Data Unavailable`,
        leetcodeUsername: `${RUN}-du`.toLowerCase(),
        syncState: { create: { status: 'PROFILE_PRIVATE' } },
        infosysEnrollment: { create: { campusId } },
      },
    }),
  ]);
  studentLinked = linked.id;
  studentNoProfile = noProfile.id;
  studentDataUnavailable = dataUnavailable.id;
});

afterAll(async () => {
  await prisma.infosysDailyProblemStatus.deleteMany({
    where: { infosysDailyStatus: { studentId: { in: [studentLinked, studentNoProfile, studentDataUnavailable] } } },
  });
  await prisma.infosysDailyStatus.deleteMany({
    where: { studentId: { in: [studentLinked, studentNoProfile, studentDataUnavailable] } },
  });
  await prisma.infosysAssignment.deleteMany({ where: { dayKey: { in: [...usedDayKeys] } } });
  await prisma.submission.deleteMany({ where: { studentId: studentLinked } });
  await prisma.infosysEnrollment.deleteMany({
    where: { studentId: { in: [studentLinked, studentNoProfile, studentDataUnavailable] } },
  });
  await prisma.studentSyncState.deleteMany({ where: { studentId: { in: [studentLinked, studentDataUnavailable] } } });
  await prisma.student.deleteMany({ where: { id: { in: [studentLinked, studentNoProfile, studentDataUnavailable] } } });
  await prisma.problem.deleteMany({ where: { id: { in: [problemA, problemB] } } });
  await prisma.campus.delete({ where: { id: campusId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.infosysDailyProblemStatus.deleteMany({
    where: { infosysDailyStatus: { studentId: { in: [studentLinked, studentNoProfile, studentDataUnavailable] } } },
  });
  await prisma.infosysDailyStatus.deleteMany({
    where: { studentId: { in: [studentLinked, studentNoProfile, studentDataUnavailable] } },
  });
  await prisma.infosysAssignment.deleteMany({ where: { dayKey: { in: [...usedDayKeys] } } });
  usedDayKeys.clear();
  await prisma.submission.deleteMany({ where: { studentId: studentLinked } });
});

describe('InfosysRollupService', () => {
  it('trackingStartDate is MIN(dayKey), not the earliest createdAt', async () => {
    await makeAssignment('2026-09-25', [problemA]);
    await makeAssignment('2026-09-20', [problemB]); // entered second, dated earlier
    expect(await service.trackingStartDate()).toBe('2026-09-20');
  });

  it('a submission before the tracking start date is NOT counted (§2, §13)', async () => {
    await makeAssignment('2026-09-20', [problemA]);
    const slug = (await prisma.problem.findUniqueOrThrow({ where: { id: problemA } })).titleSlug;
    await prisma.submission.create({
      data: {
        studentId: studentLinked,
        providerSubmissionId: `${RUN}-1`,
        titleSlug: slug,
        title: 'Two Sum',
        status: 'ACCEPTED',
        submittedAt: new Date('2026-09-15T00:00:00Z'),
        dayKey: '2026-09-15',
      },
    });

    await service.recomputeDay('2026-09-20');
    const status = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: studentLinked, dayKey: '2026-09-20' } },
    });
    expect(status!.solvedCount).toBe(0);
    expect(status!.notAttemptedCount).toBe(1);
  });

  it('a submission at or after the tracking start date IS counted', async () => {
    await makeAssignment('2026-09-20', [problemA]);
    const slug = (await prisma.problem.findUniqueOrThrow({ where: { id: problemA } })).titleSlug;
    await prisma.submission.create({
      data: {
        studentId: studentLinked,
        providerSubmissionId: `${RUN}-2`,
        titleSlug: slug,
        title: 'Two Sum',
        status: 'ACCEPTED',
        submittedAt: new Date('2026-09-21T00:00:00Z'),
        dayKey: '2026-09-21',
      },
    });

    await service.recomputeDay('2026-09-20');
    const status = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: studentLinked, dayKey: '2026-09-20' } },
    });
    expect(status!.solvedCount).toBe(1);
  });

  it('PROFILE_NOT_LINKED is never converted to 0 (§6, §13)', async () => {
    await makeAssignment('2026-09-20', [problemA, problemB]);
    await service.recomputeDay('2026-09-20');
    const status = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: studentNoProfile, dayKey: '2026-09-20' } },
    });
    expect(status!.profileNotLinkedCount).toBe(2);
    expect(status!.notAttemptedCount).toBe(0);
    expect(status!.solvedCount).toBe(0);
  });

  it('DATA_UNAVAILABLE is never converted to 0 (§6, §13)', async () => {
    await makeAssignment('2026-09-20', [problemA, problemB]);
    await service.recomputeDay('2026-09-20');
    const status = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: studentDataUnavailable, dayKey: '2026-09-20' } },
    });
    expect(status!.dataUnavailableCount).toBe(2);
    expect(status!.notAttemptedCount).toBe(0);
  });

  it('a late-entered historical assignment keeps its original (assigned) date, not the entry date', async () => {
    // "Entered" now (createdAt = now), but dayKey is the actual assignment date.
    await makeAssignment('2026-09-20', [problemA]);
    const stored = await prisma.infosysAssignment.findUnique({ where: { dayKey: '2026-09-20' } });
    expect(stored!.dayKey).toBe('2026-09-20');
    // createdAt is "now" (test run time), definitely not equal to the assigned dayKey.
    expect(stored!.createdAt.toISOString().slice(0, 10)).not.toBe('2026-09-20');
  });

  it('§15: a question solved between the (late-entered) assignment date and the (later) profile-add date still counts', async () => {
    // Infosys start = assignment date = 20 Sep. Student solved on 21 Sep, profile added
    // "today" (simulated by this test running after both). Recompute must still credit it.
    await makeAssignment('2026-09-20', [problemA]);
    const slug = (await prisma.problem.findUniqueOrThrow({ where: { id: problemA } })).titleSlug;
    await prisma.submission.create({
      data: {
        studentId: studentLinked,
        providerSubmissionId: `${RUN}-3`,
        titleSlug: slug,
        title: 'Two Sum',
        status: 'ACCEPTED',
        submittedAt: new Date('2026-09-21T00:00:00Z'),
        dayKey: '2026-09-21',
      },
    });
    await service.recomputeStudent(studentLinked);
    const status = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: studentLinked, dayKey: '2026-09-20' } },
    });
    expect(status!.solvedCount).toBe(1);
  });

  it('§15: a question solved 5 days before the tracking start date must NOT count even via recomputeStudent', async () => {
    await makeAssignment('2026-09-20', [problemA]);
    const slug = (await prisma.problem.findUniqueOrThrow({ where: { id: problemA } })).titleSlug;
    await prisma.submission.create({
      data: {
        studentId: studentLinked,
        providerSubmissionId: `${RUN}-4`,
        titleSlug: slug,
        title: 'Two Sum',
        status: 'ACCEPTED',
        submittedAt: new Date('2026-09-15T00:00:00Z'),
        dayKey: '2026-09-15',
      },
    });
    await service.recomputeStudent(studentLinked);
    const status = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: studentLinked, dayKey: '2026-09-20' } },
    });
    expect(status!.solvedCount).toBe(0);
  });

  it('§7: 10 submissions with 2 accepted for the same problem = 1 solved, not 2', async () => {
    await makeAssignment('2026-09-20', [problemA]);
    const slug = (await prisma.problem.findUniqueOrThrow({ where: { id: problemA } })).titleSlug;
    await prisma.submission.createMany({
      data: Array.from({ length: 8 }, (_, i) => ({
        studentId: studentLinked,
        providerSubmissionId: `${RUN}-dup-wa-${i}`,
        titleSlug: slug,
        title: 'Two Sum',
        status: 'ATTEMPTED_NOT_ACCEPTED' as const,
        submittedAt: new Date(`2026-09-2${(i % 9) + 1}T00:00:00Z`),
        dayKey: `2026-09-2${(i % 9) + 1}`,
      })),
    });
    await prisma.submission.createMany({
      data: [
        {
          studentId: studentLinked,
          providerSubmissionId: `${RUN}-dup-ac-1`,
          titleSlug: slug,
          title: 'Two Sum',
          status: 'ACCEPTED',
          submittedAt: new Date('2026-09-25T00:00:00Z'),
          dayKey: '2026-09-25',
        },
        {
          studentId: studentLinked,
          providerSubmissionId: `${RUN}-dup-ac-2`,
          titleSlug: slug,
          title: 'Two Sum',
          status: 'ACCEPTED',
          submittedAt: new Date('2026-09-26T00:00:00Z'),
          dayKey: '2026-09-26',
        },
      ],
    });

    await service.recomputeDay('2026-09-20');
    const status = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: studentLinked, dayKey: '2026-09-20' } },
    });
    expect(status!.solvedCount).toBe(1);
  });

  it('recomputing twice in a row is idempotent (§5)', async () => {
    await makeAssignment('2026-09-20', [problemA]);
    const slug = (await prisma.problem.findUniqueOrThrow({ where: { id: problemA } })).titleSlug;
    await prisma.submission.create({
      data: {
        studentId: studentLinked,
        providerSubmissionId: `${RUN}-idem`,
        titleSlug: slug,
        title: 'Two Sum',
        status: 'ACCEPTED',
        submittedAt: new Date('2026-09-21T00:00:00Z'),
        dayKey: '2026-09-21',
      },
    });

    await service.recomputeDay('2026-09-20');
    const first = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: studentLinked, dayKey: '2026-09-20' } },
    });
    await service.recomputeDay('2026-09-20');
    const second = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: studentLinked, dayKey: '2026-09-20' } },
    });

    expect(second!.id).toBe(first!.id); // updated in place, not duplicated
    expect(second!.solvedCount).toBe(first!.solvedCount);
    const rowCount = await prisma.infosysDailyStatus.count({
      where: { studentId: studentLinked, dayKey: '2026-09-20' },
    });
    expect(rowCount).toBe(1);
  });

  it('a day with no InfosysAssignment is a no-op', async () => {
    const result = await service.recomputeDay('2026-01-01');
    expect(result.studentsProcessed).toBe(0);
    const status = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: studentLinked, dayKey: '2026-01-01' } },
    });
    expect(status).toBeNull();
  });

  it('the same problem cannot be assigned twice on the same day (§7, DB-enforced)', async () => {
    await expect(
      prisma.infosysAssignment.create({
        data: {
          dayKey: '2026-09-22',
          problems: {
            create: [
              { problemId: problemA, position: 1 },
              { problemId: problemA, position: 2 },
            ],
          },
        },
      }),
    ).rejects.toThrow();
  });

  it('assignedCount = solved + attemptedNotSolved + notAttempted for a fully-observed student (partition invariant)', async () => {
    await makeAssignment('2026-09-20', [problemA, problemB]);
    const slugA = (await prisma.problem.findUniqueOrThrow({ where: { id: problemA } })).titleSlug;
    await prisma.submission.create({
      data: {
        studentId: studentLinked,
        providerSubmissionId: `${RUN}-partition`,
        titleSlug: slugA,
        title: 'Two Sum',
        status: 'ACCEPTED',
        submittedAt: new Date('2026-09-21T00:00:00Z'),
        dayKey: '2026-09-21',
      },
    });
    await service.recomputeDay('2026-09-20');
    const status = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: studentLinked, dayKey: '2026-09-20' } },
    });
    expect(status!.solvedCount + status!.attemptedNotSolvedCount + status!.notAttemptedCount).toBe(
      status!.assignedCount,
    );
    expect(status!.assignedCount).toBe(2);
  });
});
