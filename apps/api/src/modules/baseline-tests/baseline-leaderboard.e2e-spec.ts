/**
 * The baseline student-wise leaderboard, against a real database.
 *
 * Two things are being verified that a unit test on the ranking function cannot reach:
 *
 *  1. The board is built from the *eligible roster*, so a student who never opened the
 *     test still has a row. A board assembled from attempt rows silently shrinks the
 *     denominator and makes a test half the cohort skipped look like a test everybody took.
 *
 *  2. Historical immutability. Solving a baseline problem *after* the attempt window has
 *     closed must not raise the recorded score. The baseline says what the student could do
 *     that day; their current ability is a separate number.
 *
 * Fixtures live under a unique prefix and are removed in `afterAll`.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BaselineTestsService } from './baseline-tests.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

const prisma = new PrismaClient();

const RUN = `e2e-baseline-${Date.now()}`;
const email = (name: string): string => `${RUN}-${name}@baseline-board.invalid`;

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const campuses = { resolveScope: async () => ({ campusId: null, batchId: null }) } as never;
const provider = {} as never;
const service = new BaselineTestsService(prisma as never, time, campuses, provider);

/** The attempt window: opened and closed well in the past, so "later" is unambiguous. */
const OPENED_AT = new Date('2026-08-01T04:00:00.000Z');
const CLOSED_AT = new Date('2026-08-01T05:00:00.000Z');
const AFTER_THE_TEST = new Date('2026-08-10T06:00:00.000Z');

let campusId: string;
let testId: string;
const problemIds: string[] = [];
const studentIds: Record<string, string> = {};

async function makeStudent(key: string, name: string): Promise<string> {
  const student = await prisma.student.create({
    data: {
      name,
      email: email(key),
      leetcodeUsername: `${RUN}-${key}`,
      campusId,
      status: 'ACTIVE',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      // Every real student has one — the importer creates it — and it is what tells a
      // genuine zero apart from "we have never read this account".
      syncState: { create: { status: 'OK', lastSuccessAt: new Date('2026-08-26T00:00:00.000Z') } },
    },
  });
  studentIds[key] = student.id;
  return student.id;
}

/** An attempt whose window is closed, graded from whatever is in the submission mirror. */
async function makeAttempt(studentId: string, solvedSlugIndexes: number[]): Promise<void> {
  await prisma.baselineTestAttempt.create({
    data: {
      testId,
      studentId,
      campusId,
      startedAt: OPENED_AT,
      expiresAt: CLOSED_AT,
      maxScore: problemIds.length,
      status: 'SUBMITTED',
      submittedAt: CLOSED_AT,
    },
  });

  for (const index of solvedSlugIndexes) {
    await prisma.submission.create({
      data: {
        studentId,
        problemId: problemIds[index]!,
        providerSubmissionId: `${RUN}-${studentId}-${index}`,
        provider: 'leetcode',
        titleSlug: `${RUN}-problem-${index}`,
        title: `Problem ${index}`,
        status: 'ACCEPTED',
        submittedAt: new Date(OPENED_AT.getTime() + (index + 1) * 60_000),
        dayKey: '2026-08-01',
      },
    });
  }
}

beforeAll(async () => {
  // Its own campus, not a shared one. Eligibility for a baseline is "every ACTIVE student
  // in the test's scope", so running against a seeded campus would pull that campus's real
  // roster onto this board and make every count in this file depend on the seed.
  const campus = await prisma.campus.create({
    data: { name: `${RUN} Campus`, code: RUN.slice(0, 24).toUpperCase(), status: 'ACTIVE' },
  });
  campusId = campus.id;

  for (let i = 0; i < 4; i += 1) {
    const problem = await prisma.problem.create({
      data: {
        titleSlug: `${RUN}-problem-${i}`,
        title: `Problem ${i}`,
        difficulty: 'EASY',
        url: `https://leetcode.com/problems/${RUN}-problem-${i}/`,
      },
    });
    problemIds.push(problem.id);
  }

  const test = await prisma.baselineTest.create({
    data: {
      name: `${RUN} Baseline`,
      dayKey: '2026-08-01',
      campusId,
      status: 'CLOSED',
      durationMinutes: 60,
      opensAt: OPENED_AT,
      closesAt: CLOSED_AT,
      problems: {
        create: problemIds.map((problemId, index) => ({
          problemId,
          position: index + 1,
          points: 1,
          difficulty: 'EASY',
        })),
      },
    },
  });
  testId = test.id;

  // 3 of 4, 2 of 4, 0 of 4 having tried, and one student who never opened it.
  await makeAttempt(await makeStudent('rahul', 'Rahul Sharma'), [0, 1, 2]);
  await makeAttempt(await makeStudent('aman', 'Aman Verma'), [0, 1]);
  await makeAttempt(await makeStudent('ravi', 'Ravi Kumar'), []);
  await makeStudent('absent', 'Absent Student');

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
  await prisma.campus.deleteMany({ where: { id: campusId } });
  await prisma.$disconnect();
});

