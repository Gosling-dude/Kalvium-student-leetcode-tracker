/**
 * `DashboardService` — the mentor-facing solved / attempted-not-solved / not-attempted
 * split (§ submission-attempt tracking).
 *
 * The property worth protecting: these three numbers are always read straight from each
 * problem's stored `DailyProblemStatus.status` — set by `calculateAssignmentCompletion`
 * from the student's actual submission mirror — and never re-derived from whether an
 * accepted submission exists. `solvedCount + attemptedNotSolvedCount + notAttemptedCount`
 * must equal `assignedCount` for every student, in every bucket, on every day, including
 * a historical one and across batches with different problem counts.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { DashboardService } from './dashboard.service';

/** One `DailyProblemStatus` row as Prisma would return it, joined to its problem title. */
function problemStatus(overrides: {
  problemId: string;
  position: number;
  title: string;
  status: 'ACCEPTED' | 'ATTEMPTED_NOT_ACCEPTED' | 'NOT_ATTEMPTED';
  attempts?: number;
  solvedAt?: Date | null;
}) {
  return {
    id: `dps-${overrides.problemId}`,
    dailyStatusId: 'ds-1',
    problemId: overrides.problemId,
    position: overrides.position,
    status: overrides.status,
    solvedAt: overrides.solvedAt ?? (overrides.status === 'ACCEPTED' ? new Date('2026-08-10T10:00:00Z') : null),
    language: overrides.status === 'ACCEPTED' ? 'python3' : null,
    runtime: null,
    memory: null,
    attempts: overrides.attempts ?? (overrides.status === 'NOT_ATTEMPTED' ? 0 : 1),
    problem: { title: overrides.title },
  };
}

/** One `DailyStatus` row, joined exactly as `statusInclude()`/`loadStatusesWithProblems` shape it. */
function dailyStatus(overrides: {
  studentId: string;
  name: string;
  batchId: string | null;
  batchName?: string | null;
  batchCode?: string | null;
  solvedCount: number;
  assignedCount: number;
  problems: ReturnType<typeof problemStatus>[];
  syncStatus?: string;
  score?: number;
  completedAt?: Date | null;
}) {
  return {
    id: `ds-${overrides.studentId}`,
    studentId: overrides.studentId,
    dayKey: '2026-08-10',
    assignmentId: 'assignment-1',
    batchId: overrides.batchId,
    assignedCount: overrides.assignedCount,
    solvedCount: overrides.solvedCount,
    score: overrides.score ?? 0,
    scoreBreakdown: null,
    completedAt: overrides.completedAt ?? null,
    completionMinute: null,
    firstSolvedAt: null,
    lastSolvedAt: null,
    isPerfect: overrides.solvedCount === overrides.assignedCount && overrides.assignedCount > 0,
    streakAtDay: 0,
    syncStatus: overrides.syncStatus ?? 'OK',
    isOverridden: false,
    overrideNote: null,
    overriddenById: null,
    computedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    student: {
      id: overrides.studentId,
      name: overrides.name,
      email: `${overrides.name.toLowerCase().replace(/\s+/g, '.')}@kalvium.community`,
      squad: null,
      batch: overrides.batchName ? { name: overrides.batchName, code: overrides.batchCode ?? null } : null,
      syncState: { status: overrides.syncStatus ?? 'OK', lastError: null },
      cohort: null,
      maxBeltLevel: null,
      leetcodeUsername: `${overrides.name.toLowerCase().replace(/\s+/g, '')}`,
      currentStreak: 0,
    },
    batch: overrides.batchName ? { name: overrides.batchName, code: overrides.batchCode ?? null } : null,
    problemStatuses: overrides.problems,
  };
}

