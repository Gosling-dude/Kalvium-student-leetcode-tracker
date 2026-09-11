/**
 * The reported scenario, reproduced through the real rollup against a real database.
 *
 *   Today is 11 September. Assignments for the 7th, 8th, 9th and 10th were shared with
 *   students directly at the time, and only entered into the tracker on the 11th. One
 *   student had solved Two Sum on the **5th** — before the assignment existed, and
 *   before the window any of those days would have searched.
 *
 *   For the 7 September assignment, Two Sum must read SOLVED.
 *
 * The previous behaviour failed this twice over. The submission query was bounded to
 * `[D-2, D]`, so a solve on the 5th was not even loaded for the 7th; and the day was
 * never recomputed at all unless a sync happened to touch it.
 *
 * These tests drive `RollupService.recomputeDay` rather than the pure rule, because the
 * pure rule was never the broken part — the load in front of it was, and a unit test of
 * the rule cannot see a row the query did not return.
 *
 * The other half of the requirement is asserted just as hard: crediting a June solve to a
 * September assignment must not manufacture a September streak. `solvedCount` and
 * `inWindowSolvedCount` are checked separately on every row.
 *
 * Fixtures live under a unique prefix and are removed in `afterAll`.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RollupService } from '../scoring/rollup.service';
import { ScoringConfigService } from '../scoring/scoring-config.service';
import { StudentMetricsService } from '../scoring/student-metrics.service';
import { BatchesService } from '../batches/batches.service';
import { CampusesService } from '../campuses/campuses.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

const prisma = new PrismaClient();

const RUN = `e2e-late-${Date.now()}`;
const CODE = `LA${Date.now().toString(36).toUpperCase()}`;
const IST = '+05:30';

/** The scenario's dates, in a year the programme will never hold data for. */
const ASSIGNMENT_DAYS = ['2099-09-07', '2099-09-08', '2099-09-09', '2099-09-10'] as const;
/** The day every one of those rows was actually inserted. */
const ENTERED_ON = '2099-09-11';
/** Before the assignment date, before the lookback, before the row existed. */
const SOLVED_LONG_BEFORE = '2099-09-05';
/** Long before everything — the "at ANY TIME" end of the rule. */
const SOLVED_MONTHS_BEFORE = '2099-06-14';
const ENROLLED = '2099-06-01';

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
let batchId: string;
/** Two problems per day, so a partial result is distinguishable from a total one. */
const slugsByDay: Record<string, string[]> = {};
const problemIds: string[] = [];
const assignmentIds: string[] = [];
const studentIds: Record<string, string> = {};

async function student(key: string): Promise<string> {
  const row = await prisma.student.create({
    data: {
      name: `${RUN} ${key}`,
      email: `${RUN}-${key}@late.invalid`,
      leetcodeUsername: `${RUN}-${key}`,
      campusId,
      batchId,
      status: 'ACTIVE',
      createdAt: ist(ENROLLED, '09:00'),
      campusHistory: {
        create: { toCampusId: campusId, effectiveFromDayKey: ENROLLED, source: 'MIGRATION' },
      },
      batchHistory: {
        create: { toBatchId: batchId, effectiveFromDayKey: ENROLLED, source: 'MIGRATION' },
      },
      syncState: { create: { status: 'OK', lastSyncedAt: ist(ENTERED_ON, '08:00') } },
    },
  });
  studentIds[key] = row.id;
  return row.id;
}

async function submit(
  studentId: string,
  slug: string,
  day: string,
  hhmm: string,
  status: 'ACCEPTED' | 'ATTEMPTED_NOT_ACCEPTED' = 'ACCEPTED',
  seq = 1,
): Promise<void> {
  const problem = await prisma.problem.findUniqueOrThrow({ where: { titleSlug: slug } });
  await prisma.submission.create({
    data: {
      studentId,
      problemId: problem.id,
      providerSubmissionId: `${RUN}-${studentId}-${slug}-${day}-${hhmm}-${seq}`,
      titleSlug: slug,
      title: slug.toUpperCase(),
      status,
      submittedAt: ist(day, hhmm),
      dayKey: day,
      language: 'python3',
    },
  });
}

/** The stored result for one student on one day, as the tracker would display it. */
async function stored(key: string, dayKey: string) {
  return prisma.dailyStatus.findUniqueOrThrow({
    where: { studentId_dayKey: { studentId: studentIds[key]!, dayKey } },
    include: { problemStatuses: { orderBy: { position: 'asc' } } },
  });
}

