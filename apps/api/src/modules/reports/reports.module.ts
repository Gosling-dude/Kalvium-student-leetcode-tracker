import { Controller, Get, Module, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { EXPORT_FORMATS, type ExportFormat } from '@dsa/shared';

import { DashboardModule } from '../dashboard/dashboard.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { ReportsService } from './reports.service';

@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily')
  @ApiOperation({ summary: 'Daily report data' })
  @ApiQuery({ name: 'dayKey', required: false })
  daily(@Query('dayKey') dayKey?: string) {
    return this.reports.dailyReport(dayKey);
  }

  @Get('weekly')
  @ApiOperation({ summary: 'Weekly report data' })
  weekly(@Query('dayKey') dayKey?: string) {
    return this.reports.weeklyReport(dayKey);
  }

  @Get('monthly')
  @ApiOperation({ summary: 'Monthly report data' })
  monthly(@Query('dayKey') dayKey?: string) {
    return this.reports.monthlyReport(dayKey);
  }

  @Get('groups')
  @ApiOperation({ summary: 'Group report data' })
  groups(@Query('dayKey') dayKey?: string) {
    return this.reports.groupReport(dayKey);
  }

  @Get('attendance')
  @ApiOperation({ summary: 'Attendance matrix over a date range' })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  attendance(@Query('from') from: string, @Query('to') to: string) {
    return this.reports.attendanceReport(from, to);
  }

  @Get('export/daily')
  @ApiOperation({ summary: 'Download the daily report' })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  async exportDaily(
    @Res() res: Response,
    @Query('dayKey') dayKey?: string,
    @Query('format') format: ExportFormat = 'XLSX',
  ): Promise<void> {
    const report = await this.reports.dailyReport(dayKey);
    const payload = await this.reports.export(
      format,
      `daily-report-${report.dayKey}`,
      [
        { header: 'Student', key: 'name', width: 26 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Group', key: 'group', width: 16 },
        { header: 'Batch', key: 'batch', width: 16 },
        { header: 'LeetCode', key: 'leetcodeUsername', width: 20 },
        { header: 'Solved', key: 'solved', width: 8 },
        { header: 'Completed At', key: 'completionTime', width: 14 },
        { header: 'Streak', key: 'streak', width: 8 },
        { header: 'Score', key: 'score', width: 8 },
        { header: 'Rank', key: 'rank', width: 8 },
        { header: 'Missing Questions', key: 'missing', width: 40 },
        { header: 'Sync Status', key: 'syncStatus', width: 18 },
        { header: 'Reason', key: 'reason', width: 36 },
      ],
      report.rows,
    );
    this.send(res, payload);
  }

  @Get('export/leaderboard')
  @ApiOperation({ summary: 'Download the daily report grouped by bucket' })
  async exportWeekly(
    @Res() res: Response,
    @Query('dayKey') dayKey?: string,
    @Query('format') format: ExportFormat = 'XLSX',
  ): Promise<void> {
    const report = await this.reports.weeklyReport(dayKey);
    const payload = await this.reports.export(
      format,
      `weekly-report-${report.from}-to-${report.to}`,
      [
        { header: 'Student', key: 'name', width: 26 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Group', key: 'group', width: 16 },
        { header: 'Batch', key: 'batch', width: 16 },
        { header: 'Solved', key: 'solved', width: 10 },
        { header: 'Assigned', key: 'assigned', width: 10 },
        { header: 'Completion %', key: 'completionPercent', width: 14 },
        { header: 'Score', key: 'score', width: 10 },
        { header: 'Streak', key: 'streak', width: 10 },
      ],
      report.rows,
    );
    this.send(res, payload);
  }

  @Get('export/attendance')
  @ApiOperation({ summary: 'Download the attendance matrix' })
  async exportAttendance(
    @Res() res: Response,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('format') format: ExportFormat = 'XLSX',
  ): Promise<void> {
    const report = await this.reports.attendanceReport(from, to);
    const payload = await this.reports.export(
      format,
      `attendance-${from}-to-${to}`,
      [
        { header: 'Student', key: 'name', width: 26 },
        { header: 'Email', key: 'email', width: 30 },
        ...report.days.map((day) => ({ header: day.slice(5), key: day, width: 8 })),
        { header: 'Days Active', key: 'daysActive', width: 12 },
        { header: 'Attendance %', key: 'attendancePercent', width: 14 },
      ],
      report.rows as unknown as Record<string, unknown>[],
    );
    this.send(res, payload);
  }

  private send(res: Response, payload: { filename: string; contentType: string; buffer: Buffer }) {
    res.setHeader('Content-Type', payload.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}"`);
    res.setHeader('Content-Length', payload.buffer.length);
    res.send(payload.buffer);
  }
}

@Module({
  imports: [DashboardModule, LeaderboardModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
