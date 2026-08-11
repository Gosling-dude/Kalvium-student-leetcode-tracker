/**
 * The historical-integrity guarantee, verified against a real database.
 *
 * The scenario from the spec (§26):
 *
 *   Student A is in Foundation on 10 Aug and moves to Intermediate on 15 Aug.
 *
 *   Verify: the 10 Aug assignment is Foundation's, the 10 Aug result is unchanged, the
 *   15 Aug assignment is Intermediate's, the student's *current* batch is Intermediate,
 *   and a report about 10 Aug still says Foundation.
 *
 * This is an integration test rather than a unit test on purpose. What is being verified
 * is a property of stored data — that recomputing a closed day does not re-stamp it —
 * and a mocked Prisma would only prove the mock behaves as written.
 *
 * Fixtures live under a unique prefix and are removed in `afterAll`, so this is safe to
 * run against a development database.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBatchOnDay, selectAssignmentForBatch } from '@dsa/shared';

const prisma = new PrismaClient();

/** Unique per run, so a crashed run never collides with the next one. */
const RUN = `e2e-${Date.now()}`;
const email = (name: string): string => `${RUN}-${name}@batch-history.invalid`;

const AUG_10 = '2026-08-10';
const AUG_15 = '2026-08-15';

let foundationId: string;
let intermediateId: string;
let studentId: string;
let aug10AssignmentId: string;
let aug15AssignmentId: string;
const problemIds: string[] = [];
/** Every assignment this suite creates, torn down in `afterAll` even if a test throws. */
const createdAssignmentIds: string[] = [];

beforeAll(async () => {
  const foundation = await prisma.batch.findUnique({ where: { code: 'A' } });
  const intermediate = await prisma.batch.findUnique({ where: { code: 'B' } });

  if (!foundation || !intermediate) {
    throw new Error(
      'Batches A and B are missing. Run `npm run db:migrate -w @dsa/api` before the e2e suite.',
    );
  }

  foundationId = foundation.id;
  intermediateId = intermediate.id;

  // Two distinct problems, so "was this student measured against the right set" is
  // answerable by looking at which problem ids their day references.
  for (const slug of [`${RUN}-foundation-problem`, `${RUN}-intermediate-problem`]) {
    const problem = await prisma.problem.create({
      data: {
        titleSlug: slug,
        title: slug,
        difficulty: 'EASY',
        url: `https://leetcode.com/problems/${slug}/`,
      },
    });
    problemIds.push(problem.id);
  }

  const student = await prisma.student.create({
    data: {
      name: `${RUN} Mover`,
      email: email('mover'),
      leetcodeUsername: `${RUN}-mover`,
      batchId: foundationId,
      cohort: 1,
      maxBeltLevel: 4,
      // Placed in Foundation from the start.
      batchHistory: {
        create: {
          toBatchId: foundationId,
          effectiveFromDayKey: '2026-08-01',
          source: 'ROSTER_SYNC',
          reason: 'Initial placement',
        },
      },
    },
  });
  studentId = student.id;

  // Different problem sets for the two batches on their respective days.
  const aug10 = await prisma.assignment.create({
    data: {
      dayKey: AUG_10,
      batchId: foundationId,
      title: 'Foundation 10 Aug',
      problems: { create: [{ problemId: problemIds[0]!, position: 1 }] },
    },
  });
  aug10AssignmentId = aug10.id;
  createdAssignmentIds.push(aug10.id);

  const aug15 = await prisma.assignment.create({
    data: {
      dayKey: AUG_15,
      batchId: intermediateId,
      title: 'Intermediate 15 Aug',
      problems: { create: [{ problemId: problemIds[1]!, position: 1 }] },
    },
  });
  aug15AssignmentId = aug15.id;
  createdAssignmentIds.push(aug15.id);

  // The 10 Aug result, recorded while the student was in Foundation.
  await prisma.dailyStatus.create({
    data: {
      studentId,
      dayKey: AUG_10,
      assignmentId: aug10AssignmentId,
      batchId: foundationId,
      assignedCount: 1,
      solvedCount: 1,
      score: 100,
      isPerfect: true,
      streakAtDay: 1,
      syncStatus: 'OK',
    },
  });
});