beforeAll(async () => {
  const campus = await prisma.campus.create({
    data: { name: `${RUN} Campus`, code: CODE },
  });
  campusId = campus.id;
  const batch = await prisma.batch.create({
    data: { name: `${RUN} Foundation`, code: 'A', campusId },
  });
  batchId = batch.id;

  for (const day of ASSIGNMENT_DAYS) {
    const slugs = [`${RUN}-${day}-1`.toLowerCase(), `${RUN}-${day}-2`.toLowerCase()];
    slugsByDay[day] = slugs;

    const problems = [];
    for (const slug of slugs) {
      const problem = await prisma.problem.create({
        data: {
          titleSlug: slug,
          title: slug.toUpperCase(),
          difficulty: 'EASY',
          url: `https://leetcode.com/problems/${slug}/`,
        },
      });
      problemIds.push(problem.id);
      problems.push(problem);
    }

    const assignment = await prisma.assignment.create({
      data: {
        dayKey: day,
        campusId,
        batchId,
        originalCampusId: campusId,
        originalBatchId: batchId,
        title: `${RUN} ${day}`,
        // The whole point: entered on the 11th, dated the 7th–10th.
        createdAt: ist(ENTERED_ON, '10:30'),
        problems: { create: problems.map((p, i) => ({ problemId: p.id, position: i + 1 })) },
      },
    });
    assignmentIds.push(assignment.id);
  }

  await student('early');       // solved on the 5th, before the assignment existed
  await student('months-early'); // solved in June
  await student('onTime');      // solved on the day itself
  await student('attempted');   // submitted, never accepted
  await student('nothing');     // no submissions at all

  const day7 = ASSIGNMENT_DAYS[0];
  await submit(studentIds.early!, slugsByDay[day7]![0]!, SOLVED_LONG_BEFORE, '14:00');
  await submit(studentIds['months-early']!, slugsByDay[day7]![0]!, SOLVED_MONTHS_BEFORE, '14:00');
  await submit(studentIds.onTime!, slugsByDay[day7]![0]!, day7, '19:00');
  await submit(
    studentIds.attempted!,
    slugsByDay[day7]![0]!,
    day7,
    '19:00',
    'ATTEMPTED_NOT_ACCEPTED',
  );

  // Recompute every affected day, oldest first — what a backfill does.
  for (const day of ASSIGNMENT_DAYS) await rollup.recomputeDay(day);
});

