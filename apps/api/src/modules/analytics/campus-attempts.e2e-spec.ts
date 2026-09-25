/**
 * `CampusAttemptsService` against a real database — Campus Analysis -> Attempts Analysis —
 * plus the weekly Campus Analysis outcome counts it exposed as broken.
 *
 * Pinned here: attempts are the mirrored submissions to an *assigned* problem from its
 * assignment day until the same problem is next assigned to the student, de-duplicated
 * by LeetCode id; failed attempts stop at the first AC; a student with no readable
 * LeetCode data is "no data", never "not attempted"; every filter narrows the same rows
 * (and a date filter never shortens a period); the drill-down and all three Excel
 * exports are the same rows as the page; excluded campuses, archived students and
 * Infosys work never appear; and reading any of it changes no stored figure.
 */

import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { assertQuestionTotalsReconcile } from '@dsa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CampusAnalysisService } from './campus-analysis.service';
import { CampusAttemptsService } from './campus-attempts.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { CampusesService } from '../campuses/campuses.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import type { RequestUser } from '../../common/decorators';

const prisma = new PrismaClient();
const RUN = `e2e-catt-${Date.now()}`;
const STAMP = Date.now().toString(36).toUpperCase();

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const mentorScope = new MentorScopeService(prisma as never);
const cache = { remember: (_key: string, _ttl: number, fn: () => unknown) => fn() } as never;
const campusesService = new CampusesService(prisma as never, time, cache, mentorScope);
const campusAnalysis = new CampusAnalysisService(prisma as never, time, mentorScope, campusesService);
const service = new CampusAttemptsService(prisma as never, time, campusAnalysis);

const admin: RequestUser = { id: '', email: 'a@x.invalid', name: 'Admin', role: 'ADMIN', studentId: null } as RequestUser;

// Friday, Saturday, Sunday: one Monday-based analysis week.
const D1 = '2097-05-10';
const D2 = '2097-05-11';
const D3 = '2097-05-12';
const BEFORE = '2097-05-09';

type Ever = 'ACCEPTED' | 'ATTEMPTED_NOT_ACCEPTED' | 'NOT_ATTEMPTED';

const ids = {
  campusA: '', campusB: '', campusX: '',
  batchAF: '', batchAI: '', batchBF: '',
  squad1: '', squad2: '',
  one: '', five: '', bee: '', nod: '', zed: '',
  infosysAssignment: '',
};
const problems: Record<string, string> = {};
const assignments: string[] = [];
let submissionSeq = 9_000_000_000;

const slug = (key: string) => `${RUN}-${key}`.toLowerCase();
const short = (s: string) => s.slice(RUN.length + 1);

async function problem(key: string, difficulty: 'EASY' | 'MEDIUM' | 'HARD'): Promise<void> {
  const p = await prisma.problem.create({
    data: { titleSlug: slug(key), title: `${RUN} ${key}`, difficulty, url: `https://leetcode.com/problems/${slug(key)}/` },
  });
  problems[key] = p.id;
}

async function assignment(dayKey: string, campusId: string, batchId: string | null, keys: string[]): Promise<string> {
  const a = await prisma.assignment.create({
    data: {
      dayKey, campusId, batchId, originalCampusId: campusId, originalBatchId: batchId,
      problems: { create: keys.map((k, i) => ({ problemId: problems[k]!, position: i + 1 })) },
    },
  });
  assignments.push(a.id);
  return a.id;
}

/** A DailyStatus as the rollup would write it; `ever` is the ever-based per-problem status. */
async function scoreDay(studentId: string, dayKey: string, assignmentId: string, ever: Record<string, Ever> = {}): Promise<void> {
  const links = await prisma.assignmentProblem.findMany({ where: { assignmentId }, include: { problem: true } });
  const status = await prisma.dailyStatus.create({
    data: { studentId, dayKey, assignmentId, assignedCount: links.length, solvedCount: 0, inWindowSolvedCount: 0, computedVersion: 2 },
  });
  await prisma.dailyProblemStatus.createMany({
    data: links.map((l) => ({
      dailyStatusId: status.id,
      problemId: l.problemId,
      position: l.position,
      status: ever[short(l.problem.title)] ?? 'NOT_ATTEMPTED',
    })),
  });
}