afterAll(async () => {
  // Ordered so foreign keys are satisfied without relying on cascade behaviour.
  await prisma.dailyStatus.deleteMany({ where: { studentId } });
  await prisma.studentBatchHistory.deleteMany({ where: { studentId } });
  await prisma.student.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.assignmentProblem.deleteMany({
    where: { assignmentId: { in: createdAssignmentIds } },
  });
  await prisma.assignment.deleteMany({ where: { id: { in: createdAssignmentIds } } });
  await prisma.problem.deleteMany({ where: { id: { in: problemIds } } });
  await prisma.$disconnect();
});

describe('a student moved between batches mid-programme', () => {
  it('starts in Foundation with the 10 Aug result recorded there', async () => {
    const status = await prisma.dailyStatus.findUnique({
      where: { studentId_dayKey: { studentId, dayKey: AUG_10 } },
    });

    expect(status?.batchId).toBe(foundationId);
    expect(status?.solvedCount).toBe(1);
    expect(status?.assignmentId).toBe(aug10AssignmentId);
  });

  it('records the move without touching the closed day', async () => {
    await prisma.$transaction([
      prisma.student.update({ where: { id: studentId }, data: { batchId: intermediateId } }),
      prisma.studentBatchHistory.create({
        data: {
          studentId,
          fromBatchId: foundationId,
          toBatchId: intermediateId,
          effectiveFromDayKey: AUG_15,
          source: 'MANUAL',
          reason: 'Ready for harder problems',
        },
      }),
    ]);

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    expect(student?.batchId).toBe(intermediateId);

    // The whole point: the 10 Aug row is untouched by a change made on the 15th.
    const status = await prisma.dailyStatus.findUnique({
      where: { studentId_dayKey: { studentId, dayKey: AUG_10 } },
    });
    expect(status?.batchId).toBe(foundationId);
    expect(status?.solvedCount).toBe(1);
  });

  it('resolves the historical batch per day, not from the current batch', async () => {
    const placements = await prisma.studentBatchHistory.findMany({
      where: { studentId },
      select: { toBatchId: true, effectiveFromDayKey: true, changedAt: true },
    });

    expect(resolveBatchOnDay(placements, AUG_10)).toBe(foundationId);
    expect(resolveBatchOnDay(placements, '2026-08-11')).toBe(foundationId);
    expect(resolveBatchOnDay(placements, AUG_15)).toBe(intermediateId);
    expect(resolveBatchOnDay(placements, '2026-08-20')).toBe(intermediateId);
  });

  it('evaluates each day against the batch the student was in that day', async () => {
    const placements = await prisma.studentBatchHistory.findMany({
      where: { studentId },
      select: { toBatchId: true, effectiveFromDayKey: true, changedAt: true },
    });

    for (const [dayKey, expectedAssignmentId] of [
      [AUG_10, aug10AssignmentId],
      [AUG_15, aug15AssignmentId],
    ] as const) {
      const candidates = await prisma.assignment.findMany({ where: { dayKey } });
      const batchOnDay = resolveBatchOnDay(placements, dayKey);
      const selected = selectAssignmentForBatch(candidates, batchOnDay);

      expect(selected?.id).toBe(expectedAssignmentId);
    }
  });

  it('still reports 10 Aug under Foundation when filtering by batch', async () => {
    // Exactly the query the batch-filtered daily report runs.
    const foundationRows = await prisma.dailyStatus.findMany({
      where: { dayKey: AUG_10, batchId: foundationId, studentId },
    });
    const intermediateRows = await prisma.dailyStatus.findMany({
      where: { dayKey: AUG_10, batchId: intermediateId, studentId },
    });

    expect(foundationRows).toHaveLength(1);
    expect(intermediateRows).toHaveLength(0);
  });
});