function assignmentSummary(overrides: {
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  problemCount: number;
  campusId?: string | null;
  id?: string;
}) {
  return {
    id: overrides.id ?? `assignment-${overrides.batchCode ?? 'none'}`,
    dayKey: '2026-08-10',
    campusId: overrides.campusId ?? null,
    batchId: overrides.batchId,
    batchName: overrides.batchName,
    batchCode: overrides.batchCode,
    originalBatchId: overrides.batchId,
    originalBatchName: overrides.batchName,
    originalBatchCode: overrides.batchCode,
    audienceChangedAt: null,
    title: null,
    topic: null,
    notes: null,
    difficulty: null,
    problems: Array.from({ length: overrides.problemCount }, (_, i) => ({
      id: `p${i + 1}`,
      position: i + 1,
      problemId: `p${i + 1}`,
      title: `Problem ${i + 1}`,
      titleSlug: `problem-${i + 1}`,
      url: `https://leetcode.com/problems/problem-${i + 1}/`,
      difficulty: 'MEDIUM',
      questionFrontendId: null,
      acceptanceRate: null,
      topicTags: [],
      companyTags: [],
      isPaidOnly: false,
    })),
    createdAt: new Date().toISOString(),
    createdByName: null,
  };
}

/** Captures the `where` each `dailyStatus.findMany` ran with, for the scoping tests. */
const capturedWheres: Record<string, unknown>[] = [];

/** Captures the `where` each `studentSyncState.groupBy` ran with, for the scoping tests. */
const capturedSyncWheres: Record<string, unknown>[] = [];

function makeService(
  dailyStatusRows: unknown[],
  assignments: unknown[] = [],
  options: { syncStateGroups?: { status: string; _count: { _all: number } }[]; activeStudents?: number } = {},
) {
  const prisma = {
    dailyStatus: {
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        if (where) capturedWheres.push(where);
        return dailyStatusRows;
      },
    },
    student: {
      count: async () => options.activeStudents ?? dailyStatusRows.length,
      // Backs the campus breakdown's unassigned count. These fixtures carry no campus,
      // so there is nothing unassigned to report.
      groupBy: async () => [],
    },
    // Backs the sync-health summary, which is read from the roster rather than from the
    // day's rows — see `getStats`.
    studentSyncState: {
      groupBy: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        if (where) capturedSyncWheres.push(where);
        return options.syncStateGroups ?? [];
      },
    },
    syncJob: { findFirst: async () => null },
    leaderboardEntry: { findMany: async () => [] },
    squadLeaderboardEntry: { findFirst: async () => null },
    batch: { findMany: async () => [] },
    campus: { findMany: async () => [] },
  };
  const cache = { remember: async (_key: string, _ttl: number, fn: () => unknown) => fn() };
  const time = {
    today: () => '2026-08-10',
    localTime: (date: Date | null) => (date ? '14:30' : null),
  };
  const assignmentsService = { findAllByDay: async () => assignments };

  const service = new DashboardService(
    prisma as never,
    cache as never,
    time as never,
    assignmentsService as never,
  );
  return service;
}

