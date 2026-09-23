/**
 * Removing a student from the active Infosys cohort (deleting their `InfosysEnrollment`
 * row — the mechanism the 2026-09-23 cohort reconciliation used, see
 * `infosys-cohort-reconcile-2026-09-23.ts`) must exclude them from every active Infosys
 * view without touching a single historical row.
 *
 * "Historical data != active cohort": `InfosysDailyStatus` / `InfosysDailyProblemStatus`
 * key on `studentId` directly (never on `InfosysEnrollment`, see the schema.prisma
 * section banner), so they cannot cascade away when the enrollment row is deleted —
 * this test proves that in both directions: the removed student's history survives, and
 * every active-cohort read (dashboard totals, the student list, category counts) stops
 * counting them the moment their enrollment is gone.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InfosysRollupService } from './infosys-rollup.service';
import { InfosysAnalyticsService } from './infosys-analytics.service';

const prisma = new PrismaClient();
const RUN = `e2e-infosysremoval-${Date.now()}`;
const CODE = `IX${Date.now().toString(36).toUpperCase()}`;

const time = {
  bounds: (dayKey: string) => ({
    start: new Date(`${dayKey}T00:00:00.000Z`),
    end: new Date(`${dayKey}T23:59:59.999Z`),
  }),
} as never;

const rollup = new InfosysRollupService(prisma as never, time);
const analytics = new InfosysAnalyticsService(prisma as never, rollup);

let campusId: string;
let problemId: string;
let dayKey: string;
let staying: string;
let removed: string;

beforeAll(async () => {
  const campus = await prisma.campus.create({ data: { name: `${RUN} Campus`, code: CODE } });
  campusId = campus.id;

  const problem = await prisma.problem.create({
    data: {
      titleSlug: `${RUN}-two-sum`,
      title: `${RUN}-two-sum`,
      difficulty: 'EASY',
      url: `https://leetcode.com/problems/${RUN}-two-sum/`,
    },
  });
  problemId = problem.id;

  dayKey = '2026-09-21';
  await prisma.infosysAssignment.create({
    data: { dayKey, problems: { create: [{ problemId, position: 1 }] } },
  });

  const [stayingStudent, removedStudent] = await Promise.all([
    prisma.student.create({
      data: { name: `${RUN} Staying`, infosysEnrollment: { create: { campusId } } },
    }),
    prisma.student.create({
      data: { name: `${RUN} Removed`, infosysEnrollment: { create: { campusId } } },
    }),
  ]);
  staying = stayingStudent.id;
  removed = removedStudent.id;

  // Materialise a real day for both students, exactly like production's rollup does.
  await rollup.recomputeDay(dayKey as never);
});

afterAll(async () => {
  await prisma.infosysDailyProblemStatus.deleteMany({
    where: { infosysDailyStatus: { studentId: { in: [staying, removed] } } },
  });
  await prisma.infosysDailyStatus.deleteMany({ where: { studentId: { in: [staying, removed] } } });
  await prisma.infosysAssignment.deleteMany({ where: { dayKey } });
  await prisma.problem.delete({ where: { id: problemId } });
  await prisma.infosysEnrollment.deleteMany({ where: { studentId: { in: [staying, removed] } } });
  await prisma.student.deleteMany({ where: { id: { in: [staying, removed] } } });
  await prisma.campus.delete({ where: { id: campusId } });
  await prisma.$disconnect();
});

describe('removing an InfosysEnrollment excludes the student from active analytics without deleting history', () => {
  it('both students are counted while both are enrolled', async () => {
    const before = await analytics.studentAnalysis();
    const ids = before.map((a) => a.studentId);
    expect(ids).toContain(staying);
    expect(ids).toContain(removed);
  });

  it('after the enrollment row is deleted, the student disappears from active analytics', async () => {
    await prisma.infosysEnrollment.delete({ where: { studentId: removed } });

    const after = await analytics.studentAnalysis();
    const ids = after.map((a) => a.studentId);
    expect(ids).toContain(staying);
    expect(ids).not.toContain(removed);

    const single = await analytics.studentAnalysisFor(removed);
    expect(single).toBeNull();
  });

  it('the removed student’s historical InfosysDailyStatus / InfosysDailyProblemStatus rows still exist', async () => {
    const status = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: removed, dayKey } },
      include: { problemStatuses: true },
    });
    expect(status).not.toBeNull();
    expect(status!.assignedCount).toBe(1);
    expect(status!.problemStatuses).toHaveLength(1);
  });

  it('the removed student’s Student row and the assignment itself are untouched', async () => {
    const student = await prisma.student.findUnique({ where: { id: removed } });
    expect(student).not.toBeNull();

    const assignment = await prisma.infosysAssignment.findUnique({ where: { dayKey } });
    expect(assignment).not.toBeNull();
  });
});
