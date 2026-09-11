/**
 * Filter correctness, per role, against a real database.
 *
 * Every case here is a filter that was reported as "not appearing" or "not working", and
 * every one of them turned out to be a scoping question rather than a UI one:
 *
 *  - **The options offered must be options the caller can act on.** `GET /students/filters`
 *    returned every campus, batch and squad in the programme to every mentor, with a live
 *    student count against each. Picking one then produced an empty table, which reads as
 *    a broken filter — and the counts alone described cohorts the mentor has no grant on.
 *  - **Filters compose.** Campus + batch + squad + search + status applied together must
 *    narrow, not override one another, and the count beside a paginated result must be the
 *    count of the *filtered* set.
 *  - **Pagination and sorting stay inside the filter.** Page 2 of a campus-filtered list
 *    is page 2 of that campus, not of the programme.
 *  - **A mentor's scope survives every one of the above**, including the case where the
 *    request names a campus they do not hold.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StudentsService } from './students.service';
import { StudentMetricsService } from '../scoring/student-metrics.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import type { StudentQueryDto } from './dto/student.dto';

const prisma = new PrismaClient();
const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const mentorScope = new MentorScopeService(prisma as never);
const metrics = new StudentMetricsService(
  prisma as never,
  time,
  { getActive: async () => null } as never,
  {} as never,
);
const students = new StudentsService(prisma as never, time, metrics, {} as never);

const RUN = `e2e-filter-${Date.now()}`;
const CODE = `FS${Date.now().toString(36).toUpperCase()}`;

let vels: string;
let srm: string;
let velsFoundation: string;
let velsIntermediate: string;
let srmFoundation: string;
let velsSquad: string;
let velsMentor: { id: string; role: 'MENTOR' };
let admin: { id: string; role: 'ADMIN' };

/** A query object with the getters `PaginationQueryDto` supplies. */
function query(over: Partial<StudentQueryDto> = {}): StudentQueryDto {
  const page = over.page ?? 1;
  const pageSize = over.pageSize ?? 50;
  return {
    page,
    pageSize,
    sortOrder: over.sortOrder ?? 'asc',
    get skip() {
      return (page - 1) * pageSize;
    },
    get take() {
      return pageSize;
    },
    ...over,
  } as StudentQueryDto;
}

