/**
 * The Infosys "Daily Report" — a wide, date-wise submission matrix for the whole active
 * cohort, read from the same materialised `InfosysDailyStatus` rows the dashboard and
 * Student Analysis page already read (§13: never a live LeetCode fetch on page load).
 *
 * One function builds the matrix (`buildReport`); the on-screen table and the Excel
 * export both render from its output, so they cannot disagree (§14). The export
 * (`buildWorkbook`) is the same rows and columns laid out in a workbook instead of JSON.
 */

import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import {
  analysisWeeks,
  type DayKey,
  type InfosysCategory,
  type InfosysDailyReportDay,
  type InfosysDailyReportResponse,
  type InfosysDailyReportRow,
  type InfosysDailyReportWeek,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { InfosysRollupService } from './infosys-rollup.service';
import { InfosysAnalyticsService } from './infosys-analytics.service';

export interface InfosysDailyReportFilters {
  campusName?: string | null;
  category?: InfosysCategory | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-21" -> "21 Sep 2026". Parsed from the string directly — never round-tripped
 * through a `Date`, so there is no timezone to get wrong. */
function formatDay(dayKey: string): string {
  const [year, month, day] = dayKey.split('-');
  return `${day} ${MONTHS[Number(month) - 1]} ${year}`;
}

/** "21 Sep" — the short form used inside a merged week header. */
function formatDayShort(dayKey: string): string {
  const [, month, day] = dayKey.split('-');
  return `${day} ${MONTHS[Number(month) - 1]}`;
}

@Injectable()
export class InfosysDailyReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rollup: InfosysRollupService,
    private readonly analytics: InfosysAnalyticsService,
  ) {}

  async buildReport(asOf: DayKey, filters: InfosysDailyReportFilters = {}): Promise<InfosysDailyReportResponse> {
    const trackingStart = await this.rollup.trackingStartDate();
    if (!trackingStart) {
      return { asOf, trackingStart: null, days: [], weeks: [], rows: [] };
    }
    // A student's whole-period category/profile state (§14: the same value the
    // dashboard and Students page already show) — never recomputed against `asOf`,
    // which only ever narrows which day *columns* are visible.
    const analyses = await this.analytics.studentAnalysis();

    if (asOf < trackingStart) {
      return { asOf, trackingStart, days: [], weeks: [], rows: this.emptyRows(analyses, filters) };
    }

    const assignments = await this.prisma.infosysAssignment.findMany({
      where: { dayKey: { gte: trackingStart, lte: asOf } },
      select: { dayKey: true, _count: { select: { problems: true } } },
      orderBy: { dayKey: 'asc' },
    });

    const days: InfosysDailyReportDay[] = [];
    const assignedDayKeys = assignments.map((a) => a.dayKey as DayKey);
    const assignedCountByDay = new Map(assignments.map((a) => [a.dayKey, a._count.problems]));

    const calendarWeeks = analysisWeeks(trackingStart, asOf);
    const weeks: InfosysDailyReportWeek[] = [];
    let weekNumber = 0;
    for (const week of calendarWeeks) {
      const daysInWeek = assignedDayKeys.filter((d) => d >= week.from && d <= week.to);
      if (daysInWeek.length === 0) continue; // e.g. a week that fell entirely on 27 Sep
      weekNumber += 1;
      for (const dayKey of daysInWeek) {
        days.push({ dayKey, weekNumber, assignedCount: assignedCountByDay.get(dayKey) ?? 0 });
      }
      const label =
        daysInWeek.length === 1
          ? `Week ${weekNumber} (${formatDayShort(daysInWeek[0]!)})`
          : `Week ${weekNumber} (${formatDayShort(daysInWeek[0]!)} – ${formatDayShort(daysInWeek[daysInWeek.length - 1]!)})`;
      weeks.push({ weekNumber, label, days: daysInWeek });
    }

    if (days.length === 0) {
      return { asOf, trackingStart, days: [], weeks: [], rows: this.emptyRows(analyses, filters) };
    }

    const studentIds = analyses.map((a) => a.studentId);
    const statuses = await this.prisma.infosysDailyStatus.findMany({
      where: { studentId: { in: studentIds }, dayKey: { in: assignedDayKeys } },
      select: { studentId: true, dayKey: true, solvedCount: true },
    });
    const solvedByStudent = new Map<string, Map<string, number>>();
    for (const s of statuses) {
      const m = solvedByStudent.get(s.studentId) ?? new Map<string, number>();
      m.set(s.dayKey, s.solvedCount);
      solvedByStudent.set(s.studentId, m);
    }

    const rows: InfosysDailyReportRow[] = analyses
      .filter((a) => filters.campusName == null || a.campusName === filters.campusName)
      .filter((a) => filters.category == null || a.verdict.category === filters.category)
      .map((a) => {
        const dayMap = solvedByStudent.get(a.studentId);
        const daily: Record<string, number> = {};
        let total = 0;
        for (const dayKey of assignedDayKeys) {
          const solved = dayMap?.get(dayKey) ?? 0;
          daily[dayKey] = solved;
          total += solved;
        }
        return {
          rank: 0,
          studentId: a.studentId,
          name: a.name,
          campusName: a.campusName,
          category: a.verdict.category,
          profileState: a.profileState,
          daily,
          total,
        };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

    rows.forEach((row, i) => (row.rank = i + 1));

    return { asOf, trackingStart, days, weeks, rows };
  }

  /** Before any assignment exists at all — every filtered student still gets a row
   * (§11: a student without a profile still appears), just with no day columns. */
  private emptyRows(
    analyses: Awaited<ReturnType<InfosysAnalyticsService['studentAnalysis']>>,
    filters: InfosysDailyReportFilters,
  ): InfosysDailyReportRow[] {
    return analyses
      .filter((a) => filters.campusName == null || a.campusName === filters.campusName)
      .filter((a) => filters.category == null || a.verdict.category === filters.category)
      .map((a, i) => ({
        rank: i + 1,
        studentId: a.studentId,
        name: a.name,
        campusName: a.campusName,
        category: a.verdict.category,
        profileState: a.profileState,
        daily: {},
        total: 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row, i) => ({ ...row, rank: i + 1 }));
  }

  async buildWorkbook(asOf: DayKey, filters: InfosysDailyReportFilters = {}): Promise<Buffer> {
    const report = await this.buildReport(asOf, filters);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'DSA Tracker';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Infosys Daily Report');

    const FIXED_COLS = 3; // Rank, Student, Campus
    const dayCols = report.days.length;
    const totalCol = FIXED_COLS + dayCols + 1;

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

    // Row 1/2/3 fixed columns, merged vertically across all three header rows.
    sheet.mergeCells(1, 1, 3, 1);
    setHeaderCell(1, 1, 'Rank');
    sheet.mergeCells(1, 2, 3, 2);
    setHeaderCell(1, 2, 'Student');
    sheet.mergeCells(1, 3, 3, 3);
    setHeaderCell(1, 3, 'Campus');
    sheet.mergeCells(1, totalCol, 3, totalCol);
    setHeaderCell(1, totalCol, 'Total Solved');

    // Week headers (row 1, merged across each week's day columns), day headers (row
    // 2), assigned-count headers (row 3).
    let col = FIXED_COLS + 1;
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

    // Data rows.
    let r = 4;
    for (const row of report.rows) {
      sheet.getCell(r, 1).value = row.rank;
      sheet.getCell(r, 2).value = row.name;
      sheet.getCell(r, 3).value = row.campusName ?? '';
      let c = FIXED_COLS + 1;
      for (const day of report.days) {
        sheet.getCell(r, c).value = row.daily[day.dayKey] ?? 0;
        c += 1;
      }
      const firstDayCol = FIXED_COLS + 1;
      const lastDayCol = FIXED_COLS + dayCols;
      sheet.getCell(r, totalCol).value =
        dayCols > 0
          ? { formula: `SUM(${sheet.getCell(r, firstDayCol).address}:${sheet.getCell(r, lastDayCol).address})` }
          : 0;

      for (let cc = 1; cc <= totalCol; cc++) {
        const cell = sheet.getCell(r, cc);
        cell.border = border;
        cell.alignment = cc === 2 || cc === 3 ? { horizontal: 'left', vertical: 'middle' } : center;
      }
      r += 1;
    }

    // Column widths.
    sheet.getColumn(1).width = 7;
    sheet.getColumn(2).width = 26;
    sheet.getColumn(3).width = 34;
    for (let c = FIXED_COLS + 1; c <= FIXED_COLS + dayCols; c++) sheet.getColumn(c).width = 13;
    sheet.getColumn(totalCol).width = 14;

    sheet.views = [{ state: 'frozen', ySplit: 3 }];
    const lastRow = Math.max(r - 1, 3);
    sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: lastRow, column: totalCol } };

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
}
