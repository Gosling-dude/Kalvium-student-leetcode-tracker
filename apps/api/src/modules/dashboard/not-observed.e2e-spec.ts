/**
 * `NOT_OBSERVED` on the mentor tracker, against a real database.
 *
 * The production case this pins down: 44 SRM students were imported on 8 Sep into a
 * cohort whose assignments start on 25 Aug. They genuinely were SRM students the whole
 * time — their placement history is back-dated to enrolment — but the tracker was not
 * mirroring their submissions, and LeetCode's public endpoint only exposes a student's
 * ~20 most recent submissions, so the intervening weeks are permanently unreachable.
 *
 * "We have no evidence" and "they solved nothing" are different claims. Every table in
 * the app used to render both as `0`, which put a whole mid-term intake on every earlier
 * day's leaderboard at zero and dragged the cohort's completion rate down with numbers
 * nobody ever observed.
 *
 * These run against a real database because the claim under test is about which rows
 * exist and which do not — a mocked Prisma would only prove the mock returns what it was
 * told to.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DashboardService } from './dashboard.service';
import { BatchesService } from '../batches/batches.service';
import { CampusesService } from '../campuses/campuses.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

const prisma = new PrismaClient();

const RUN = `e2e-notobs-${Date.now()}`;
const CODE = `NO${Date.now().toString(36).toUpperCase().slice(-6)}`;

/** The day an assignment exists on. Fixed and in the past, like the real case. */
const PAST_DAY = '2026-08-28';
/** The day the late cohort was imported — after the assignment. */
const IMPORT_DAY = '2026-09-08';

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const noCache = {
  get: async () => null,
  set: async () => undefined,
  del: async () => undefined,
  delByPrefix: async () => undefined,
  remember: async <T>(_k: string, _ttl: number, fn: () => Promise<T>) => fn(),
  flush: async () => undefined,
} as never;

let campusId: string;
let otherCampusId: string;
let assignmentId: string;
let problemIds: string[] = [];
let dashboard: DashboardService;

/** Everything `findAllByDay` hands the dashboard, built from the fixtures. */
async function assignmentSummaries(dayKey: string) {
  const rows = await prisma.assignment.findMany({
    where: { dayKey },
    include: {
      problems: { include: { problem: true }, orderBy: { position: 'asc' } },
      campus: true,
      batch: true,
    },
  });
  return rows.map((a) => ({
    id: a.id,
    dayKey: a.dayKey,
    campusId: a.campusId,
    campusName: a.campus?.name ?? null,
    campusCode: a.campus?.code ?? null,
    batchId: a.batchId,
    batchName: a.batch?.name ?? null,
    batchCode: a.batch?.code ?? null,
    audienceLabel: a.campus?.name ?? 'Everyone',
    studentCount: 0,
    originalCampusId: a.originalCampusId,
    originalCampusName: null,
    originalCampusCode: null,
    originalBatchId: a.originalBatchId,
    originalBatchName: null,
    originalBatchCode: null,
    title: a.title,
    topic: a.topic,
    notes: a.notes,
    difficulty: a.difficulty,
    isPublished: a.isPublished,
    problems: a.problems.map((p) => ({
      id: p.id,
      position: p.position,
      problemId: p.problemId,
      title: p.problem.title,
      titleSlug: p.problem.titleSlug,
      url: p.problem.url,
      difficulty: p.problem.difficulty,
      questionFrontendId: p.problem.questionFrontendId,
      acceptanceRate: p.problem.acceptanceRate,
      topicTags: p.problem.topicTags,
      companyTags: p.problem.companyTags,
      isPaidOnly: p.problem.isPaidOnly,
    })),
    createdAt: a.createdAt.toISOString(),
    createdByName: null,
  }));
}

