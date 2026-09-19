/**
 * §22/§23: a mentor must see only their granted campus's Infosys data; an admin sees
 * everything. Reuses `MentorScopeService` — the same service every other campus-aware
 * endpoint in this codebase is scoped by — so this test is really checking that
 * `InfosysAnalyticsService` actually calls it, not re-deriving the scoping rule itself.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InfosysAnalyticsService } from './infosys-analytics.service';
import { InfosysRollupService } from './infosys-rollup.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';

const prisma = new PrismaClient();
const RUN = `e2e-infosysscope-${Date.now()}`;
const CODE = `IS${Date.now().toString(36).toUpperCase()}`;

const time = {
  bounds: (dayKey: string) => ({
    start: new Date(`${dayKey}T00:00:00.000Z`),
    end: new Date(`${dayKey}T23:59:59.999Z`),
  }),
} as never;

const rollup = new InfosysRollupService(prisma as never, time);
const scope = new MentorScopeService(prisma as never);
const analytics = new InfosysAnalyticsService(prisma as never, scope, rollup);

let campusA: string;
let campusB: string;
let studentA: string;
let studentB: string;
let mentorUserId: string;
let adminUserId: string;
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
      data: { name: `${RUN} A Student`, infosysEnrollment: { create: { campusId: campusA } } },
    }),
    prisma.student.create({
      data: { name: `${RUN} B Student`, infosysEnrollment: { create: { campusId: campusB } } },
    }),
  ]);
  studentA = sa.id;
  studentB = sb.id;

  await prisma.infosysAssignment.create({
    data: { dayKey: '2026-09-20', problems: { create: [{ problemId, position: 1 }] } },
  });
  await rollup.recomputeDay('2026-09-20');

  const [mentor, admin] = await Promise.all([
    prisma.user.create({
      data: {
        email: `${RUN}-mentor@kalvium.community`,
        passwordHash: 'x',
        role: 'MENTOR',
        name: 'Mentor',
        mentorCampuses: { create: { campusId: campusA } },
      },
    }),
    prisma.user.create({
      data: { email: `${RUN}-admin@kalvium.community`, passwordHash: 'x', role: 'ADMIN', name: 'Admin' },
    }),
  ]);
  mentorUserId = mentor.id;
  adminUserId = admin.id;
});

afterAll(async () => {
  await prisma.infosysDailyProblemStatus.deleteMany({
    where: { infosysDailyStatus: { studentId: { in: [studentA, studentB] } } },
  });
  await prisma.infosysDailyStatus.deleteMany({ where: { studentId: { in: [studentA, studentB] } } });
  await prisma.infosysAssignment.deleteMany({ where: { dayKey: '2026-09-20' } });
  await prisma.mentorCampus.deleteMany({ where: { userId: mentorUserId } });
  await prisma.user.deleteMany({ where: { id: { in: [mentorUserId, adminUserId] } } });
  await prisma.infosysEnrollment.deleteMany({ where: { studentId: { in: [studentA, studentB] } } });
  await prisma.student.deleteMany({ where: { id: { in: [studentA, studentB] } } });
  await prisma.problem.delete({ where: { id: problemId } });
  await prisma.campus.deleteMany({ where: { id: { in: [campusA, campusB] } } });
  await prisma.$disconnect();
});

describe('Infosys analysis scoping', () => {
  it('admin sees every campus', async () => {
    const summary = await analytics.campusSummary({ id: adminUserId, role: 'ADMIN' });
    const ids = summary.map((s) => s.campusId);
    expect(ids).toContain(campusA);
    expect(ids).toContain(campusB);
  });

  it('mentor sees only their granted campus', async () => {
    const summary = await analytics.campusSummary({ id: mentorUserId, role: 'MENTOR' });
    const ids = summary.map((s) => s.campusId);
    expect(ids).toContain(campusA);
    expect(ids).not.toContain(campusB);
  });

  it('mentor requesting another campus explicitly gets nothing, not an error-revealing result', async () => {
    const summary = await analytics.campusSummary({ id: mentorUserId, role: 'MENTOR' }, campusB);
    expect(summary).toHaveLength(0);
  });

  it('student-level view is scoped the same way: mentor never sees the other campus’s student', async () => {
    const students = await analytics.studentAnalysis({ id: mentorUserId, role: 'MENTOR' });
    const ids = students.map((s) => s.studentId);
    expect(ids).toContain(studentA);
    expect(ids).not.toContain(studentB);
  });

  it('admin student-level view includes both campuses’ students', async () => {
    const students = await analytics.studentAnalysis({ id: adminUserId, role: 'ADMIN' });
    const ids = students.map((s) => s.studentId);
    expect(ids).toContain(studentA);
    expect(ids).toContain(studentB);
  });
});
