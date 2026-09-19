/**
 * Infosys is one flat cohort, never campus-divided (see
 * `InfosysAnalyticsService`'s header comment — an earlier version of this feature
 * built a full campus-wise analysis layer and it was deliberately removed). This test
 * exists to keep that true structurally: two students at two different campuses must
 * combine into one dashboard total, and the student list must never accept or need a
 * campus filter to see both of them.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InfosysAnalyticsService } from './infosys-analytics.service';
import { InfosysRollupService } from './infosys-rollup.service';

const prisma = new PrismaClient();
const RUN = `e2e-infosyscohort-${Date.now()}`;
const CODE = `IC${Date.now().toString(36).toUpperCase()}`;

const time = {
  bounds: (dayKey: string) => ({
    start: new Date(`${dayKey}T00:00:00.000Z`),
    end: new Date(`${dayKey}T23:59:59.999Z`),
  }),
} as never;

const rollup = new InfosysRollupService(prisma as never, time);
const analytics = new InfosysAnalyticsService(prisma as never, rollup);

let campusA: string;
let campusB: string;
let studentA: string;
let studentB: string;
let problemId: string;

beforeAll(async () => {
  const [a, b] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} A`, code: `${CODE}A` } }),
    prisma.campus.create({ data: { name: `${RUN} B`, code: `${CODE}B` } }),
  ]);
  campusA = a.id;
  campusB = b.id;

  const problem = await prisma.problem.create({
    data: { titleSlug: `${RUN}-slug`, title: 'X', difficulty: 'EASY', url: 'https://leetcode.com/problems/x/' },
  });
  problemId = problem.id;

  const [sa, sb] = await Promise.all([
    prisma.student.create({
      data: {
        name: `${RUN} A Student`,
        leetcodeUsername: `${RUN}-a`.toLowerCase(),
        syncState: { create: { status: 'OK' } },
        infosysEnrollment: { create: { campusId: campusA } },
      },
    }),
    prisma.student.create({
      data: {
        name: `${RUN} B Student`,
        leetcodeUsername: `${RUN}-b`.toLowerCase(),
        syncState: { create: { status: 'OK' } },
        infosysEnrollment: { create: { campusId: campusB } },
      },
    }),
  ]);
  studentA = sa.id;
  studentB = sb.id;

  await prisma.infosysAssignment.create({
    data: { dayKey: '2026-09-20', problems: { create: [{ problemId, position: 1 }] } },
  });

  const slug = `${RUN}-slug`;
  // Student A solves it, student B does not — a real, checkable difference.
  await prisma.submission.create({
    data: {
      studentId: studentA,
      providerSubmissionId: `${RUN}-sub`,
      titleSlug: slug,
      title: 'X',
      status: 'ACCEPTED',
      submittedAt: new Date('2026-09-21T00:00:00Z'),
      dayKey: '2026-09-21',
    },
  });

  await rollup.recomputeDay('2026-09-20');
});

afterAll(async () => {
  await prisma.infosysDailyProblemStatus.deleteMany({
    where: { infosysDailyStatus: { studentId: { in: [studentA, studentB] } } },
  });
  await prisma.infosysDailyStatus.deleteMany({ where: { studentId: { in: [studentA, studentB] } } });
  await prisma.infosysAssignment.deleteMany({ where: { dayKey: '2026-09-20' } });
  await prisma.submission.deleteMany({ where: { studentId: studentA } });
  await prisma.infosysEnrollment.deleteMany({ where: { studentId: { in: [studentA, studentB] } } });
  await prisma.student.deleteMany({ where: { id: { in: [studentA, studentB] } } });
  await prisma.problem.delete({ where: { id: problemId } });
  await prisma.campus.deleteMany({ where: { id: { in: [campusA, campusB] } } });
  await prisma.$disconnect();
});

describe('Infosys is one cohort, not campus-divided', () => {
  it('the dashboard has no campus field, one distinct question assigned counts as 1 (not 205+), and combines both campuses’ students into one total', async () => {
    const dashboard = await analytics.dashboard();
    expect(dashboard).not.toHaveProperty('campusId');
    expect(dashboard).not.toHaveProperty('campusName');
    expect(dashboard.totalStudents).toBeGreaterThanOrEqual(2);
    // The single problem this fixture assigned is exactly 1 distinct question, however
    // many students (real roster + these 2 fixtures) it was assigned to (§10).
    expect(dashboard.assigned).toBe(1);
    // At least one student (studentA) solved it, so the question's cohort-wide outcome
    // is SOLVED, and the partition holds at the question level.
    expect(dashboard.solved).toBe(1);
    expect(dashboard.solved + dashboard.attemptedNotSolved + dashboard.notAttempted).toBe(dashboard.assigned);
  });

  it('the student list returns students from every campus together, with no campus argument to the call', async () => {
    const students = await analytics.studentAnalysis();
    const ids = students.map((s) => s.studentId);
    expect(ids).toContain(studentA);
    expect(ids).toContain(studentB);
  });

  it('campusName is present only as an informational field, never used to exclude a student', async () => {
    const students = await analytics.studentAnalysis();
    const a = students.find((s) => s.studentId === studentA)!;
    const b = students.find((s) => s.studentId === studentB)!;
    expect(a.campusName).toBe(`${RUN} A`);
    expect(b.campusName).toBe(`${RUN} B`);
    // Both present in the same flat list despite different campusName values.
  });

  it('a student solving the assigned question is reflected correctly in their own analysis', async () => {
    const analysis = await analytics.studentAnalysisFor(studentA);
    expect(analysis).not.toBeNull();
    expect(analysis!.solved).toBe(1);
  });

  it('the other student, who did not solve it, is NOT_ATTEMPTED, not silently dropped', async () => {
    const analysis = await analytics.studentAnalysisFor(studentB);
    expect(analysis).not.toBeNull();
    expect(analysis!.solved).toBe(0);
    expect(analysis!.notAttempted).toBe(1);
  });

  it('a student not enrolled in Infosys at all returns null, not an error', async () => {
    const analysis = await analytics.studentAnalysisFor('00000000-0000-0000-0000-000000000000');
    expect(analysis).toBeNull();
  });
});
