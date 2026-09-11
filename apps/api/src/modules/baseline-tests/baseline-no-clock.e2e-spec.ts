/**
 * A baseline test has no clock and no register.
 *
 * Two changes the programme asked for, verified against a real database rather than
 * against the pure rule, because both failures were in the *loads* rather than in the
 * arithmetic:
 *
 *  - **No time window.** Grading bounded submissions to `[startedAt, min(expiresAt,
 *    submittedAt, now)]`. A student who started late, finished late, or solved the problem
 *    a week either side of the test scored zero on a problem they had demonstrably solved.
 *    Grading now applies no date filter at all.
 *  - **No "Absent".** `NOT_STARTED` was labelled "Absent" and sat one column from a solved
 *    count that frequently contradicted it — a student could be Absent and 3/4 at once. A
 *    baseline is not a register: participation is reported as what was observed, and never
 *    enters the score.
 *
 * The tests also pin the thing that must *not* change: counting a solve from outside the
 * sitting is not the same as pretending it happened during it. The timestamps are reported
 * as they are, and the risk signals still distinguish the two.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASELINE_ATTEMPT_STATUS_LABELS, displayAttemptStatus } from '@dsa/shared';

import { BaselineTestsService } from './baseline-tests.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

const prisma = new PrismaClient();

const RUN = `e2e-noclock-${Date.now()}`;
const CODE = `NC${Date.now().toString(36).toUpperCase()}`;
const email = (key: string): string => `${RUN}-${key}@no-clock.invalid`;

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const campuses = { resolveScope: async () => ({ campusId: null, batchId: null }) } as never;
const service = new BaselineTestsService(prisma as never, time, campuses, {} as never);

/** A one-hour sitting, long closed — so "before" and "after" are unambiguous. */
const OPENED_AT = new Date('2099-08-01T04:00:00.000Z');
const CLOSED_AT = new Date('2099-08-01T05:00:00.000Z');
const STARTED_AT = new Date('2099-08-01T04:05:00.000Z');
/** Comfortably past any 60-minute window from `STARTED_AT`. */
const LONG_AFTER_START = new Date('2099-08-01T07:30:00.000Z');
const DAYS_AFTER_CLOSE = new Date('2099-08-09T10:00:00.000Z');
const WEEKS_BEFORE = new Date('2099-07-02T10:00:00.000Z');

let campusId: string;
let testId: string;
const problemIds: string[] = [];
const slugs: string[] = [];
const studentIds: Record<string, string> = {};

async function makeStudent(key: string): Promise<string> {
  const student = await prisma.student.create({
    data: {
      name: `${RUN} ${key}`,
      email: email(key),
      leetcodeUsername: `${RUN}-${key}`,
      campusId,
      status: 'ACTIVE',
      createdAt: new Date('2099-07-01T00:00:00.000Z'),
      syncState: {
        create: { status: 'OK', lastSuccessAt: new Date('2099-08-20T00:00:00.000Z') },
      },
    },
  });
  studentIds[key] = student.id;
  return student.id;
}

async function submit(
  key: string,
  slugIndex: number,
  at: Date,
  status: 'ACCEPTED' | 'ATTEMPTED_NOT_ACCEPTED' = 'ACCEPTED',
  seq = 1,
): Promise<void> {
  await prisma.submission.create({
    data: {
      studentId: studentIds[key]!,
      problemId: problemIds[slugIndex]!,
      providerSubmissionId: `${RUN}-${key}-${slugIndex}-${seq}`,
      titleSlug: slugs[slugIndex]!,
      title: slugs[slugIndex]!.toUpperCase(),
      status,
      submittedAt: at,
      dayKey: at.toISOString().slice(0, 10),
    },
  });
}

async function startedAttempt(key: string, submittedAt: Date | null): Promise<void> {
  await prisma.baselineTestAttempt.create({
    data: {
      testId,
      studentId: studentIds[key]!,
      campusId,
      startedAt: STARTED_AT,
      submittedAt,
      status: submittedAt ? 'SUBMITTED' : 'IN_PROGRESS',
      maxScore: 40,
    },
  });
}

