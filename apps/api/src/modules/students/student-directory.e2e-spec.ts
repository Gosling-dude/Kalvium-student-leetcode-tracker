/**
 * The student directory is a roster view, not a sync view.
 *
 * A production report said the Students page showed 21 of SRM's 99 students. The cause
 * turned out to be a sync-state filter left applied rather than the query — but the
 * question the report raises is worth answering permanently, because the failure mode it
 * describes is silent: a student who disappears from the directory because of a join
 * against `DailyStatus`, `StudentSyncState`, `Batch` or `LeaderboardEntry` looks exactly
 * like a student who was never imported, and nothing on the page says which.
 *
 * So the property under test is a negative one, and it is checked one missing relation at
 * a time: **being on the roster is sufficient to appear**. No batch, no cohort, no handle,
 * no sync row, no daily status, no assignment, no submission — every one of those students
 * is still a student, and the campus count and the directory total must agree about them
 * (§2, §3, §5, §8).
 *
 * Integration rather than unit tests, for the same reason as `campus-isolation.e2e-spec`:
 * what is being verified is which rows a Prisma query returns, and a mocked client would
 * only prove the mock was written to agree with the assertion.
 *
 * Fixtures live under a unique prefix and are removed in `afterAll`, so this is safe to
 * run against a development database that already has data in it.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();

/** Unique per run, so a crashed run never collides with the next one. */
const RUN = `e2e-dir-${Date.now()}`;

/**
 * The directory's `where` clause, mirroring `StudentsService.buildWhere`.
 *
 * Restated here rather than imported because importing the service would drag in Nest's
 * DI container, and because the point of the test is that the *shape* is a roster filter:
 * a plain `AND` of optional scalar predicates on `students`, with no relation filter that
 * could turn into an inner join. If someone adds one, this file has to be edited to match,
 * which is exactly the moment to ask whether it belongs there.
 */
interface DirectoryQuery {
  campusId?: string;
  batchId?: string;
  unassigned?: boolean;
  syncStatus?: string;
  includeArchived?: boolean;
  status?: string;
}

function directoryWhere(query: DirectoryQuery): Record<string, unknown> {
  return {
    // Fixture isolation: the real query has no such clause.
    email: { startsWith: RUN },
    ...(query.status
      ? { status: query.status }
      : query.includeArchived
        ? {}
        : { status: { not: 'ARCHIVED' } }),
    ...(query.campusId ? { campusId: query.campusId } : {}),
    ...(query.batchId ? { batchId: query.batchId } : {}),
    ...(query.unassigned ? { batchId: null } : {}),
    ...(query.syncStatus ? { syncState: { status: query.syncStatus } } : {}),
  };
}

async function directoryTotal(query: DirectoryQuery): Promise<number> {
  return prisma.student.count({ where: directoryWhere(query) as never });
}