beforeAll(async () => {
  const [v, s] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} Vels`, code: `${CODE}V` } }),
    prisma.campus.create({ data: { name: `${RUN} SRM`, code: `${CODE}S` } }),
  ]);
  vels = v.id;
  srm = s.id;

  const [vf, vi, sf] = await Promise.all([
    prisma.batch.create({ data: { name: `${RUN} V Foundation`, code: 'A', campusId: vels } }),
    prisma.batch.create({ data: { name: `${RUN} V Intermediate`, code: 'B', campusId: vels } }),
    prisma.batch.create({ data: { name: `${RUN} S Foundation`, code: 'A', campusId: srm } }),
  ]);
  velsFoundation = vf.id;
  velsIntermediate = vi.id;
  srmFoundation = sf.id;

  const squad = await prisma.squad.create({
    data: { name: 'Squad 77', campusId: vels, batchId: velsFoundation },
  });
  velsSquad = squad.id;
  await prisma.squad.create({ data: { name: 'Squad 88', campusId: srm, batchId: srmFoundation } });

  // 6 Vels Foundation (3 in Squad 77), 4 Vels Intermediate, 5 SRM Foundation.
  const rows: { name: string; campusId: string; batchId: string; squadId?: string }[] = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push({
      name: `${RUN} VF ${String(i).padStart(2, '0')}`,
      campusId: vels,
      batchId: velsFoundation,
      ...(i < 3 ? { squadId: velsSquad } : {}),
    });
  }
  for (let i = 0; i < 4; i += 1) {
    rows.push({
      name: `${RUN} VI ${String(i).padStart(2, '0')}`,
      campusId: vels,
      batchId: velsIntermediate,
    });
  }
  for (let i = 0; i < 5; i += 1) {
    rows.push({
      name: `${RUN} SF ${String(i).padStart(2, '0')}`,
      campusId: srm,
      batchId: srmFoundation,
    });
  }
  for (const row of rows) {
    await prisma.student.create({ data: { ...row, cohort: 4, status: 'ACTIVE' } });
  }

  // One archived Vels student, to prove the default excludes them and the filter finds them.
  await prisma.student.create({
    data: {
      name: `${RUN} VF archived`,
      campusId: vels,
      batchId: velsFoundation,
      status: 'ARCHIVED',
      cohort: 4,
    },
  });

  const mentor = await prisma.user.create({
    data: {
      email: `${RUN}-vels@filter-scope.invalid`,
      name: 'Vels mentor',
      role: 'MENTOR',
      passwordHash: 'x',
      mentorCampuses: { create: { campusId: vels } },
    },
  });
  velsMentor = { id: mentor.id, role: 'MENTOR' };

  const adminUser = await prisma.user.create({
    data: {
      email: `${RUN}-admin@filter-scope.invalid`,
      name: 'Admin',
      role: 'ADMIN',
      passwordHash: 'x',
    },
  });
  admin = { id: adminUser.id, role: 'ADMIN' };
});

afterAll(async () => {
  await prisma.student.deleteMany({ where: { name: { startsWith: RUN } } });
  await prisma.squad.deleteMany({ where: { campusId: { in: [vels, srm] } } });
  await prisma.batch.deleteMany({ where: { campusId: { in: [vels, srm] } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.campus.deleteMany({ where: { id: { in: [vels, srm] } } });
  await prisma.$disconnect();
});

/** What the directory would return for this caller and query, scope applied. */
async function asCaller(user: { id: string; role: 'MENTOR' | 'ADMIN' }, q: StudentQueryDto) {
  const allowed = await mentorScope.allowedCampusIds(user);
  const narrowed = mentorScope.narrow(q.campusId, allowed);
  if (narrowed.deny) return students.emptyPage(q);
  q.campusId = narrowed.campusId;
  return students.findAll(q, { campusIds: narrowed.campusIds });
}

function names(page: { items: { name: string }[] }): string[] {
  return page.items.filter((row) => row.name.startsWith(RUN)).map((row) => row.name);
}

describe('filter options are narrowed to what the caller can act on', () => {
  it('offers a mentor only their own campus, batches and squads', async () => {
    const allowed = await mentorScope.allowedCampusIds(velsMentor);
    const options = await students.getFilterOptions(allowed);

    const ours = options.campuses.filter((c) => c.code.startsWith(CODE));
    expect(ours.map((c) => c.code)).toEqual([`${CODE}V`]);

    expect(options.batches.filter((b) => b.name.startsWith(RUN)).map((b) => b.name)).toEqual([
      `${RUN} V Foundation`,
      `${RUN} V Intermediate`,
    ]);
    // SRM's Squad 88 is not offered, and neither is its student count.
    expect(options.squads.some((g) => g.campusId === srm)).toBe(false);
    expect(options.squadNumbers.some((n) => n.campusId === srm)).toBe(false);
  });

  it('offers an admin every campus', async () => {
    const options = await students.getFilterOptions(await mentorScope.allowedCampusIds(admin));
    const ours = options.campuses.filter((c) => c.code.startsWith(CODE)).map((c) => c.code);
    expect(ours.sort()).toEqual([`${CODE}S`, `${CODE}V`]);
  });

  it('offers a mentor with no grants nothing, rather than everything', async () => {
    // `[]` and `null` must not collapse: the direction they collapse in decides whether
    // this mentor sees nothing or sees the whole programme.
    const options = await students.getFilterOptions([]);
    expect(options.campuses).toEqual([]);
    expect(options.batches).toEqual([]);
  });
});

describe('a mentor is pinned to their campus on every shape of query', () => {
  it('returns only their campus when no campus is named', async () => {
    const page = await asCaller(velsMentor, query());
    expect(names(page)).toHaveLength(10);
    expect(names(page).every((n) => n.includes(' V'))).toBe(true);
  });

  it('answers a request for another campus as empty, never as their own', async () => {
    const page = await asCaller(velsMentor, query({ campusId: srm }));
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('cannot reach another campus by naming its batch id', async () => {
    // The batch filter is not a way around the campus filter: both apply.
    const page = await asCaller(velsMentor, query({ batchId: srmFoundation }));
    expect(page.items).toEqual([]);
  });

  it('cannot reach another campus by naming its squad number', async () => {
    // Squad numbers repeat across campuses, which is exactly why this needs asserting.
    const page = await asCaller(velsMentor, query({ squadNumber: 88 }));
    expect(names(page)).toEqual([]);
  });

  it('lets an admin see both campuses, and narrow to either', async () => {
    // Searched by the run prefix rather than listed unfiltered: an admin's unfiltered
    // page 1 is the whole roster, and this suite's fixtures are not on it.
    const all = await asCaller(admin, query({ search: RUN }));
    expect(names(all)).toHaveLength(15);

    const justSrm = await asCaller(admin, query({ search: RUN, campusId: srm }));
    expect(names(justSrm)).toHaveLength(5);
  });
});

describe('filters compose rather than override', () => {
  it('narrows by campus and batch together', async () => {
    const page = await asCaller(velsMentor, query({ batchId: velsFoundation }));
    expect(names(page)).toHaveLength(6);
  });

  it('narrows by campus, batch and squad together', async () => {
    const page = await asCaller(velsMentor, query({ batchId: velsFoundation, squadNumber: 77 }));
    expect(names(page)).toHaveLength(3);
  });

  it('applies search *inside* the filter, not instead of it', async () => {
    // "VF" matches only Vels Foundation names; the Intermediate filter must still exclude
    // them, leaving nothing. A search that replaced the filter would return six.
    const page = await asCaller(
      velsMentor,
      query({ batchId: velsIntermediate, search: `${RUN} VF` }),
    );
    expect(names(page)).toEqual([]);
  });

  it('combines search with a squad filter', async () => {
    const page = await asCaller(velsMentor, query({ squadNumber: 77, search: `${RUN} VF 0` }));
    expect(names(page)).toHaveLength(3);
  });

  it('clearing a filter restores the wider set', async () => {
    const narrowed = await asCaller(velsMentor, query({ batchId: velsFoundation }));
    const cleared = await asCaller(velsMentor, query());
    expect(names(narrowed)).toHaveLength(6);
    expect(names(cleared)).toHaveLength(10);
  });
});

describe('archived students are a filter, not a default', () => {
  it('excludes them from a plain query', async () => {
    const page = await asCaller(velsMentor, query());
    expect(names(page).some((n) => n.endsWith('archived'))).toBe(false);
  });

  it('includes them when asked, and only them when named', async () => {
    const both = await asCaller(velsMentor, query({ includeArchived: true }));
    expect(names(both)).toHaveLength(11);

    const only = await asCaller(velsMentor, query({ status: 'ARCHIVED' }));
    expect(names(only)).toEqual([`${RUN} VF archived`]);
  });
});

describe('pagination and sorting stay inside the filter', () => {
  it('counts the filtered set, not the programme', async () => {
    const page = await asCaller(velsMentor, query({ batchId: velsFoundation, pageSize: 2 }));
    expect(page.items).toHaveLength(2);
    // `total` drives the pager. If it counted the unfiltered set the user would be
    // offered pages that come back empty.
    expect(page.total).toBe(6);
  });

  it('pages within the filter — page 2 of a campus, not of everything', async () => {
    const first = await asCaller(
      velsMentor,
      query({ batchId: velsFoundation, pageSize: 4, sortBy: 'name' }),
    );
    const second = await asCaller(
      velsMentor,
      query({ batchId: velsFoundation, pageSize: 4, page: 2, sortBy: 'name' }),
    );

    expect(names(first)).toHaveLength(4);
    expect(names(second)).toHaveLength(2);
    // No overlap, and nothing from another batch or campus leaked onto the second page.
    expect(names(second).every((n) => n.includes('VF'))).toBe(true);
    expect(new Set([...names(first), ...names(second)]).size).toBe(6);
  });

  it('sorts within the filter, in both directions', async () => {
    const asc = await asCaller(
      velsMentor,
      query({ batchId: velsFoundation, sortBy: 'name', sortOrder: 'asc' }),
    );
    const desc = await asCaller(
      velsMentor,
      query({ batchId: velsFoundation, sortBy: 'name', sortOrder: 'desc' }),
    );

    expect(names(asc)).toEqual([...names(desc)].reverse());
    expect(names(asc)).toHaveLength(6);
  });
});

describe('routes keyed by a student id are scoped too', () => {
  it('refuses a mentor another campus’s student, as "not found"', async () => {
    const srmStudent = await prisma.student.findFirst({
      where: { name: { startsWith: `${RUN} SF` } },
      select: { id: true },
    });

    await expect(
      mentorScope.assertStudentVisible(velsMentor, srmStudent!.id),
    ).rejects.toThrow(/was not found/);
  });

  it('allows their own', async () => {
    const velsStudent = await prisma.student.findFirst({
      where: { name: { startsWith: `${RUN} VF 0` } },
      select: { id: true },
    });

    await expect(
      mentorScope.assertStudentVisible(velsMentor, velsStudent!.id),
    ).resolves.toBeUndefined();
  });

  it('answers a missing student the same way as a forbidden one', async () => {
    // Identical messages, so the route cannot be used to probe which ids exist.
    const missing = '00000000-0000-4000-8000-000000000000';
    await expect(mentorScope.assertStudentVisible(velsMentor, missing)).rejects.toThrow(
      /was not found/,
    );
  });

  it('lets an admin read any student', async () => {
    const srmStudent = await prisma.student.findFirst({
      where: { name: { startsWith: `${RUN} SF` } },
      select: { id: true },
    });
    await expect(
      mentorScope.assertStudentVisible(admin, srmStudent!.id),
    ).resolves.toBeUndefined();
  });
});