describe('baseline leaderboard', () => {
  it('ranks students by problems solved, best first', async () => {
    const board = await service.leaderboard(testId);
    expect(board.rows.slice(0, 2).map((row) => row.studentName)).toEqual([
      'Rahul Sharma',
      'Aman Verma',
    ]);
    expect(board.rows.slice(0, 2).map((row) => row.rank)).toEqual([1, 2]);
    // Ravi and the absent student both solved nothing, so they share third.
    expect(board.rows.slice(2).every((row) => row.solvedCount === 0)).toBe(true);
  });

  it('reports solved, not-solved and percent against the real question count', async () => {
    const board = await service.leaderboard(testId);
    const rahul = board.rows.find((row) => row.studentName === 'Rahul Sharma')!;

    expect(rahul.totalQuestions).toBe(4);
    expect(rahul.solvedCount).toBe(3);
    expect(rahul.notSolvedCount).toBe(1);
    expect(rahul.percent).toBe(75);
  });

  it('lists a student who never opened the test', async () => {
    const board = await service.leaderboard(testId);
    const absent = board.rows.find((row) => row.studentName === 'Absent Student');

    expect(absent).toBeDefined();
    expect(absent!.attempted).toBe(false);
    expect(absent!.status).toBe('NOT_STARTED');
    expect(absent!.solvedCount).toBe(0);
  });

  it('ties the absent student with one who sat it and solved nothing', async () => {
    // Both genuinely solved none of these problems, and both were measured — so they tie
    // on performance. Attendance is reported in its own column and does not reorder them:
    // the board ranks what students can do.
    const board = await service.leaderboard(testId);
    const ravi = board.rows.find((row) => row.studentName === 'Ravi Kumar')!;
    const absent = board.rows.find((row) => row.studentName === 'Absent Student')!;

    expect(ravi.solvedCount).toBe(0);
    expect(absent.solvedCount).toBe(0);
    expect(ravi.rank).toBe(absent.rank);
    // The distinction survives, in the column that carries it.
    expect(ravi.status).toBe('SUBMITTED');
    expect(absent.status).toBe('NOT_STARTED');
  });

  it('counts the whole eligible cohort, not just the attempts', async () => {
    const board = await service.leaderboard(testId);
    expect(board.attemptedStudents).toBe(3);
    expect(board.notStartedStudents).toBe(1);
    expect(board.totalStudents).toBe(board.attemptedStudents + board.notStartedStudents);
  });

  it('reports Score % as questions solved, so the row agrees with its own columns', async () => {
    // The problems on this test carry equal points, so this assertion would pass either
    // way here — it is pinned because with difficulty-weighted points (EASY 10, MEDIUM 20,
    // which is the default) the weighted figure said 67% on a row whose columns read
    // "4 total, 3 solved, 1 not solved". A reader computes 75% and the row disagreed.
    const board = await service.leaderboard(testId);
    for (const row of board.rows) {
      const expected = Math.round((row.solvedCount / row.totalQuestions) * 100);
      expect(row.percent).toBe(expected);
      expect(row.solvedCount + row.notSolvedCount).toBe(row.totalQuestions);
    }
  });

  it('gives the detail view the same score as the board it was opened from', async () => {
    const board = await service.leaderboard(testId);
    const row = board.rows.find((candidate) => candidate.studentName === 'Rahul Sharma')!;
    const detail = await service.studentResult(testId, row.studentId);

    expect(detail.percent).toBe(row.percent);
    expect(detail.solvedCount).toBe(row.solvedCount);
  });

  it('averages over every student we hold data for, sat or not', async () => {
    // 75 + 50 + 0 + 0 over four measured students. The absent student *is* in this average
    // now, because we measured them: they solved none of these problems. What would be
    // excluded is a student we have never successfully read — an absence of measurement
    // rather than a measurement of zero.
    const board = await service.leaderboard(testId);
    expect(board.averagePercent).toBe(31);
    expect(board.highestPercent).toBe(75);
    expect(board.lowestPercent).toBe(0);
    expect(board.performanceUnknownStudents).toBe(0);
  });

  it('keeps cohort rank when filtered to one student', async () => {
    // Rank means "how many students did better". Filtering must not renumber it to 1.
    const board = await service.leaderboard(testId, { search: 'Aman' });
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]!.rank).toBe(2);
  });

  it('reports cohort-wide statistics regardless of the filter', async () => {
    const board = await service.leaderboard(testId, { search: 'Aman' });
    expect(board.totalStudents).toBe(4);
    expect(board.averagePercent).toBe(31);
  });

  it('sorts by name without changing anyone’s rank', async () => {
    const board = await service.leaderboard(testId, { sort: 'name', direction: 'asc' });
    expect(board.rows.map((row) => row.studentName)).toEqual([
      'Absent Student',
      'Aman Verma',
      'Rahul Sharma',
      'Ravi Kumar',
    ]);
    expect(board.rows.find((row) => row.studentName === 'Rahul Sharma')!.rank).toBe(1);
  });

  it('filters to students who never started', async () => {
    const board = await service.leaderboard(testId, { status: 'NOT_STARTED' });
    expect(board.rows.map((row) => row.studentName)).toEqual(['Absent Student']);
  });

  it('reports the same average on the report and the leaderboard', async () => {
    // One test, one screen, one number. The report's headline average sits beside
    // performance-based counts, so computing it from attempts put two different averages
    // for the same cohort in front of the same reader.
    const [board, report] = await Promise.all([
      service.leaderboard(testId),
      service.report(testId),
    ]);

    expect(report.averagePercent).toBe(board.averagePercent);
  });

  it('separates participation counts from performance counts on the report', async () => {
    const report = await service.report(testId);

    // Participation: three sat it, one did not.
    expect(report.started).toBe(3);
    expect(report.notStarted).toBe(1);
    // Performance: counted across everyone eligible, including the absent student.
    expect(report.solvedAll + report.attemptedNotSolved + report.notAttempted).toBeLessThanOrEqual(
      report.totalEligible,
    );
  });

  it('gives the per-question breakdown for one student', async () => {
    const result = await service.studentResult(testId, studentIds.rahul!);

    expect(result.rank).toBe(1);
    expect(result.solvedCount).toBe(3);
    expect(result.problems).toHaveLength(4);
    expect(result.problems.filter((p) => p.status === 'ACCEPTED')).toHaveLength(3);
    expect(result.problems.filter((p) => p.status !== 'ACCEPTED')).toHaveLength(1);
  });

  it('lists every question for a student who never started, rather than none', async () => {
    const result = await service.studentResult(testId, studentIds.absent!);

    expect(result.attempted).toBe(false);
    expect(result.problems).toHaveLength(4);
    expect(result.problems.every((p) => p.status === 'NOT_ATTEMPTED')).toBe(true);
  });
});

