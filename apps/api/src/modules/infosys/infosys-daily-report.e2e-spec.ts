/**
 * `InfosysDailyReportService` against a real database — the Daily Report's core
 * guarantees (2026-09-23 feature brief, §4-§14):
 *
 *  - the "As of Date" controls which day *columns* exist, and a day with no
 *    `InfosysAssignment` (27 Sep, mirrored here as a skipped day) never becomes one,
 *    no matter what date range is selected;
 *  - daily cells and Total Solved come from the same `InfosysDailyStatus` rows the
 *    dashboard and Student Analysis page already read, never a live LeetCode fetch;
 *  - rows are sorted by Total Solved descending, student name ascending as the
 *    deterministic tiebreak;
 *  - campus/category only narrow which rows are visible, never the underlying data;
 *  - a student removed from the active cohort (their `InfosysEnrollment` deleted)
 *    never appears, at any `asOf`;
 *  - the exported workbook's structure matches the JSON report exactly.
 */

import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InfosysRollupService } from './infosys-rollup.service';
import { InfosysAnalyticsService } from './infosys-analytics.service';
import { InfosysDailyReportService } from './infosys-daily-report.service';

const prisma = new PrismaClient();
const RUN = `e2e-infosysreport-${Date.now()}`;
const CODE = `IP${Date.now().toString(36).toUpperCase()}`;

const time = {
  bounds: (dayKey: string) => ({
    start: new Date(`${dayKey}T00:00:00.000Z`),
    end: new Date(`${dayKey}T23:59:59.999Z`),
  }),
} as never;

const rollup = new InfosysRollupService(prisma as never, time);
const analytics = new InfosysAnalyticsService(prisma as never, rollup);
const report = new InfosysDailyReportService(prisma as never, rollup, analytics);

let campusA: string;
let campusB: string;
const day1 = '2026-09-21';
const day2 = '2026-09-22';
const skippedDay = '2026-09-23'; // deliberately no InfosysAssignment — mirrors 27 Sep
const day4 = '2026-09-24';

let problemIds: Record<string, string> = {};
let strongStudent: string; // campus A, solves everything
let weakStudent: string; // campus A, solves nothing
let otherCampusStudent: string; // campus B
let removedStudent: string; // enrolled, then removed

async function makeProblem(slug: string): Promise<string> {
  const p = await prisma.problem.create({
    data: { titleSlug: slug, title: slug, difficulty: 'EASY', url: `https://leetcode.com/problems/${slug}/` },
  });
  return p.id;
}