describe('DashboardService — solved / attempted-not-solved / not-attempted classification', () => {
  it('SOLVED: an accepted submission counts as solved, not attempted', async () => {
    const row = dailyStatus({
      studentId: 's1',
      name: 'Asha',
      batchId: null,
      solvedCount: 1,
      assignedCount: 1,
      problems: [problemStatus({ problemId: 'p1', position: 1, title: 'Two Sum', status: 'ACCEPTED' })],
    });
    const service = makeService([row]);
    const dashboard = await service.getMentorDashboard('2026-08-10');
    const student = dashboard.buckets.flatMap((b) => b.students)[0]!;
    expect(student.solvedCount).toBe(1);
    expect(student.attemptedNotSolvedCount).toBe(0);
    expect(student.notAttemptedCount).toBe(0);
    expect(student.problems[0]!.status).toBe('ACCEPTED');
  });

  it('ATTEMPTED_NOT_SOLVED: a failed submission only, never inferred as not-attempted', async () => {
    const row = dailyStatus({
      studentId: 's2',
      name: 'Bilal',
      batchId: null,
      solvedCount: 0,
      assignedCount: 1,
      problems: [
        problemStatus({ problemId: 'p1', position: 1, title: 'Two Sum', status: 'ATTEMPTED_NOT_ACCEPTED', attempts: 1 }),
      ],
    });
    const service = makeService([row]);
    const dashboard = await service.getMentorDashboard('2026-08-10');
    const student = dashboard.buckets.flatMap((b) => b.students)[0]!;
    expect(student.solvedCount).toBe(0);
    expect(student.attemptedNotSolvedCount).toBe(1);
    expect(student.notAttemptedCount).toBe(0);
    expect(student.problems[0]!.status).toBe('ATTEMPTED_NOT_ACCEPTED');
  });

  it('ATTEMPTED_NOT_SOLVED: multiple failed submissions for one problem still count as one attempted-not-solved problem', async () => {
    const row = dailyStatus({
      studentId: 's3',
      name: 'Chen',
      batchId: null,
      solvedCount: 0,
      assignedCount: 1,
      problems: [
        problemStatus({ problemId: 'p1', position: 1, title: 'Two Sum', status: 'ATTEMPTED_NOT_ACCEPTED', attempts: 5 }),
      ],
    });
    const service = makeService([row]);
    const dashboard = await service.getMentorDashboard('2026-08-10');
    const student = dashboard.buckets.flatMap((b) => b.students)[0]!;
    expect(student.attemptedNotSolvedCount).toBe(1);
    expect(student.problems[0]!.attempts).toBe(5);
  });

  it('SOLVED: failed submissions followed by an accepted one resolve to solved', async () => {
    const row = dailyStatus({
      studentId: 's4',
      name: 'Dara',
      batchId: null,
      solvedCount: 1,
      assignedCount: 1,
      problems: [problemStatus({ problemId: 'p1', position: 1, title: 'Two Sum', status: 'ACCEPTED', attempts: 3 })],
    });
    const service = makeService([row]);
    const dashboard = await service.getMentorDashboard('2026-08-10');
    const student = dashboard.buckets.flatMap((b) => b.students)[0]!;
    expect(student.solvedCount).toBe(1);
    expect(student.attemptedNotSolvedCount).toBe(0);
  });

  it('NOT_ATTEMPTED: no submission at all is never conflated with a failed attempt', async () => {
    const row = dailyStatus({
      studentId: 's5',
      name: 'Emeka',
      batchId: null,
      solvedCount: 0,
      assignedCount: 1,
      problems: [problemStatus({ problemId: 'p1', position: 1, title: 'Two Sum', status: 'NOT_ATTEMPTED', attempts: 0 })],
    });
    const service = makeService([row]);
    const dashboard = await service.getMentorDashboard('2026-08-10');
    const student = dashboard.buckets.flatMap((b) => b.students)[0]!;
    expect(student.solvedCount).toBe(0);
    expect(student.attemptedNotSolvedCount).toBe(0);
    expect(student.notAttemptedCount).toBe(1);
    expect(student.problems[0]!.status).toBe('NOT_ATTEMPTED');
  });

  it('mixed 4-question assignment: 2 solved, 1 attempted-not-solved, 1 not-attempted always sums to assignedCount', async () => {
    const row = dailyStatus({
      studentId: 's6',
      name: 'Farah',
      batchId: null,
      solvedCount: 2,
      assignedCount: 4,
      problems: [
        problemStatus({ problemId: 'p1', position: 1, title: 'Problem 1', status: 'ACCEPTED' }),
        problemStatus({ problemId: 'p2', position: 2, title: 'Problem 2', status: 'ACCEPTED' }),
        problemStatus({ problemId: 'p3', position: 3, title: 'Problem 3', status: 'ATTEMPTED_NOT_ACCEPTED' }),
        problemStatus({ problemId: 'p4', position: 4, title: 'Problem 4', status: 'NOT_ATTEMPTED', attempts: 0 }),
      ],
    });
    const service = makeService([row]);
    const dashboard = await service.getMentorDashboard('2026-08-10');
    const student = dashboard.buckets.flatMap((b) => b.students)[0]!;
    expect(student.solvedCount).toBe(2);
    expect(student.attemptedNotSolvedCount).toBe(1);
    expect(student.notAttemptedCount).toBe(1);
    expect(student.solvedCount + student.attemptedNotSolvedCount + student.notAttemptedCount).toBe(4);
    expect(student.missingProblems).toEqual(['Problem 3', 'Problem 4']);
  });

  it('works identically for a historical day — the dayKey is just a query parameter, never hardcoded to "today"', async () => {
    const row = dailyStatus({
      studentId: 's7',
      name: 'Gita',
      batchId: null,
      solvedCount: 1,
      assignedCount: 2,
      problems: [
        problemStatus({ problemId: 'p1', position: 1, title: 'Problem 1', status: 'ACCEPTED' }),
        problemStatus({ problemId: 'p2', position: 2, title: 'Problem 2', status: 'ATTEMPTED_NOT_ACCEPTED' }),
      ],
    });
    row.dayKey = '2026-07-15'; // a date well in the past, exercised the same way as "today"
    const service = makeService([row]);
    const dashboard = await service.getMentorDashboard('2026-07-15');
    expect(dashboard.dayKey).toBe('2026-07-15');
    const student = dashboard.buckets.flatMap((b) => b.students)[0]!;
    expect(student.solvedCount).toBe(1);
    expect(student.attemptedNotSolvedCount).toBe(1);
  });
});

