/**
 * The campus summary counts questions, not student-question pairs.
 *
 * The bug this pins down shipped and was reported from the UI: a week where 98 students
 * each received the same 20 problems said "1,960 questions assigned". The summary was
 * adding up every student's `assignedCount`, so its headline scaled with cohort size —
 * two campuses setting identical work looked ten times apart if one had ten times the
 * students.
 *
 * The fixture is built to make that failure unmissable: 10 students, 4 distinct problems,
 * one of them deliberately set twice in the same week and once again in a later week. The
 * old arithmetic would report 40+ for the week. The right answer is 4.
 *
 * Fixtures live under a unique prefix and are removed in `afterAll`.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertQuestionTotalsReconcile } from '@dsa/shared';

import { CampusAnalysisService } from './campus-analysis.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { CampusesService } from '../campuses/campuses.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import type { RequestUser } from '../../common/decorators';

const prisma = new PrismaClient();
const RUN = `e2e-cq-${Date.now()}`;
const STAMP = Date.now().toString(36).toUpperCase();
const IST = '+05:30';

/** Week 1 = 03–09 Aug (a Monday), Week 2 = 10–16 Aug. */
const FROM = '2099-08-03';
const TO = '2099-08-16';
const ENROLLED = '2099-07-01';
/** Two assignment days inside week 1, one inside week 2. */
const DAY_A = '2099-08-04';
const DAY_B = '2099-08-06';
const DAY_C = '2099-08-11';
const STUDENT_COUNT = 10;

const ist = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00${IST}`);

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const mentorScope = new MentorScopeService(prisma as never);
const cache = { remember: (_key: string, _ttl: number, fn: () => unknown) => fn() } as never;
const service = new CampusAnalysisService(
  prisma as never,
  time,
  mentorScope,
  new CampusesService(prisma as never, time, cache, mentorScope),
);

const admin = { id: '', email: 'a@x.invalid', name: 'A', role: 'ADMIN', studentId: null } as RequestUser;

let campusId: string;
let batchId: string;
const studentIds: string[] = [];
const assignmentIds: string[] = [];
const problems: Record<string, string> = {};

/** Four distinct problems. `repeat` is the one set in two different weeks. */
const SLUGS = ['alpha', 'beta', 'gamma', 'repeat'].map((n) => `${RUN}-${n}`.toLowerCase());

async function assignment(dayKey: string, slugs: string[]): Promise<string> {
  const row = await prisma.assignment.create({
    data: {
      dayKey,
      campusId,
      batchId,
      originalCampusId: campusId,
      originalBatchId: batchId,
      title: `${RUN} ${dayKey}`,
      problems: {
        create: slugs.map((slug, i) => ({ problemId: problems[slug]!, position: i + 1 })),
      },
    },
  });
  assignmentIds.push(row.id);
  return row.id;
}

/**
 * Score one student against one assignment.
 *
 * `solvedSlugs` / `attemptedSlugs` are written as per-problem rows, which is where the
 * question-level outcome is read from.
 */
async function score(
  studentId: string,
  dayKey: string,
  assignmentId: string,
  slugs: string[],
  solvedSlugs: string[],
  attemptedSlugs: string[] = [],
): Promise<void> {
  const status = await prisma.dailyStatus.create({
    data: {
      studentId,
      dayKey,
      assignmentId,
      assignedCount: slugs.length,
      solvedCount: solvedSlugs.length,
      inWindowSolvedCount: 0,
      computedVersion: 2,
    },
  });
  await prisma.dailyProblemStatus.createMany({
    data: slugs.map((slug, i) => ({
      dailyStatusId: status.id,
      problemId: problems[slug]!,
      position: i + 1,
      status: solvedSlugs.includes(slug)
        ? ('ACCEPTED' as const)
        : attemptedSlugs.includes(slug)
          ? ('ATTEMPTED_NOT_ACCEPTED' as const)
          : ('NOT_ATTEMPTED' as const),
    })),
  });
}

beforeAll(async () => {
  campusId = (await prisma.campus.create({ data: { code: `CQ${STAMP}`.slice(0, 10), name: `${RUN} Campus` } })).id;
  batchId = (await prisma.batch.create({ data: { name: `${RUN} A`, code: 'A', campusId } })).id;

  for (const slug of SLUGS) {
    const row = await prisma.problem.create({
      data: { titleSlug: slug, title: slug.toUpperCase(), difficulty: 'EASY', url: `https://leetcode.com/problems/${slug}/` },
    });
    problems[slug] = row.id;
  }

  for (let i = 0; i < STUDENT_COUNT; i += 1) {
    const row = await prisma.student.create({
      data: {
        name: `${RUN} s${i}`,
        email: `${RUN}-s${i}@cq.invalid`,
        leetcodeUsername: `${RUN}-s${i}`,
        campusId,
        batchId,
        status: 'ACTIVE',
        createdAt: ist(ENROLLED, '09:00'),
        campusHistory: { create: { toCampusId: campusId, effectiveFromDayKey: ENROLLED, source: 'MIGRATION' } },
        batchHistory: { create: { toBatchId: batchId, effectiveFromDayKey: ENROLLED, source: 'MIGRATION' } },
        syncState: { create: { status: 'OK', lastSyncedAt: ist(TO, '08:00') } },
      },
    });
    studentIds.push(row.id);
  }

  const [alpha, beta, gamma, repeat] = SLUGS as [string, string, string, string];

  // Week 1, day A: alpha + beta. Day B: gamma + repeat. Week 2, day C: repeat again.
  const a = await assignment(DAY_A, [alpha, beta]);
  const b = await assignment(DAY_B, [gamma, repeat]);
  const c = await assignment(DAY_C, [repeat]);

  for (const [i, studentId] of studentIds.entries()) {
    // alpha: solved by three students. beta: nobody solves, two attempt it.
    await score(studentId, DAY_A, a, [alpha, beta], i < 3 ? [alpha] : [], i < 2 ? [beta] : []);
    // gamma: nobody touches it at all. repeat: one student solves it in week 1.
    await score(studentId, DAY_B, b, [gamma, repeat], i < 1 ? [repeat] : []);
    // Week 2: the same problem again, solved by nobody this time.
    await score(studentId, DAY_C, c, [repeat], []);
  }
});

