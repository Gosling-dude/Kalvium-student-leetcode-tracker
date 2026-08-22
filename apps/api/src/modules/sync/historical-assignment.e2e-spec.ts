/**
 * The late-added historical assignment, verified end to end against a real database.
 *
 * The production scenario this exists for:
 *
 *   An assignment dated **2026-08-20** was entered on **2026-08-22**. Foundation students
 *   had already solved the problems on the 18th, 19th and 20th. Running Sync reported
 *   every one of them as having solved nothing.
 *
 * The cause was not the matching rules — those were already right — but the *day
 * selection*: a sync recomputed only `job.dayKey ?? today`, so a day whose assignment
 * appeared afterwards was never re-evaluated. These tests pin both halves: that the
 * completion rules handle a late assignment, and that the pipeline actually reaches the
 * day at all.
 *
 * They also cover the campus/batch audience matrix, because "recompute more days" must
 * not become "credit more students": a Vels Foundation assignment stays Vels Foundation's
 * even when SRM students solved the identical problems on the identical day.
 *
 * Fixtures live under a unique prefix and are removed in `afterAll`, so this is safe to
 * run against a development database.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_LOOKBACK_DAYS,
  assignmentDaysAffectedBy,
  assignmentWindow,
  calculateAssignmentCompletion,
  summarizeProblemStatuses,
  type AssignedProblemRef,
} from '@dsa/shared';

const prisma = new PrismaClient();

const RUN = `e2e-hist-${Date.now()}`;

/**
 * The scenario's dates, shifted into a year the programme will never have data for.
 *
 * The relationship is what the test is about — an assignment dated D, entered on D+2 —
 * and it is preserved exactly, down to the day of the month. The year is not: pinning the
 * suite to the real 2026-08-20 would make it collide with the genuine assignment on that
 * date the moment anyone ran it against a database that has one, which is every database
 * that matters. The exact production dates are asserted in
 * `assignment-completion.spec.ts`, which needs no database and can hard-code them safely.
 */
const DAY = '2099-08-20';
/** The day the assignment row was actually inserted — two days after its own date. */
const ENTERED_ON = '2099-08-22';
const IST = '+05:30';

const ist = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00${IST}`);

interface Audience {
  campusId: string;
  batchId: string;
  assignmentId: string;
  slugs: string[];
}

const audiences: Record<string, Audience> = {};
const studentIds: string[] = [];
const problemIds: string[] = [];
const assignmentIds: string[] = [];

async function makeProblem(slug: string): Promise<{ id: string; titleSlug: string }> {
  const problem = await prisma.problem.create({
    data: {
      titleSlug: slug,
      title: slug.toUpperCase(),
      difficulty: 'MEDIUM',
      url: `https://leetcode.com/problems/${slug}/`,
    },
  });
  problemIds.push(problem.id);
  return problem;
}

async function makeStudent(
  key: string,
  campusId: string,
  batchId: string,
): Promise<string> {
  const student = await prisma.student.create({
    data: {
      name: `${RUN} ${key}`,
      email: `${RUN}-${key}@historical.invalid`,
      campusId,
      batchId,
      status: 'ACTIVE',
      createdAt: ist('2099-06-01', '09:00'),
      campusHistory: {
        create: { toCampusId: campusId, effectiveFromDayKey: '2099-06-01', source: 'MIGRATION' },
      },
      batchHistory: {
        create: { toBatchId: batchId, effectiveFromDayKey: '2099-06-01', source: 'MIGRATION' },
      },
    },
  });
  studentIds.push(student.id);
  return student.id;
}

async function submit(
  studentId: string,
  slug: string,
  day: string,
  hhmm: string,
  status: 'ACCEPTED' | 'ATTEMPTED_NOT_ACCEPTED' = 'ACCEPTED',
  seq = 1,
): Promise<void> {
  const problem = await prisma.problem.findUnique({ where: { titleSlug: slug } });
  await prisma.submission.create({
    data: {
      studentId,
      problemId: problem?.id ?? null,
      providerSubmissionId: `${RUN}-${slug}-${day}-${hhmm}-${seq}`,
      titleSlug: slug,
      title: slug.toUpperCase(),
      status,
      submittedAt: ist(day, hhmm),
      dayKey: day,
      language: 'python3',
    },
  });
}