async function submit(studentId: string, key: string, dayKey: string, times: [string, 'AC' | 'WA'][]): Promise<void> {
  await prisma.submission.createMany({
    data: times.map(([t, verdict]) => {
      const submittedAt = new Date(`${dayKey}T${t}:00+05:30`);
      return {
        studentId,
        problemId: problems[key] ?? null,
        providerSubmissionId: String(submissionSeq++),
        titleSlug: slug(key),
        title: `${RUN} ${key}`,
        status: verdict === 'AC' ? ('ACCEPTED' as const) : ('ATTEMPTED_NOT_ACCEPTED' as const),
        language: 'python3',
        submittedAt,
        dayKey: time.dayKeyOf(submittedAt),
      };
    }),
  });
}

const wa = (n: number, from = 9): [string, 'WA'][] =>
  Array.from({ length: n }, (_, i) => [`${String(from + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}`, 'WA']);

const studentsOf = () => [ids.one, ids.five, ids.bee, ids.nod, ids.zed];
const ours = <T extends { studentId: string }>(rows: T[]) => rows.filter((r) => studentsOf().includes(r.studentId));

beforeAll(async () => {
  const [a, b, x] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} A`, code: `AA${STAMP}`.slice(0, 10) } }),
    prisma.campus.create({ data: { name: `${RUN} B`, code: `BB${STAMP}`.slice(0, 10) } }),
    prisma.campus.create({ data: { name: `${RUN} X`, code: `XX${STAMP}`.slice(0, 10) } }),
  ]);
  ids.campusA = a.id; ids.campusB = b.id; ids.campusX = x.id;

  ids.batchAF = (await prisma.batch.create({ data: { name: `${RUN} Foundation`, code: 'F', campusId: a.id } })).id;
  ids.batchAI = (await prisma.batch.create({ data: { name: `${RUN} Intermediate`, code: 'I', campusId: a.id } })).id;
  ids.batchBF = (await prisma.batch.create({ data: { name: `${RUN} B Foundation`, code: 'F', campusId: b.id } })).id;
  ids.squad1 = (await prisma.squad.create({ data: { name: `${RUN} Squad 1`, campusId: a.id } })).id;
  ids.squad2 = (await prisma.squad.create({ data: { name: `${RUN} Squad 2`, campusId: a.id } })).id;

  await problem('p1', 'EASY');
  await problem('p2', 'MEDIUM');
  await problem('p3', 'HARD');
  await problem('late', 'EASY');
  await problem('p4', 'EASY');
  await problem('p5', 'MEDIUM');
  await problem('unassigned', 'EASY');
  await problem('infosys', 'EASY');
  await problem('xonly', 'EASY');

  const student = (key: string, campusId: string, batchId: string | null, squadId: string | null, options: { status?: 'ACTIVE' | 'ARCHIVED'; handle?: boolean } = {}) =>
    prisma.student.create({
      data: {
        name: `${RUN} ${key}`,
        email: `${RUN}-${key}@catt.invalid`,
        leetcodeUsername: options.handle === false ? null : `${RUN}-${key}`,
        campusId, batchId, squadId,
        status: options.status ?? 'ACTIVE',
        createdAt: new Date('2097-01-01T00:00:00Z'),
        syncState: { create: { status: options.handle === false ? 'PROFILE_MISSING' : 'OK' } },
      },
    });
  ids.one = (await student('One', a.id, ids.batchAF, ids.squad1)).id;
  ids.five = (await student('Five', a.id, ids.batchAI, ids.squad2)).id;
  ids.nod = (await student('Nod', a.id, ids.batchAF, null, { handle: false })).id;
  ids.bee = (await student('Bee', b.id, ids.batchBF, null)).id;
  // Archived, in a campus with no active student or batch — an excluded campus.
  ids.zed = (await student('Zed', x.id, null, null, { status: 'ARCHIVED' })).id;

  const aD1 = await assignment(D1, a.id, null, ['p1', 'p2', 'p3', 'late']); // whole campus A
  const aD2 = await assignment(D2, a.id, ids.batchAF, ['p4']); // Foundation only
  const aD3 = await assignment(D3, a.id, null, ['p1']); // p1 set again: D1's period for p1 ends on D2
  const bD1 = await assignment(D1, b.id, null, ['p5']);
  const xD1 = await assignment(D1, x.id, null, ['xonly']);

  // One ------------------------------------------------------------------------------
  await scoreDay(ids.one, D1, aD1, { p1: 'ACCEPTED', p2: 'ACCEPTED', late: 'ACCEPTED' });
  await submit(ids.one, 'p1', BEFORE, [['20:00', 'AC']]); // before any period
  await submit(ids.one, 'p1', D1, [['10:12', 'WA']]);
  await submit(ids.one, 'p2', D1, [['09:10', 'WA'], ['09:20', 'WA'], ['09:30', 'WA'], ['15:30', 'AC'], ['16:00', 'WA'], ['16:10', 'WA']]);
  // P3: nothing. `late`: nothing on D1, a failure and a solve the next day.
  await submit(ids.one, 'late', D2, [['11:00', 'WA'], ['11:30', 'AC']]);
  await submit(ids.one, 'unassigned', D1, wa(5)); // never shows
  await scoreDay(ids.one, D2, aD2, { p4: 'ATTEMPTED_NOT_ACCEPTED' });
  await submit(ids.one, 'p4', D2, wa(5));
  await scoreDay(ids.one, D3, aD3, { p1: 'ACCEPTED' }); // nothing new: solved before this period

  // Five (Intermediate, not given D2) ---------------------------------------------------
  await scoreDay(ids.five, D1, aD1, { p1: 'ACCEPTED', p2: 'ATTEMPTED_NOT_ACCEPTED', p3: 'ACCEPTED' });
  await submit(ids.five, 'p1', D1, wa(5));
  await submit(ids.five, 'p2', D1, wa(10, 12));
  await submit(ids.five, 'p3', D1, [['18:00', 'AC']]);
  await submit(ids.five, 'p4', D2, wa(3)); // never assigned to Five
  await scoreDay(ids.five, D3, aD3, { p1: 'ACCEPTED' });
  await submit(ids.five, 'p1', D3, [['10:00', 'WA'], ['10:30', 'AC'], ['10:40', 'AC']]);

  // Nod: no LeetCode handle at all — no evidence is not a zero.
  await scoreDay(ids.nod, D1, aD1);

  // Bee (campus B), plus Infosys work on the same day that must never be mixed in.
  await scoreDay(ids.bee, D1, bD1, { p5: 'ATTEMPTED_NOT_ACCEPTED' });
  await submit(ids.bee, 'p5', D1, wa(2));
  ids.infosysAssignment = (
    await prisma.infosysAssignment.create({
      data: { dayKey: D1, problems: { create: [{ problemId: problems.infosys!, position: 1 }] } },
    })
  ).id;
  await submit(ids.bee, 'infosys', D1, wa(4));

  // Zed: archived, excluded campus, plenty of failed attempts.
  await scoreDay(ids.zed, D1, xD1, { xonly: 'ATTEMPTED_NOT_ACCEPTED' });
  await submit(ids.zed, 'xonly', D1, wa(7));
});

afterAll(async () => {
  const students = studentsOf();
  await prisma.submission.deleteMany({ where: { studentId: { in: students } } });
  await prisma.dailyProblemStatus.deleteMany({ where: { dailyStatus: { studentId: { in: students } } } });
  await prisma.dailyStatus.deleteMany({ where: { studentId: { in: students } } });
  await prisma.infosysAssignment.deleteMany({ where: { id: ids.infosysAssignment } });
  await prisma.assignment.deleteMany({ where: { id: { in: assignments } } });
  await prisma.problem.deleteMany({ where: { id: { in: Object.values(problems) } } });
  await prisma.student.deleteMany({ where: { id: { in: students } } });
  await prisma.squad.deleteMany({ where: { id: { in: [ids.squad1, ids.squad2] } } });
  await prisma.batch.deleteMany({ where: { id: { in: [ids.batchAF, ids.batchAI, ids.batchBF] } } });
  await prisma.campus.deleteMany({ where: { id: { in: [ids.campusA, ids.campusB, ids.campusX] } } });
  await prisma.$disconnect();
});

const row = async (studentId: string, key: string, dayKey = D1) => {
  const all = await service.analysis(admin, { view: 'ALL' });
  return all.rows.find((x) => x.studentId === studentId && x.titleSlug === slug(key) && x.dayKey === dayKey);
};

describe('attempt counting', () => {
  it('A. zero submissions, never solved: Not Attempted', async () => {
    expect(await row(ids.one, 'p3')).toMatchObject({
      outcome: 'NOT_ATTEMPTED', attempts: 0, failedAttempts: 0, firstAttemptAt: null, firstAcceptedAt: null, lastAttemptAt: null,
    });
  });

  it('B. one failed, no accepted in the period (an earlier AC is outside it): Attempted But Not Solved', async () => {
    expect(await row(ids.one, 'p1')).toMatchObject({ outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 1, failedAttempts: 1, solved: false, firstAcceptedAt: null });
  });

  it('C. five and ten failed: failedAttempts = attempts', async () => {
    expect(await row(ids.five, 'p1')).toMatchObject({ outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 5, failedAttempts: 5 });
    expect(await row(ids.five, 'p2')).toMatchObject({ outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 10, failedAttempts: 10 });
    expect(await row(ids.one, 'p4', D2)).toMatchObject({ attempts: 5, failedAttempts: 5 });
  });

  it('E. three failed, accepted, two more failed: 6 attempts, 3 failed before solving', async () => {
    const r = await row(ids.one, 'p2');
    expect(r).toMatchObject({ outcome: 'SOLVED_AFTER_ATTEMPTS', attempts: 6, solved: true, failedAttempts: 3 });
    expect(r!.firstAttemptAt).toBe(new Date(`${D1}T09:10:00+05:30`).toISOString());
    expect(r!.firstAcceptedAt).toBe(new Date(`${D1}T15:30:00+05:30`).toISOString());
    expect(r!.lastAttemptAt).toBe(new Date(`${D1}T16:10:00+05:30`).toISOString());
  });

  it('D. a failure and a solve on the day after the assignment still belong to it', async () => {
    expect(await row(ids.one, 'late')).toMatchObject({ outcome: 'SOLVED_AFTER_ATTEMPTS', attempts: 2, failedAttempts: 1, windowEndDayKey: null });
  });

  it('F + H. re-assignment splits the periods: failed, accepted, accepted on D3 is its own row', async () => {
    expect(await row(ids.five, 'p1', D3)).toMatchObject({ outcome: 'SOLVED_AFTER_ATTEMPTS', attempts: 3, failedAttempts: 1 });
    expect(await row(ids.five, 'p1', D1)).toMatchObject({ attempts: 5, windowEndDayKey: D2 });
  });

  it('solved on the first try, and solved before the assignment, are their own outcomes', async () => {
    expect(await row(ids.five, 'p3')).toMatchObject({ outcome: 'SOLVED_FIRST_ATTEMPT', attempts: 1, failedAttempts: 0 });
    expect(await row(ids.one, 'p1', D3)).toMatchObject({ outcome: 'SOLVED_BEFORE_ASSIGNMENT', attempts: 0 });
  });

  it('J. a student with no readable LeetCode data is No Data, never Not Attempted', async () => {
    const all = await service.analysis(admin, { view: 'ALL', campusId: ids.campusA });
    const nod = all.rows.filter((r) => r.studentId === ids.nod);
    expect(nod).toHaveLength(4);
    expect(nod.every((r) => r.outcome === 'NO_DATA')).toBe(true);
    const na = await service.analysis(admin, { view: 'NOT_ATTEMPTED', campusId: ids.campusA });
    expect(na.rows.some((r) => r.studentId === ids.nod)).toBe(false);
  });

  it('I. unassigned problems never appear, even with submissions', async () => {
    const all = await service.analysis(admin, { view: 'ALL' });
    expect(all.rows.some((r) => r.titleSlug === slug('unassigned'))).toBe(false);
    expect(all.rows.some((r) => r.studentId === ids.five && r.titleSlug === slug('p4'))).toBe(false);
  });

  it('G. a duplicate mirrored submission cannot be stored, so it cannot be counted twice', async () => {
    const existing = await prisma.submission.findFirstOrThrow({ where: { studentId: ids.five, titleSlug: slug('p2') } });
    const { id: _id, createdAt: _c, ...copy } = existing;
    await expect(prisma.submission.create({ data: copy })).rejects.toThrow();
    expect((await row(ids.five, 'p2'))!.attempts).toBe(10);
  });

  it('Infosys work is never mixed in', async () => {
    const all = await service.analysis(admin, { view: 'ALL' });
    expect(all.rows.some((r) => r.titleSlug === slug('infosys'))).toBe(false);
    expect(ours(all.rows).filter((r) => r.studentId === ids.bee).map((r) => r.titleSlug)).toEqual([slug('p5')]);
  });

  it('excluded campuses and archived students never appear, and the campus itself is refused', async () => {
    for (const view of ['ALL', 'NOT_ATTEMPTED', 'ATTEMPTED_NOT_SOLVED'] as const) {
      const r = await service.analysis(admin, { view });
      expect(r.rows.some((x) => x.studentId === ids.zed || x.titleSlug === slug('xonly'))).toBe(false);
    }
    await expect(service.analysis(admin, { campusId: ids.campusX })).rejects.toThrow();
    await expect(service.student(admin, ids.zed)).rejects.toThrow();
  });
});

describe('views, filters and order', () => {
  it('defaults to Attempted But Not Solved, sorted failed desc, attempts desc, name asc', async () => {
    const r = ours((await service.analysis(admin, {})).rows);
    expect(r.map((x) => [short(x.name), short(x.titleSlug), x.failedAttempts])).toEqual([
      ['Five', 'p2', 10],
      ['Five', 'p1', 5],
      ['One', 'p4', 5],
      ['Bee', 'p5', 2],
      ['One', 'p1', 1],
    ]);
  });

  it('Solved After Attempts and the Multiple Attempts To Solve filter are the same rows', async () => {
    const saa = ours((await service.analysis(admin, { view: 'SOLVED_AFTER_ATTEMPTS' })).rows);
    expect(saa.map((x) => [short(x.name), short(x.titleSlug), x.dayKey])).toEqual([
      ['One', 'p2', D1],
      ['Five', 'p1', D3],
      ['One', 'late', D1],
    ]);
    const multiple = ours((await service.analysis(admin, { view: 'ALL', multipleAttempts: true })).rows);
    expect(multiple).toEqual(saa);
    expect(multiple.every((x) => x.solved && x.attempts >= 2 && x.failedAttempts >= 1)).toBe(true);
  });

  it('campus filter', async () => {
    const b = await service.analysis(admin, { campusId: ids.campusB, view: 'ALL' });
    expect(ours(b.rows).map((x) => x.studentId)).toEqual([ids.bee]);
    const a = await service.analysis(admin, { campusId: ids.campusA, view: 'ALL' });
    expect(new Set(a.rows.map((x) => x.studentId))).toEqual(new Set([ids.one, ids.five, ids.nod]));
  });

  it('batch and squad filters', async () => {
    const batch = await service.analysis(admin, { campusId: ids.campusA, batch: `${RUN} Intermediate`, view: 'ALL' });
    expect(new Set(batch.rows.map((x) => x.studentId))).toEqual(new Set([ids.five]));
    const squad = await service.analysis(admin, { campusId: ids.campusA, squad: `${RUN} Squad 1`, view: 'ALL' });
    expect(new Set(squad.rows.map((x) => x.studentId))).toEqual(new Set([ids.one]));
  });

  it('date filter narrows rows but never shortens a period', async () => {
    const d2 = await service.analysis(admin, { campusId: ids.campusA, from: D2, to: D2, view: 'ALL' });
    expect(d2.rows.map((x) => [x.studentId, short(x.titleSlug)])).toEqual([[ids.one, 'p4']]);
    const d1 = await service.analysis(admin, { campusId: ids.campusA, from: D1, to: D1, view: 'ALL' });
    expect(d1.rows.every((x) => x.dayKey === D1)).toBe(true);
    expect(d1.rows.find((x) => x.studentId === ids.one && x.titleSlug === slug('late'))).toMatchObject({ attempts: 2, failedAttempts: 1 });
  });

  it('problem and difficulty filters', async () => {
    const p = await service.analysis(admin, { campusId: ids.campusA, problem: slug('p1'), view: 'ALL' });
    expect(p.rows).toHaveLength(5);
    expect(p.rows.every((x) => x.titleSlug === slug('p1'))).toBe(true);
    expect(p.problems.map((x) => x.titleSlug)).toEqual(expect.arrayContaining([slug('p2'), slug('p4')]));
    const hard = await service.analysis(admin, { campusId: ids.campusA, difficulty: 'HARD', view: 'ALL' });
    expect(hard.rows.map((x) => short(x.titleSlug))).toEqual(['p3', 'p3', 'p3']);
  });

  it('minimum attempts', async () => {
    expect(ours((await service.analysis(admin, { minAttempts: 5 })).rows).map((x) => x.failedAttempts)).toEqual([10, 5, 5]);
    expect(ours((await service.analysis(admin, { minAttempts: 10 })).rows).map((x) => [x.studentId, short(x.titleSlug)])).toEqual([
      [ids.five, 'p2'],
    ]);
  });

  it('outcome combines with campus and date', async () => {
    const r = await service.analysis(admin, { campusId: ids.campusA, from: D1, to: D1, view: 'ATTEMPTED_NOT_SOLVED' });
    expect(r.rows.map((x) => [short(x.name), short(x.titleSlug)])).toEqual([
      ['Five', 'p2'],
      ['Five', 'p1'],
      ['One', 'p1'],
    ]);
    const na = await service.analysis(admin, { campusId: ids.campusA, view: 'NOT_ATTEMPTED' });
    expect(na.rows.map((x) => [short(x.name), short(x.titleSlug)])).toEqual([
      ['Five', 'late'],
      ['One', 'p3'],
    ]);
  });

  it('summary is over the dimension-filtered rows, not the view', async () => {
    const r = await service.analysis(admin, { campusId: ids.campusA, view: 'SOLVED_FIRST_ATTEMPT' });
    expect(r.summary).toEqual({
      attemptedNotSolved: 4,
      studentsAttemptedNotSolved: 2,
      assignedProblemsAttempted: 8,
      totalFailedAttempts: 1 + 3 + 1 + 5 + 5 + 10 + 0 + 1,
      solvedAfterMultipleAttempts: 3,
      problemsWith2PlusAttempts: 6,
      problemsWith3PlusAttempts: 5,
      problemsWith5PlusAttempts: 4,
    });
  });
});

describe('drill-down and export', () => {
  it('the drill-down is the table rows for that student, with stats and the submissions behind them', async () => {
    const table = (await service.analysis(admin, { view: 'ALL' })).rows.filter((x) => x.studentId === ids.one);
    const drill = await service.student(admin, ids.one);
    const strip = ({ submissions: _s, ...rest }: (typeof drill.rows)[number]) => rest;
    expect(drill.rows.map(strip)).toEqual(table);
    expect(drill.stats).toEqual({
      assignedProblems: 6,
      attempted: 4,
      solved: 2,
      attemptedNotSolved: 2,
      solvedAfterAttempts: 2,
      totalAttempts: 14,
      totalFailedAttempts: 10,
      averageAttemptsPerSolvedProblem: 4,
    });
    const p2 = drill.rows.find((x) => x.titleSlug === slug('p2'))!;
    expect(p2.submissions.map((s) => s.status)).toEqual([
      'ATTEMPTED_NOT_ACCEPTED', 'ATTEMPTED_NOT_ACCEPTED', 'ATTEMPTED_NOT_ACCEPTED', 'ACCEPTED', 'ATTEMPTED_NOT_ACCEPTED', 'ATTEMPTED_NOT_ACCEPTED',
    ]);
    expect(p2.submissions.every((s) => s.language === 'python3' && /^\d+$/.test(s.providerSubmissionId))).toBe(true);
    expect(drill.student.leetcodeUrl).toBe(`https://leetcode.com/u/${RUN}-One/`);
  });

  const load = async (buffer: Buffer, sheetName: string) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    return workbook.getWorksheet(sheetName)!;
  };
  const HEADERS = [
    'Student', 'Campus', 'Batch', 'Squad', 'Problem', 'Difficulty', 'Assignment Date',
    'Attempts', 'Failed Attempts', 'First Attempt', 'First Accepted', 'Last Attempt', 'Outcome',
  ];

  it('the Excel export is the page, row for row, in the same order', async () => {
    const filters = { campusId: ids.campusA, view: 'ALL' as const };
    const page = await service.analysis(admin, filters);
    const sheet = await load(await service.buildWorkbook(admin, filters), 'Attempts Analysis');
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(HEADERS);
    expect(sheet.rowCount).toBe(page.rows.length + 1);
    page.rows.forEach((r, i) => {
      const x = sheet.getRow(i + 2);
      expect([x.getCell(1).value, x.getCell(5).value, x.getCell(8).value, x.getCell(9).value]).toEqual([r.name, r.title, r.attempts, r.failedAttempts]);
    });
    const p2 = page.rows.findIndex((r) => r.studentId === ids.one && r.titleSlug === slug('p2'));
    expect([7, 10, 11, 12, 13].map((c) => sheet.getRow(p2 + 2).getCell(c).value)).toEqual([
      '10 May 2097', '10 May 2097 09:10', '10 May 2097 15:30', '10 May 2097 16:10', 'Solved After Attempts',
    ]);
  });

  it('Export Unsolved Attempts and Export Multiple Attempts are exactly those views', async () => {
    const base = { campusId: ids.campusA, view: 'SOLVED_FIRST_ATTEMPT' as const };
    const unsolved = await load(await service.buildWorkbook(admin, base, 'unsolved'), 'Unsolved Attempts');
    const unsolvedRows = (await service.analysis(admin, { ...base, view: 'ATTEMPTED_NOT_SOLVED' })).rows;
    expect(unsolved.rowCount).toBe(unsolvedRows.length + 1);
    unsolvedRows.forEach((r, i) => expect(unsolved.getRow(i + 2).getCell(9).value).toBe(r.failedAttempts));

    const multiple = await load(await service.buildWorkbook(admin, base, 'multiple'), 'Multiple Attempts');
    const multipleRows = (await service.analysis(admin, { ...base, view: 'ALL', multipleAttempts: true })).rows;
    expect(multiple.rowCount).toBe(multipleRows.length + 1);
    multipleRows.forEach((r, i) => expect(multiple.getRow(i + 2).getCell(13).value).toBe('Solved After Attempts'));
  });
});