describe('baseline historical immutability vs current ability', () => {
  it('raises current performance but never the recorded test result', async () => {
    // The two requirements that look contradictory until they are separated:
    //
    //   "If a student has solved a baseline question at ANY TIME, recognise it."
    //   "Solving Q3 later must NOT change the recorded baseline from 3/4 to 4/4."
    //
    // Both hold, because they are about different numbers. `inWindowSolvedCount` is what
    // the test measured on the day and is frozen; `solvedCount` is what the student can do
    // now. Reporting only one of them is what forces a choice between the two rules.
    const before = await service.leaderboard(testId);
    const rahulBefore = before.rows.find((row) => row.studentName === 'Rahul Sharma')!;
    expect(rahulBefore.solvedCount).toBe(3);
    expect(rahulBefore.inWindowSolvedCount).toBe(3);

    // The fourth problem, solved nine days after the test closed.
    await prisma.submission.create({
      data: {
        studentId: studentIds.rahul!,
        problemId: problemIds[3]!,
        providerSubmissionId: `${RUN}-late-solve`,
        provider: 'leetcode',
        titleSlug: `${RUN}-problem-3`,
        title: 'Problem 3',
        status: 'ACCEPTED',
        submittedAt: AFTER_THE_TEST,
        dayKey: '2026-08-10',
      },
    });

    // A re-grade is the operation that would rewrite history if the window were not frozen.
    await service.gradeTest(testId);

    const after = await service.leaderboard(testId);
    const rahulAfter = after.rows.find((row) => row.studentName === 'Rahul Sharma')!;

    // Current ability now reflects the late solve — this is the reported bug being fixed.
    expect(rahulAfter.solvedCount).toBe(4);
    expect(rahulAfter.percent).toBe(100);

    // The test's own record does not move. It says what happened on the day.
    expect(rahulAfter.inWindowSolvedCount).toBe(3);
  });

  it('keeps the stored attempt untouched by the later solve', async () => {
    // Immutability at the storage layer, not just in the projection: the row that records
    // what the student did during the test still says three.
    const attempt = await prisma.baselineTestAttempt.findUnique({
      where: { testId_studentId: { testId, studentId: studentIds.rahul! } },
    });

    expect(attempt?.solvedCount).toBe(3);
  });

  it('shows the improvement between the two, per problem', async () => {
    const detail = await service.studentResult(testId, studentIds.rahul!);

    // Four ✓ on current ability...
    expect(detail.problems.filter((p) => p.status === 'ACCEPTED')).toHaveLength(4);
    // ...while the recorded sitting stays at three.
    expect(detail.inWindowSolvedCount).toBe(3);
    // And the late one carries the evidence of when it was actually solved.
    const late = detail.problems[3]!;
    expect(late.firstAcceptedAt).toBe(AFTER_THE_TEST.toISOString());
  });
});
