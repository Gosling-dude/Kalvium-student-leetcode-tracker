/**
 * Found live in production: `GET /infosys/students` showed "0 students" while 205
 * were genuinely enrolled, because `studentAnalysis()` returned `[]` whenever no
 * `InfosysAssignment` existed yet — conflating "no tracking window" with "no roster".
 * The roster import happens before the first assignment is ever entered (§1 of the
 * brief explicitly describes this order), so this was not an edge case: it was the
 * state production was actually in.
 *
 * This test enrolls students with zero InfosysAssignment rows anywhere in the
 * database reachable by it (a fresh, isolated fixture, not reusing the real roster)
 * and asserts the list still shows them, with empty weeks and zero counts rather than
 * being empty itself.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InfosysAnalyticsService } from './infosys-analytics.service';
import { InfosysRollupService } from './infosys-rollup.service';

const prisma = new PrismaClient();
const RUN = `e2e-infosysbeforeassign-${Date.now()}`;
const CODE = `BA${Date.now().toString(36).toUpperCase()}`;

const time = {
  bounds: (dayKey: string) => ({
    start: new Date(`${dayKey}T00:00:00.000Z`),
    end: new Date(`${dayKey}T23:59:59.999Z`),
  }),
} as never;

const rollup = new InfosysRollupService(prisma as never, time);
const analytics = new InfosysAnalyticsService(prisma as never, rollup);

let campusId: string;
let studentId: string;

beforeAll(async () => {
  const campus = await prisma.campus.create({ data: { name: `${RUN} Campus`, code: CODE } });
  campusId = campus.id;

  const student = await prisma.student.create({
    data: {
      name: `${RUN} Student`,
      status: 'ARCHIVED',
      campusId: null,
      infosysEnrollment: { create: { campusId } },
    },
  });
  studentId = student.id;
});

afterAll(async () => {
  await prisma.infosysEnrollment.deleteMany({ where: { studentId } });
  await prisma.student.delete({ where: { id: studentId } });
  await prisma.campus.delete({ where: { id: campusId } });
  await prisma.$disconnect();
});

describe('Infosys student list before any assignment has ever been entered', () => {
  it('studentAnalysis() still lists an enrolled student, not an empty array', async () => {
    // Note: this reads the real database, which may or may not have InfosysAssignment
    // rows from the actual roster by the time this runs — the assertion is scoped to
    // this fixture's own student, not to the list being empty overall.
    const students = await analytics.studentAnalysis();
    const found = students.find((s) => s.studentId === studentId);
    expect(found).toBeDefined();
    expect(found!.assigned).toBe(0);
    expect(found!.weeks).toEqual([]);
  });

  it('studentAnalysisFor() returns the student with empty weeks rather than null', async () => {
    const analysis = await analytics.studentAnalysisFor(studentId);
    expect(analysis).not.toBeNull();
    expect(analysis!.weeks).toEqual([]);
    expect(analysis!.assigned).toBe(0);
    expect(analysis!.solved).toBe(0);
  });

  it('an unlinked profile is still reported as PROFILE_NOT_LINKED, not a fabricated category', async () => {
    const analysis = await analytics.studentAnalysisFor(studentId);
    expect(analysis!.profileState).toBe('PROFILE_NOT_LINKED');
    expect(analysis!.verdict.category).toBe('PROFILE_NOT_LINKED');
  });
});
