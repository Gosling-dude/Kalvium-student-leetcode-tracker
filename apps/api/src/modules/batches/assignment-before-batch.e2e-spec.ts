/**
 * The assignment published *before* the cohort was split into batches.
 *
 * The production incident, reproduced end to end against a real database:
 *
 *   Alliance published two batch-scoped assignments for **31 Aug** — one for Foundation,
 *   one for Intermediate. Its 46 students had no batch at all at that point. The next
 *   morning an admin divided them into the two batches. Every Mentor View figure for
 *   31 Aug then read zero: `assignedCount = 0`, no assignment linked, and the two batches
 *   merged into a single meaningless section.
 *
 * Nothing was wrong with the matching rules, the submissions or the assignments. The
 * placement rows were dated `effectiveFromDayKey = today`, so 31 Aug still resolved to
 * "no batch" for all 46 — and `selectAssignmentForScope` cannot pair a batch-targeted
 * assignment with a student who has no batch, by design. The cohort was scored against
 * nothing on a day they had genuinely been assigned work.
 *
 * The fix is in `BatchesService.defaultPlacementDay`: a student's *first* placement is
 * back-dated to enrolment, because classifying someone for the first time states what has
 * been true since they joined rather than changing anything today. A genuine move keeps
 * its "effective today" semantics, which is what stops an already-scored day being re-filed
 * under a batch the student was not in at the time (§7).
 *
 * What each test pins:
 *
 *  - the scenario itself, through the real `moveStudent` and `RollupService`;
 *  - that a *later* move does not drag closed days with it;
 *  - that submissions predating the split still count, and none are lost;
 *  - that the split does not leak one campus's assignment onto another's students.
 *
 * Fixtures live under a unique prefix and are removed in `afterAll`.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RollupService } from '../scoring/rollup.service';
import { ScoringConfigService } from '../scoring/scoring-config.service';
import { StudentMetricsService } from '../scoring/student-metrics.service';
import { BatchesService } from './batches.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { CampusesService } from '../campuses/campuses.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

const prisma = new PrismaClient();

const RUN = `e2e-abb-${Date.now()}`;
const CODE = `AB${Date.now().toString(36).toUpperCase()}`;
const IST = '+05:30';

/**
 * The incident's shape, in a year the programme will never hold data for: the assignment
 * day, and the day the split was performed — the day *after*.
 */
const DAY = '2099-08-31';
const SPLIT_DAY = '2099-09-01';
/** Enrolment, several days before the assignment — the day a first placement back-dates to. */
const ENROLLED = '2099-08-26';