async function makeStudent(input: {
  label: string;
  campus: string;
  createdAt: Date;
  handle?: string;
}) {
  const student = await prisma.student.create({
    data: {
      name: `${RUN} ${input.label}`,
      email: `${RUN}-${input.label}@notobs.invalid`,
      campusId: input.campus,
      leetcodeUsername: input.handle ?? `${RUN}-${input.label}`,
      status: 'ACTIVE',
      createdAt: input.createdAt,
    },
  });
  // Placement back-dated to the cohort's enrolment: they were on the roster on PAST_DAY
  // even when the tracker only started watching them later. The two dates are separate
  // facts, and keeping them separate is the whole mechanism under test.
  await prisma.studentCampusHistory.create({
    data: {
      studentId: student.id,
      toCampusId: input.campus,
      effectiveFromDayKey: '2026-08-01',
      reason: 'fixture',
    },
  });
  return student;
}

beforeAll(async () => {
  const [campus, other] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} SRM`, code: `${CODE}S` } }),
    prisma.campus.create({ data: { name: `${RUN} VELS`, code: `${CODE}V` } }),
  ]);
  campusId = campus.id;
  otherCampusId = other.id;

  const problems = await Promise.all(
    ['alpha', 'beta', 'gamma', 'delta'].map((slug, i) =>
      prisma.problem.create({
        data: {
          titleSlug: `${RUN}-${slug}`,
          title: `${RUN} ${slug}`,
          difficulty: 'EASY',
          url: `https://leetcode.com/problems/${RUN}-${slug}/`,
          questionFrontendId: String(9000 + i),
        },
      }),
    ),
  );
  problemIds = problems.map((p) => p.id);

  const assignment = await prisma.assignment.create({
    data: {
      dayKey: PAST_DAY,
      campusId,
      isPublished: true,
      problems: {
        create: problemIds.map((problemId, position) => ({ problemId, position: position + 1 })),
      },
    },
  });
  assignmentId = assignment.id;

  // Watched from before the assignment: a real, trustworthy zero.
  const watched = await makeStudent({
    label: 'watched',
    campus: campusId,
    createdAt: new Date('2026-08-01T00:00:00Z'),
  });
  // Watched, and solved two of the four.
  const solver = await makeStudent({
    label: 'solver',
    campus: campusId,
    createdAt: new Date('2026-08-01T00:00:00Z'),
  });
  // Imported after the assignment: unobservable.
  const late = await makeStudent({
    label: 'late',
    campus: campusId,
    createdAt: new Date(`${IMPORT_DAY}T06:00:00Z`),
  });
  // Imported late *and* carrying one surviving submission inside the window.
  const lateWithEvidence = await makeStudent({
    label: 'late-evidence',
    campus: campusId,
    createdAt: new Date(`${IMPORT_DAY}T06:00:00Z`),
  });
  // Imported late at a different campus: must never appear in this campus's view.
  await makeStudent({
    label: 'late-other-campus',
    campus: otherCampusId,
    createdAt: new Date(`${IMPORT_DAY}T06:00:00Z`),
  });

  await prisma.dailyStatus.createMany({
    data: [
      {
        studentId: watched.id,
        dayKey: PAST_DAY,
        assignmentId,
        campusId,
        assignedCount: 4,
        solvedCount: 0,
        syncStatus: 'OK',
      },
      {
        studentId: solver.id,
        dayKey: PAST_DAY,
        assignmentId,
        campusId,
        assignedCount: 4,
        solvedCount: 2,
        syncStatus: 'OK',
      },
    ],
  });

  // The late student's one surviving accepted submission, plus a duplicate of the same
  // problem — the floor must count distinct problems, not submissions (§9).
  await prisma.submission.createMany({
    data: [
      {
        studentId: lateWithEvidence.id,
        problemId: problemIds[0]!,
        providerSubmissionId: `${RUN}-1`,
        titleSlug: `${RUN}-alpha`,
        title: `${RUN} alpha`,
        status: 'ACCEPTED',
        submittedAt: new Date(`${PAST_DAY}T05:00:00Z`),
        dayKey: PAST_DAY,
      },
      {
        studentId: lateWithEvidence.id,
        problemId: problemIds[0]!,
        providerSubmissionId: `${RUN}-2`,
        titleSlug: `${RUN}-alpha`,
        title: `${RUN} alpha`,
        status: 'ACCEPTED',
        submittedAt: new Date(`${PAST_DAY}T06:00:00Z`),
        dayKey: PAST_DAY,
      },
    ],
  });

  const campuses = new CampusesService(
    prisma as never,
    time,
    noCache,
    new MentorScopeService(prisma as never),
  );
  const batches = new BatchesService(prisma as never, time, noCache);
  const assignments = {
    findAllByDay: async (day: string) => assignmentSummaries(day),
  } as never;

  dashboard = new DashboardService(prisma as never, noCache, time, assignments, campuses, batches);
});

