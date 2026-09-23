/**
 * Campus Analysis must show only campuses with real Coding-Hours activity — the same bug
 * already found and fixed on the main Dashboard (`aedec6e`, `infosys-campus-breakdown.e2e-spec.ts`)
 * existed here too: `scopeFor` queried every `Campus` row unconditionally, so an
 * Infosys-only campus (zero Coding-Hours students, zero batches) showed up as an empty
 * "0 active students" card here as well. Fixed by routing through
 * `CampusesService.findAll`'s already-tested `hasCodingHoursActivity` filter.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CampusAnalysisService } from './campus-analysis.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { CampusesService } from '../campuses/campuses.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import type { RequestUser } from '../../common/decorators';

const prisma = new PrismaClient();
const RUN = `e2e-casc-${Date.now()}`;
const CODE = `CS${Date.now().toString(36).toUpperCase()}`;

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const mentorScope = new MentorScopeService(prisma as never);
const cache = { remember: (_key: string, _ttl: number, fn: () => unknown) => fn() } as never;
const campuses = new CampusesService(prisma as never, time, cache, mentorScope);
const service = new CampusAnalysisService(prisma as never, time, mentorScope, campuses);

const admin: RequestUser = { id: '', email: 'a@x.invalid', name: 'Admin', role: 'ADMIN', studentId: null } as RequestUser;

let activeCampusId: string;
let infosysOnlyCampusId: string;
let batchId: string;
let studentId: string;

beforeAll(async () => {
  const [active, infosysOnly] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} Active`, code: `${CODE}A` } }),
    prisma.campus.create({ data: { name: `${RUN} Infosys Only`, code: `${CODE}I` } }),
  ]);
  activeCampusId = active.id;
  infosysOnlyCampusId = infosysOnly.id;

  const batch = await prisma.batch.create({
    data: { name: `${RUN} Batch`, code: 'A', campusId: activeCampusId },
  });
  batchId = batch.id;

  const student = await prisma.student.create({
    data: { name: `${RUN} Student`, status: 'ACTIVE', campusId: activeCampusId, batchId },
  });
  studentId = student.id;
});

afterAll(async () => {
  await prisma.student.deleteMany({ where: { id: studentId } });
  await prisma.batch.delete({ where: { id: batchId } });
  await prisma.campus.deleteMany({ where: { id: { in: [activeCampusId, infosysOnlyCampusId] } } });
  await prisma.$disconnect();
});

describe('Campus Analysis excludes campuses with no Coding-Hours activity', () => {
  it('an admin’s campus list never includes an Infosys-only campus', async () => {
    const { campuses } = await service.summary(admin, {});
    const ids = campuses.map((c) => c.campusId);
    expect(ids).toContain(activeCampusId);
    expect(ids).not.toContain(infosysOnlyCampusId);
  });

  it('requesting the Infosys-only campus id directly 404s, not silently succeeds', async () => {
    await expect(service.summary(admin, { campusId: infosysOnlyCampusId })).rejects.toThrow();
  });

  it('the Infosys-only campus row itself is untouched (no data deleted, no status changed)', async () => {
    const campus = await prisma.campus.findUnique({ where: { id: infosysOnlyCampusId } });
    expect(campus).not.toBeNull();
    expect(campus!.status).toBe('ACTIVE');
  });
});