const ist = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00${IST}`);

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const noCache = {
  get: async () => null,
  set: async () => undefined,
  del: async () => undefined,
  delByPrefix: async () => undefined,
} as never;

const scoringConfig = new ScoringConfigService(prisma as never);
const batches = new BatchesService(prisma as never, time, noCache);
const metrics = new StudentMetricsService(prisma as never, time, scoringConfig, batches);
const campuses = new CampusesService(
  prisma as never,
  time,
  noCache,
  new MentorScopeService(prisma as never),
);
const rollup = new RollupService(
  prisma as never,
  noCache,
  time,
  scoringConfig,
  metrics,
  batches,
  campuses,
);

let campusId: string;
let otherCampusId: string;
let foundationId: string;
let intermediateId: string;
let otherFoundationId: string;
let foundationAssignmentId: string;
let intermediateAssignmentId: string;

/** Foundation's four problems, and Intermediate's four. Deliberately disjoint. */
const FOUNDATION_SLUGS = ['abb-good-pairs', 'abb-running-sum', 'abb-altitude', 'abb-pivot'];
const INTERMEDIATE_SLUGS = ['abb-3sum-closest', 'abb-4sum', 'abb-palindrome-ii', 'abb-square-sum'];

const problemIds: string[] = [];
const studentIds: string[] = [];

/** Unclassified at creation: no batch, and no batch history — exactly the incident's state. */
async function unclassifiedStudent(key: string): Promise<string> {
  const row = await prisma.student.create({
    data: {
      name: `${RUN} ${key}`,
      email: `${RUN}-${key}@abb.invalid`,
      leetcodeUsername: `${RUN}-${key}`,
      campusId,
      batchId: null,
      status: 'ACTIVE',
      createdAt: ist(ENROLLED, '18:27'),
      campusHistory: {
        create: { toCampusId: campusId, effectiveFromDayKey: ENROLLED, source: 'MIGRATION' },
      },
    },
  });
  studentIds.push(row.id);
  return row.id;
}

async function submit(studentId: string, slug: string, day: string, hhmm: string): Promise<void> {
  const problem = await prisma.problem.findUniqueOrThrow({ where: { titleSlug: slug } });
  await prisma.submission.create({
    data: {
      studentId,
      problemId: problem.id,
      providerSubmissionId: `${RUN}-${studentId}-${slug}-${day}-${hhmm}`,
      titleSlug: slug,
      title: slug,
      status: 'ACCEPTED',
      submittedAt: ist(day, hhmm),
      dayKey: day,
      language: 'python3',
    },
  });
}

async function statusFor(studentId: string, dayKey: string) {
  return prisma.dailyStatus.findUnique({
    where: { studentId_dayKey: { studentId, dayKey } },
  });
}

beforeAll(async () => {
  const campus = await prisma.campus.create({
    data: { code: CODE, name: `${RUN} Campus`, status: 'ACTIVE' },
  });
  campusId = campus.id;

  const other = await prisma.campus.create({
    data: { code: `${CODE}X`, name: `${RUN} Other Campus`, status: 'ACTIVE' },
  });
  otherCampusId = other.id;

  const mkBatch = async (cid: string, code: string, name: string): Promise<string> =>
    (await prisma.batch.create({ data: { campusId: cid, code, name, status: 'ACTIVE' } })).id;

  foundationId = await mkBatch(campusId, 'A', 'Foundation Level');
  intermediateId = await mkBatch(campusId, 'B', 'Intermediate Level');
  otherFoundationId = await mkBatch(otherCampusId, 'A', 'Foundation Level');

  for (const slug of [...FOUNDATION_SLUGS, ...INTERMEDIATE_SLUGS]) {
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

  const mkAssignment = async (batchId: string, slugs: string[]): Promise<string> => {
    const assignment = await prisma.assignment.create({
      data: {
        dayKey: DAY,
        campusId,
        batchId,
        originalCampusId: campusId,
        originalBatchId: batchId,
        isPublished: true,
      },
    });
    for (const [index, slug] of slugs.entries()) {
      const problem = await prisma.problem.findUniqueOrThrow({ where: { titleSlug: slug } });
      await prisma.assignmentProblem.create({
        data: { assignmentId: assignment.id, problemId: problem.id, position: index + 1 },
      });
    }
    return assignment.id;
  };

  foundationAssignmentId = await mkAssignment(foundationId, FOUNDATION_SLUGS);
  intermediateAssignmentId = await mkAssignment(intermediateId, INTERMEDIATE_SLUGS);
});

afterAll(async () => {
  // `DailyProblemStatus` cascades from `DailyStatus`, but deleting it first keeps the
  // teardown independent of that cascade staying in place.
  await prisma.dailyProblemStatus.deleteMany({
    where: { dailyStatus: { studentId: { in: studentIds } } },
  });
  await prisma.dailyStatus.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentBatchHistory.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentCampusHistory.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.leaderboardEntry.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentAchievement.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentSyncState.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.assignmentProblem.deleteMany({
    where: { assignmentId: { in: [foundationAssignmentId, intermediateAssignmentId] } },
  });
  await prisma.assignment.deleteMany({
    where: { id: { in: [foundationAssignmentId, intermediateAssignmentId] } },
  });
  await prisma.problem.deleteMany({ where: { id: { in: problemIds } } });
  await prisma.batch.deleteMany({
    where: { id: { in: [foundationId, intermediateId, otherFoundationId] } },
  });
  await prisma.campus.deleteMany({ where: { id: { in: [campusId, otherCampusId] } } });
  await prisma.$disconnect();
});

describe('an assignment published before the cohort was split', () => {
  it('scores the day under the batch each student was later placed into', async () => {
    const solver = await unclassifiedStudent('solver');
    const idle = await unclassifiedStudent('idle');
    const advanced = await unclassifiedStudent('advanced');

    // Work done on the assignment's own day, while nobody had a batch yet.
    await submit(solver, FOUNDATION_SLUGS[0]!, DAY, '12:48');
    await submit(advanced, INTERMEDIATE_SLUGS[0]!, DAY, '09:15');

    // The split, performed the next morning through the real service.
    await batches.moveStudent({ studentId: solver, toBatchId: foundationId });
    await batches.moveStudent({ studentId: idle, toBatchId: foundationId });
    await batches.moveStudent({ studentId: advanced, toBatchId: intermediateId });

    await rollup.recomputeDay(DAY, { force: true });

    const solverRow = await statusFor(solver, DAY);
    const idleRow = await statusFor(idle, DAY);
    const advancedRow = await statusFor(advanced, DAY);

    // Filed under the batch they are in, not under "no batch".
    expect(solverRow?.batchId).toBe(foundationId);
    expect(idleRow?.batchId).toBe(foundationId);
    expect(advancedRow?.batchId).toBe(intermediateId);

    // Matched to their batch's assignment — and never to the other batch's.
    expect(solverRow?.assignmentId).toBe(foundationAssignmentId);
    expect(idleRow?.assignmentId).toBe(foundationAssignmentId);
    expect(advancedRow?.assignmentId).toBe(intermediateAssignmentId);

    // The whole point: four problems assigned, not zero.
    expect(solverRow?.assignedCount).toBe(4);
    expect(idleRow?.assignedCount).toBe(4);
    expect(advancedRow?.assignedCount).toBe(4);

    // Submissions made before the split still count.
    expect(solverRow?.solvedCount).toBe(1);
    expect(advancedRow?.solvedCount).toBe(1);

    // A student with nothing solved is still present and still shown as assigned.
    expect(idleRow?.solvedCount).toBe(0);
  });

  it('back-dates the first placement to enrolment, not to the day of the split', async () => {
    const student = await unclassifiedStudent('backdate');
    await batches.moveStudent({ studentId: student, toBatchId: foundationId });

    const placements = await prisma.studentBatchHistory.findMany({ where: { studentId: student } });
    expect(placements).toHaveLength(1);
    expect(placements[0]?.effectiveFromDayKey).toBe(ENROLLED);
    expect(placements[0]?.fromBatchId).toBeNull();

    // Which is what makes every day from enrolment onwards resolve to the batch.
    expect(await batches.batchOnDay(student, DAY)).toBe(foundationId);
    expect(await batches.batchOnDay(student, ENROLLED)).toBe(foundationId);
  });

  /**
   * The guarantee the back-dating must not swallow. Once a student has been placed, moving
   * them is a decision about *today*: the day they completed under Foundation stays
   * Foundation's, and only days from the move onward belong to Intermediate.
   */
  it('does not let a later move re-file a day that was already scored', async () => {
    const mover = await unclassifiedStudent('mover');
    await submit(mover, FOUNDATION_SLUGS[0]!, DAY, '10:00');

    await batches.moveStudent({ studentId: mover, toBatchId: foundationId });
    await rollup.recomputeDay(DAY, { force: true });

    expect((await statusFor(mover, DAY))?.batchId).toBe(foundationId);

    // A genuine move now — the student already has a placement on record.
    await batches.moveStudent({
      studentId: mover,
      toBatchId: intermediateId,
      effectiveFromDayKey: SPLIT_DAY,
    });

    // The move is effective from the split day forward, so the assignment day is untouched.
    expect(await batches.batchOnDay(mover, DAY)).toBe(foundationId);
    expect(await batches.batchOnDay(mover, SPLIT_DAY)).toBe(intermediateId);

    await rollup.recomputeDay(DAY, { force: true });
    const after = await statusFor(mover, DAY);
    expect(after?.batchId).toBe(foundationId);
    expect(after?.assignmentId).toBe(foundationAssignmentId);
    expect(after?.solvedCount).toBe(1);
  });

  it('keeps every historical submission through the split and the recompute', async () => {
    const student = await unclassifiedStudent('history');
    await submit(student, FOUNDATION_SLUGS[0]!, DAY, '08:00');
    await submit(student, FOUNDATION_SLUGS[1]!, DAY, '08:30');

    const before = await prisma.submission.count({ where: { studentId: student } });

    await batches.moveStudent({ studentId: student, toBatchId: foundationId });
    await rollup.recomputeDay(DAY, { force: true });
    await rollup.recomputeDay(DAY, { force: true });

    expect(await prisma.submission.count({ where: { studentId: student } })).toBe(before);
    expect((await statusFor(student, DAY))?.solvedCount).toBe(2);
  });

  /**
   * Repairing one campus's placements must not widen anybody's audience. A student in
   * another campus, placed into a batch with the same code on the same day, is still
   * matched to nothing here — their campus published no assignment.
   */
  it('does not leak the assignment to another campus placed on the same day', async () => {
    const outsider = await prisma.student.create({
      data: {
        name: `${RUN} outsider`,
        email: `${RUN}-outsider@abb.invalid`,
        leetcodeUsername: `${RUN}-outsider`,
        campusId: otherCampusId,
        status: 'ACTIVE',
        createdAt: ist(ENROLLED, '18:27'),
        campusHistory: {
          create: { toCampusId: otherCampusId, effectiveFromDayKey: ENROLLED, source: 'MIGRATION' },
        },
      },
    });
    studentIds.push(outsider.id);

    // Same problems, same day — only the campus differs.
    await submit(outsider.id, FOUNDATION_SLUGS[0]!, DAY, '12:00');
    await batches.moveStudent({ studentId: outsider.id, toBatchId: otherFoundationId });
    await rollup.recomputeDay(DAY, { force: true });

    const row = await statusFor(outsider.id, DAY);
    expect(row?.campusId).toBe(otherCampusId);
    expect(row?.assignmentId).toBeNull();
    expect(row?.assignedCount).toBe(0);
  });
});