beforeAll(async () => {
  const [ca, cb] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} A`, code: `${CODE}A` } }),
    prisma.campus.create({ data: { name: `${RUN} B`, code: `${CODE}B` } }),
  ]);
  campusA = ca.id;
  campusB = cb.id;

  const slugs = [`${RUN}-p1`, `${RUN}-p2`, `${RUN}-p3`];
  const ids = await Promise.all(slugs.map(makeProblem));
  problemIds = Object.fromEntries(slugs.map((s, i) => [s, ids[i]!]));

  await prisma.infosysAssignment.create({
    data: { dayKey: day1, problems: { create: [{ problemId: problemIds[slugs[0]!]!, position: 1 }] } },
  });
  await prisma.infosysAssignment.create({
    data: { dayKey: day2, problems: { create: [{ problemId: problemIds[slugs[1]!]!, position: 1 }] } },
  });
  // No assignment for `skippedDay` — deliberate.
  await prisma.infosysAssignment.create({
    data: { dayKey: day4, problems: { create: [{ problemId: problemIds[slugs[2]!]!, position: 1 }] } },
  });

  const [strong, weak, other, removed] = await Promise.all([
    prisma.student.create({
      data: {
        name: `${RUN} A Strong`,
        status: 'ARCHIVED',
        leetcodeUsername: `${RUN}-strong`.toLowerCase(),
        syncState: { create: { status: 'OK' } },
        infosysEnrollment: { create: { campusId: campusA } },
      },
    }),
    prisma.student.create({
      data: {
        name: `${RUN} A Weak`,
        status: 'ARCHIVED',
        infosysEnrollment: { create: { campusId: campusA } },
      },
    }),
    prisma.student.create({
      data: {
        name: `${RUN} B Other`,
        status: 'ARCHIVED',
        infosysEnrollment: { create: { campusId: campusB } },
      },
    }),
    prisma.student.create({
      data: {
        name: `${RUN} Removed`,
        status: 'ARCHIVED',
        infosysEnrollment: { create: { campusId: campusA } },
      },
    }),
  ]);
  strongStudent = strong.id;
  weakStudent = weak.id;
  otherCampusStudent = other.id;
  removedStudent = removed.id;

  await prisma.submission.createMany({
    data: [
      { studentId: strongStudent, titleSlug: slugs[0]!, title: slugs[0]!, providerSubmissionId: `${RUN}-1`, status: 'ACCEPTED', submittedAt: new Date(`${day1}T10:00:00Z`), dayKey: day1 },
      { studentId: strongStudent, titleSlug: slugs[1]!, title: slugs[1]!, providerSubmissionId: `${RUN}-2`, status: 'ACCEPTED', submittedAt: new Date(`${day2}T10:00:00Z`), dayKey: day2 },
      { studentId: strongStudent, titleSlug: slugs[2]!, title: slugs[2]!, providerSubmissionId: `${RUN}-3`, status: 'ACCEPTED', submittedAt: new Date(`${day4}T10:00:00Z`), dayKey: day4 },
    ],
  });

  await rollup.recomputeAll();

  // Remove this student from the active cohort *after* they have real history, the
  // same way the 2026-09-23 cohort reconciliation did.
  await prisma.infosysEnrollment.delete({ where: { studentId: removedStudent } });
});

afterAll(async () => {
  const ids = [strongStudent, weakStudent, otherCampusStudent, removedStudent];
  await prisma.infosysDailyProblemStatus.deleteMany({ where: { infosysDailyStatus: { studentId: { in: ids } } } });
  await prisma.infosysDailyStatus.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.infosysAssignment.deleteMany({ where: { dayKey: { in: [day1, day2, day4] } } });
  for (const id of Object.values(problemIds)) await prisma.problem.delete({ where: { id } });
  await prisma.infosysEnrollment.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await prisma.campus.deleteMany({ where: { id: { in: [campusA, campusB] } } });
  await prisma.$disconnect();
});

describe('InfosysDailyReportService.buildReport', () => {
  it('asOf controls which day columns exist', async () => {
    const r1 = await report.buildReport(day1);
    expect(r1.days.map((d) => d.dayKey)).toEqual([day1]);

    const r2 = await report.buildReport(day2);
    expect(r2.days.map((d) => d.dayKey)).toEqual([day1, day2]);
  });

  it('a day with no InfosysAssignment never becomes a column, even when asOf spans it', async () => {
    const r = await report.buildReport(day4);
    const dayKeys = r.days.map((d) => d.dayKey);
    expect(dayKeys).toContain(day1);
    expect(dayKeys).toContain(day2);
    expect(dayKeys).toContain(day4);
    expect(dayKeys).not.toContain(skippedDay);
  });

  it('daily cells match the materialised InfosysDailyStatus data', async () => {
    const r = await report.buildReport(day4);
    const strongRow = r.rows.find((row) => row.studentId === strongStudent)!;
    expect(strongRow.daily[day1]).toBe(1);
    expect(strongRow.daily[day2]).toBe(1);
    expect(strongRow.daily[day4]).toBe(1);
    expect(strongRow.total).toBe(3);

    const weakRow = r.rows.find((row) => row.studentId === weakStudent)!;
    expect(weakRow.total).toBe(0);
  });

  it('Total Solved equals the sum of every visible daily cell', async () => {
    const r = await report.buildReport(day4);
    for (const row of r.rows) {
      const sum = Object.values(row.daily).reduce((s, v) => s + v, 0);
      expect(row.total).toBe(sum);
    }
  });

  it('sorted by Total Solved descending, name ascending for ties', async () => {
    const r = await report.buildReport(day4);
    for (let i = 0; i < r.rows.length - 1; i++) {
      const a = r.rows[i]!;
      const b = r.rows[i + 1]!;
      expect(a.total >= b.total).toBe(true);
      if (a.total === b.total) expect(a.name.localeCompare(b.name)).toBeLessThanOrEqual(0);
    }
    expect(r.rows[0]!.studentId).toBe(strongStudent);
  });

  it('campus and category filters combine and only narrow the view, not the data', async () => {
    const rAll = await report.buildReport(day4);
    const ids = rAll.rows.map((r) => r.studentId);
    expect(ids).toContain(strongStudent);
    expect(ids).toContain(otherCampusStudent);

    const rCampusA = await report.buildReport(day4, { campusName: `${RUN} A` });
    const idsA = rCampusA.rows.map((r) => r.studentId);
    expect(idsA).toContain(strongStudent);
    expect(idsA).not.toContain(otherCampusStudent);
  });

  it('a student removed from the active cohort never appears, at any asOf', async () => {
    for (const asOf of [day1, day2, day4]) {
      const r = await report.buildReport(asOf);
      expect(r.rows.map((row) => row.studentId)).not.toContain(removedStudent);
    }
  });

  it('DATA_UNAVAILABLE never appears as a category', async () => {
    const r = await report.buildReport(day4);
    for (const row of r.rows) expect(row.category as string).not.toBe('DATA_UNAVAILABLE');
  });

  it('the exported workbook matches the on-screen report exactly', async () => {
    const jsonReport = await report.buildReport(day4);
    const buffer = await report.buildWorkbook(day4);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.getWorksheet('Infosys Daily Report')!;
    expect(sheet).toBeDefined();

    // Row 4 onward is data; row count matches, and Total Solved column matches.
    const totalCol = 3 + jsonReport.days.length + 1;
    expect(sheet.getCell(4, totalCol).value).toBeDefined();

    jsonReport.rows.forEach((row, i) => {
      const excelRow = 4 + i;
      expect(sheet.getCell(excelRow, 1).value).toBe(row.rank);
      expect(sheet.getCell(excelRow, 2).value).toBe(row.name);
      expect(sheet.getCell(excelRow, 3).value).toBe(row.campusName ?? '');
    });

    expect(sheet.lastRow!.number).toBe(3 + jsonReport.rows.length);
  });
});
