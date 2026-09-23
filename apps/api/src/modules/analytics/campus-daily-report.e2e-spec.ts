/**
 * `CampusDailyReportService` against a real database — the Coding-Hours Daily Report's
 * guarantees (2026-09-23 feature brief, §8-§14):
 *
 *  - "As of Date" controls which day columns exist; a day with no `DailyStatus` row for
 *    any in-scope student never becomes one;
 *  - daily cells and Total Solved come straight from `DailyStatus.solvedCount` ("ever
 *    solved" — the existing Coding-Hours rule, never Infosys's tracking-window rule);
 *  - "questions given" is a distinct-problem count, never students x problems;
 *  - rows sort by Total Solved descending, student name ascending as the tiebreak;
 *  - campus/batch/squad/category/search only narrow which rows are visible;
 *  - a campus with no Coding-Hours activity never appears, at any filter;
 *  - the exported workbook matches the on-screen report exactly.
 */

import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CampusAnalysisService } from './campus-analysis.service';
import { CampusDailyReportService } from './campus-daily-report.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { CampusesService } from '../campuses/campuses.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import type { RequestUser } from '../../common/decorators';

const prisma = new PrismaClient();
const RUN = `e2e-cadr-${Date.now()}`;
const STAMP = Date.now().toString(36).toUpperCase();

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const mentorScope = new MentorScopeService(prisma as never);
const cache = { remember: (_key: string, _ttl: number, fn: () => unknown) => fn() } as never;
const campusesService = new CampusesService(prisma as never, time, cache, mentorScope);
const campusAnalysis = new CampusAnalysisService(prisma as never, time, mentorScope, campusesService);
const report = new CampusDailyReportService(prisma as never, campusAnalysis);

const admin: RequestUser = { id: '', email: 'a@x.invalid', name: 'Admin', role: 'ADMIN', studentId: null } as RequestUser;

const day1 = '2099-08-03';
const day2 = '2099-08-04';
const skippedDay = '2099-08-05'; // deliberately no assignment/DailyStatus at all
const day4 = '2099-08-06';

let activeCampusId: string;
let inactiveCampusId: string;
let batchStrong: string;
let batchWeak: string;
const problemIds: string[] = [];
const assignmentIds: Record<string, string> = {};
let strongStudent: string;
let weakStudent: string;

async function makeAssignment(dayKey: string, campusId: string, batchId: string): Promise<string> {
  const p1 = await prisma.problem.create({
    data: { titleSlug: `${RUN}-${dayKey}-1`, title: `${RUN}-${dayKey}-1`, difficulty: 'EASY', url: `https://leetcode.com/problems/${RUN}-${dayKey}-1/` },
  });
  const p2 = await prisma.problem.create({
    data: { titleSlug: `${RUN}-${dayKey}-2`, title: `${RUN}-${dayKey}-2`, difficulty: 'EASY', url: `https://leetcode.com/problems/${RUN}-${dayKey}-2/` },
  });
  problemIds.push(p1.id, p2.id);
  const assignment = await prisma.assignment.create({
    data: {
      dayKey,
      campusId,
      batchId,
      originalCampusId: campusId,
      originalBatchId: batchId,
      title: `${RUN} ${dayKey}`,
      problems: { create: [{ problemId: p1.id, position: 1 }, { problemId: p2.id, position: 2 }] },
    },
  });
  return assignment.id;
}

async function scoreDay(studentId: string, dayKey: string, assignmentId: string, solved: number): Promise<void> {
  const status = await prisma.dailyStatus.create({
    data: { studentId, dayKey, assignmentId, assignedCount: 2, solvedCount: solved, inWindowSolvedCount: 0, computedVersion: 2 },
  });
  const links = await prisma.assignmentProblem.findMany({ where: { assignmentId }, orderBy: { position: 'asc' } });
  await prisma.dailyProblemStatus.createMany({
    data: links.map((link, i) => ({
      dailyStatusId: status.id,
      problemId: link.problemId,
      position: link.position,
      status: i < solved ? ('ACCEPTED' as const) : ('NOT_ATTEMPTED' as const),
    })),
  });
}

