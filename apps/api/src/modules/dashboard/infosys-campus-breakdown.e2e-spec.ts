/**
 * Found live: `GET /dashboard`'s per-campus card grid showed all 10 Infosys-only
 * campuses (Chitkara, JECRC, etc. — real institutions, zero Coding-Hours students or
 * batches) as empty cards ("0 active students · No assignment today") alongside
 * Alliance/SRM/Vels. `buildCampusBreakdown`'s "every active campus gets a row even on
 * a day with no work" fallback queried every `Campus` row unconditionally — true
 * before Infosys existed, wrong the moment a campus could exist for a different
 * program entirely.
 *
 * Fixed by routing through `CampusesService.findAll`'s already-tested
 * `hasCodingHoursActivity` filter instead of a second copy of the predicate. This
 * test proves the actual dashboard-shaped behaviour, not just the filter in
 * isolation (that's `infosys-campus-filter.e2e-spec.ts`).
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DashboardService } from './dashboard.service';
import { CampusesService } from '../campuses/campuses.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { BatchesService } from '../batches/batches.service';
import { EnrolmentService } from '../../common/services/enrolment.service';

const prisma = new PrismaClient();
const RUN = `e2e-dashinfosys-${Date.now()}`;
const CODE = `DI${Date.now().toString(36).toUpperCase()}`;
const TODAY = '2026-09-19';

const noCache = { remember: async (_k: string, _t: number, fn: () => unknown) => fn() };
const time = {
  today: () => TODAY,
  yesterday: () => '2026-09-18',
  localTime: () => null,
  dayKeyOf: (date: Date) => date.toISOString().slice(0, 10),
  bounds: (dayKey: string) => ({
    start: new Date(`${dayKey}T00:00:00Z`),
    end: new Date(`${dayKey}T23:59:59Z`),
  }),
};

let dashboard: DashboardService;
let codingHoursCampusId: string;
let infosysOnlyCampusId: string;
let batchId: string;

beforeAll(async () => {
  const [ch, io] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} Coding Hours`, code: `${CODE}CH` } }),
    prisma.campus.create({ data: { name: `${RUN} Infosys Only`, code: `${CODE}IO` } }),
  ]);
  codingHoursCampusId = ch.id;
  infosysOnlyCampusId = io.id;

  // A batch alone is enough to count as "Coding-Hours activity" — no daily status
  // rows are needed to prove inclusion vs exclusion; that's what the filter checks.
  const batch = await prisma.batch.create({
    data: { campusId: codingHoursCampusId, name: 'Foundation Level', code: 'A' },
  });
  batchId = batch.id;

  const campuses = new CampusesService(prisma as never, time as never, noCache as never, new MentorScopeService(prisma as never));
  const batches = new BatchesService(prisma as never, time as never, noCache as never);
  const assignments = { findAllByDay: async () => [] } as never;

  dashboard = new DashboardService(
    prisma as never,
    noCache as never,
    time as never,
    assignments,
    campuses,
    batches,
    new EnrolmentService(prisma as never, time as never),
  );
});

afterAll(async () => {
  await prisma.batch.delete({ where: { id: batchId } });
  await prisma.campus.deleteMany({ where: { id: { in: [codingHoursCampusId, infosysOnlyCampusId] } } });
  await prisma.$disconnect();
});

describe('dashboard campus breakdown excludes Infosys-only campuses', () => {
  it('a real Coding-Hours campus (has a batch) gets a card even with no activity today', async () => {
    const stats = await dashboard.getStats(TODAY);
    const ids = stats.campusBreakdown.map((c) => c.campusId);
    expect(ids).toContain(codingHoursCampusId);
  });

  it('an Infosys-only campus (zero batches, zero Coding-Hours students) gets no card', async () => {
    const stats = await dashboard.getStats(TODAY);
    const ids = stats.campusBreakdown.map((c) => c.campusId);
    expect(ids).not.toContain(infosysOnlyCampusId);
  });
});
