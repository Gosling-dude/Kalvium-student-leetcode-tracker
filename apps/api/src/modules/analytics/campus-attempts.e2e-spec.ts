/**
 * `CampusAttemptsService` against a real database — Campus Analysis -> Attempts Analysis.
 *
 * What is pinned here: attempts are the mirrored submissions to an *assigned* problem on
 * its assignment day, de-duplicated by LeetCode id; failed attempts stop at the first AC;
 * every filter narrows the same rows; the drill-down and both Excel exports are the same
 * rows as the page; excluded campuses, archived students and Infosys work never appear;
 * and reading any of it changes no stored Coding-Hours figure.
 */

import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
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

const D1 = '2097-05-10';
const D2 = '2097-05-11';
const BEFORE = '2097-05-09';

const ids = {
  campusA: '', campusB: '', campusX: '',
  batchAF: '', batchAI: '', batchBF: '',
  squad1: '', squad2: '',
  one: '', five: '', bee: '', zed: '',
  infosysAssignment: '',
};
const problems: Record<string, string> = {};
const assignments: string[] = [];
let submissionSeq = 9_000_000_000;

const slug = (key: string) => `${RUN}-${key}`.toLowerCase();

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

/** A DailyStatus as the rollup would write it. `everStatus` is deliberately ever-based. */
async function scoreDay(studentId: string, dayKey: string, assignmentId: string, everStatus: Record<string, 'ACCEPTED' | 'NOT_ATTEMPTED'> = {}): Promise<void> {
  const links = await prisma.assignmentProblem.findMany({ where: { assignmentId }, include: { problem: true } });
  const status = await prisma.dailyStatus.create({
    data: { studentId, dayKey, assignmentId, assignedCount: links.length, solvedCount: 0, inWindowSolvedCount: 0, computedVersion: 2 },
  });
  await prisma.dailyProblemStatus.createMany({
    data: links.map((l) => ({
      dailyStatusId: status.id,
      problemId: l.problemId,
      position: l.position,
      status: everStatus[l.problem.title.slice(RUN.length + 1)] ?? 'NOT_ATTEMPTED',
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

const ours = <T extends { studentId: string }>(rows: T[]) =>
  rows.filter((r) => [ids.one, ids.five, ids.bee, ids.zed].includes(r.studentId));

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
  await problem('p4', 'EASY');
  await problem('p5', 'MEDIUM');
  await problem('unassigned', 'EASY');
  await problem('infosys', 'EASY');
  await problem('xonly', 'EASY');

  const student = (key: string, campusId: string, batchId: string | null, squadId: string | null, status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE') =>
    prisma.student.create({
      data: {
        name: `${RUN} ${key}`,
        email: `${RUN}-${key}@catt.invalid`,
        leetcodeUsername: `${RUN}-${key}`,
        campusId, batchId, squadId, status,
        createdAt: new Date('2097-01-01T00:00:00Z'),
        syncState: { create: { status: 'OK' } },
      },
    });
  ids.one = (await student('One', a.id, ids.batchAF, ids.squad1)).id;
  ids.five = (await student('Five', a.id, ids.batchAI, ids.squad2)).id;
  ids.bee = (await student('Bee', b.id, ids.batchBF, null)).id;
  // Archived, in a campus with no active student or batch — an excluded campus.
  ids.zed = (await student('Zed', x.id, null, null, 'ARCHIVED')).id;

  const aD1 = await assignment(D1, a.id, null, ['p1', 'p2', 'p3']); // whole campus A
  const aD2 = await assignment(D2, a.id, ids.batchAF, ['p4']); // Foundation only
  const bD1 = await assignment(D1, b.id, null, ['p5']);
  const xD1 = await assignment(D1, x.id, null, ['xonly']);

  // One: P1 accepted *before* the day (ever-solved says ACCEPTED), then 1 WA on the day.
  await scoreDay(ids.one, D1, aD1, { p1: 'ACCEPTED' });
  await submit(ids.one, 'p1', BEFORE, [['20:00', 'AC']]);
  await submit(ids.one, 'p1', D1, [['10:12', 'WA']]);
  // P2: 3 WA, AC, then 2 more WA.
  await submit(ids.one, 'p2', D1, [['09:10', 'WA'], ['09:20', 'WA'], ['09:30', 'WA'], ['15:30', 'AC'], ['16:00', 'WA'], ['16:10', 'WA']]);
  // P3: nothing. Unassigned problem: 5 WA on the day — must never show.
  await submit(ids.one, 'unassigned', D1, wa(5));
  // D2, P4: 5 WA.
  await scoreDay(ids.one, D2, aD2);
  await submit(ids.one, 'p4', D2, wa(5));

  // Five (Intermediate, not given D2): P1 5 WA, P2 10 WA, P3 AC first time.
  await scoreDay(ids.five, D1, aD1);
  await submit(ids.five, 'p1', D1, wa(5));
  await submit(ids.five, 'p2', D1, wa(10, 12));
  await submit(ids.five, 'p3', D1, [['18:00', 'AC']]);
  // P4 was never assigned to Five; submissions to it must not appear.
  await submit(ids.five, 'p4', D2, wa(3));

  // Bee (campus B): P5 2 WA. Plus Infosys work on the same day, never mixed in.
  await scoreDay(ids.bee, D1, bD1);
  await submit(ids.bee, 'p5', D1, wa(2));
  ids.infosysAssignment = (
    await prisma.infosysAssignment.create({
      data: { dayKey: D1, problems: { create: [{ problemId: problems.infosys!, position: 1 }] } },
    })
  ).id;
  await submit(ids.bee, 'infosys', D1, wa(4));

  // Zed: archived, excluded campus, plenty of failed attempts.
  await scoreDay(ids.zed, D1, xD1);
  await submit(ids.zed, 'xonly', D1, wa(7));
});

afterAll(async () => {
  const students = [ids.one, ids.five, ids.bee, ids.zed];
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

const row = async (studentId: string, key: string, filters: Parameters<CampusAttemptsService['analysis']>[1] = {}) => {
  const r = await service.analysis(admin, { view: 'NOT_ATTEMPTED', ...filters });
  const all = await service.analysis(admin, { view: 'ALL_ATTEMPTS', ...filters });
  return [...r.rows, ...all.rows].find((x) => x.studentId === studentId && x.titleSlug === slug(key));
};

describe('attempt counting', () => {
  it('zero submissions is Not Attempted', async () => {
    expect(await row(ids.one, 'p3')).toMatchObject({ outcome: 'NOT_ATTEMPTED', attempts: 0, failedAttempts: 0, solved: false });
  });

  it('one failed submission: Attempted But Not Solved, 1 attempt — the earlier AC and the ever-solved status are ignored', async () => {
    expect(await row(ids.one, 'p1')).toMatchObject({ outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 1, failedAttempts: 1, solved: false });
  });

  it('five failed submissions: 5 attempts, 5 failed', async () => {
    expect(await row(ids.five, 'p1')).toMatchObject({ outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 5, failedAttempts: 5 });
    expect(await row(ids.one, 'p4')).toMatchObject({ attempts: 5, failedAttempts: 5 });
  });

  it('three failed then accepted then two more: 6 attempts, solved, 3 failed before solving', async () => {
    const r = await row(ids.one, 'p2');
    expect(r).toMatchObject({ outcome: 'SOLVED_AFTER_ATTEMPTS', attempts: 6, solved: true, failedAttempts: 3 });
    expect(r!.firstAttemptAt).toBe(new Date(`${D1}T09:10:00+05:30`).toISOString());
    expect(r!.lastAttemptAt).toBe(new Date(`${D1}T16:10:00+05:30`).toISOString());
  });

  it('unassigned problems never appear, even with submissions on the day', async () => {
    const all = await service.analysis(admin, { view: 'ALL_ATTEMPTS' });
    expect(all.rows.some((r) => r.titleSlug === slug('unassigned'))).toBe(false);
    // P4 was assigned to Foundation only; Five (Intermediate) submitted to it anyway.
    expect(all.rows.some((r) => r.studentId === ids.five && r.titleSlug === slug('p4'))).toBe(false);
  });

  it('a duplicate mirrored submission cannot be stored, so it cannot be counted twice', async () => {
    const existing = await prisma.submission.findFirstOrThrow({ where: { studentId: ids.five, titleSlug: slug('p1') } });
    const { id: _id, createdAt: _c, ...copy } = existing;
    await expect(prisma.submission.create({ data: copy })).rejects.toThrow();
    expect((await row(ids.five, 'p1'))!.attempts).toBe(5);
  });

  it('Infosys work is never mixed in', async () => {
    const all = await service.analysis(admin, { view: 'ALL_ATTEMPTS' });
    expect(all.rows.some((r) => r.titleSlug === slug('infosys'))).toBe(false);
    expect(ours(all.rows).filter((r) => r.studentId === ids.bee).map((r) => r.titleSlug)).toEqual([slug('p5')]);
  });

  it('excluded campuses and archived students never appear, and the campus itself is refused', async () => {
    for (const view of ['ALL_ATTEMPTS', 'NOT_ATTEMPTED', 'ATTEMPTED_NOT_SOLVED'] as const) {
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
    expect(r.every((x) => x.outcome === 'ATTEMPTED_NOT_SOLVED')).toBe(true);
    expect(r.map((x) => [x.name.slice(RUN.length + 1), x.titleSlug.slice(RUN.length + 1), x.failedAttempts])).toEqual([
      ['Five', 'p2', 10],
      ['Five', 'p1', 5],
      ['One', 'p4', 5],
      ['Bee', 'p5', 2],
      ['One', 'p1', 1],
    ]);
  });

  it('Solved After Attempts and All Attempts', async () => {
    const solved = ours((await service.analysis(admin, { view: 'SOLVED_AFTER_ATTEMPTS' })).rows);
    expect(solved.map((x) => x.titleSlug).sort()).toEqual([slug('p2'), slug('p3')]);
    const all = ours((await service.analysis(admin, { view: 'ALL_ATTEMPTS' })).rows);
    expect(all).toHaveLength(7);
  });

  it('campus filter', async () => {
    const b = await service.analysis(admin, { campusId: ids.campusB, view: 'ALL_ATTEMPTS' });
    expect(b.rows.every((x) => x.campusCode === `BB${STAMP}`.slice(0, 10))).toBe(true);
    expect(ours(b.rows).map((x) => x.studentId)).toEqual([ids.bee]);
    const a = await service.analysis(admin, { campusId: ids.campusA, view: 'ALL_ATTEMPTS' });
    expect(new Set(a.rows.map((x) => x.studentId))).toEqual(new Set([ids.one, ids.five]));
  });

  it('batch filter', async () => {
    const r = await service.analysis(admin, { campusId: ids.campusA, batch: `${RUN} Intermediate`, view: 'ALL_ATTEMPTS' });
    expect(new Set(r.rows.map((x) => x.studentId))).toEqual(new Set([ids.five]));
  });

  it('squad filter', async () => {
    const r = await service.analysis(admin, { campusId: ids.campusA, squad: `${RUN} Squad 1`, view: 'ALL_ATTEMPTS' });
    expect(new Set(r.rows.map((x) => x.studentId))).toEqual(new Set([ids.one]));
  });

  it('date filter', async () => {
    const d2 = await service.analysis(admin, { campusId: ids.campusA, from: D2, to: D2, view: 'ALL_ATTEMPTS' });
    expect(d2.rows.map((x) => [x.studentId, x.titleSlug])).toEqual([[ids.one, slug('p4')]]);
    const d1 = await service.analysis(admin, { campusId: ids.campusA, from: D1, to: D1, view: 'ALL_ATTEMPTS' });
    expect(d1.rows.every((x) => x.dayKey === D1)).toBe(true);
  });

  it('problem and difficulty filters', async () => {
    const p = await service.analysis(admin, { campusId: ids.campusA, problem: slug('p1'), view: 'ALL_ATTEMPTS' });
    expect(p.rows.map((x) => x.titleSlug)).toEqual([slug('p1'), slug('p1')]);
    // The Problem list still offers every assigned problem while one is picked.
    expect(p.problems.map((x) => x.titleSlug)).toEqual(expect.arrayContaining([slug('p2'), slug('p4')]));
    const hard = await service.analysis(admin, { campusId: ids.campusA, difficulty: 'HARD', view: 'ALL_ATTEMPTS' });
    expect(hard.rows.map((x) => x.titleSlug)).toEqual([slug('p3')]);
  });

  it('minimum attempts', async () => {
    const five = ours((await service.analysis(admin, { minAttempts: 5 })).rows);
    expect(five.map((x) => x.failedAttempts)).toEqual([10, 5, 5]);
    const ten = ours((await service.analysis(admin, { minAttempts: 10 })).rows);
    expect(ten.map((x) => [x.studentId, x.titleSlug])).toEqual([[ids.five, slug('p2')]]);
  });

  it('outcome filter combines with campus and date', async () => {
    const r = await service.analysis(admin, { campusId: ids.campusA, from: D1, to: D1, view: 'ATTEMPTED_NOT_SOLVED' });
    expect(r.rows.map((x) => [x.name.slice(RUN.length + 1), x.titleSlug.slice(RUN.length + 1)])).toEqual([
      ['Five', 'p2'],
      ['Five', 'p1'],
      ['One', 'p1'],
    ]);
    const na = await service.analysis(admin, { campusId: ids.campusA, view: 'NOT_ATTEMPTED' });
    expect(na.rows.map((x) => [x.studentId, x.titleSlug])).toEqual([[ids.one, slug('p3')]]);
  });

  it('summary counts over the dimension filters, not the view', async () => {
    const r = await service.analysis(admin, { campusId: ids.campusA, view: 'SOLVED_AFTER_ATTEMPTS' });
    expect(r.summary).toEqual({
      studentsAttemptedNotSolved: 2,
      assignedProblemsAttempted: 6,
      totalFailedAttempts: 1 + 3 + 5 + 5 + 10 + 0,
      studentsWith3PlusNoAc: 2,
      studentsWith5PlusNoAc: 2,
    });
  });
});

describe('drill-down and export', () => {
  it('the student drill-down is the table rows for that student, with the submissions behind them', async () => {
    const table = (await service.analysis(admin, { view: 'ALL_ATTEMPTS' })).rows.filter((x) => x.studentId === ids.one);
    const drill = await service.student(admin, ids.one);
    const strip = ({ submissions: _s, ...rest }: (typeof drill.rows)[number]) => rest;
    expect(drill.rows.map(strip)).toEqual(table);
    const p2 = drill.rows.find((x) => x.titleSlug === slug('p2'))!;
    expect(p2.submissions.map((s) => s.status)).toEqual([
      'ATTEMPTED_NOT_ACCEPTED', 'ATTEMPTED_NOT_ACCEPTED', 'ATTEMPTED_NOT_ACCEPTED', 'ACCEPTED', 'ATTEMPTED_NOT_ACCEPTED', 'ATTEMPTED_NOT_ACCEPTED',
    ]);
    expect(p2.submissions.every((s) => s.language === 'python3' && /^\d+$/.test(s.providerSubmissionId))).toBe(true);
    expect(p2.submissions).toHaveLength(p2.attempts);
    expect(drill.student.leetcodeUrl).toBe(`https://leetcode.com/u/${RUN}-One/`);
  });

  it('the Excel export is the page, row for row, in the same order', async () => {
    const filters = { campusId: ids.campusA, view: 'ALL_ATTEMPTS' as const };
    const page = await service.analysis(admin, filters);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await service.buildWorkbook(admin, filters)) as never);
    const sheet = workbook.getWorksheet('Attempts Analysis')!;
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual([
      'Student', 'Campus', 'Batch', 'Squad', 'Problem', 'Difficulty', 'Assignment Date',
      'Attempts', 'Solved', 'Failed Attempts', 'First Attempt', 'Last Attempt',
    ]);
    expect(sheet.rowCount).toBe(page.rows.length + 1);
    page.rows.forEach((r, i) => {
      const x = sheet.getRow(i + 2);
      expect([x.getCell(1).value, x.getCell(5).value, x.getCell(8).value, x.getCell(9).value, x.getCell(10).value]).toEqual([
        r.name, r.title, r.attempts, r.solved ? 'Yes' : 'No', r.failedAttempts,
      ]);
    });
    const p2 = page.rows.findIndex((r) => r.studentId === ids.one && r.titleSlug === slug('p2'));
    expect(sheet.getRow(p2 + 2).getCell(7).value).toBe('10 May');
    expect(sheet.getRow(p2 + 2).getCell(11).value).toBe('10 May 09:10');
    expect(sheet.getRow(p2 + 2).getCell(12).value).toBe('10 May 16:10');
  });

  it('Export Unsolved Attempts holds only Attempted But Not Solved, whatever the page view', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await service.buildWorkbook(admin, { campusId: ids.campusA, view: 'SOLVED_AFTER_ATTEMPTS' }, 'unsolved')) as never);
    const sheet = workbook.getWorksheet('Unsolved Attempts')!;
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual([
      'Student', 'Campus', 'Batch', 'Squad', 'Problem', 'Attempts', 'Failed Attempts', 'Assignment Date',
    ]);
    const unsolved = await service.analysis(admin, { campusId: ids.campusA, view: 'ATTEMPTED_NOT_SOLVED' });
    expect(sheet.rowCount).toBe(unsolved.rows.length + 1);
    unsolved.rows.forEach((r, i) => expect(sheet.getRow(i + 2).getCell(7).value).toBe(r.failedAttempts));
  });
});

describe('historical Coding-Hours data', () => {
  it('reading and exporting changes no stored figure', async () => {
    const snapshot = () =>
      prisma.dailyStatus.findMany({
        where: { studentId: { in: [ids.one, ids.five, ids.bee] } },
        orderBy: [{ studentId: 'asc' }, { dayKey: 'asc' }],
        include: { problemStatuses: { orderBy: { position: 'asc' } } },
      });
    const before = await snapshot();
    await service.analysis(admin, { view: 'ALL_ATTEMPTS' });
    await service.student(admin, ids.one);
    await service.buildWorkbook(admin, {}, 'unsolved');
    expect(await snapshot()).toEqual(before);
    // The ever-solved figure the rest of Campus Analysis reads is still what it was.
    const oneD1 = before.find((d) => d.studentId === ids.one && d.dayKey === D1)!;
    expect(oneD1.problemStatuses.find((p) => p.problemId === problems.p1)!.status).toBe('ACCEPTED');
  });
});