/** The completion result for one student, computed exactly as the rollup computes it. */
async function evaluate(
  studentId: string,
  audience: Audience,
): Promise<ReturnType<typeof calculateAssignmentCompletion>> {
  const links = await prisma.assignmentProblem.findMany({
    where: { assignmentId: audience.assignmentId },
    include: { problem: true },
    orderBy: { position: 'asc' },
  });

  const assigned: AssignedProblemRef[] = links.map((link) => ({
    problemId: link.problem.id,
    titleSlug: link.problem.titleSlug.toLowerCase(),
    position: link.position,
  }));

  const { startDayKey, endDayKey } = assignmentWindow(DAY, ASSIGNMENT_LOOKBACK_DAYS);
  const submissions = await prisma.submission.findMany({
    where: {
      studentId,
      dayKey: { gte: startDayKey, lte: endDayKey },
      titleSlug: { in: assigned.map((a) => a.titleSlug) },
    },
  });

  return calculateAssignmentCompletion(DAY, assigned, submissions, ASSIGNMENT_LOOKBACK_DAYS);
}

beforeAll(async () => {
  const vels = await prisma.campus.findUniqueOrThrow({ where: { code: 'VELS' } });
  const srm = await prisma.campus.findUniqueOrThrow({ where: { code: 'SRM' } });

  const batchFor = async (campusId: string, code: string): Promise<string> =>
    (
      await prisma.batch.findUniqueOrThrow({
        where: { campusId_code: { campusId, code } },
      })
    ).id;

  const combos: [string, string, string][] = [
    ['velsFoundation', vels.id, await batchFor(vels.id, 'A')],
    ['velsIntermediate', vels.id, await batchFor(vels.id, 'B')],
    ['srmFoundation', srm.id, await batchFor(srm.id, 'A')],
    ['srmIntermediate', srm.id, await batchFor(srm.id, 'B')],
  ];

  // Four audiences, four *distinct* problem sets, all dated 20 Aug and all entered on
  // the 22nd. Distinct sets are what make a cross-audience leak visible rather than
  // merely unlikely.
  for (const [key, campusId, batchId] of combos) {
    const slugs = [`${RUN}-${key}-1`.toLowerCase(), `${RUN}-${key}-2`.toLowerCase()];
    const problems = [];
    for (const slug of slugs) problems.push(await makeProblem(slug));

    const assignment = await prisma.assignment.create({
      data: {
        dayKey: DAY,
        campusId,
        batchId,
        originalCampusId: campusId,
        originalBatchId: batchId,
        title: `${RUN} ${key}`,
        // The whole point: the row is created two days after the date it describes.
        createdAt: ist(ENTERED_ON, '11:00'),
        problems: {
          create: problems.map((p, i) => ({ problemId: p.id, position: i + 1 })),
        },
      },
    });
    assignmentIds.push(assignment.id);
    audiences[key] = { campusId, batchId, assignmentId: assignment.id, slugs };
  }
});

afterAll(async () => {
  await prisma.dailyProblemStatus.deleteMany({
    where: { dailyStatus: { studentId: { in: studentIds } } },
  });
  await prisma.dailyStatus.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentCampusHistory.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentBatchHistory.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.dailyStatus.updateMany({
    where: { assignmentId: { in: assignmentIds } },
    data: { assignmentId: null },
  });
  await prisma.assignmentProblem.deleteMany({ where: { assignmentId: { in: assignmentIds } } });
  await prisma.assignment.deleteMany({ where: { id: { in: assignmentIds } } });
  await prisma.problem.deleteMany({ where: { id: { in: problemIds } } });
  await prisma.$disconnect();
});

describe('the assignment really was entered after its own date', () => {
  it('has a createdAt two days later than the day it describes', async () => {
    // If this ever stops being true the rest of the suite proves nothing.
    const assignment = await prisma.assignment.findUniqueOrThrow({
      where: { id: audiences.velsFoundation!.assignmentId },
    });
    expect(assignment.dayKey).toBe(DAY);
    expect(assignment.createdAt.getTime()).toBeGreaterThan(ist(DAY, '23:59').getTime());
  });
});