describe('DashboardService — Foundation and Intermediate stay independently bucketed', () => {
  it('sizes each batch section against its own assignment, never the other batch\'s count', async () => {
    const foundationStudent = dailyStatus({
      studentId: 'f1',
      name: 'Foundation Student',
      batchId: 'batch-a',
      batchName: 'Foundation Level',
      batchCode: 'A',
      solvedCount: 4,
      assignedCount: 4,
      problems: Array.from({ length: 4 }, (_, i) =>
        problemStatus({ problemId: `fp${i + 1}`, position: i + 1, title: `F${i + 1}`, status: 'ACCEPTED' }),
      ),
    });
    const intermediateStudent = dailyStatus({
      studentId: 'i1',
      name: 'Intermediate Student',
      batchId: 'batch-b',
      batchName: 'Intermediate Level',
      batchCode: 'B',
      solvedCount: 3,
      assignedCount: 5,
      problems: [
        ...Array.from({ length: 3 }, (_, i) =>
          problemStatus({ problemId: `ip${i + 1}`, position: i + 1, title: `I${i + 1}`, status: 'ACCEPTED' }),
        ),
        problemStatus({ problemId: 'ip4', position: 4, title: 'I4', status: 'ATTEMPTED_NOT_ACCEPTED' }),
        problemStatus({ problemId: 'ip5', position: 5, title: 'I5', status: 'NOT_ATTEMPTED', attempts: 0 }),
      ],
    });

    const assignments = [
      assignmentSummary({ batchId: 'batch-a', batchName: 'Foundation Level', batchCode: 'A', problemCount: 4 }),
      assignmentSummary({ batchId: 'batch-b', batchName: 'Intermediate Level', batchCode: 'B', problemCount: 5 }),
    ];

    const service = makeService([foundationStudent, intermediateStudent], assignments);
    const dashboard = await service.getMentorDashboard('2026-08-10');

    expect(dashboard.sections).toHaveLength(2);
    const foundation = dashboard.sections.find((s) => s.batchCode === 'A')!;
    const intermediate = dashboard.sections.find((s) => s.batchCode === 'B')!;

    expect(foundation.assignedCount).toBe(4);
    const completeBucket = foundation.buckets.find((b) => b.solvedCount === 4)!;
    expect(completeBucket.students).toHaveLength(1);
    expect(completeBucket.students[0]!.notAttemptedCount).toBe(0);

    expect(intermediate.assignedCount).toBe(5);
    const intermediateRow = intermediate.buckets.flatMap((b) => b.students).find((s) => s.studentId === 'i1')!;
    expect(intermediateRow.solvedCount).toBe(3);
    expect(intermediateRow.attemptedNotSolvedCount).toBe(1);
    expect(intermediateRow.notAttemptedCount).toBe(1);
  });
});

