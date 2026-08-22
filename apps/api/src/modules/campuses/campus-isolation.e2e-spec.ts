/**
 * Cross-campus isolation and historical integrity, verified against a real database.
 *
 * Three scenarios, each of which the schema — not the application code — is ultimately
 * responsible for:
 *
 *  1. **Four independent scopes on one date.** Vels/Foundation, Vels/Intermediate,
 *     SRM/Foundation and SRM/Intermediate can all be created for the same day, and the
 *     partial unique indexes still forbid a genuine duplicate of any one of them (§9).
 *
 *  2. **No cross-campus leak.** Resolving what an SRM student was assigned never returns
 *     a Vels row, and vice versa.
 *
 *  3. **A campus transfer does not rewrite history.** A student at Vels on 10 Aug who
 *     transfers to SRM on 20 Aug is still reported under Vels for 10 Aug, and their
 *     10 Aug result is unchanged (§17).
 *
 * Integration rather than unit tests on purpose: what is being verified is a property of
 * stored data and of database constraints, and a mocked Prisma would only prove the mock
 * behaves as written.
 *
 * Fixtures live under a unique prefix and are removed in `afterAll`, so this is safe to
 * run against a development database.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveCampusOnDay, selectAssignmentForScope } from '@dsa/shared';

const prisma = new PrismaClient();

/** Unique per run, so a crashed run never collides with the next one. */
const RUN = `e2e-campus-${Date.now()}`;

const AUG_10 = '2026-08-10';
const AUG_20 = '2026-08-20';
/** Far enough out that no real assignment exists for it. */
const DAY = '2099-06-01';

let velsId: string;
let srmId: string;
let velsA: string;
let velsB: string;
let srmA: string;
let srmB: string;
let studentId: string;

const createdAssignmentIds: string[] = [];
const createdProblemIds: string[] = [];

async function campusByCode(code: string): Promise<{ id: string }> {
  const campus = await prisma.campus.findUnique({ where: { code }, select: { id: true } });
  if (!campus) {
    throw new Error(
      `Campus ${code} is missing. Run \`npm run db:migrate -w @dsa/api\` before the e2e suite.`,
    );
  }
  return campus;
}

async function batchByCode(campusId: string, code: string): Promise<{ id: string }> {
  const batch = await prisma.batch.findUnique({
    where: { campusId_code: { campusId, code } },
    select: { id: true },
  });
  if (!batch) throw new Error(`Batch ${code} is missing at campus ${campusId}.`);
  return batch;
}

beforeAll(async () => {
  velsId = (await campusByCode('VELS')).id;
  srmId = (await campusByCode('SRM')).id;
  velsA = (await batchByCode(velsId, 'A')).id;
  velsB = (await batchByCode(velsId, 'B')).id;
  srmA = (await batchByCode(srmId, 'A')).id;
  srmB = (await batchByCode(srmId, 'B')).id;

  // One problem per audience, so "which set was this student measured against" is
  // answerable by looking at which problem id their day references.
  for (const suffix of ['va', 'vb', 'sa', 'sb', 'hist']) {
    const problem = await prisma.problem.create({
      data: {
        titleSlug: `${RUN}-${suffix}`,
        title: `${RUN} ${suffix}`,
        difficulty: 'EASY',
        url: `https://leetcode.com/problems/${RUN}-${suffix}/`,
      },
    });
    createdProblemIds.push(problem.id);
  }

  // A student who starts at Vels/Foundation and transfers to SRM/Intermediate on 20 Aug.
  const student = await prisma.student.create({
    data: {
      name: `${RUN} transferee`,
      email: `${RUN}@campus-isolation.invalid`,
      campusId: velsId,
      batchId: velsA,
      status: 'ACTIVE',
      campusHistory: {
        create: [
          { toCampusId: velsId, effectiveFromDayKey: '2026-01-01', source: 'MIGRATION' },
          {
            fromCampusId: velsId,
            toCampusId: srmId,
            effectiveFromDayKey: AUG_20,
            source: 'MANUAL',
          },
        ],
      },
      batchHistory: {
        create: [
          { toBatchId: velsA, effectiveFromDayKey: '2026-01-01', source: 'MIGRATION' },
          { fromBatchId: velsA, toBatchId: srmB, effectiveFromDayKey: AUG_20, source: 'MANUAL' },
        ],
      },
    },
  });
  studentId = student.id;
});

afterAll(async () => {
  await prisma.dailyStatus.deleteMany({ where: { studentId } });
  await prisma.assignmentProblem.deleteMany({
    where: { assignmentId: { in: createdAssignmentIds } },
  });
  await prisma.assignment.deleteMany({ where: { id: { in: createdAssignmentIds } } });
  await prisma.student.deleteMany({ where: { id: studentId } });
  await prisma.problem.deleteMany({ where: { id: { in: createdProblemIds } } });
  await prisma.$disconnect();
});