afterAll(async () => {
  const students = await prisma.student.findMany({
    where: { name: { startsWith: RUN } },
    select: { id: true },
  });
  const ids = students.map((s) => s.id);
  await prisma.dailyProblemStatus.deleteMany({
    where: { dailyStatus: { studentId: { in: ids } } },
  });
  await prisma.dailyStatus.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentCampusHistory.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await prisma.assignmentProblem.deleteMany({ where: { assignmentId } });
  await prisma.assignment.deleteMany({ where: { id: assignmentId } });
  await prisma.problem.deleteMany({ where: { id: { in: problemIds } } });
  await prisma.campus.deleteMany({ where: { id: { in: [campusId, otherCampusId] } } });
  await prisma.$disconnect();
});

describe('NOT_OBSERVED is not zero', () => {
  it('keeps unobserved students out of every completion bucket', async () => {
    const view = await dashboard.getMentorDashboard(PAST_DAY, { campusId });
    const bucketed = view.buckets.flatMap((b) => b.students.map((s) => s.name));

    expect(bucketed).toHaveLength(2);
    expect(bucketed.some((n) => n.includes('late'))).toBe(false);
    // The specific regression: the late students must not land in "solved 0" beside the
    // student who genuinely solved nothing.
    const zero = view.buckets.find((b) => b.solvedCount === 0);
    expect(zero?.students.map((s) => s.name)).toEqual([`${RUN} watched`]);
  });

  it('reports them separately, with the day they became observable', async () => {
    const view = await dashboard.getMentorDashboard(PAST_DAY, { campusId });
    const names = view.notObserved.map((r) => r.name).sort();

    expect(names).toEqual([`${RUN} late`, `${RUN} late-evidence`]);
    expect(view.notObserved[0]?.observedFromDayKey).toBe(IMPORT_DAY);
    expect(view.notObserved[0]?.reason).toContain(IMPORT_DAY);
  });

  it('states the denominator and the roster separately', async () => {
    const view = await dashboard.getMentorDashboard(PAST_DAY, { campusId });

    // 2 evaluated of 4 on the roster. Reporting 2 alone reads as the whole cohort;
    // reporting 4 as the denominator invents two students' worth of failure.
    expect(view.totalStudents).toBe(2);
    expect(view.rosterTotal).toBe(4);
    expect(view.notObserved).toHaveLength(2);
    expect(view.totalStudents + view.notObserved.length).toBe(view.rosterTotal);
  });

  it('still counts a genuinely observed result', async () => {
    const view = await dashboard.getMentorDashboard(PAST_DAY, { campusId });
    const two = view.buckets.find((b) => b.solvedCount === 2);

    expect(two?.students.map((s) => s.name)).toEqual([`${RUN} solver`]);
    expect(two?.students[0]?.solvedCount).toBe(2);
  });

  it('reports surviving evidence as a floor, counting a problem once however often it was submitted', async () => {
    const view = await dashboard.getMentorDashboard(PAST_DAY, { campusId });
    const withEvidence = view.notObserved.find((r) => r.name.endsWith('late-evidence'));
    const without = view.notObserved.find((r) => r.name.endsWith('late'));

    // Two accepted submissions, one distinct problem.
    expect(withEvidence?.provenSolvedFloor).toBe(1);
    expect(withEvidence?.assignedCount).toBe(4);
    // No evidence is 0 — which is why it is called a floor and never rendered as a score.
    expect(without?.provenSolvedFloor).toBe(0);
  });

  it('shows the assignment existed even for a day it can report nothing about', async () => {
    const view = await dashboard.getMentorDashboard(PAST_DAY, { campusId });
    const section = view.sections.find((s) => s.campusId === campusId);

    expect(section?.assignedCount).toBe(4);
    expect(section?.notObserved).toHaveLength(2);
    expect(section?.rosterTotal).toBe(4);
  });
});