describe('DashboardService — bucket-level attempted vs not-attempted split', () => {
  it('answers "did these students attempt and fail, or never try" for the zero bucket', async () => {
    const triedButFailed = dailyStatus({
      studentId: 'z1',
      name: 'Tried',
      batchId: null,
      solvedCount: 0,
      assignedCount: 1,
      problems: [problemStatus({ problemId: 'p1', position: 1, title: 'P1', status: 'ATTEMPTED_NOT_ACCEPTED' })],
    });
    const neverTried = dailyStatus({
      studentId: 'z2',
      name: 'Never',
      batchId: null,
      solvedCount: 0,
      assignedCount: 1,
      problems: [problemStatus({ problemId: 'p1', position: 1, title: 'P1', status: 'NOT_ATTEMPTED', attempts: 0 })],
    });

    const service = makeService([triedButFailed, neverTried]);
    const dashboard = await service.getMentorDashboard('2026-08-10');
    const zeroBucket = dashboard.buckets.find((b) => b.solvedCount === 0)!;

    expect(zeroBucket.students).toHaveLength(2);
    expect(zeroBucket.studentsAttemptedCount).toBe(1);
    expect(zeroBucket.studentsNotAttemptedCount).toBe(1);
  });

  it('counts nobody in either bucket once the assignment is fully complete', async () => {
    const complete = dailyStatus({
      studentId: 'c1',
      name: 'Complete',
      batchId: null,
      solvedCount: 1,
      assignedCount: 1,
      problems: [problemStatus({ problemId: 'p1', position: 1, title: 'P1', status: 'ACCEPTED' })],
    });
    const service = makeService([complete]);
    const dashboard = await service.getMentorDashboard('2026-08-10');
    const completeBucket = dashboard.buckets.find((b) => b.solvedCount === 1)!;
    expect(completeBucket.studentsAttemptedCount).toBe(0);
    expect(completeBucket.studentsNotAttemptedCount).toBe(0);
  });
});

describe('DashboardService.getStats — aggregate attempted/not-attempted split', () => {
  let rows: unknown[];

  beforeEach(() => {
    rows = [
      dailyStatus({
        studentId: 'a1',
        name: 'Attempted One',
        batchId: null,
        solvedCount: 0,
        assignedCount: 1,
        problems: [problemStatus({ problemId: 'p1', position: 1, title: 'P1', status: 'ATTEMPTED_NOT_ACCEPTED' })],
      }),
      dailyStatus({
        studentId: 'a2',
        name: 'Not Attempted One',
        batchId: null,
        solvedCount: 0,
        assignedCount: 1,
        problems: [problemStatus({ problemId: 'p1', position: 1, title: 'P1', status: 'NOT_ATTEMPTED', attempts: 0 })],
      }),
      dailyStatus({
        studentId: 'a3',
        name: 'Fully Done',
        batchId: null,
        solvedCount: 1,
        assignedCount: 1,
        problems: [problemStatus({ problemId: 'p1', position: 1, title: 'P1', status: 'ACCEPTED' })],
      }),
    ];
  });

  it('splits "did not complete" students into attempted vs never-attempted, excluding those who finished', async () => {
    const service = makeService(rows);
    const stats = await service.getStats('2026-08-10');
    expect(stats.attemptedNotSolvedStudents).toBe(1);
    expect(stats.notAttemptedStudents).toBe(1);
  });
});


/**
 * The scope filter must reach the database, not just the response shape.
 *
 * This is a regression test for a real bug: `getStats` built its own filter object and
 * dropped `campusId`, so `?campus=VELS` changed the headline count while every breakdown
 * still contained SRM's rows. The filter *looked* applied, which is the worst kind of
 * wrong — a mentor scoped to one campus was reading another campus's students (§12).
 */
