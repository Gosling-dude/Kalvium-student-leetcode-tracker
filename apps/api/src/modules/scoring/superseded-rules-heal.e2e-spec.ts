/**
 * The gap that let a wrong report go out while every health check stayed green.
 *
 * `20260911090000_assignment_solved_ever` redefined `solvedCount` from "solved inside the
 * lookback window" to "ever solved". The migration backfilled the *new* column losslessly
 * but could not raise `solvedCount` itself — that needs the submission mirror re-read per
 * day — and nothing scheduled the re-read. `findStaleAssignmentDays` looked only at
 * `assignments.updatedAt`, and no assignment had changed: only the rule had. So 229
 * production student-days went on publishing the old windowed figure, and the campus
 * report read them as though they were ever-solved figures.
 *
 * The fix is to make "computed under superseded rules" a state the rows themselves carry,
 * so the system can find and heal it without a human remembering a documented step. These
 * tests assert that end to end, on a real database, including the property the whole
 * design rests on: healing is idempotent, so the fifth run changes nothing.
 *
 * Fixtures live under a unique prefix and are removed in `afterAll`.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPLETION_RULES_VERSION } from '@dsa/shared';

import { RollupService } from './rollup.service';
import { ScoringConfigService } from './scoring-config.service';
import { StudentMetricsService } from './student-metrics.service';
import { BatchesService } from '../batches/batches.service';
import { CampusesService } from '../campuses/campuses.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { EnrolmentService } from '../../common/services/enrolment.service';

const prisma = new PrismaClient();

const RUN = `e2e-sv-${Date.now()}`;
const CODE = `SV${Date.now().toString(36).toUpperCase()}`;
const IST = '+05:30';

/** Dated in a year the programme will never hold real data for. */
const ASSIGNMENT_DAY = '2099-09-07';
/** Entered into the tracker four days after the work was set. */
const ENTERED_ON = '2099-09-11';
/** Before the assignment date and before its two-day lookback — the reported case. */
const SOLVED_BEFORE = '2099-09-04';
const ENROLLED = '2099-06-01';

