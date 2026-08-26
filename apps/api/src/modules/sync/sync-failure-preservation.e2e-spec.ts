/**
 * A sync that failed is not a student who solved nothing.
 *
 * The rule the whole reporting stack rests on, and the one whose violation is most
 * expensive: a mentor who sees 0/4 acts on it. If LeetCode was unreachable that morning,
 * every action taken on that report is wrong — a chased student, a logged blocker, an
 * escalation about someone who did the work.
 *
 * The architecture is supposed to make this structural: `recomputeDay` derives results
 * from the stored submission mirror, never from a live provider call, so an unreachable
 * provider cannot subtract anything that was already mirrored. This suite proves that
 * property holds in practice rather than only in the design, and pins it so a future
 * change that starts reading the provider during a rollup fails here.
 *
 * The distinction being protected, in the brief's own terms:
 *
 *   sync SUCCEEDED + 0 relevant accepted problems  → the student solved 0. Report it.
 *   sync FAILED                                    → we do not know. Preserve, and say so.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RollupService } from '../scoring/rollup.service';
import { ScoringConfigService } from '../scoring/scoring-config.service';
import { StudentMetricsService } from '../scoring/student-metrics.service';
import { BatchesService } from '../batches/batches.service';
import { CampusesService } from '../campuses/campuses.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

const prisma = new PrismaClient();

const RUN = `e2e-syncfail-${Date.now()}`;
const CODE = `SF${Date.now().toString(36).toUpperCase()}`;
const DAY = '2026-08-18';

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
const campuses = new CampusesService(prisma as never, time, noCache);
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
let assignmentId: string;
let didTheWork: string;
let didNothing: string;
const problemIds: string[] = [];

async function student(key: string, name: string): Promise<string> {
  const row = await prisma.student.create({
    data: {
      name,
      email: `${RUN}-${key}@sync-fail.invalid`,
      leetcodeUsername: `${RUN}-${key}`,
      campusId,
      status: 'ACTIVE',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      campusHistory: {
        create: { toCampusId: campusId, effectiveFromDayKey: '2026-08-01', source: 'MANUAL' },
      },
      syncState: { create: { status: 'OK', lastSuccessAt: new Date('2026-08-18T04:00:00.000Z') } },
    },
  });
  return row.id;
}

/** The status a failed provider read leaves behind — exactly what `StudentSyncService` writes. */
async function markSyncFailed(studentId: string, status: 'PROVIDER_ERROR' | 'RATE_LIMITED') {
  await prisma.studentSyncState.update({
    where: { studentId },
    data: {
      status,
      lastSyncedAt: new Date(),
      lastError: 'LeetCode was unreachable',
      consecutiveFailures: { increment: 1 },
      // Deliberately untouched: the last time we genuinely knew something.
    },
  });
}

async function solvedCountFor(studentId: string): Promise<number> {
  const row = await prisma.dailyStatus.findUnique({
    where: { studentId_dayKey: { studentId, dayKey: DAY } },
  });
  return row?.solvedCount ?? -1;
}

beforeAll(async () => {
  const campus = await prisma.campus.create({
    data: { name: `${RUN} Campus`, code: CODE },
  });
  campusId = campus.id;

  for (let i = 0; i < 4; i += 1) {
    const problem = await prisma.problem.create({
      data: {
        titleSlug: `${RUN}-p${i}`,
        title: `Problem ${i}`,
        difficulty: 'EASY',
        url: `https://leetcode.com/problems/${RUN}-p${i}/`,
      },
    });
    problemIds.push(problem.id);
  }

  const assignment = await prisma.assignment.create({
    data: {
      dayKey: DAY,
      campusId,
      title: `${RUN} assignment`,
      problems: {
        create: problemIds.map((problemId, index) => ({ problemId, position: index + 1 })),
      },
    },
  });
  assignmentId = assignment.id;

  didTheWork = await student('worked', 'Did The Work');
  didNothing = await student('nothing', 'Did Nothing');

  // Four accepted submissions, mirrored while the provider was still reachable.
  for (let i = 0; i < 4; i += 1) {
    await prisma.submission.create({
      data: {
        studentId: didTheWork,
        problemId: problemIds[i]!,
        providerSubmissionId: `${RUN}-sub-${i}`,
        provider: 'leetcode',
        titleSlug: `${RUN}-p${i}`,
        title: `Problem ${i}`,
        status: 'ACCEPTED',
        submittedAt: new Date(`2026-08-18T0${4 + i}:00:00.000Z`),
        dayKey: DAY,
      },
    });
  }
});

