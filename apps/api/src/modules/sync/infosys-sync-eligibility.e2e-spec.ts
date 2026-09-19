/**
 * A student archived out of Coding Hours who is still enrolled in Infosys Preparation
 * must keep being picked up by a routine sync.
 *
 * Confirmed against production before this fix: 12 of the Infosys roster's 19 "Vels
 * Institute of Science" students already exist as `ARCHIVED` Coding-Hours students at
 * that campus. Infosys has no sync engine of its own (§5 of the program brief) — it
 * reads the same raw `Submission` mirror this job populates — so if `resolveStudentIds`
 * only ever looked at Coding-Hours' `status`, those 12 real students would silently stop
 * getting new submissions mirrored the moment Coding Hours archived them, and Infosys
 * would report them as increasingly stale without any error appearing anywhere.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SyncService } from './sync.service';

const prisma = new PrismaClient();

const RUN = `e2e-infosync-${Date.now()}`;
const CODE = `IE${Date.now().toString(36).toUpperCase()}`;

let campusId: string;
let archivedInfosysStudent: string;
let archivedCodingHoursOnlyStudent: string;
let activeCodingHoursStudent: string;

/** Only `start()`'s resolution of which students to include is exercised; the queue
 * dispatch is stubbed so no actual sync work runs. */
const service = new SyncService(
  prisma as never,
  undefined as never,
  { today: () => '2026-09-19' } as never,
  { dispatch: async () => {} } as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
);

beforeAll(async () => {
  const campus = await prisma.campus.create({ data: { name: `${RUN} Campus`, code: CODE } });
  campusId = campus.id;

  const [infosysArchived, codingHoursOnlyArchived, active] = await Promise.all([
    prisma.student.create({
      data: {
        name: `${RUN} Infosys Archived`,
        campusId,
        status: 'ARCHIVED',
        leetcodeUsername: `${RUN}-infosys-archived`.toLowerCase(),
        infosysEnrollment: { create: { campusId } },
      },
    }),
    prisma.student.create({
      data: {
        name: `${RUN} Coding Hours Only Archived`,
        campusId,
        status: 'ARCHIVED',
        leetcodeUsername: `${RUN}-ch-only-archived`.toLowerCase(),
      },
    }),
    prisma.student.create({
      data: {
        name: `${RUN} Active`,
        campusId,
        status: 'ACTIVE',
        leetcodeUsername: `${RUN}-active`.toLowerCase(),
      },
    }),
  ]);

  archivedInfosysStudent = infosysArchived.id;
  archivedCodingHoursOnlyStudent = codingHoursOnlyArchived.id;
  activeCodingHoursStudent = active.id;
});

afterAll(async () => {
  await prisma.infosysEnrollment.deleteMany({ where: { studentId: archivedInfosysStudent } });
  await prisma.student.deleteMany({
    where: { id: { in: [archivedInfosysStudent, archivedCodingHoursOnlyStudent, activeCodingHoursStudent] } },
  });
  await prisma.campus.delete({ where: { id: campusId } });
  await prisma.$disconnect();
});

describe('sync eligibility includes archived-but-Infosys-enrolled students', () => {
  it('includes an ACTIVE Coding-Hours student', async () => {
    const summary = await service.start({ mode: 'FULL' });
    const items = await prisma.syncJobItem.findMany({ where: { syncJobId: summary.id } });
    const ids = items.map((i) => i.studentId);
    expect(ids).toContain(activeCodingHoursStudent);
    await prisma.syncJobItem.deleteMany({ where: { syncJobId: summary.id } });
    await prisma.syncJob.delete({ where: { id: summary.id } });
  });

  it('includes an ARCHIVED Coding-Hours student who is enrolled in Infosys', async () => {
    const summary = await service.start({ mode: 'FULL' });
    const items = await prisma.syncJobItem.findMany({ where: { syncJobId: summary.id } });
    const ids = items.map((i) => i.studentId);
    expect(ids).toContain(archivedInfosysStudent);
    await prisma.syncJobItem.deleteMany({ where: { syncJobId: summary.id } });
    await prisma.syncJob.delete({ where: { id: summary.id } });
  });

  it('excludes an ARCHIVED Coding-Hours student with no Infosys enrollment', async () => {
    const summary = await service.start({ mode: 'FULL' });
    const items = await prisma.syncJobItem.findMany({ where: { syncJobId: summary.id } });
    const ids = items.map((i) => i.studentId);
    expect(ids).not.toContain(archivedCodingHoursOnlyStudent);
    await prisma.syncJobItem.deleteMany({ where: { syncJobId: summary.id } });
    await prisma.syncJob.delete({ where: { id: summary.id } });
  });
});