describe('DashboardService — the campus filter reaches the query', () => {
  beforeEach(() => {
    capturedWheres.length = 0;
  });

  it('passes campusId through on getStats, not only batchId', async () => {
    const service = makeService([]);
    await service.getStats('2026-08-10', { campusId: 'campus-vels', batchId: 'batch-a' });

    expect(capturedWheres.length).toBeGreaterThan(0);
    for (const where of capturedWheres) {
      expect(where).toMatchObject({ campusId: 'campus-vels', batchId: 'batch-a' });
    }
  });

  it('passes campusId through on the mentor dashboard', async () => {
    const service = makeService([]);
    await service.getMentorDashboard('2026-08-10', { campusId: 'campus-srm' });

    expect(capturedWheres.length).toBeGreaterThan(0);
    for (const where of capturedWheres) {
      expect(where).toMatchObject({ campusId: 'campus-srm' });
    }
  });

  it('omits both keys entirely when nothing is filtered, rather than sending nulls', async () => {
    // `campusId: null` would match only rows whose frozen campus is null — the pre-campus
    // remnants — instead of matching everything.
    const service = makeService([]);
    await service.getStats('2026-08-10', {});

    for (const where of capturedWheres) {
      expect(where).not.toHaveProperty('campusId');
      expect(where).not.toHaveProperty('batchId');
    }
  });
});

/**
 * The dashboard's sync summary.
 *
 * The defect these cover: with 21 students who had no LeetCode handle, the dashboard read
 * "22 students' data could not be read this sync" and wore a permanent "Last sync had
 * errors" badge. 21 of those 22 had never been requested from the provider at all. The
 * summary has to separate a roster gap from a failed read, and it has to account for
 * every active student while doing it — including students the last rollup never saw.
 */
describe('DashboardService.getStats — sync health', () => {
  beforeEach(() => {
    capturedSyncWheres.length = 0;
  });

  it('separates a missing profile from a failed read', async () => {
    const service = makeService([], [], {
      activeStudents: 130,
      syncStateGroups: [
        { status: 'OK', _count: { _all: 108 } },
        { status: 'PROFILE_MISSING', _count: { _all: 21 } },
        { status: 'USER_NOT_FOUND', _count: { _all: 1 } },
      ],
    });

    const stats = await service.getStats('2026-08-10', {});

    expect(stats.syncSummary).toMatchObject({
      activeStudents: 130,
      synced: 108,
      profileMissing: 21,
      awaitingFirstSync: 0,
      // The single number that means "something broke" — 1, not 22.
      failed: 1,
    });
  });

  it('partitions the roster, so no active student is uncounted', async () => {
    const service = makeService([], [], {
      activeStudents: 130,
      syncStateGroups: [
        { status: 'OK', _count: { _all: 108 } },
        { status: 'PROFILE_MISSING', _count: { _all: 21 } },
        { status: 'USER_NOT_FOUND', _count: { _all: 1 } },
      ],
    });

    const { syncSummary: s } = await service.getStats('2026-08-10', {});
    expect(s.synced + s.profileMissing + s.awaitingFirstSync + s.failed).toBe(s.activeStudents);
  });

  it('counts a student with no sync row at all as awaiting their first sync', async () => {
    // The state between import and first sync. Previously invisible to the summary, which
    // is how the newest students — the ones most likely to need attention — went missing.
    const service = makeService([], [], {
      activeStudents: 10,
      syncStateGroups: [{ status: 'OK', _count: { _all: 7 } }],
    });

    const { syncSummary: s } = await service.getStats('2026-08-10', {});
    expect(s.awaitingFirstSync).toBe(3);
    expect(s.synced + s.profileMissing + s.awaitingFirstSync + s.failed).toBe(10);
  });

  it('reads the roster, not the day — a student with no daily status is still counted', async () => {
    // No `dailyStatus` rows at all, yet the summary still describes 130 students. Reading
    // this from the day's rows is what would drop everyone imported since the last rollup.
    const service = makeService([], [], {
      activeStudents: 130,
      syncStateGroups: [{ status: 'OK', _count: { _all: 130 } }],
    });

    const stats = await service.getStats('2026-08-10', {});
    expect(stats.activeStudents).toBe(0);
    expect(stats.syncSummary.activeStudents).toBe(130);
    expect(stats.syncSummary.synced).toBe(130);
  });

  it('scopes the summary to the campus in view', async () => {
    const service = makeService([], [], { activeStudents: 99, syncStateGroups: [] });
    await service.getStats('2026-08-10', { campusId: 'campus-srm' });

    expect(capturedSyncWheres.length).toBeGreaterThan(0);
    for (const where of capturedSyncWheres) {
      expect(where).toMatchObject({ student: { status: 'ACTIVE', campusId: 'campus-srm' } });
    }
  });

  it('reports nothing under byStatus when every student synced cleanly', async () => {
    const service = makeService([], [], {
      activeStudents: 31,
      syncStateGroups: [{ status: 'OK', _count: { _all: 31 } }],
    });

    const { syncSummary } = await service.getStats('2026-08-10', {});
    expect(syncSummary.byStatus).toEqual({});
    expect(syncSummary.failed).toBe(0);
  });
});