afterAll(async () => {
  const ids = [didTheWork, didNothing].filter(Boolean);
  await prisma.dailyProblemStatus.deleteMany({
    where: { dailyStatus: { studentId: { in: ids } } },
  });
  await prisma.dailyStatus.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.leaderboardEntry.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentSyncState.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await prisma.assignmentProblem.deleteMany({ where: { assignmentId } });
  await prisma.assignment.deleteMany({ where: { id: assignmentId } });
  await prisma.problem.deleteMany({ where: { id: { in: problemIds } } });
  await prisma.campus.deleteMany({ where: { id: campusId } });
  await prisma.$disconnect();
});

describe('a successful sync establishes the truth', () => {
  it('records the work that was done', async () => {
    await rollup.recomputeDay(DAY);
    expect(await solvedCountFor(didTheWork)).toBe(4);
  });

  it('records a genuine zero for a student who solved nothing', async () => {
    // The case that *must* still report 0: the read succeeded, there is simply nothing
    // there. Only a successful sync can establish confirmed zero progress.
    expect(await solvedCountFor(didNothing)).toBe(0);

    const state = await prisma.studentSyncState.findUnique({ where: { studentId: didNothing } });
    expect(state?.status).toBe('OK');
  });
});

describe('a failed sync preserves what was already known', () => {
  it('does not turn 4/4 into 0/4 when the provider is unreachable', async () => {
    await markSyncFailed(didTheWork, 'PROVIDER_ERROR');
    await rollup.recomputeDay(DAY);

    // The single assertion this file exists for.
    expect(await solvedCountFor(didTheWork)).toBe(4);
  });

  it('does not turn 4/4 into 0/4 when the provider rate-limits us either', async () => {
    await markSyncFailed(didTheWork, 'RATE_LIMITED');
    await rollup.recomputeDay(DAY);

    expect(await solvedCountFor(didTheWork)).toBe(4);
  });

  it('marks the day with the failure, so the number is not read as confirmed', async () => {
    const row = await prisma.dailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: didTheWork, dayKey: DAY } },
    });
    // The count survived; what changed is that the row now says we could not re-read it.
    expect(row?.syncStatus).toBe('RATE_LIMITED');
  });

  it('keeps the last successful sync timestamp, so "as of when" is answerable', async () => {
    const state = await prisma.studentSyncState.findUnique({ where: { studentId: didTheWork } });

    expect(state?.lastSuccessAt).not.toBeNull();
    expect(state!.lastSuccessAt!.getTime()).toBeLessThan(state!.lastSyncedAt!.getTime());
    expect(state?.lastError).toBe('LeetCode was unreachable');
    expect(state?.consecutiveFailures).toBeGreaterThan(0);
  });

  it('still reports a genuine zero as zero, even mid-outage', async () => {
    // A failed sync must not launder an actual zero into "unknown" either — the student
    // who did nothing is still a student who did nothing, on the evidence we hold.
    await markSyncFailed(didNothing, 'PROVIDER_ERROR');
    await rollup.recomputeDay(DAY);

    expect(await solvedCountFor(didNothing)).toBe(0);
  });

  it('recovers the same numbers once the provider comes back', async () => {
    await prisma.studentSyncState.update({
      where: { studentId: didTheWork },
      data: { status: 'OK', lastSuccessAt: new Date(), lastError: null, consecutiveFailures: 0 },
    });
    await rollup.recomputeDay(DAY);

    expect(await solvedCountFor(didTheWork)).toBe(4);
    const row = await prisma.dailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: didTheWork, dayKey: DAY } },
    });
    expect(row?.syncStatus).toBe('OK');
  });
});

describe('repeated rollups are idempotent', () => {
  it('produces the same numbers however many times it runs', async () => {
    await rollup.recomputeDay(DAY);
    await rollup.recomputeDay(DAY);
    await rollup.recomputeDay(DAY);

    expect(await solvedCountFor(didTheWork)).toBe(4);

    // And no duplicate per-problem rows: a rollup rebuilds, it does not append.
    const perProblem = await prisma.dailyProblemStatus.count({
      where: { dailyStatus: { studentId: didTheWork, dayKey: DAY } },
    });
    expect(perProblem).toBe(4);
  });
});