beforeAll(async () => {
  const campus = await prisma.campus.create({ data: { name: `${RUN} Campus`, code: CODE } });
  campusId = campus.id;

  for (let i = 0; i < 4; i += 1) {
    const slug = `${RUN}-q${i}`.toLowerCase();
    slugs.push(slug);
    const problem = await prisma.problem.create({
      data: {
        titleSlug: slug,
        title: slug.toUpperCase(),
        difficulty: 'EASY',
        url: `https://leetcode.com/problems/${slug}/`,
      },
    });
    problemIds.push(problem.id);
  }

  const test = await prisma.baselineTest.create({
    data: {
      name: `${RUN} Baseline`,
      dayKey: '2099-08-01',
      campusId,
      // The column still exists and still carries what the test was configured with.
      // Nothing may read it.
      durationMinutes: 60,
      opensAt: OPENED_AT,
      closesAt: CLOSED_AT,
      status: 'CLOSED',
      problems: {
        create: problemIds.map((problemId, i) => ({
          problemId,
          position: i + 1,
          points: 10,
          difficulty: 'EASY' as const,
        })),
      },
    },
  });
  testId = test.id;

  await makeStudent('lateFinisher');
  await makeStudent('afterClose');
  await makeStudent('beforeOpen');
  await makeStudent('neverOpened');
  await makeStudent('inProgress');

  // Started on time, solved three problems hours later — past any 60-minute window.
  await startedAttempt('lateFinisher', null);
  await submit('lateFinisher', 0, LONG_AFTER_START);
  await submit('lateFinisher', 1, LONG_AFTER_START);
  await submit('lateFinisher', 2, LONG_AFTER_START);

  // Sat it, handed in, then solved a fourth problem eight days after the test closed.
  await startedAttempt('afterClose', new Date('2099-08-01T04:50:00.000Z'));
  await submit('afterClose', 0, new Date('2099-08-01T04:20:00.000Z'));
  await submit('afterClose', 3, DAYS_AFTER_CLOSE);

  // Solved two of them a month before the test opened, and sat it.
  await startedAttempt('beforeOpen', new Date('2099-08-01T04:40:00.000Z'));
  await submit('beforeOpen', 0, WEEKS_BEFORE);
  await submit('beforeOpen', 1, WEEKS_BEFORE);

  // Never opened the portal, but has solved two of the problems.
  await submit('neverOpened', 0, WEEKS_BEFORE);
  await submit('neverOpened', 1, DAYS_AFTER_CLOSE);

  // Opened it and never handed in — under the old rule this became EXPIRED.
  await startedAttempt('inProgress', null);

  await service.gradeTest(testId);
});

afterAll(async () => {
  const ids = Object.values(studentIds);
  await prisma.baselineTestProblemResult.deleteMany({
    where: { attempt: { testId } },
  });
  await prisma.baselineTestAttempt.deleteMany({ where: { testId } });
  await prisma.baselineTestProblem.deleteMany({ where: { testId } });
  await prisma.baselineTest.delete({ where: { id: testId } });
  await prisma.submission.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentSyncState.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await prisma.problem.deleteMany({ where: { id: { in: problemIds } } });
  await prisma.campus.delete({ where: { id: campusId } });
  await prisma.$disconnect();
});

async function row(key: string) {
  const board = await service.leaderboard(testId);
  return board.rows.find((entry) => entry.studentId === studentIds[key]!)!;
}

async function attempt(key: string) {
  return prisma.baselineTestAttempt.findUnique({
    where: { testId_studentId: { testId, studentId: studentIds[key]! } },
  });
}