describe('weekly Campus Analysis outcome counts', () => {
  it('count student x question outcomes, so attempted-not-solved is not hidden by one solver', async () => {
    const { campuses } = await campusAnalysis.summary(admin, { campusId: ids.campusA, from: D1, to: D3 });
    const campus = campuses[0]!;
    const week = campus.weeks.find((w) => w.assigned > 0)!;
    // Five distinct questions — never students x questions.
    expect(week.assigned).toBe(5);
    expect(week).toMatchObject({
      studentQuestions: 13,
      solved: 5,
      attemptedNotSolved: 2,
      notAttempted: 2,
      noData: 4,
    });
    expect(week.solvePercent).toBeCloseTo(5 / 9);
    expect(week.attemptPercent).toBeCloseTo(7 / 9);
    expect(assertQuestionTotalsReconcile(week)).toBeNull();
    // Questions anyone solved stays question-level and ever-solved.
    expect(week.questionsSolved).toBe(4);
  });
});

describe('mentor scoping', () => {
  it('a mentor granted campus B sees only campus B, and campus A is not found', async () => {
    const user = await prisma.user.create({
      data: {
        email: `${RUN}-mentor@catt.invalid`,
        name: 'B mentor',
        role: 'MENTOR',
        passwordHash: 'x',
        mentorCampuses: { create: { campusId: ids.campusB } },
      },
    });
    try {
      const mentor = { id: user.id, email: user.email, name: user.name, role: 'MENTOR', studentId: null } as RequestUser;
      const r = await service.analysis(mentor, { view: 'ALL' });
      expect(new Set(r.rows.map((x) => x.studentId))).toEqual(new Set([ids.bee]));
      await expect(service.analysis(mentor, { campusId: ids.campusA })).rejects.toThrow();
      await expect(service.student(mentor, ids.one)).rejects.toThrow();
      await expect(service.buildWorkbook(mentor, { campusId: ids.campusA })).rejects.toThrow();
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

describe('historical Coding-Hours data', () => {
  it('reading and exporting changes no stored figure', async () => {
    const snapshot = () =>
      prisma.dailyStatus.findMany({
        where: { studentId: { in: [ids.one, ids.five, ids.bee, ids.nod] } },
        orderBy: [{ studentId: 'asc' }, { dayKey: 'asc' }],
        include: { problemStatuses: { orderBy: { position: 'asc' } } },
      });
    const before = await snapshot();
    await service.analysis(admin, { view: 'ALL' });
    await service.student(admin, ids.one);
    await service.buildWorkbook(admin, {}, 'multiple');
    await campusAnalysis.summary(admin, { campusId: ids.campusA, from: D1, to: D3 });
    expect(await snapshot()).toEqual(before);
  });
});