/**
 * What the dashboard says about today's problem set when several audiences each have
 * their own.
 *
 * Production ran a day with three assignments — one campus-wide set and two batch sets —
 * and the dashboard's "Today's assignment" card read "No assignment for today. Create
 * today's four problems." Every one of those assignments was in the database. The card
 * was reading `assignment`, which is deliberately null when no single set covers the
 * view; with nothing else to go on, the UI could not tell that apart from a day nobody
 * had set work for, and told an admin to create a duplicate.
 */
describe('DashboardService — how many assignments the day actually has', () => {
  it('reports the count when several audiences each have their own set, so "none" is not implied', async () => {
    const rows = [
      dailyStatus({
        studentId: 's1',
        name: 'Foundation student',
        batchId: 'batch-a',
        batchCode: 'A',
        solvedCount: 0,
        assignedCount: 4,
        problems: [],
      }),
    ];
    const service = makeService(rows, [
      assignmentSummary({ id: 'a-srm', campusId: 'campus-srm', batchId: null, batchName: null, batchCode: null, problemCount: 4 }),
      assignmentSummary({ id: 'a-vels-a', campusId: 'campus-vels', batchId: 'batch-a', batchName: 'Foundation', batchCode: 'A', problemCount: 4 }),
      assignmentSummary({ id: 'a-vels-b', campusId: 'campus-vels', batchId: 'batch-b', batchName: 'Intermediate', batchCode: 'B', problemCount: 4 }),
    ]);

    const stats = await service.getStats('2026-08-10');

    // Still null — no single set speaks for every campus and batch in view.
    expect(stats.assignment).toBeNull();
    // ...but the day plainly has work, and the UI can now say which is true.
    expect(stats.assignmentCount).toBe(3);
  });

  it('reports zero only when the day genuinely has no assignment', async () => {
    const service = makeService([], []);

    const stats = await service.getStats('2026-08-10');

    expect(stats.assignment).toBeNull();
    expect(stats.assignmentCount).toBe(0);
  });

  it('shows a campus its own single set even while another campus also has work that day', async () => {
    const rows = [
      dailyStatus({
        studentId: 's1',
        name: 'SRM student',
        batchId: null,
        solvedCount: 0,
        assignedCount: 4,
        problems: [],
      }),
    ];
    const service = makeService(rows, [
      assignmentSummary({ id: 'a-srm', campusId: 'campus-srm', batchId: null, batchName: null, batchCode: null, problemCount: 4 }),
      assignmentSummary({ id: 'a-vels-a', campusId: 'campus-vels', batchId: 'batch-a', batchName: 'Foundation', batchCode: 'A', problemCount: 4 }),
      assignmentSummary({ id: 'a-vels-b', campusId: 'campus-vels', batchId: 'batch-b', batchName: 'Intermediate', batchCode: 'B', problemCount: 4 }),
    ]);

    // Filtering to SRM: that campus had exactly one set, and another campus's two are
    // no reason to withhold it.
    const stats = await service.getStats('2026-08-10', { campusId: 'campus-srm' });

    expect(stats.assignment?.id).toBe('a-srm');
    expect(stats.assignmentCount).toBe(1);
  });
});