afterAll(async () => {
  await prisma.dailyProblemStatus.deleteMany({ where: { dailyStatus: { studentId: { in: studentIds } } } });
  await prisma.dailyStatus.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.assignmentProblem.deleteMany({ where: { assignmentId: { in: assignmentIds } } });
  await prisma.assignment.deleteMany({ where: { id: { in: assignmentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.problem.deleteMany({ where: { id: { in: Object.values(problems) } } });
  await prisma.batch.deleteMany({ where: { campusId } });
  await prisma.campus.delete({ where: { id: campusId } });
  await prisma.$disconnect();
});

const period = { from: FROM, to: TO };
const summary = async () => {
  const result = await service.summary(admin, { ...period, campusId });
  return result.campuses.find((c) => c.campusId === campusId)!;
};

describe('campus questions are counted once, however many students received them', () => {
  it('reports distinct problems for the week, not students x questions', async () => {
    const week1 = (await summary()).weeks.find((w) => w.weekNumber === 1)!;
    // Ten students each received four problem slots across two days. The old summary
    // reported 40; the answer is the four distinct problems.
    expect(week1.assigned).toBe(4);
    expect(week1.assigned).not.toBe(4 * STUDENT_COUNT);
  });

  it('does not change when the cohort grows', async () => {
    const before = (await summary()).weeks.find((w) => w.weekNumber === 1)!.assigned;

    const extra = await prisma.student.create({
      data: {
        name: `${RUN} extra`,
        email: `${RUN}-extra@cq.invalid`,
        leetcodeUsername: `${RUN}-extra`,
        campusId,
        batchId,
        status: 'ACTIVE',
        createdAt: ist(ENROLLED, '09:00'),
        campusHistory: { create: { toCampusId: campusId, effectiveFromDayKey: ENROLLED, source: 'MIGRATION' } },
        batchHistory: { create: { toBatchId: batchId, effectiveFromDayKey: ENROLLED, source: 'MIGRATION' } },
        syncState: { create: { status: 'OK' } },
      },
    });
    studentIds.push(extra.id);
    const assignments = await prisma.assignment.findMany({ where: { id: { in: assignmentIds } }, include: { problems: true } });
    for (const a of assignments) {
      await score(
        extra.id,
        a.dayKey,
        a.id,
        SLUGS.filter((s) => a.problems.some((p) => p.problemId === problems[s])),
        [],
      );
    }

    expect((await summary()).weeks.find((w) => w.weekNumber === 1)!.assigned).toBe(before);
  });

  it('counts outcomes per student x question, not per question', async () => {
    // 11 students x 4 questions. Before 2026-09-25 a question was "attempted, not solved"
    // only if *nobody* had solved it, which hid every failing student at a real campus.
    const week1 = (await summary()).weeks.find((w) => w.weekNumber === 1)!;
    expect(week1.studentQuestions).toBe(44);
    expect(week1.solved).toBe(4); // alpha x3, repeat x1
    expect(week1.attemptedNotSolved).toBe(2); // beta x2
    expect(week1.notAttempted).toBe(38);
    expect(week1.noData).toBe(0);
    // The question-level "did anyone solve it" figure is still there, still ever-solved.
    expect(week1.questionsSolved).toBe(2);
  });

  it('holds solved + attempted + not attempted + no data = student x question pairs, every week', async () => {
    for (const week of (await summary()).weeks) {
      expect(assertQuestionTotalsReconcile(week), `week ${week.weekNumber}`).toBeNull();
    }
  });

  it('counts a problem set in two weeks once per week and once for the period', async () => {
    const campus = await summary();
    expect(campus.weeks.find((w) => w.weekNumber === 1)!.assigned).toBe(4);
    expect(campus.weeks.find((w) => w.weekNumber === 2)!.assigned).toBe(1);
    // Four distinct problems over the period, not five: `repeat` appears in both weeks.
    expect(campus.assigned).toBe(4);
  });

  it('treats a question solved in any week as solved for the period', async () => {
    const campus = await summary();
    // `repeat` went unsolved in week 2 but was solved in week 1.
    expect(campus.weeks.find((w) => w.weekNumber === 2)!.questionsSolved).toBe(0);
    expect(campus.questionsSolved).toBe(2);
    // Pair outcomes add each week's pairs: week 1's four, week 2's none.
    expect(campus.solved).toBe(4);
  });

  it('keeps the student completion rate, which the question counts cannot express', async () => {
    const week1 = (await summary()).weeks.find((w) => w.weekNumber === 1)!;
    // Two of four questions were solved by somebody — but hardly anybody solved them, and
    // the solve rate now says so directly.
    expect(week1.questionsSolved / week1.assigned).toBe(0.5);
    expect(week1.solvePercent).toBeCloseTo(4 / 44);
    expect(week1.studentCompletionPercent).toBeLessThan(0.15);
  });

  it('reports percentages that sum to one across the three outcomes', async () => {
    const week1 = (await summary()).weeks.find((w) => w.weekNumber === 1)!;
    expect(week1.attemptPercent).toBeCloseTo(6 / 44);
    expect((week1.attemptPercent ?? 0) + (week1.notAttemptedPercent ?? 0)).toBeCloseTo(1);
  });
});

describe('the question drill-down', () => {
  it('lists one row per distinct problem with its student counts', async () => {
    const detail = await service.questions(admin, campusId, { ...period, weekNumber: 1 });
    expect(detail.questions).toHaveLength(4);
    expect(detail.totals.assigned).toBe(4);

    const alpha = detail.questions.find((q) => q.slug.endsWith('-alpha'))!;
    expect(alpha.studentsSolved).toBe(3);
    expect(alpha.outcome).toBe('SOLVED');

    const beta = detail.questions.find((q) => q.slug.endsWith('-beta'))!;
    expect(beta.studentsSolved).toBe(0);
    expect(beta.studentsAttemptedNotSolved).toBe(2);
    expect(beta.outcome).toBe('ATTEMPTED_NOT_SOLVED');

    const gamma = detail.questions.find((q) => q.slug.endsWith('-gamma'))!;
    expect(gamma.outcome).toBe('NOT_ATTEMPTED');
    expect(gamma.studentsNotAttempted).toBe(gamma.studentsAssigned);
  });

  it('agrees with the campus card it opens', async () => {
    const campus = await summary();
    for (const week of campus.weeks) {
      const detail = await service.questions(admin, campusId, { ...period, weekNumber: week.weekNumber });
      expect(detail.questions.length, `week ${week.weekNumber}`).toBe(week.assigned);
      expect(detail.totals.solved).toBe(week.solved);
    }
  });
});
