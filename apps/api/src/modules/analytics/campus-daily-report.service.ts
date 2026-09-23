/**
 * The Coding-Hours Daily Report — the wide, date-wise submission matrix, built from the
 * exact rows `CampusAnalysisService` already computes (campus scope, category, per-
 * student figures) plus the day-by-day `DailyStatus` data those rows are themselves
 * aggregated from. No new business rule: "solved" is still `DailyStatus.solvedCount`
 * ("ever solved", §14 — see `campus-analysis.service.ts`'s own header comment), campus
 * scope is still `CampusAnalysisService.allStudents`'s already-tested
 * `hasCodingHoursActivity` filter, category is still `categoriseStudent`'s verdict.
 * This file only adds the day-by-day matrix shape and the Excel export on top.
 */

import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import {
  analysisWeeks,
  type CampusCategory,
  type CampusDailyReportDay,
  type CampusDailyReportResponse,
  type CampusDailyReportRow,
  type CampusDailyReportWeek,
  type DayKey,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import type { RequestUser } from '../../common/decorators';
import { CampusAnalysisService } from './campus-analysis.service';

export interface CampusDailyReportFilters {
  campusId?: string | null;
  batch?: string | null;
  squad?: string | null;
  category?: CampusCategory | null;
  search?: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(dayKey: string): string {
  const [year, month, day] = dayKey.split('-');
  return `${day} ${MONTHS[Number(month) - 1]} ${year}`;
}

function formatDayShort(dayKey: string): string {
  const [, month, day] = dayKey.split('-');
  return `${day} ${MONTHS[Number(month) - 1]}`;
}

@Injectable()
export class CampusDailyReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campusAnalysis: CampusAnalysisService,
  ) {}

  async buildReport(
    user: RequestUser,
    asOf: DayKey,
    filters: CampusDailyReportFilters = {},
  ): Promise<CampusDailyReportResponse> {
    const { students } = await this.campusAnalysis.allStudents(user, {
      to: asOf,
      campusId: filters.campusId ?? undefined,
    });
    const studentIds = students.map((s) => s.studentId);

    if (studentIds.length === 0) {
      return { asOf, trackingStart: null, days: [], weeks: [], rows: [] };
    }

    const earliest = await this.prisma.dailyStatus.findFirst({
      where: { studentId: { in: studentIds }, dayKey: { lte: asOf } },
      orderBy: { dayKey: 'asc' },
      select: { dayKey: true },
    });
    const trackingStart = earliest?.dayKey as DayKey | undefined;
    if (!trackingStart) {
      return { asOf, trackingStart: null, days: [], weeks: [], rows: this.filterAndRank(students, new Map(), [], filters) };
    }

    const statuses = await this.prisma.dailyStatus.findMany({
      where: { studentId: { in: studentIds }, dayKey: { gte: trackingStart, lte: asOf } },
      select: { studentId: true, dayKey: true, solvedCount: true },
    });

    const dayKeysWithData = [...new Set(statuses.map((s) => s.dayKey))].sort();

    // Distinct problems assigned each day, to *this filtered student set* — read from
    // DailyProblemStatus rather than re-deriving the campus/batch audience resolution
    // Assignment already applies; whatever these students actually had assigned is, by
    // construction, the right count (§13: distinct problems, never students x problems).
    const dailyStatusIds = await this.prisma.dailyStatus.findMany({
      where: { studentId: { in: studentIds }, dayKey: { in: dayKeysWithData } },
      select: { id: true, dayKey: true },
    });
    const problemRows = await this.prisma.dailyProblemStatus.findMany({
      where: { dailyStatusId: { in: dailyStatusIds.map((d) => d.id) } },
      select: { dailyStatusId: true, problemId: true },
    });
    const dayKeyByStatusId = new Map(dailyStatusIds.map((d) => [d.id, d.dayKey]));
    const problemIdsByDay = new Map<string, Set<string>>();
    for (const row of problemRows) {
      const dayKey = dayKeyByStatusId.get(row.dailyStatusId);
      if (!dayKey) continue;
      const set = problemIdsByDay.get(dayKey) ?? new Set<string>();
      set.add(row.problemId);
      problemIdsByDay.set(dayKey, set);
    }

    const days: CampusDailyReportDay[] = [];
    const weeks: CampusDailyReportWeek[] = [];
    const calendarWeeks = analysisWeeks(trackingStart, asOf);
    let weekNumber = 0;
    for (const week of calendarWeeks) {
      const daysInWeek = dayKeysWithData.filter((d) => d >= week.from && d <= week.to);
      if (daysInWeek.length === 0) continue;
      weekNumber += 1;
      for (const dayKey of daysInWeek) {
        days.push({ dayKey, weekNumber, assignedCount: problemIdsByDay.get(dayKey)?.size ?? 0 });
      }
      const label =
        daysInWeek.length === 1
          ? `Week ${weekNumber} (${formatDayShort(daysInWeek[0]!)})`
          : `Week ${weekNumber} (${formatDayShort(daysInWeek[0]!)} – ${formatDayShort(daysInWeek[daysInWeek.length - 1]!)})`;
      weeks.push({ weekNumber, label, days: daysInWeek });
    }

    const solvedByStudent = new Map<string, Map<string, number>>();
    for (const s of statuses) {
      const m = solvedByStudent.get(s.studentId) ?? new Map<string, number>();
      m.set(s.dayKey, s.solvedCount);
      solvedByStudent.set(s.studentId, m);
    }

    const rows = this.filterAndRank(students, solvedByStudent, dayKeysWithData, filters);
    return { asOf, trackingStart, days, weeks, rows };
  }

  private filterAndRank(
    students: Awaited<ReturnType<CampusAnalysisService['allStudents']>>['students'],
    solvedByStudent: Map<string, Map<string, number>>,
    dayKeys: string[],
    filters: CampusDailyReportFilters,
  ): CampusDailyReportRow[] {
    const needle = (filters.search ?? '').trim().toLowerCase();

    const rows = students
      .filter((s) => filters.batch == null || s.batch === filters.batch)
      .filter((s) => filters.squad == null || s.squad === filters.squad)
      .filter((s) => filters.category == null || s.verdict.category === filters.category)
      .filter((s) => !needle || s.name.toLowerCase().includes(needle))
      .map((s) => {
        const dayMap = solvedByStudent.get(s.studentId);
        const daily: Record<string, number> = {};
        let total = 0;
        for (const dayKey of dayKeys) {
          const solved = dayMap?.get(dayKey) ?? 0;
          daily[dayKey] = solved;
          total += solved;
        }
        return {
          rank: 0,
          studentId: s.studentId,
          name: s.name,
          campusCode: s.campusCode,
          batch: s.batch,
          squad: s.squad,
          category: s.verdict.category,
          leetcodeUsername: s.leetcodeUsername,
          leetcodeUrl: s.leetcodeUrl,
          daily,
          total,
        };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

    rows.forEach((row, i) => (row.rank = i + 1));
    return rows;
  }

  async buildWorkbook(user: RequestUser, asOf: DayKey, filters: CampusDailyReportFilters = {}): Promise<Buffer> {
    const report = await this.buildReport(user, asOf, filters);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'DSA Tracker';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Campus Analysis Report');

    const HEADERS = ['Rank', 'Student', 'Campus', 'Batch', 'Squad'];
    const fixedCount = HEADERS.length;
    const dayCols = report.days.length;
    const totalCol = fixedCount + dayCols + 1;

    const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    const headerFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } };
    const subHeaderFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    const thin: ExcelJS.Border = { style: 'thin', color: { argb: 'FFB7B7B7' } };
    const border: Partial<ExcelJS.Borders> = { top: thin, bottom: thin, left: thin, right: thin };
    const center: Partial<ExcelJS.Alignment> = { horizontal: 'center', vertical: 'middle', wrapText: true };

    const setHeaderCell = (row: number, col: number, value: unknown, fill = headerFill): void => {
      const cell = sheet.getCell(row, col);
      cell.value = value as ExcelJS.CellValue;
      cell.font = headerFont;
      cell.fill = fill;
      cell.alignment = center;
      cell.border = border;
    };

    HEADERS.forEach((h, i) => {
      sheet.mergeCells(1, i + 1, 3, i + 1);
      setHeaderCell(1, i + 1, h);
    });
    sheet.mergeCells(1, totalCol, 3, totalCol);
    setHeaderCell(1, totalCol, 'Total Solved');

    let col = fixedCount + 1;
    for (const week of report.weeks) {
      const span = week.days.length;
      if (span > 1) sheet.mergeCells(1, col, 1, col + span - 1);
      setHeaderCell(1, col, week.label);
      for (let i = 0; i < span; i++) {
        const dayKey = week.days[i]!;
        const assignedCount = report.days.find((d) => d.dayKey === dayKey)?.assignedCount ?? 0;
        setHeaderCell(2, col + i, formatDay(dayKey), subHeaderFill);
        setHeaderCell(3, col + i, `${assignedCount} question${assignedCount === 1 ? '' : 's'} given`, subHeaderFill);
      }
      col += span;
    }

    let r = 4;
    for (const row of report.rows) {
      sheet.getCell(r, 1).value = row.rank;
      sheet.getCell(r, 2).value = row.name;
      sheet.getCell(r, 3).value = row.campusCode ?? '';
      sheet.getCell(r, 4).value = row.batch ?? '';
      sheet.getCell(r, 5).value = row.squad ?? '';
      let c = fixedCount + 1;
      for (const day of report.days) {
        sheet.getCell(r, c).value = row.daily[day.dayKey] ?? 0;
        c += 1;
      }
      const firstDayCol = fixedCount + 1;
      const lastDayCol = fixedCount + dayCols;
      sheet.getCell(r, totalCol).value =
        dayCols > 0
          ? { formula: `SUM(${sheet.getCell(r, firstDayCol).address}:${sheet.getCell(r, lastDayCol).address})` }
          : 0;

      for (let cc = 1; cc <= totalCol; cc++) {
        const cell = sheet.getCell(r, cc);
        cell.border = border;
        cell.alignment = cc === 2 ? { horizontal: 'left', vertical: 'middle' } : center;
      }
      r += 1;
    }

    sheet.getColumn(1).width = 7;
    sheet.getColumn(2).width = 26;
    sheet.getColumn(3).width = 12;
    sheet.getColumn(4).width = 14;
    sheet.getColumn(5).width = 12;
    for (let c = fixedCount + 1; c <= fixedCount + dayCols; c++) sheet.getColumn(c).width = 13;
    sheet.getColumn(totalCol).width = 14;

    sheet.views = [{ state: 'frozen', ySplit: 3 }];
    const lastRow = Math.max(r - 1, 3);
    sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: lastRow, column: totalCol } };

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
}
