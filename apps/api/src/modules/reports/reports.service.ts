/**
 * Report generation and export.
 *
 * Exports are streamed from the same services the UI reads, so a downloaded CSV and
 * the on-screen table can never disagree.
 */

import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { DayKey, ExportFormat } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';

export interface ExportPayload {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

interface Column {
  header: string;
  key: string;
  width?: number;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    private readonly dashboard: DashboardService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  /**
   * Daily report: every student's outcome for a day, optionally narrowed to one batch
   * and/or cohort — the batch-wise, cohort-wise and all-students exports (§5).
   */
  async dailyReport(
    dayKey?: DayKey,
    filter: { batchId?: string | null; cohort?: number | null } = {},
  ) {
    const day = dayKey ?? this.time.today();
    const mentor = await this.dashboard.getMentorDashboard(day, { batchId: filter.batchId });

    const students = mentor.buckets
      .flatMap((bucket) => bucket.students)
      .filter((student) => filter.cohort == null || student.cohort === filter.cohort);

    return {
      dayKey: day,
      batchId: mentor.batchId,
      assignment: mentor.assignment,
      sections: mentor.sections.map((section) => ({
        batchId: section.batchId,
        batchName: section.batchName,
        batchCode: section.batchCode,
        assignedCount: section.assignedCount,
        totalStudents: section.totalStudents,
      })),
      totalStudents: students.length,
      rows: students.map((student) => ({
          name: student.name,
          email: student.email,
          squad: student.squadName ?? '',
          batch: student.batchName ?? '',
          cohort: student.cohort ?? '',
          maxBeltLevel: student.maxBeltLevel ?? '',
          leetcodeUsername: student.leetcodeUsername,
          assigned: student.assignedCount,
          solved: student.solvedCount,
          completionTime: student.completionTime ?? '',
          streak: student.currentStreak,
          score: student.score,
          rank: student.rank ?? '',
          missing: student.missingProblems.join(' | '),
          syncStatus: student.syncStatus,
          reason: student.reason ?? '',
      })),
    };
  }

  /** Attendance: whether a student engaged at all, per day, over a range. */
  async attendanceReport(from: DayKey, to: DayKey) {
    const statuses = await this.prisma.dailyStatus.findMany({
      where: { dayKey: { gte: from, lte: to }, student: { status: 'ACTIVE' } },
      include: { student: { select: { id: true, name: true, email: true } } },
      orderBy: { dayKey: 'asc' },
    });

    const days = this.time.range(from, to);
    const byStudent = new Map<string, { name: string; email: string; days: Map<string, number> }>();

    for (const status of statuses) {
      const entry = byStudent.get(status.studentId) ?? {
        name: status.student.name,
        email: status.student.email,
        days: new Map<string, number>(),
      };
      entry.days.set(status.dayKey, status.solvedCount);
      byStudent.set(status.studentId, entry);
    }

    return {
      from,
      to,
      days,
      rows: [...byStudent].map(([studentId, entry]) => {
        const present = days.filter((day) => (entry.days.get(day) ?? 0) > 0).length;
        return {
          studentId,
          name: entry.name,
          email: entry.email,
          ...Object.fromEntries(days.map((day) => [day, entry.days.get(day) ?? 0])),
          daysActive: present,
          attendancePercent:
            days.length > 0 ? Math.round((present / days.length) * 10000) / 100 : 0,
        };
      }),
    };
  }

  async weeklyReport(dayKey?: DayKey) {
    const day = dayKey ?? this.time.today();
    const { from, to } = this.time.weekBounds(day);
    return this.periodReport(from, to, 'weekly');
  }

  async monthlyReport(dayKey?: DayKey) {
    const day = dayKey ?? this.time.today();
    const { from, to } = this.time.monthBounds(day);
    return this.periodReport(from, to, 'monthly');
  }

  private async periodReport(from: DayKey, to: DayKey, label: string) {
    const rows = await this.prisma.dailyStatus.groupBy({
      by: ['studentId'],
      where: { dayKey: { gte: from, lte: to }, student: { status: 'ACTIVE' } },
      _sum: { solvedCount: true, assignedCount: true, score: true },
      _count: { _all: true },
    });

    const students = await this.prisma.student.findMany({
      where: { id: { in: rows.map((r) => r.studentId) } },
      include: { squad: { select: { name: true } }, batch: { select: { name: true } } },
    });
    const byId = new Map(students.map((s) => [s.id, s]));

    return {
      period: label,
      from,
      to,
      rows: rows
        .map((row) => {
          const student = byId.get(row.studentId);
          const solved = row._sum.solvedCount ?? 0;
          const assigned = row._sum.assignedCount ?? 0;
          return {
            studentId: row.studentId,
            name: student?.name ?? 'Unknown',
            email: student?.email ?? '',
            squad: student?.squad?.name ?? '',
            batch: student?.batch?.name ?? '',
            solved,
            assigned,
            completionPercent:
              assigned > 0 ? Math.round((solved / assigned) * 10000) / 100 : 0,
            score: row._sum.score ?? 0,
            streak: student?.currentStreak ?? 0,
          };
        })
        .sort((a, b) => b.score - a.score),
    };
  }