afterAll(async () => {
  const ids = Object.values(studentIds);
  await prisma.dailyProblemStatus.deleteMany({
    where: { dailyStatus: { studentId: { in: ids } } },
  });
  await prisma.dailyStatus.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.assignmentProblem.deleteMany({ where: { assignmentId: { in: assignmentIds } } });
  await prisma.assignment.deleteMany({ where: { id: { in: assignmentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await prisma.problem.deleteMany({ where: { id: { in: problemIds } } });
  await prisma.batch.deleteMany({ where: { campusId } });
  await prisma.campus.delete({ where: { id: campusId } });
  await prisma.$disconnect();
});

describe('an assignment entered after its own date reconciles that date', () => {
  it('preserves the original assignment date rather than today', async () => {
    const rows = await prisma.assignment.findMany({
      where: { id: { in: assignmentIds } },
      select: { dayKey: true, createdAt: true },
      orderBy: { dayKey: 'asc' },
    });

    expect(rows.map((r) => r.dayKey)).toEqual([...ASSIGNMENT_DAYS]);
    // Every one of them was created after every one of the days it describes.
    expect(rows.every((r) => time.dayKeyOf(r.createdAt) === ENTERED_ON)).toBe(true);
  });

  it('counts a solve from two days before the assignment date — the reported case', async () => {
    const row = await stored('early', ASSIGNMENT_DAYS[0]);
    expect(row.assignedCount).toBe(2);
    expect(row.solvedCount).toBe(1);
    expect(row.problemStatuses[0]!.status).toBe('ACCEPTED');
    // The evidence travels with the result: solved on the 5th, credited to the 7th.
    expect(time.dayKeyOf(row.problemStatuses[0]!.solvedAt!)).toBe(SOLVED_LONG_BEFORE);
  });

  it('counts a solve from months earlier — "at ANY TIME" means at any time', async () => {
    const row = await stored('months-early', ASSIGNMENT_DAYS[0]);
    expect(row.solvedCount).toBe(1);
    expect(row.problemStatuses[0]!.status).toBe('ACCEPTED');
    expect(time.dayKeyOf(row.problemStatuses[0]!.solvedAt!)).toBe(SOLVED_MONTHS_BEFORE);
  });

  it('does not turn a long-past solve into practice on the assignment day', async () => {
    // The other half of the rule, and the one that is easy to lose. Crediting the June
    // solve must not claim the student worked in September.
    const months = await stored('months-early', ASSIGNMENT_DAYS[0]);
    expect(months.solvedCount).toBe(1);
    expect(months.inWindowSolvedCount).toBe(0);
    expect(months.problemStatuses[0]!.inWindowStatus).toBe('NOT_ATTEMPTED');
    expect(months.streakAtDay).toBe(0);

    // …while a student who solved it on the day gets both.
    const onTime = await stored('onTime', ASSIGNMENT_DAYS[0]);
    expect(onTime.solvedCount).toBe(1);
    expect(onTime.inWindowSolvedCount).toBe(1);
    expect(onTime.streakAtDay).toBeGreaterThan(0);
  });

  it('treats the 5th as practice for the 7th, because it is inside the lookback', async () => {
    // Worth stating rather than leaving implicit: the reported case (solved on the 5th,
    // assignment dated the 7th) sits *inside* `[D-2, D]`, so it counts on both measures.
    // It failed before this change not because of the window but because the query in
    // front of the rule was bounded by the assignment's own creation day.
    const early = await stored('early', ASSIGNMENT_DAYS[0]);
    expect(early.solvedCount).toBe(1);
    expect(early.inWindowSolvedCount).toBe(1);
  });

  it('keeps attempted-not-solved distinct from not-attempted', async () => {
    const attempted = await stored('attempted', ASSIGNMENT_DAYS[0]);
    expect(attempted.solvedCount).toBe(0);
    expect(attempted.problemStatuses[0]!.status).toBe('ATTEMPTED_NOT_ACCEPTED');
    expect(attempted.problemStatuses[1]!.status).toBe('NOT_ATTEMPTED');

    const nothing = await stored('nothing', ASSIGNMENT_DAYS[0]);
    expect(nothing.problemStatuses.every((p) => p.status === 'NOT_ATTEMPTED')).toBe(true);
  });

  it('leaves the other three days honestly at zero rather than inventing a solve', async () => {
    // Only the 7th's problems were ever solved. Counting "solved at any time" must not
    // spill across days — each assignment has its own problem set.
    for (const day of ASSIGNMENT_DAYS.slice(1)) {
      const row = await stored('early', day);
      expect(row.assignedCount).toBe(2);
      expect(row.solvedCount).toBe(0);
    }
  });
});

describe('reconciliation is idempotent', () => {
  it('produces the same result however many times it runs', async () => {
    const before = await stored('early', ASSIGNMENT_DAYS[0]);

    await rollup.recomputeDay(ASSIGNMENT_DAYS[0]);
    await rollup.recomputeDay(ASSIGNMENT_DAYS[0]);
    await rollup.recomputeDay(ASSIGNMENT_DAYS[0]);

    const after = await stored('early', ASSIGNMENT_DAYS[0]);
    expect(after.solvedCount).toBe(before.solvedCount);
    expect(after.inWindowSolvedCount).toBe(before.inWindowSolvedCount);
    expect(after.assignedCount).toBe(before.assignedCount);
    expect(after.problemStatuses).toHaveLength(before.problemStatuses.length);
    expect(after.problemStatuses[0]!.solvedAt).toEqual(before.problemStatuses[0]!.solvedAt);
  });

  it('counts twenty accepted submissions to one problem as one solved problem', async () => {
    const key = 'onTime';
    const slug = slugsByDay[ASSIGNMENT_DAYS[0]]![0]!;
    for (let i = 2; i <= 21; i += 1) {
      await submit(studentIds[key]!, slug, ASSIGNMENT_DAYS[0], '20:00', 'ACCEPTED', i);
    }
    await rollup.recomputeDay(ASSIGNMENT_DAYS[0]);

    const row = await stored(key, ASSIGNMENT_DAYS[0]);
    expect(row.solvedCount).toBe(1);
    // The attempt count still records all twenty-one — deduplication is about the
    // *problem*, not about forgetting what was observed.
    expect(row.problemStatuses[0]!.attempts).toBe(21);
    // And the solve time stays the earliest one, not the twenty-first.
    expect(row.problemStatuses[0]!.solvedAt).toEqual(ist(ASSIGNMENT_DAYS[0], '19:00'));
  });

  it('never exceeds the assigned count, however many submissions arrive', async () => {
    const rows = await prisma.dailyStatus.findMany({
      where: { studentId: { in: Object.values(studentIds) } },
      select: { solvedCount: true, inWindowSolvedCount: true, assignedCount: true },
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.solvedCount).toBeLessThanOrEqual(row.assignedCount);
      // The database CHECK constraint states this too; asserting it here catches a
      // service that computes the pair inconsistently before Postgres has to.
      expect(row.inWindowSolvedCount).toBeLessThanOrEqual(row.solvedCount);
    }
  });
});

describe('a later assignment does not re-credit an earlier day', () => {
  it('scores each day only against its own problems', async () => {
    // Solve the 10th's first problem. The 7th, 8th and 9th must not move: their problem
    // sets are disjoint, and "solved at any time" is about time, not about which
    // assignment a problem belongs to.
    await submit(studentIds.early!, slugsByDay[ASSIGNMENT_DAYS[3]]![0]!, ENTERED_ON, '09:00');
    for (const day of ASSIGNMENT_DAYS) await rollup.recomputeDay(day);

    expect((await stored('early', ASSIGNMENT_DAYS[0])).solvedCount).toBe(1);
    expect((await stored('early', ASSIGNMENT_DAYS[1])).solvedCount).toBe(0);
    expect((await stored('early', ASSIGNMENT_DAYS[2])).solvedCount).toBe(0);
    expect((await stored('early', ASSIGNMENT_DAYS[3])).solvedCount).toBe(1);
  });
});
