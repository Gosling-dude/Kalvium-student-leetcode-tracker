/**
 * The Coding-Hours campus filter picker (`ScopeFilter` on the frontend) must not offer
 * a campus that exists only for Infosys Preparation.
 *
 * Found live: after the Infosys roster import created 10 new `Campus` rows (Chitkara,
 * JECRC, etc. — real institutions with real Infosys students, but zero Coding-Hours
 * presence, since Infosys students deliberately have `Student.campusId: null`), every
 * existing Coding-Hours screen using the shared campus picker — Assignments, Campus
 * Analysis, the dashboard — started listing them alongside Alliance/SRM/Vels, with
 * nothing behind them to filter by. `hasCodingHoursActivity` is the fix:
 * `CampusesService.findAll` excludes campuses with zero active Coding-Hours students
 * and zero active batches when the caller opts in, which `ScopeFilter` now does.
 *
 * Admin campus-management views (`mentor-management.tsx`) deliberately call this
 * endpoint *without* the flag, and must still see every campus — an admin granting a
 * mentor access, or just managing the roster, needs the full list, Infosys-only
 * campuses included. This is tested here too, so the fix cannot accidentally widen
 * into hiding a real campus from campus management.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CampusesService } from './campuses.service';
import { MentorScopeService } from './mentor-scope.service';

const prisma = new PrismaClient();
const RUN = `e2e-infosyscampusfilter-${Date.now()}`;
const CODE = `IF${Date.now().toString(36).toUpperCase()}`;

const time = { today: () => '2026-09-19' } as never;
const cache = { remember: (_key: string, _ttl: number, fn: () => unknown) => fn() } as never;
const mentorScope = new MentorScopeService(prisma as never);
const service = new CampusesService(prisma as never, time, cache, mentorScope);

let codingHoursCampus: string;
let infosysOnlyCampus: string;
let chStudentId: string;
let infosysStudentId: string;
let batchId: string;

beforeAll(async () => {
  const [ch, io] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} Coding Hours Campus`, code: `${CODE}CH` } }),
    prisma.campus.create({ data: { name: `${RUN} Infosys Only Campus`, code: `${CODE}IO` } }),
  ]);
  codingHoursCampus = ch.id;
  infosysOnlyCampus = io.id;

  const batch = await prisma.batch.create({
    data: { campusId: codingHoursCampus, name: 'Foundation Level', code: 'A' },
  });
  batchId = batch.id;

  const [chStudent, infosysStudent] = await Promise.all([
    prisma.student.create({
      data: { name: `${RUN} CH Student`, status: 'ACTIVE', campusId: codingHoursCampus, batchId },
    }),
    prisma.student.create({
      data: {
        name: `${RUN} Infosys Student`,
        status: 'ACTIVE',
        campusId: null,
        infosysEnrollment: { create: { campusId: infosysOnlyCampus } },
      },
    }),
  ]);
  chStudentId = chStudent.id;
  infosysStudentId = infosysStudent.id;
});

afterAll(async () => {
  await prisma.infosysEnrollment.deleteMany({ where: { studentId: infosysStudentId } });
  await prisma.student.deleteMany({ where: { id: { in: [chStudentId, infosysStudentId] } } });
  await prisma.batch.delete({ where: { id: batchId } });
  await prisma.campus.deleteMany({ where: { id: { in: [codingHoursCampus, infosysOnlyCampus] } } });
  await prisma.$disconnect();
});

describe('CampusesService.findAll hasCodingHoursActivity', () => {
  it('without the flag (admin campus management), both campuses are returned', async () => {
    const all = await service.findAll(false, null, false);
    const ids = all.map((c) => c.id);
    expect(ids).toContain(codingHoursCampus);
    expect(ids).toContain(infosysOnlyCampus);
  });

  it('with the flag (the Coding-Hours filter picker), the Infosys-only campus is excluded', async () => {
    const filtered = await service.findAll(false, null, true);
    const ids = filtered.map((c) => c.id);
    expect(ids).toContain(codingHoursCampus);
    expect(ids).not.toContain(infosysOnlyCampus);
  });
});