const ist = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00${IST}`);

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const noCache = {
  get: async () => null,
  set: async () => undefined,
  del: async () => undefined,
  delByPrefix: async () => undefined,
  flush: async () => undefined,
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
  new EnrolmentService(prisma as never, time),
);

let campusId: string;
let batchId: string;
let studentId: string;
let assignmentId: string;
const problemIds: string[] = [];
const slugs = [`${RUN}-p1`.toLowerCase(), `${RUN}-p2`.toLowerCase()];

const row = () =>
  prisma.dailyStatus.findUniqueOrThrow({
    where: { studentId_dayKey: { studentId, dayKey: ASSIGNMENT_DAY } },
    include: { problemStatuses: { orderBy: { position: 'asc' } } },
  });

/**
 * Put the stored row back into the exact state the ever-solved migration left production
 * in: the windowed figure sitting in `solvedCount`, stamped with the rule set that wrote
 * it. Reproducing the bug this way rather than by reverting the code is deliberate —
 * production was never running old code, it was running new code over old rows.
 */
async function rewindToSupersededRules(): Promise<void> {
  const current = await row();
  await prisma.dailyStatus.update({
    where: { id: current.id },
    data: {
      solvedCount: current.inWindowSolvedCount,
      computedVersion: COMPLETION_RULES_VERSION - 1,
    },
  });
}

beforeAll(async () => {
  campusId = (await prisma.campus.create({ data: { name: `${RUN} Campus`, code: CODE } })).id;
  batchId = (await prisma.batch.create({ data: { name: `${RUN} Foundation`, code: 'A', campusId } })).id;

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

  assignmentId = (
    await prisma.assignment.create({
      data: {
        dayKey: ASSIGNMENT_DAY,
        campusId,
        batchId,
        originalCampusId: campusId,
        originalBatchId: batchId,
        title: `${RUN} ${ASSIGNMENT_DAY}`,
        createdAt: ist(ENTERED_ON, '10:30'),
        problems: { create: problems.map((p, i) => ({ problemId: p.id, position: i + 1 })) },
      },
    })
  ).id;

  studentId = (
    await prisma.student.create({
      data: {
        name: `${RUN} student`,
        email: `${RUN}@superseded.invalid`,
        leetcodeUsername: RUN,
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
    })
  ).id;

  // Solved before the assignment existed, and outside the window it would have searched.
  await prisma.submission.create({
    data: {
      studentId,
      problemId: problemIds[0]!,
      providerSubmissionId: `${RUN}-1`,
      titleSlug: slugs[0]!,
      title: slugs[0]!.toUpperCase(),
      status: 'ACCEPTED',
      submittedAt: ist(SOLVED_BEFORE, '14:00'),
      dayKey: SOLVED_BEFORE,
      language: 'python3',
    },
  });

  await rollup.recomputeDay(ASSIGNMENT_DAY);
});

afterAll(async () => {
  await prisma.dailyProblemStatus.deleteMany({ where: { dailyStatus: { studentId } } });
  await prisma.dailyStatus.deleteMany({ where: { studentId } });
  await prisma.submission.deleteMany({ where: { studentId } });
  await prisma.assignmentProblem.deleteMany({ where: { assignmentId } });
  await prisma.assignment.delete({ where: { id: assignmentId } });
  await prisma.student.delete({ where: { id: studentId } });
  await prisma.problem.deleteMany({ where: { id: { in: problemIds } } });
  await prisma.batch.deleteMany({ where: { campusId } });
  await prisma.campus.delete({ where: { id: campusId } });
  await prisma.$disconnect();
});

describe('a rule change leaves a trace the system can act on', () => {
  it('stamps the current rules version on every row it writes', async () => {
    const stored = await row();
    expect(stored.computedVersion).toBe(COMPLETION_RULES_VERSION);
  });

  it('separates the two figures: ever-solved counts the early solve, the window does not', async () => {
    const stored = await row();
    expect(stored.assignedCount).toBe(2);
    // Solved on the 4th: credited to the 7 Sep assignment entered on the 11th.
    expect(stored.solvedCount).toBe(1);
    // …and still not evidence that the student practised that week.
    expect(stored.inWindowSolvedCount).toBe(0);
  });

  it('reports a row left on an older rules version as stale', async () => {
    await rewindToSupersededRules();

    const stale = await rollup.findSupersededDays();
    expect(stale).toContain(ASSIGNMENT_DAY);

    // And the ordinary range scan sees it too, without any assignment having changed.
    const viaRange = await rollup.findStaleAssignmentDays(ASSIGNMENT_DAY, ASSIGNMENT_DAY);
    expect(viaRange).toContain(ASSIGNMENT_DAY);
  });

  it('counts the outstanding work so it cannot be missed', async () => {
    const pending = await rollup.countSupersededRows();
    expect(pending.days).toBeGreaterThanOrEqual(1);
    expect(pending.rows).toBeGreaterThanOrEqual(1);
  });

  it('heals the superseded row back to the ever-solved figure', async () => {
    const before = await row();
    // The bug, reproduced: the report would read 0 for a problem the student had solved.
    expect(before.solvedCount).toBe(0);

    await rollup.healSupersededDays();

    const after = await row();
    expect(after.solvedCount).toBe(1);
    expect(after.inWindowSolvedCount).toBe(0);
    expect(after.computedVersion).toBe(COMPLETION_RULES_VERSION);
  });

  it('is idempotent — running it five more times changes nothing', async () => {
    const after = await row();

    for (let i = 0; i < 5; i += 1) {
      const result = await rollup.healSupersededDays();
      // Nothing left to select, so nothing is even recomputed.
      expect(result.days).not.toContain(ASSIGNMENT_DAY);
    }

    const settled = await row();
    expect(settled.solvedCount).toBe(after.solvedCount);
    expect(settled.inWindowSolvedCount).toBe(after.inWindowSolvedCount);
    expect(settled.computedVersion).toBe(after.computedVersion);
  });

  it('leaves nothing stale once healed', async () => {
    // Scoped to this fixture's day: the e2e suites share one database, and whether some
    // other suite's rows are stale is not what this test is about.
    expect(await rollup.findSupersededDays()).not.toContain(ASSIGNMENT_DAY);
    expect((await row()).computedVersion).toBe(COMPLETION_RULES_VERSION);
  });
});