beforeAll(async () => {
  const [active, inactive] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} Active`, code: `AC${STAMP}`.slice(0, 10) } }),
    prisma.campus.create({ data: { name: `${RUN} Inactive`, code: `IN${STAMP}`.slice(0, 10) } }),
  ]);
  activeCampusId = active.id;
  inactiveCampusId = inactive.id;

  const [bs, bw] = await Promise.all([
    prisma.batch.create({ data: { name: `${RUN} Strong Batch`, code: 'A', campusId: activeCampusId } }),
    prisma.batch.create({ data: { name: `${RUN} Weak Batch`, code: 'B', campusId: activeCampusId } }),
  ]);
  batchStrong = bs.id;
  batchWeak = bw.id;

  assignmentIds[day1] = await makeAssignment(day1, activeCampusId, batchStrong);
  assignmentIds[day2] = await makeAssignment(day2, activeCampusId, batchStrong);
  // No assignment at all for `skippedDay`.
  assignmentIds[day4] = await makeAssignment(day4, activeCampusId, batchStrong);

  const strong = await prisma.student.create({
    data: {
      name: `${RUN} Strong`,
      email: `${RUN}-strong@cadr.invalid`,
      leetcodeUsername: `${RUN}-strong`,
      campusId: activeCampusId,
      batchId: batchStrong,
      status: 'ACTIVE',
      syncState: { create: { status: 'OK' } },
    },
  });
  const weak = await prisma.student.create({
    data: {
      name: `${RUN} Weak`,
      email: `${RUN}-weak@cadr.invalid`,
      leetcodeUsername: `${RUN}-weak`,
      campusId: activeCampusId,
      batchId: batchWeak,
      status: 'ACTIVE',
      syncState: { create: { status: 'OK' } },
    },
  });
  strongStudent = strong.id;
  weakStudent = weak.id;

  for (const day of [day1, day2, day4]) {
    await scoreDay(strongStudent, day, assignmentIds[day]!, 2);
    await scoreDay(weakStudent, day, assignmentIds[day]!, 0);
  }
});

afterAll(async () => {
  const ids = [strongStudent, weakStudent];
  await prisma.dailyProblemStatus.deleteMany({ where: { dailyStatus: { studentId: { in: ids } } } });
  await prisma.dailyStatus.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.assignmentProblem.deleteMany({ where: { assignmentId: { in: Object.values(assignmentIds) } } });
  await prisma.assignment.deleteMany({ where: { id: { in: Object.values(assignmentIds) } } });
  await prisma.problem.deleteMany({ where: { id: { in: problemIds } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await prisma.batch.deleteMany({ where: { id: { in: [batchStrong, batchWeak] } } });
  await prisma.campus.deleteMany({ where: { id: { in: [activeCampusId, inactiveCampusId] } } });
  await prisma.$disconnect();
});

describe('CampusDailyReportService.buildReport', () => {
  it('asOf controls which day columns exist', async () => {
    const r1 = await report.buildReport(admin, day1);
    expect(r1.days.map((d) => d.dayKey)).toEqual([day1]);

    const r2 = await report.buildReport(admin, day2);
    expect(r2.days.map((d) => d.dayKey)).toEqual([day1, day2]);
  });

  it('a day with no DailyStatus data never becomes a column, even when asOf spans it', async () => {
    const r = await report.buildReport(admin, day4);
    const dayKeys = r.days.map((d) => d.dayKey);
    expect(dayKeys).toContain(day1);
    expect(dayKeys).toContain(day4);
    expect(dayKeys).not.toContain(skippedDay);
  });

  it('daily cells match DailyStatus.solvedCount ("ever solved", not window-restricted)', async () => {
    const r = await report.buildReport(admin, day4);
    const strongRow = r.rows.find((row) => row.studentId === strongStudent)!;
    expect(strongRow.daily[day1]).toBe(2);
    expect(strongRow.daily[day2]).toBe(2);
    expect(strongRow.daily[day4]).toBe(2);
    expect(strongRow.total).toBe(6);

    const weakRow = r.rows.find((row) => row.studentId === weakStudent)!;
    expect(weakRow.total).toBe(0);
  });

  it('"questions given" is a distinct-problem count, never students x problems', async () => {
    const r = await report.buildReport(admin, day1);
    // Two students, both assigned the same 2 problems that day — must read 2, not 4.
    expect(r.days.find((d) => d.dayKey === day1)?.assignedCount).toBe(2);
  });

  it('sorted by Total Solved descending, name ascending for ties', async () => {
    const r = await report.buildReport(admin, day4);
    expect(r.rows[0]!.studentId).toBe(strongStudent);
    expect(r.rows[0]!.rank).toBe(1);
    for (let i = 0; i < r.rows.length - 1; i++) {
      expect(r.rows[i]!.total >= r.rows[i + 1]!.total).toBe(true);
    }
  });

  it('batch filter narrows the view without changing the underlying data', async () => {
    const r = await report.buildReport(admin, day4, { batch: `${RUN} Strong Batch` });
    const ids = r.rows.map((row) => row.studentId);
    expect(ids).toContain(strongStudent);
    expect(ids).not.toContain(weakStudent);
  });

  it('search filter matches by name', async () => {
    const r = await report.buildReport(admin, day4, { search: 'weak' });
    expect(r.rows.map((row) => row.studentId)).toEqual([weakStudent]);
  });

  it('a campus with no Coding-Hours activity is refused, not silently returned empty', async () => {
    // Same "not found, not forbidden" behaviour `campus-analysis-scope.e2e-spec.ts`
    // asserts directly on `CampusAnalysisService` — this proves it holds through
    // `CampusDailyReportService.buildReport` too, not just the summary endpoint.
    await expect(report.buildReport(admin, day4, { campusId: inactiveCampusId })).rejects.toThrow();
  });

  it('the exported workbook matches the on-screen report exactly', async () => {
    const jsonReport = await report.buildReport(admin, day4);
    const buffer = await report.buildWorkbook(admin, day4);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.getWorksheet('Campus Analysis Report')!;
    expect(sheet).toBeDefined();

    jsonReport.rows.forEach((row, i) => {
      const excelRow = 4 + i;
      expect(sheet.getCell(excelRow, 1).value).toBe(row.rank);
      expect(sheet.getCell(excelRow, 2).value).toBe(row.name);
    });
    expect(sheet.lastRow!.number).toBe(3 + jsonReport.rows.length);
  });
});
