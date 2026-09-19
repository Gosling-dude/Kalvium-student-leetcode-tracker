/**
 * `active_students_without_a_campus` (integrity.service.ts) must not fire for a student
 * who has no Coding-Hours campus because they are Infosys-only — that state is correct
 * by design (see the schema.prisma section banner above `InfosysEnrollment`), not a data
 * integrity bug. This broke the production "Verify the deployed system" workflow the
 * moment 193 genuinely campus-less Infosys students were imported (CI run #218): the
 * check didn't yet know that reason for `campusId: null` existed.
 *
 * Tests the exact query the service runs, rather than instantiating the whole
 * `IntegrityService` (which also pulls in `BaselineTestsService`'s full dependency
 * graph for unrelated findings) — this is the invariant that actually matters here.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();
const RUN = `e2e-integrity-infosys-${Date.now()}`;
const CODE = `II${Date.now().toString(36).toUpperCase()}`;

let infosysCampusId: string;
let infosysOnlyStudentId: string;
let genuineOrphanStudentId: string;

async function countOrphanedActiveStudents(): Promise<number> {
  return prisma.student.count({
    where: { status: 'ACTIVE', campusId: null, infosysEnrollment: { is: null } },
  });
}

beforeAll(async () => {
  const campus = await prisma.campus.create({ data: { name: `${RUN} Campus`, code: CODE } });
  infosysCampusId = campus.id;

  const [infosysOnly, genuineOrphan] = await Promise.all([
    prisma.student.create({
      data: {
        name: `${RUN} Infosys Only`,
        status: 'ACTIVE',
        campusId: null,
        infosysEnrollment: { create: { campusId: infosysCampusId } },
      },
    }),
    prisma.student.create({
      data: { name: `${RUN} Genuine Orphan`, status: 'ACTIVE', campusId: null },
    }),
  ]);
  infosysOnlyStudentId = infosysOnly.id;
  genuineOrphanStudentId = genuineOrphan.id;
});

afterAll(async () => {
  await prisma.infosysEnrollment.deleteMany({ where: { studentId: infosysOnlyStudentId } });
  await prisma.student.deleteMany({ where: { id: { in: [infosysOnlyStudentId, genuineOrphanStudentId] } } });
  await prisma.campus.delete({ where: { id: infosysCampusId } });
  await prisma.$disconnect();
});

describe('active_students_without_a_campus excludes Infosys-only students', () => {
  it('does not count an active, Coding-Hours-campus-less, Infosys-enrolled student', async () => {
    const count = await prisma.student.count({
      where: {
        id: infosysOnlyStudentId,
        status: 'ACTIVE',
        campusId: null,
        infosysEnrollment: { is: null },
      },
    });
    expect(count).toBe(0);
  });

  it('still counts a genuine Coding-Hours orphan (no campus, not Infosys-enrolled)', async () => {
    const count = await prisma.student.count({
      where: {
        id: genuineOrphanStudentId,
        status: 'ACTIVE',
        campusId: null,
        infosysEnrollment: { is: null },
      },
    });
    expect(count).toBe(1);
  });

  it('the real aggregate query (as run in production) includes the genuine orphan and excludes the Infosys-only student', async () => {
    const total = await countOrphanedActiveStudents();
    const ids = await prisma.student.findMany({
      where: { status: 'ACTIVE', campusId: null, infosysEnrollment: { is: null } },
      select: { id: true },
    });
    const idSet = new Set(ids.map((s) => s.id));
    expect(idSet.has(genuineOrphanStudentId)).toBe(true);
    expect(idSet.has(infosysOnlyStudentId)).toBe(false);
    expect(total).toBe(ids.length);
  });
});