describe('scoping holds', () => {
  it('never credits a student for another campus’s problem, so the floor cannot exceed what they were set', async () => {
    // The regression, caught against production: the evidence query spans every
    // audience's problems for the day in one round trip, and counting its results
    // directly credited an SRM student for problems only Vels was given — surfacing as
    // "at least 6 of 4". The floor must be intersected with the student's own set.
    const other = await prisma.problem.create({
      data: {
        titleSlug: `${RUN}-vels-only`,
        title: `${RUN} vels only`,
        difficulty: 'EASY',
        url: `https://leetcode.com/problems/${RUN}-vels-only/`,
      },
    });
    const velsAssignment = await prisma.assignment.create({
      data: {
        dayKey: PAST_DAY,
        campusId: otherCampusId,
        isPublished: true,
        problems: { create: [{ problemId: other.id, position: 1 }] },
      },
    });
    const late = await prisma.student.findFirstOrThrow({
      where: { name: `${RUN} late-evidence` },
    });
    await prisma.submission.create({
      data: {
        studentId: late.id,
        problemId: other.id,
        providerSubmissionId: `${RUN}-vels`,
        titleSlug: `${RUN}-vels-only`,
        title: `${RUN} vels only`,
        status: 'ACCEPTED',
        submittedAt: new Date(`${PAST_DAY}T07:00:00Z`),
        dayKey: PAST_DAY,
      },
    });

    try {
      const view = await dashboard.getMentorDashboard(PAST_DAY, { campusId });
      const row = view.notObserved.find((r) => r.name.endsWith('late-evidence'));
      // Still 1: the Vels problem is not one of the four this student was set.
      expect(row?.provenSolvedFloor).toBe(1);
      expect(row?.provenSolvedFloor).toBeLessThanOrEqual(row!.assignedCount);
    } finally {
      await prisma.submission.deleteMany({ where: { providerSubmissionId: `${RUN}-vels` } });
      await prisma.assignmentProblem.deleteMany({ where: { assignmentId: velsAssignment.id } });
      await prisma.assignment.delete({ where: { id: velsAssignment.id } });
      await prisma.problem.delete({ where: { id: other.id } });
    }
  });

  it('never reports another campus’s unobserved students', async () => {
    const view = await dashboard.getMentorDashboard(PAST_DAY, { campusId });
    expect(view.notObserved.some((r) => r.name.includes('other-campus'))).toBe(false);
  });

  it('reports nothing unobserved for a campus with no assignment that day', async () => {
    // The other campus has a late-imported student but no assignment on PAST_DAY. There
    // is nothing unobserved to report: the day simply did not apply to them, exactly as
    // it does not for an observed student.
    const view = await dashboard.getMentorDashboard(PAST_DAY, { campusId: otherCampusId });
    expect(view.notObserved).toHaveLength(0);
  });

  it('treats a day after the import as fully observed', async () => {
    // On the import day itself nobody is unobservable, so the roster and the denominator
    // agree again — the state is a property of the date, not a permanent mark.
    const view = await dashboard.getMentorDashboard(IMPORT_DAY, { campusId });
    expect(view.notObserved).toHaveLength(0);
  });
});