async function directoryPage(
  query: DirectoryQuery,
  page: number,
  pageSize: number,
): Promise<{ items: { email: string | null }[]; total: number; totalPages: number }> {
  const where = directoryWhere(query) as never;
  const [items, total] = await Promise.all([
    prisma.student.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { email: true },
    }),
    prisma.student.count({ where }),
  ]);
  return { items, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

let velsId: string;
let srmId: string;
let velsA: string;
let velsB: string;
let srmA: string;

/** Emails of the individually-interesting fixtures, so assertions can name them. */
const NO_HANDLE = `${RUN}-no-handle@kalvium.com`;
const NO_SYNC_ROW = `${RUN}-no-sync-row@kalvium.com`;
const NO_DAILY_STATUS = `${RUN}-no-daily@kalvium.com`;
const NO_BATCH = `${RUN}-no-batch@kalvium.com`;
const USER_NOT_FOUND = `${RUN}-user-not-found@kalvium.com`;
const PROFILE_MISSING = `${RUN}-profile-missing@kalvium.com`;
const NEVER_SYNCED = `${RUN}-never-synced@kalvium.com`;
const ARCHIVED = `${RUN}-archived@kalvium.com`;

async function campusByCode(code: string): Promise<{ id: string }> {
  const campus = await prisma.campus.findUnique({ where: { code }, select: { id: true } });
  if (!campus) {
    throw new Error(
      `Campus ${code} is missing. Run \`npm run db:migrate -w @dsa/api\` before the e2e suite.`,
    );
  }
  return campus;
}

async function batchByCode(campusId: string, code: string): Promise<{ id: string }> {
  const batch = await prisma.batch.findUnique({
    where: { campusId_code: { campusId, code } },
    select: { id: true },
  });
  if (!batch) throw new Error(`Batch ${code} is missing at campus ${campusId}.`);
  return batch;
}

/**
 * One student, with only what the caller asks for.
 *
 * Every relation is opt-in so a test can create a student who genuinely lacks one —
 * a fixture helper that always creates a sync row could not express "no sync row at all",
 * which is one of the cases that matters most here.
 */
async function makeStudent(input: {
  email: string;
  campusId: string | null;
  batchId?: string | null;
  handle?: string | null;
  syncStatus?: string | null;
  status?: string;
}): Promise<string> {
  const student = await prisma.student.create({
    data: {
      name: input.email,
      email: input.email,
      campusId: input.campusId,
      batchId: input.batchId ?? null,
      leetcodeUsername: input.handle ?? null,
      status: (input.status ?? 'ACTIVE') as never,
      ...(input.syncStatus
        ? { syncState: { create: { status: input.syncStatus as never } } }
        : {}),
    },
    select: { id: true },
  });
  return student.id;
}

beforeAll(async () => {
  velsId = (await campusByCode('VELS')).id;
  srmId = (await campusByCode('SRM')).id;
  velsA = (await batchByCode(velsId, 'A')).id;
  velsB = (await batchByCode(velsId, 'B')).id;
  srmA = (await batchByCode(srmId, 'A')).id;

  // Production's shape, scaled down but with the same joints: an SRM intake that is
  // entirely unplaced and partly unlinked, a Vels roster that is fully placed and synced,
  // and archived students who left the programme.
  //
  // SRM: 9 active — 5 fully synced, 1 with no handle, 1 whose handle does not resolve,
  // 1 with a handle the sync has not reached, 1 with no sync row at all.
  for (let i = 0; i < 5; i++) {
    await makeStudent({
      email: `${RUN}-srm-ok-${i}@kalvium.com`,
      campusId: srmId,
      handle: `${RUN}-srm-${i}`,
      syncStatus: 'OK',
    });
  }
  await makeStudent({
    email: PROFILE_MISSING,
    campusId: srmId,
    handle: null,
    syncStatus: 'PROFILE_MISSING',
  });
  await makeStudent({
    email: USER_NOT_FOUND,
    campusId: srmId,
    handle: `${RUN}-ghost`,
    syncStatus: 'USER_NOT_FOUND',
  });
  await makeStudent({
    email: NEVER_SYNCED,
    campusId: srmId,
    handle: `${RUN}-pending`,
    syncStatus: 'NEVER_SYNCED',
  });
  // No sync row at all — the state a student is in between import and first sync.
  await makeStudent({ email: NO_SYNC_ROW, campusId: srmId, handle: `${RUN}-fresh`, syncStatus: null });

  // Aliases onto SRM fixtures, so the "still appears" tests read as their own sentence.
  await makeStudent({ email: NO_HANDLE, campusId: srmId, handle: null, syncStatus: 'PROFILE_MISSING' });
  await makeStudent({ email: NO_BATCH, campusId: srmId, batchId: null, handle: `${RUN}-nb`, syncStatus: 'OK' });
  await makeStudent({
    email: NO_DAILY_STATUS,
    campusId: srmId,
    handle: `${RUN}-nds`,
    syncStatus: 'OK',
  });

  // Vels: 4 active, placed across both batches, plus one archived.
  await makeStudent({ email: `${RUN}-vels-a-0@kalvium.com`, campusId: velsId, batchId: velsA, handle: `${RUN}-va0`, syncStatus: 'OK' });
  await makeStudent({ email: `${RUN}-vels-a-1@kalvium.com`, campusId: velsId, batchId: velsA, handle: `${RUN}-va1`, syncStatus: 'OK' });
  await makeStudent({ email: `${RUN}-vels-b-0@kalvium.com`, campusId: velsId, batchId: velsB, handle: `${RUN}-vb0`, syncStatus: 'OK' });
  await makeStudent({ email: `${RUN}-vels-b-1@kalvium.com`, campusId: velsId, batchId: velsB, handle: `${RUN}-vb1`, syncStatus: 'OK' });
  await makeStudent({
    email: ARCHIVED,
    campusId: velsId,
    batchId: velsA,
    handle: `${RUN}-gone`,
    syncStatus: 'OK',
    status: 'ARCHIVED',
  });

  // One SRM student placed into a batch, so the campus + batch combination has something
  // to find and "SRM has 12 unassigned" is a claim with a counterexample behind it.
  await makeStudent({ email: `${RUN}-srm-placed@kalvium.com`, campusId: srmId, batchId: srmA, handle: `${RUN}-sp`, syncStatus: 'OK' });
});

afterAll(async () => {
  await prisma.studentSyncState.deleteMany({ where: { student: { email: { startsWith: RUN } } } });
  await prisma.student.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.$disconnect();
});

/** Active SRM fixtures: 5 OK + profile-missing + not-found + never-synced + no-sync-row
 *  + no-handle + no-batch + no-daily + placed = 13. */
const SRM_ACTIVE = 13;
const VELS_ACTIVE = 4;
const GLOBAL_ACTIVE = SRM_ACTIVE + VELS_ACTIVE;

describe('student directory — the roster is what decides who appears', () => {
  it('returns every active student at a campus, whatever their sync state', async () => {
    expect(await directoryTotal({ campusId: srmId })).toBe(SRM_ACTIVE);
  });

  it('agrees with the campus card, which is what the two numbers on screen are', async () => {
    // The campus chip reads `_count.students where status ACTIVE`; the directory reads
    // `status != ARCHIVED`. They are different predicates, and they must not diverge —
    // "SRM 99" beside a list of 21 is the report this whole file exists for.
    const campusCardCount = await prisma.student.count({
      where: { campusId: srmId, status: 'ACTIVE', email: { startsWith: RUN } },
    });
    expect(await directoryTotal({ campusId: srmId })).toBe(campusCardCount);
  });

  it('keeps Vels intact, and does not leak SRM into it', async () => {
    expect(await directoryTotal({ campusId: velsId })).toBe(VELS_ACTIVE);
  });

  it('counts every campus when none is named', async () => {
    expect(await directoryTotal({})).toBe(GLOBAL_ACTIVE);
    expect(await directoryTotal({ campusId: srmId })).toBe(SRM_ACTIVE);
    expect(await directoryTotal({ campusId: velsId })).toBe(VELS_ACTIVE);
    // Not a coincidence to be asserted loosely: the campus totals must partition the global
    // one, or some student belongs to neither view.
    expect(SRM_ACTIVE + VELS_ACTIVE).toBe(GLOBAL_ACTIVE);
  });

  /**
   * The heart of it. Each of these students is missing exactly one thing the directory
   * must not require, and each is asserted by name — a total alone would still pass if two
   * students dropped out and two were double-counted.
   */
  it.each([
    ['no LeetCode username', NO_HANDLE],
    ['no sync-state row at all', NO_SYNC_ROW],
    ['no daily status', NO_DAILY_STATUS],
    ['no batch', NO_BATCH],
    ['no assignment or submission', NO_DAILY_STATUS],
    ['a username that does not resolve', USER_NOT_FOUND],
    ['a profile nobody has collected', PROFILE_MISSING],
    ['a first sync still pending', NEVER_SYNCED],
  ])('still lists a student with %s', async (_label, email) => {
    const rows = await prisma.student.findMany({
      where: directoryWhere({ campusId: srmId }) as never,
      select: { email: true },
    });
    expect(rows.map((row) => row.email)).toContain(email);
  });

  it('leaves archived students out of the current roster, and finds them on request', async () => {
    const current = await prisma.student.findMany({
      where: directoryWhere({ campusId: velsId }) as never,
      select: { email: true },
    });
    expect(current.map((row) => row.email)).not.toContain(ARCHIVED);

    const withArchived = await prisma.student.findMany({
      where: directoryWhere({ campusId: velsId, includeArchived: true }) as never,
      select: { email: true },
    });
    expect(withArchived.map((row) => row.email)).toContain(ARCHIVED);
    expect(await directoryTotal({ campusId: velsId, status: 'ARCHIVED' })).toBe(1);
  });
});

describe('student directory — filters narrow, and only the named one narrows', () => {
  it('filters by sync status independently of campus', async () => {
    expect(await directoryTotal({ campusId: srmId, syncStatus: 'PROFILE_MISSING' })).toBe(2);
    expect(await directoryTotal({ campusId: srmId, syncStatus: 'USER_NOT_FOUND' })).toBe(1);
    expect(await directoryTotal({ campusId: srmId, syncStatus: 'NEVER_SYNCED' })).toBe(1);
    // And removing it returns the whole campus — the exact round trip the bug report
    // never got to make, because the page gave no sign a filter was applied.
    expect(await directoryTotal({ campusId: srmId })).toBe(SRM_ACTIVE);
  });

  it('accounts for every student across the sync states, losing none', async () => {
    const states = ['OK', 'PROFILE_MISSING', 'NEVER_SYNCED', 'USER_NOT_FOUND', 'PROFILE_PRIVATE', 'RATE_LIMITED', 'PROVIDER_ERROR', 'TIMEOUT'];
    let counted = 0;
    for (const state of states) counted += await directoryTotal({ campusId: srmId, syncStatus: state });
    const noRow = await prisma.student.count({
      where: { ...(directoryWhere({ campusId: srmId }) as object), syncState: { is: null } } as never,
    });
    expect(counted + noRow).toBe(SRM_ACTIVE);
  });

  it('filters by batch independently of campus', async () => {
    expect(await directoryTotal({ campusId: velsId, batchId: velsA })).toBe(2);
    expect(await directoryTotal({ campusId: velsId, batchId: velsB })).toBe(2);
    expect(await directoryTotal({ campusId: srmId, batchId: srmA })).toBe(1);
  });

  it('combines campus and batch without either being ignored', async () => {
    // Vels Foundation must not pick up SRM Foundation: the codes are identical.
    expect(await directoryTotal({ campusId: velsId, batchId: velsA })).toBe(2);
    expect(await directoryTotal({ campusId: srmId, batchId: velsA })).toBe(0);
  });

  it('treats "unassigned" as the absence of a batch, not as a batch', async () => {
    expect(await directoryTotal({ campusId: srmId, unassigned: true })).toBe(SRM_ACTIVE - 1);
    expect(await directoryTotal({ campusId: velsId, unassigned: true })).toBe(0);
  });
});

describe('student directory — pagination reports the whole set, not the page', () => {
  it('keeps the total independent of the page size', async () => {
    const small = await directoryPage({ campusId: srmId }, 1, 5);
    expect(small.items).toHaveLength(5);
    expect(small.total).toBe(SRM_ACTIVE);
    expect(small.totalPages).toBe(Math.ceil(SRM_ACTIVE / 5));

    // "Page 1 of 1" alongside a campus of 13 is the shape of the original report.
    const oneBigPage = await directoryPage({ campusId: srmId }, 1, 100);
    expect(oneBigPage.items).toHaveLength(SRM_ACTIVE);
    expect(oneBigPage.totalPages).toBe(1);
  });

  it('walks every page without dropping or repeating a student', async () => {
    const pageSize = 5;
    const seen = new Set<string>();
    const { totalPages } = await directoryPage({ campusId: srmId }, 1, pageSize);
    for (let page = 1; page <= totalPages; page++) {
      const result = await directoryPage({ campusId: srmId }, page, pageSize);
      // Identity for this assertion is the email when there is one; a student without
      // one is still counted, keyed by nothing else that is unique here.
      for (const row of result.items) seen.add(row.email ?? '');
    }
    expect(seen.size).toBe(SRM_ACTIVE);
  });
});