describe('the 60-minute window is gone', () => {
  it('credits a student who solved hours after starting', async () => {
    // Three problems, every one of them accepted long past a 60-minute window. Under the
    // old rule this student scored 0.
    expect((await row('lateFinisher')).solvedCount).toBe(3);
    expect((await attempt('lateFinisher'))?.solvedCount).toBe(3);
  });

  it('credits a solve from after the test closed', async () => {
    expect((await row('afterClose')).solvedCount).toBe(2);
    expect((await attempt('afterClose'))?.solvedCount).toBe(2);
  });

  it('credits a solve from before the test opened', async () => {
    expect((await row('beforeOpen')).solvedCount).toBe(2);
    expect((await attempt('beforeOpen'))?.solvedCount).toBe(2);
  });

  it('writes no expiry on any attempt', async () => {
    const attempts = await prisma.baselineTestAttempt.findMany({ where: { testId } });
    expect(attempts.length).toBeGreaterThan(0);
    // Attempts created by this suite carry none. The column survives for the rows that
    // were written when a clock existed.
    expect(attempts.every((a) => a.expiresAt === null)).toBe(true);
  });

  it('never moves an unfinished attempt to EXPIRED, however long ago it started', async () => {
    // The sitting closed in 2099-08 and has been re-graded since. Under the old rule this
    // attempt would have been marked EXPIRED on the first re-grade.
    expect((await attempt('inProgress'))?.status).toBe('IN_PROGRESS');
  });

  it('is idempotent — re-grading does not change a single count', async () => {
    const before = await prisma.baselineTestAttempt.findMany({
      where: { testId },
      select: { studentId: true, solvedCount: true, score: true, status: true },
      orderBy: { studentId: 'asc' },
    });

    await service.gradeTest(testId);
    await service.gradeTest(testId);

    const after = await prisma.baselineTestAttempt.findMany({
      where: { testId },
      select: { studentId: true, solvedCount: true, score: true, status: true },
      orderBy: { studentId: 'asc' },
    });
    expect(after).toEqual(before);
  });
});

describe('participation is observed, never scored', () => {
  it('gives a student who never opened the test their real solved count', async () => {
    const entry = await row('neverOpened');
    expect(entry.solvedCount).toBe(2);
    expect(entry.attempted).toBe(false);
    expect(entry.status).toBe('NOT_STARTED');
  });

  it('ranks that student above one who opened it and solved less', async () => {
    const neverOpened = await row('neverOpened');
    const inProgress = await row('inProgress');
    expect(inProgress.solvedCount).toBe(0);
    // Performance, not attendance: two solved beats none, whoever pressed Start.
    expect(neverOpened.rank).toBeLessThan(inProgress.rank);
  });

  it('never labels anyone absent', async () => {
    const board = await service.leaderboard(testId);
    const labels = board.rows.map((entry) =>
      BASELINE_ATTEMPT_STATUS_LABELS[displayAttemptStatus(entry.status)],
    );
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some((label) => /absent/i.test(label))).toBe(false);
    expect(labels.some((label) => /expired|time up/i.test(label))).toBe(false);
  });

  it('reports no window-restricted count beside the solved count any more', async () => {
    // The column existed only because grading discarded solutions outside a clock. With
    // the clock gone it reported nothing except whether Start had been pressed.
    const entry = await row('lateFinisher');
    expect(entry).not.toHaveProperty('inWindowSolvedCount');
  });
});

describe('counting a solve is not the same as claiming when it happened', () => {
  it('reports the real acceptance time for a solve from before the test', async () => {
    const detail = await service.studentResult(testId, studentIds.beforeOpen!);
    const solved = detail.problems.filter((p) => p.status === 'ACCEPTED');
    expect(solved).toHaveLength(2);
    expect(solved[0]!.firstAcceptedAt).toBe(WEEKS_BEFORE.toISOString());
  });

  it('does not report a time-to-solve for a solve that predates the sitting', async () => {
    // A negative interval is not a fast solve. Recording one would feed the pace-based
    // risk signals a number that means nothing and flag the best-prepared students.
    const results = await prisma.baselineTestProblemResult.findMany({
      where: { attempt: { testId, studentId: studentIds.beforeOpen! }, status: 'ACCEPTED' },
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.timeToSolveSeconds === null)).toBe(true);
  });

  it('still raises SOLVED_BEFORE_TEST, which is the fact a mentor wanted', async () => {
    const stored = await attempt('beforeOpen');
    expect(stored?.riskFlags).toContain('SOLVED_BEFORE_TEST');
  });
});