  async squadReport(dayKey?: DayKey) {
    const day = dayKey ?? this.time.today();
    const rows = await this.leaderboard.getSquadLeaderboard('MONTHLY', day);
    return { dayKey: day, rows };
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  async export(
    format: ExportFormat,
    title: string,
    columns: Column[],
    rows: Record<string, unknown>[],
  ): Promise<ExportPayload> {
    const safeTitle = title.replace(/[^a-z0-9-_]/gi, '-').toLowerCase();

    switch (format) {
      case 'CSV':
        return {
          filename: `${safeTitle}.csv`,
          contentType: 'text/csv; charset=utf-8',
          buffer: this.toCsv(columns, rows),
        };
      case 'PDF':
        return {
          filename: `${safeTitle}.pdf`,
          contentType: 'application/pdf',
          buffer: await this.toPdf(title, columns, rows),
        };
      case 'JSON':
        return {
          filename: `${safeTitle}.json`,
          contentType: 'application/json',
          buffer: Buffer.from(JSON.stringify(rows, null, 2), 'utf8'),
        };
      case 'XLSX':
      default:
        return {
          filename: `${safeTitle}.xlsx`,
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: await this.toXlsx(title, columns, rows),
        };
    }
  }

  private toCsv(columns: Column[], rows: Record<string, unknown>[]): Buffer {
    const escape = (value: unknown): string => {
      const text = value === null || value === undefined ? '' : String(value);
      // Quote when the value contains a delimiter, quote or newline; double inner quotes.
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [
      columns.map((column) => escape(column.header)).join(','),
      ...rows.map((row) => columns.map((column) => escape(row[column.key])).join(',')),
    ];

    // BOM so Excel opens UTF-8 correctly rather than mangling non-ASCII names.
    return Buffer.from(`﻿${lines.join('\r\n')}`, 'utf8');
  }

  private async toXlsx(
    title: string,
    columns: Column[],
    rows: Record<string, unknown>[],
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'DSA Tracker';
    workbook.created = new Date();

    // Excel rejects sheet names over 31 characters or containing []*/\?:
    const sheet = workbook.addWorksheet(title.replace(/[[\]*/\\?:]/g, '-').slice(0, 31) || 'Report');

    sheet.columns = columns.map((column) => ({
      header: column.header,
      key: column.key,
      width: column.width ?? 20,
    }));

    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    header.alignment = { vertical: 'middle' };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const row of rows) sheet.addRow(row);

    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: Math.max(columns.length, 1) },
    };

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  private toPdf(
    title: string,
    columns: Column[],
    rows: Record<string, unknown>[],
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // Landscape: these reports are wide, and portrait truncates the useful columns.
      const doc = new PDFDocument({ margin: 32, size: 'A4', layout: 'landscape' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(16).text(title, { align: 'left' });
      doc
        .fontSize(9)
        .fillColor('#666')
        .text(`Generated ${new Date().toISOString()} • ${rows.length} rows`);
      doc.moveDown(0.8).fillColor('#000');

      const pageWidth = doc.page.width - 64;
      const columnWidth = pageWidth / Math.max(columns.length, 1);
      const rowHeight = 16;

      const drawHeader = (): void => {
        doc.fontSize(8).font('Helvetica-Bold');
        columns.forEach((column, index) => {
          doc.text(column.header, 32 + index * columnWidth, doc.y, {
            width: columnWidth - 4,
            ellipsis: true,
            continued: false,
          });
        });
        doc.moveDown(0.4);
        doc.font('Helvetica');
      };

      drawHeader();
      let y = doc.y;

      for (const row of rows) {
        // Manual pagination: pdfkit will not wrap a hand-positioned table for us.
        if (y > doc.page.height - 48) {
          doc.addPage();
          y = 48;
          doc.y = y;
          drawHeader();
          y = doc.y;
        }

        doc.fontSize(8);
        columns.forEach((column, index) => {
          const value = row[column.key];
          doc.text(
            value === null || value === undefined ? '' : String(value),
            32 + index * columnWidth,
            y,
            { width: columnWidth - 4, ellipsis: true, lineBreak: false },
          );
        });
        y += rowHeight;
      }

      doc.end();
    });
  }
}
