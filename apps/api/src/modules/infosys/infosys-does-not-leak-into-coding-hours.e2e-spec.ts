/**
 * Found live: every Coding-Hours "current roster" surface (dashboard, leaderboard,
 * campus-analysis, reports, analytics) filters its base population on
 * `Student.status: 'ACTIVE'` alone. `import-infosys-roster.ts` originally created new
 * Infosys students with `status: 'ACTIVE'`, `campusId: null` — the first-ever students
 * in this system's history with no Coding-Hours campus who still counted as an active
 * Coding-Hours student. That silently inflated the main dashboard's student totals,
 * "profile missing" tally, and every other Coding-Hours aggregate.
 *
 * The fix: Infosys-only students are `status: 'ARCHIVED'` — the one status this
 * codebase already, comprehensively excludes from every current Coding-Hours view.
 * This test asserts the actual invariant, not an implementation detail: such a
 * student must not match the shape every Coding-Hours roster query uses
 * (`status: 'ACTIVE'`), while still being fully visible to Infosys's own analytics,
 * which never reads `Student.status` at all.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InfosysAnalyticsService } from './infosys-analytics.service';
import { InfosysRollupService } from './infosys-rollup.service';

const prisma = new PrismaClient();
const RUN = `e2e-infosysnoleak-${Date.now()}`;
const CODE = `NL${Date.now().toString(36).toUpperCase()}`;

const time = {
  bounds: (dayKey: string) => ({
    start: new Date(`${dayKey}T00:00:00.000Z`),
    end: new Date(`${dayKey}T23:59:59.999Z`),
  }),
} as never;

const rollup = new InfosysRollupService(prisma as never, time);
const analytics = new InfosysAnalyticsService(prisma as never, rollup);

let campusId: string;
let infosysOnlyStudentId: string;
let problemId: string;

beforeAll(async () => {
  const campus = await prisma.campus.create({ data: { name: `${RUN} Campus`, code: CODE } });
  campusId = campus.id;

  const student = await prisma.student.create({
    data: {
      name: `${RUN} Infosys Only`,
      status: 'ARCHIVED',
      archivedAt: new Date(),
      archivedReason: 'Never enrolled in Coding Hours — Infosys Preparation only',
      campusId: null,
      infosysEnrollment: { create: { campusId } },
    },
  });
  infosysOnlyStudentId = student.id;

  // studentAnalysis() needs a tracking window (MIN(InfosysAssignment.dayKey)) to
  // return anything at all — without this, `period()` is null and every student list
  // is legitimately empty, which would make this test pass for the wrong reason.
  const problem = await prisma.problem.create({
    data: { titleSlug: `${RUN}-slug`, title: 'X', difficulty: 'EASY', url: 'https://leetcode.com/problems/x/' },
  });
  problemId = problem.id;
  await prisma.infosysAssignment.create({
    data: { dayKey: '2020-11-15', problems: { create: [{ problemId, position: 1 }] } },
  });
});

afterAll(async () => {
  await prisma.infosysDailyProblemStatus.deleteMany({
    where: { infosysDailyStatus: { studentId: infosysOnlyStudentId } },
  });
  await prisma.infosysDailyStatus.deleteMany({ where: { studentId: infosysOnlyStudentId } });
  await prisma.infosysAssignment.deleteMany({ where: { dayKey: '2020-11-15' } });
  await prisma.problem.delete({ where: { id: problemId } });
  await prisma.infosysEnrollment.deleteMany({ where: { studentId: infosysOnlyStudentId } });
  await prisma.student.delete({ where: { id: infosysOnlyStudentId } });
  await prisma.campus.delete({ where: { id: campusId } });
  await prisma.$disconnect();
});

describe('an Infosys-only student does not leak into Coding-Hours roster queries', () => {
  it('does not match the shape every Coding-Hours "active roster" query uses', async () => {
    const matches = await prisma.student.count({
      where: { id: infosysOnlyStudentId, status: 'ACTIVE' },
    });
    expect(matches).toBe(0);
  });

  it('is still fully counted in Infosys’s own totalStudents (Infosys never reads Student.status)', async () => {
    const dashboard = await analytics.dashboard();
    // Bounded, not exact — the real roster + other tests may add enrollments — but this
    // student's own enrollment row must be among what infosysEnrollment.count() sees.
    const totalEnrollments = await prisma.infosysEnrollment.count();
    expect(dashboard.totalStudents).toBe(totalEnrollments);
    const thisOne = await prisma.infosysEnrollment.findUnique({ where: { studentId: infosysOnlyStudentId } });
    expect(thisOne).not.toBeNull();
  });

  it('still appears in the Infosys student list despite being Coding-Hours-ARCHIVED', async () => {
    const students = await analytics.studentAnalysis();
    const found = students.find((s) => s.studentId === infosysOnlyStudentId);
    expect(found).toBeDefined();
    expect(found!.profileState).toBe('PROFILE_NOT_LINKED');
  });
});