describe('E–K: submission timing against a late-added assignment', () => {
  it('F: counts a solve made before the assignment row existed', async () => {
    const audience = audiences.velsFoundation!;
    const student = await makeStudent('f-before-creation', audience.campusId, audience.batchId);
    // Solved on the assignment date itself — two days before anyone entered the row.
    await submit(student, audience.slugs[0]!, DAY, '10:15');

    const result = await evaluate(student, audience);
    expect(result.solvedCount).toBe(1);
    expect(result.problems[0]!.status).toBe('ACCEPTED');
  });

  it('G: counts a solve inside the two-day lookback', async () => {
    const audience = audiences.velsFoundation!;
    const student = await makeStudent('g-lookback', audience.campusId, audience.batchId);
    await submit(student, audience.slugs[0]!, '2099-08-18', '09:00');

    const result = await evaluate(student, audience);
    expect(result.solvedCount).toBe(1);
    expect(result.problems[0]!.solvedOnDayKey).toBe('2099-08-18');
  });

  it('H: does not count a solve outside the lookback', async () => {
    const audience = audiences.velsFoundation!;
    const student = await makeStudent('h-outside', audience.campusId, audience.batchId);
    await submit(student, audience.slugs[0]!, '2099-08-17', '12:00');

    const result = await evaluate(student, audience);
    expect(result.solvedCount).toBe(0);
    expect(result.problems[0]!.status).toBe('NOT_ATTEMPTED');
  });

  it('I: a 23:30 IST solve stays on its own program day', async () => {
    const audience = audiences.velsFoundation!;
    const student = await makeStudent('i-midnight', audience.campusId, audience.batchId);
    await submit(student, audience.slugs[0]!, DAY, '23:30');

    // Stored as 18:00 UTC — same calendar date in UTC, but the assertion that matters is
    // the program-day bucket, which is what every query filters on.
    const row = await prisma.submission.findFirstOrThrow({ where: { studentId: student } });
    expect(row.submittedAt.toISOString()).toBe('2099-08-20T18:00:00.000Z');
    expect(row.dayKey).toBe(DAY);

    expect((await evaluate(student, audience)).solvedCount).toBe(1);
  });

  it('J: wrong answers are attempted, not solved', async () => {
    const audience = audiences.velsFoundation!;
    const student = await makeStudent('j-failed', audience.campusId, audience.batchId);
    await submit(student, audience.slugs[0]!, DAY, '11:00', 'ATTEMPTED_NOT_ACCEPTED', 1);
    await submit(student, audience.slugs[0]!, DAY, '11:30', 'ATTEMPTED_NOT_ACCEPTED', 2);

    const result = await evaluate(student, audience);
    const counts = summarizeProblemStatuses(result.problems);
    expect(counts.solvedCount).toBe(0);
    expect(counts.attemptedNotSolvedCount).toBe(1);
    expect(counts.notAttemptedCount).toBe(1);
  });

  it('K: no submission at all is not-attempted', async () => {
    const audience = audiences.velsFoundation!;
    const student = await makeStudent('k-nothing', audience.campusId, audience.batchId);

    const result = await evaluate(student, audience);
    expect(summarizeProblemStatuses(result.problems)).toEqual({
      solvedCount: 0,
      attemptedNotSolvedCount: 0,
      notAttemptedCount: 2,
    });
  });

  it('L/M: repeated and duplicate accepted submissions count once', async () => {
    const audience = audiences.velsFoundation!;
    const student = await makeStudent('l-duplicates', audience.campusId, audience.batchId);
    await submit(student, audience.slugs[0]!, DAY, '09:00', 'ACCEPTED', 1);
    await submit(student, audience.slugs[0]!, DAY, '09:05', 'ACCEPTED', 2);
    await submit(student, audience.slugs[0]!, DAY, '09:10', 'ACCEPTED', 3);

    const result = await evaluate(student, audience);
    expect(result.solvedCount).toBe(1);
    expect(result.problems[0]!.attempts).toBe(3);
    // The earliest accepted submission is the solve time; a re-solve must not move it.
    expect(result.problems[0]!.solvedAt).toEqual(ist(DAY, '09:00'));
  });

  it('every outcome satisfies solved + attempted + not-attempted = assigned', async () => {
    const audience = audiences.velsFoundation!;
    const student = await makeStudent('sum-invariant', audience.campusId, audience.batchId);
    await submit(student, audience.slugs[0]!, DAY, '09:00');
    await submit(student, audience.slugs[1]!, DAY, '10:00', 'ATTEMPTED_NOT_ACCEPTED');

    const result = await evaluate(student, audience);
    const counts = summarizeProblemStatuses(result.problems);
    expect(
      counts.solvedCount + counts.attemptedNotSolvedCount + counts.notAttemptedCount,
    ).toBe(result.assignedCount);
  });
});