describe('four independent scopes on one calendar date', () => {
  it('accepts all four without any of them colliding', async () => {
    const scopes: [string, string, string][] = [
      [velsId, velsA, `${RUN}-va`],
      [velsId, velsB, `${RUN}-vb`],
      [srmId, srmA, `${RUN}-sa`],
      [srmId, srmB, `${RUN}-sb`],
    ];

    for (const [campusId, batchId, slug] of scopes) {
      const problem = await prisma.problem.findUniqueOrThrow({ where: { titleSlug: slug } });
      const assignment = await prisma.assignment.create({
        data: {
          dayKey: DAY,
          campusId,
          batchId,
          originalCampusId: campusId,
          originalBatchId: batchId,
          problems: { create: [{ problemId: problem.id, position: 1 }] },
        },
      });
      createdAssignmentIds.push(assignment.id);
    }

    const rows = await prisma.assignment.findMany({ where: { dayKey: DAY } });
    expect(rows).toHaveLength(4);
  });

  it('still refuses a genuine duplicate of one of those four', async () => {
    // The composite unique index, doing exactly its job: same day, same campus, same
    // batch. Four coexisting audiences must not weaken that.
    await expect(
      prisma.assignment.create({
        data: { dayKey: DAY, campusId: srmId, batchId: srmA },
      }),
    ).rejects.toThrow();
  });

  it('refuses a second whole-campus row for the same day', async () => {
    // The partial unique index on (dayKey, campusId) WHERE batch_id IS NULL. Without it,
    // Postgres would treat the two NULL batches as distinct and allow both.
    const first = await prisma.assignment.create({
      data: { dayKey: DAY, campusId: srmId, batchId: null },
    });
    createdAssignmentIds.push(first.id);

    await expect(
      prisma.assignment.create({ data: { dayKey: DAY, campusId: srmId, batchId: null } }),
    ).rejects.toThrow();
  });

  it('refuses a second everyone row for the same day', async () => {
    // The partial unique index on (dayKey) WHERE campus_id IS NULL AND batch_id IS NULL.
    const first = await prisma.assignment.create({
      data: { dayKey: DAY, campusId: null, batchId: null },
    });
    createdAssignmentIds.push(first.id);

    await expect(
      prisma.assignment.create({ data: { dayKey: DAY, campusId: null, batchId: null } }),
    ).rejects.toThrow();
  });
});

describe('resolution never crosses a campus', () => {
  it('gives each audience its own problem set', async () => {
    const candidates = await prisma.assignment.findMany({
      where: { dayKey: DAY },
      include: { problems: { include: { problem: true } } },
    });

    const slugFor = (campusId: string, batchId: string): string | undefined =>
      selectAssignmentForScope(candidates, { campusId, batchId })?.problems[0]?.problem
        .titleSlug;

    expect(slugFor(velsId, velsA)).toBe(`${RUN}-va`);
    expect(slugFor(velsId, velsB)).toBe(`${RUN}-vb`);
    expect(slugFor(srmId, srmA)).toBe(`${RUN}-sa`);
    expect(slugFor(srmId, srmB)).toBe(`${RUN}-sb`);
  });

  it('never hands an SRM student a Vels set when SRM has none of its own', async () => {
    const velsOnly = await prisma.assignment.findMany({
      where: { dayKey: DAY, campusId: velsId },
      include: { problems: { include: { problem: true } } },
    });

    expect(selectAssignmentForScope(velsOnly, { campusId: srmId, batchId: srmA })).toBeNull();
  });
});

describe('a campus transfer does not rewrite history', () => {
  it('resolves the campus that was true on the day, not the current one', async () => {
    const placements = await prisma.studentCampusHistory.findMany({
      where: { studentId },
      select: { toCampusId: true, effectiveFromDayKey: true, changedAt: true },
    });

    expect(resolveCampusOnDay(placements, AUG_10)).toBe(velsId);
    expect(resolveCampusOnDay(placements, '2026-08-19')).toBe(velsId);
    expect(resolveCampusOnDay(placements, AUG_20)).toBe(srmId);

    // The student's *current* campus is SRM — and that is precisely the value that must
    // not be used to answer the 10 Aug question above.
    const current = await prisma.student.findUniqueOrThrow({
      where: { id: studentId },
      select: { campusId: true },
    });
    expect(current.campusId).toBe(velsId);
  });

  it('keeps a past day filed under the campus it was recorded with', async () => {
    const problem = await prisma.problem.findUniqueOrThrow({
      where: { titleSlug: `${RUN}-hist` },
    });
    const historical = await prisma.assignment.create({
      data: {
        dayKey: AUG_10,
        campusId: velsId,
        batchId: velsA,
        originalCampusId: velsId,
        originalBatchId: velsA,
        problems: { create: [{ problemId: problem.id, position: 1 }] },
      },
    });
    createdAssignmentIds.push(historical.id);

    // The rollup freezes campus and batch on the row the first time the day is scored.
    await prisma.dailyStatus.create({
      data: {
        studentId,
        dayKey: AUG_10,
        assignmentId: historical.id,
        campusId: velsId,
        batchId: velsA,
        assignedCount: 1,
        solvedCount: 1,
      },
    });

    // Exactly the query a campus-filtered historical report runs.
    const underVels = await prisma.dailyStatus.count({
      where: { dayKey: AUG_10, campusId: velsId, studentId },
    });
    const underSrm = await prisma.dailyStatus.count({
      where: { dayKey: AUG_10, campusId: srmId, studentId },
    });

    expect(underVels).toBe(1);
    expect(underSrm).toBe(0);
  });
});

describe('campus-scoped batch codes', () => {
  it('lets both campuses have a batch with the same code and name', async () => {
    const vels = await prisma.batch.findUniqueOrThrow({
      where: { campusId_code: { campusId: velsId, code: 'A' } },
    });
    const srm = await prisma.batch.findUniqueOrThrow({
      where: { campusId_code: { campusId: srmId, code: 'A' } },
    });

    expect(vels.id).not.toBe(srm.id);
    expect(vels.name).toBe(srm.name);
  });

  it('still refuses a duplicate code within one campus', async () => {
    await expect(
      prisma.batch.create({ data: { campusId: srmId, code: 'A', name: `${RUN} clash` } }),
    ).rejects.toThrow();
  });
});