describe('per-batch assignment constraints', () => {
  it('allows two batches different problem sets on the same date', async () => {
    const second = await prisma.assignment.create({
      data: {
        dayKey: AUG_10,
        batchId: intermediateId,
        title: 'Intermediate 10 Aug',
        problems: { create: [{ problemId: problemIds[1]!, position: 1 }] },
      },
    });
    // Registered immediately, so a later assertion failure still leaves a clean database.
    createdAssignmentIds.push(second.id);

    // Scoped to the two batches under test: the database may legitimately also hold a
    // pre-batch (batch-less) assignment for this date, which is not what this asserts.
    const sameDay = await prisma.assignment.findMany({
      where: { dayKey: AUG_10, batchId: { in: [foundationId, intermediateId] } },
    });
    expect(sameDay).toHaveLength(2);
    expect(new Set(sameDay.map((a) => a.batchId))).toEqual(
      new Set([foundationId, intermediateId]),
    );

  });

  it('refuses a second assignment for the same batch and date', async () => {
    await expect(
      prisma.assignment.create({ data: { dayKey: AUG_10, batchId: foundationId } }),
    ).rejects.toThrow();
  });
});

describe('archived students', () => {
  it('keeps every historical record while leaving the current roster', async () => {
    const archived = await prisma.student.create({
      data: {
        name: `${RUN} Leaver`,
        email: email('leaver'),
        leetcodeUsername: `${RUN}-leaver`,
        batchId: foundationId,
      },
    });

    await prisma.dailyStatus.create({
      data: {
        studentId: archived.id,
        dayKey: AUG_10,
        batchId: foundationId,
        assignedCount: 1,
        solvedCount: 1,
        syncStatus: 'OK',
      },
    });

    await prisma.student.update({
      where: { id: archived.id },
      data: {
        status: 'ARCHIVED',
        archivedAt: new Date(),
        archivedReason: 'Not in the current roster',
      },
    });

    // Gone from the current roster…
    const current = await prisma.student.findMany({
      where: { status: 'ACTIVE', id: archived.id },
    });
    expect(current).toHaveLength(0);

    // …but every historical row is still there, and still readable.
    const history = await prisma.dailyStatus.findMany({ where: { studentId: archived.id } });
    expect(history).toHaveLength(1);
    expect(history[0]?.solvedCount).toBe(1);

    const stillExists = await prisma.student.findUnique({ where: { id: archived.id } });
    expect(stillExists?.archivedReason).toBe('Not in the current roster');

    await prisma.dailyStatus.deleteMany({ where: { studentId: archived.id } });
    await prisma.student.delete({ where: { id: archived.id } });
  });
});

describe('email is the canonical student identity', () => {
  it('refuses a second student with the same email', async () => {
    const first = await prisma.student.create({
      data: { name: `${RUN} First`, email: email('dupe'), batchId: foundationId },
    });

    // The roster matches on email, so two rows sharing one would split a student's
    // history across both and make "which is the real one" unanswerable.
    await expect(
      prisma.student.create({
        data: { name: `${RUN} Second`, email: email('dupe'), batchId: intermediateId },
      }),
    ).rejects.toThrow();

    await prisma.student.delete({ where: { id: first.id } });
  });

  it('allows many students with no LeetCode handle yet', async () => {
    // Roster membership and a linked LeetCode account are separate facts: NULLs are
    // distinct in the unique index, so an unlinked student is not a duplicate.
    const created = await Promise.all(
      ['nolink-a', 'nolink-b'].map((name) =>
        prisma.student.create({
          data: {
            name: `${RUN} ${name}`,
            email: email(name),
            leetcodeUsername: null,
            batchId: foundationId,
          },
        }),
      ),
    );

    expect(created).toHaveLength(2);
    expect(created.every((student) => student.leetcodeUsername === null)).toBe(true);

    await prisma.student.deleteMany({ where: { id: { in: created.map((s) => s.id) } } });
  });
});