describe('A–D, N, O: the audience matrix on one historical date', () => {
  const keys = ['velsFoundation', 'velsIntermediate', 'srmFoundation', 'srmIntermediate'] as const;

  it('gives each campus + batch its own result from its own problems', async () => {
    for (const key of keys) {
      const audience = audiences[key]!;
      const student = await makeStudent(`matrix-${key}`, audience.campusId, audience.batchId);
      await submit(student, audience.slugs[0]!, DAY, '10:00');
      await submit(student, audience.slugs[1]!, '2099-08-19', '18:00');

      const result = await evaluate(student, audience);
      expect(result.solvedCount).toBe(2);
    }
  });

  it('N/O: solving another audience’s problems credits nothing', async () => {
    // The leak that would matter most, and the one "recompute more days" could have
    // introduced: an SRM Foundation student who solved *Vels* Foundation's problems on
    // the same date must score zero against their own assignment.
    const mine = audiences.srmFoundation!;
    const theirs = audiences.velsFoundation!;

    const student = await makeStudent('n-cross-campus', mine.campusId, mine.batchId);
    await submit(student, theirs.slugs[0]!, DAY, '10:00');
    await submit(student, theirs.slugs[1]!, DAY, '10:30');

    expect((await evaluate(student, mine)).solvedCount).toBe(0);

    // And the same across batches within one campus.
    const intermediate = audiences.velsIntermediate!;
    const other = await makeStudent('o-cross-batch', intermediate.campusId, intermediate.batchId);
    await submit(other, theirs.slugs[0]!, DAY, '10:00');
    expect((await evaluate(other, intermediate)).solvedCount).toBe(0);
  });

  it('four audiences share the date without colliding', async () => {
    const rows = await prisma.assignment.findMany({
      where: { id: { in: assignmentIds } },
      select: { dayKey: true, campusId: true, batchId: true },
    });
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.dayKey))).toEqual(new Set([DAY]));
    expect(new Set(rows.map((r) => `${r.campusId}|${r.batchId}`)).size).toBe(4);
  });
});

describe('the day-selection rule that actually caused the bug', () => {
  it('reports a day whose assignment is newer than its last computation', async () => {
    // `findStaleAssignmentDays` is what makes a sync reach 20 Aug at all. The fixtures
    // above were all entered on the 22nd and never computed, so the day must be flagged.
    const rows = await prisma.$queryRaw<{ dayKey: string }[]>`
      SELECT DISTINCT a."dayKey"
      FROM "assignments" a
      WHERE a."dayKey" >= ${'2099-08-10'}
        AND a."dayKey" <= ${ENTERED_ON}
        AND a."updatedAt" > COALESCE(
          (SELECT MAX(d."computedAt") FROM "daily_statuses" d WHERE d."dayKey" = a."dayKey"),
          '-infinity'::timestamp
        )
    `;
    expect(rows.map((r) => r.dayKey)).toContain(DAY);
  });

  it('reaches the assignment day from a submission made two days earlier', async () => {
    // A student who solved on the 18th is why recomputing only the submission's own day
    // is not enough: the assignment they satisfied is dated the 20th.
    expect(assignmentDaysAffectedBy('2099-08-18')).toContain(DAY);
  });
});
