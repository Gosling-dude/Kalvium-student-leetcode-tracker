/**
 * A sync job's per-student rows must not name another campus's students.
 *
 * `GET /sync/jobs/:id/items` keys on nothing but the job id, and a sync job covers the
 * whole roster — so before this was scoped the response was a directory of every campus's
 * students, names and LeetCode handles included, reachable by any mentor.
 *
 * This one was found by auditing what every controller does with campus rather than by
 * following the reported symptom: it sits behind the admin screen's sync panel, not the
 * mentor pages that were reported as leaking. Testing only the pages named in a bug report
 * would have left it in place, which is why the test lives here rather than being folded
 * into the mentor-view suite.
 *
 * The filter is on the *student*, since the job has no campus of its own. A row whose
 * student falls outside the caller's grants is dropped rather than redacted: rendering it
 * as "Unknown" would still disclose that another campus had a student with that sync
 * outcome, and the row count is information on its own.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SyncService } from './sync.service';

const prisma = new PrismaClient();

const RUN = `e2e-syncitems-${Date.now()}`;
const CODE = `SI${Date.now().toString(36).toUpperCase()}`;

let vels: string;
let srm: string;
let velsStudent: string;
let srmStudent: string;
let jobId: string;

/** Only `jobItems` is exercised, and it touches nothing but Prisma. */
const service = new SyncService(
  prisma as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
);

beforeAll(async () => {
  const [v, s] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} Vels`, code: `${CODE}V` } }),
    prisma.campus.create({ data: { name: `${RUN} SRM`, code: `${CODE}S` } }),
  ]);
  vels = v.id;
  srm = s.id;

  const [a, b] = await Promise.all([
    prisma.student.create({
      data: {
        name: `${RUN} Vels Student`,
        campusId: vels,
        leetcodeUsername: `${RUN}-vels`.toLowerCase(),
      },
    }),
    prisma.student.create({
      data: {
        name: `${RUN} SRM Student`,
        campusId: srm,
        leetcodeUsername: `${RUN}-srm`.toLowerCase(),
      },
    }),
  ]);
  velsStudent = a.id;
  srmStudent = b.id;

  // One job covering both campuses — the shape every real sync has.
  const job = await prisma.syncJob.create({
    data: { status: 'COMPLETED', mode: 'FULL', trigger: 'MANUAL', totalStudents: 2 },
  });
  jobId = job.id;

  await prisma.syncJobItem.createMany({
    data: [
      { syncJobId: jobId, studentId: velsStudent, status: 'OK', newSubmissions: 3 },
      { syncJobId: jobId, studentId: srmStudent, status: 'OK', newSubmissions: 5 },
    ],
  });
});

afterAll(async () => {
  await prisma.syncJobItem.deleteMany({ where: { syncJobId: jobId } });
  await prisma.syncJob.delete({ where: { id: jobId } });
  await prisma.student.deleteMany({ where: { id: { in: [velsStudent, srmStudent] } } });
  await prisma.campus.deleteMany({ where: { id: { in: [vels, srm] } } });
  await prisma.$disconnect();
});

describe('sync job items', () => {
  it('gives an admin every campus’s rows', async () => {
    const rows = await service.jobItems(jobId, null);
    expect(rows).toHaveLength(2);
  });

  it('gives a mentor only their own campus’s rows', async () => {
    const rows = await service.jobItems(jobId, [vels]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.studentId).toBe(velsStudent);
  });

  it('never names another campus’s student or handle', async () => {
    // The actual disclosure: names and LeetCode handles, not just ids.
    const rows = await service.jobItems(jobId, [vels]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('SRM Student');
    expect(text).not.toContain(`${RUN}-srm`);
  });

  it('drops the foreign row rather than redacting it', async () => {
    // A row rendered as "Unknown" still says another campus had a student with this sync
    // outcome, and the count discloses how many.
    const rows = await service.jobItems(jobId, [vels]);
    expect(rows.map((row) => row.name)).not.toContain('Unknown');
    expect(rows).toHaveLength(1);
  });

  it('shows a mentor with no grants nothing', async () => {
    // `[]` must match nobody — never widen into "no filter".
    expect(await service.jobItems(jobId, [])).toHaveLength(0);
  });

  it('shows both campuses to a mentor granted both', async () => {
    const rows = await service.jobItems(jobId, [vels, srm]);
    expect(rows).toHaveLength(2);
  });
});
