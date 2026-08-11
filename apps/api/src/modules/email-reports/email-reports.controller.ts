/**
 * Daily email reporting API (§19).
 *
 * Restricted to ADMIN/MENTOR — a VIEWER can see the dashboard elsewhere in the app but
 * has no business generating or sending campus-wide email, per the spec's access rule.
 * Every mutating route is `@Audit`-logged by the global `AuditInterceptor`.
 */

import { Controller, Get, Post, Patch, Body, Param, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { EXPORT_FORMATS, type ExportFormat } from '@dsa/shared';

import { Audit, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { ReportsService } from '../reports/reports.service';
import { DailyReportService } from './daily-report.service';
import { EmailReportsService } from './email-reports.service';
import { BlockersService } from './blockers.service';
import {
  ApproveEmailDto,
  CreateBlockerDto,
  GenerateEmailDto,
  ListEmailHistoryDto,
  PreviewEmailDto,
  SendEmailDto,
  UpdateBlockerDto,
} from './dto/email-reports.dto';

@ApiTags('Reports')
@ApiBearerAuth()
@Roles('ADMIN', 'MENTOR')
@Controller('reports')
export class EmailReportsController {
  constructor(
    private readonly dailyReport: DailyReportService,
    private readonly emailReports: EmailReportsService,
    private readonly blockers: BlockersService,
    private readonly exportService: ReportsService,
  ) {}

  // --- Report reconstruction ------------------------------------------------

  @Get('daily/:date')
  @ApiOperation({ summary: 'Full daily report for one date — summary, buckets, action items, blockers' })
  @ApiQuery({ name: 'squadId', required: false })
  daily(@Param('date') date: string, @Query('squadId') squadId?: string) {
    return this.dailyReport.build(date, squadId);
  }

  @Get('daily/:date/summary')
  @ApiOperation({ summary: 'Just the summary card numbers for one date' })
  async summary(@Param('date') date: string, @Query('squadId') squadId?: string) {
    return (await this.dailyReport.build(date, squadId)).summary;
  }

  @Get('daily/:date/students')
  @ApiOperation({ summary: 'The student table for one date' })
  @ApiQuery({ name: 'tier', required: false, description: 'Filter by action tier' })
  async students(
    @Param('date') date: string,
    @Query('squadId') squadId?: string,
    @Query('tier') tier?: string,
  ) {
    const report = await this.dailyReport.build(date, squadId);
    return tier ? report.students.filter((s) => s.actionTier === tier) : report.students;
  }

  @Get('daily/:date/export')
  @ApiOperation({ summary: 'Download the student table (CSV/XLSX)' })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  async exportDaily(
    @Res() res: Response,
    @Param('date') date: string,
    @Query('format') format: ExportFormat = 'CSV',
    @Query('squadId') squadId?: string,
  ): Promise<void> {
    const report = await this.dailyReport.build(date, squadId);
    const rows = report.students.map((s) => ({
      student: s.name,
      email: s.email,
      squad: s.squadName ?? '',
      date: report.summary.dayKey,
      assigned: s.assignedCount,
      solved: s.solvedCount,
      completionPercent: s.completionPercent,
      status: s.statusLabel,
      blocker: s.blocker
        ? s.blocker.category === 'NO_BLOCKER'
          ? 'No blocker'
          : (s.blocker.description ?? s.blocker.category)
        : 'No blocker reported',
      actionRequired: s.actionRequired,
    }));

    const payload = await this.exportService.export(
      format,
      `daily-email-report-${report.summary.dayKey}`,
      [
        { header: 'Student', key: 'student', width: 26 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Squad', key: 'squad', width: 14 },
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Assigned', key: 'assigned', width: 10 },
        { header: 'Solved', key: 'solved', width: 10 },
        { header: 'Completion %', key: 'completionPercent', width: 14 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Blocker', key: 'blocker', width: 36 },
        { header: 'Action Required', key: 'actionRequired', width: 44 },
      ],
      rows,
    );

    res.setHeader('Content-Type', payload.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}"`);
    res.setHeader('Content-Length', payload.buffer.length);
    res.send(payload.buffer);
  }

  // --- Email generation & approval workflow ---------------------------------

  @Post('daily/:date/generate-email')
  @ApiOperation({ summary: 'Render the report as an email and save it as a DRAFT' })
  @Audit('EMAIL_REPORT_GENERATED', 'EmailReport')
  generateEmail(
    @Param('date') date: string,
    @Body() dto: GenerateEmailDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.emailReports.generateDraft(date, dto, user.id);
  }

  @Post('email/preview')
  @ApiOperation({ summary: 'Re-render a draft with edited recipients/subject (the "Edit" step)' })
  preview(@Body() dto: PreviewEmailDto) {
    return this.emailReports.previewOrEdit(dto);
  }

  @Post('email/approve')
  @ApiOperation({ summary: 'Approval gate — required before send' })
  @Audit('EMAIL_REPORT_APPROVED', 'EmailReport')
  approve(@Body() dto: ApproveEmailDto, @CurrentUser() user: RequestUser) {
    return this.emailReports.approve(dto.emailReportId, user.id);
  }

  @Post('email/send')
  @ApiOperation({ summary: 'Send an APPROVED report. Refused for anything else.' })
  @Audit('EMAIL_REPORT_SENT', 'EmailReport')
  // Sending real email to real recipients — a much tighter ceiling than the app default.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  send(@Body() dto: SendEmailDto, @CurrentUser() user: RequestUser) {
    return this.emailReports.send(dto.emailReportId, user.id, dto.force ?? false);
  }

  @Get('email/history')
  @ApiOperation({ summary: 'Email report history' })
  history(@Query() query: ListEmailHistoryDto) {
    return this.emailReports.history(query);
  }

  @Get('email/status')
  @ApiOperation({ summary: 'Whether a date already has a sent (or in-flight) report' })
  @ApiQuery({ name: 'dayKey', required: true })
  status(@Query('dayKey') dayKey: string) {
    return this.emailReports.statusForDay(dayKey);
  }

  @Get('email/:id')
  @ApiOperation({ summary: 'View a specific report from history' })
  findOne(@Param('id') id: string) {
    return this.emailReports.findById(id);
  }

  // --- Blockers ---------------------------------------------------------------

  @Post('blockers')
  @ApiOperation({ summary: 'Record (or update) a blocker for one student on one day' })
  @Audit('BLOCKER_RECORDED', 'Blocker')
  createBlocker(@Body() dto: CreateBlockerDto, @CurrentUser() user: RequestUser) {
    return this.blockers.create(dto, user.id);
  }

  @Patch('blockers/:id')
  @ApiOperation({ summary: 'Update a blocker record' })
  @Audit('BLOCKER_UPDATED', 'Blocker')
  updateBlocker(
    @Param('id') id: string,
    @Body() dto: UpdateBlockerDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.blockers.update(id, dto, user.id);
  }

  @Get('blockers')
  @ApiOperation({ summary: 'List blockers for a day and/or student' })
  @ApiQuery({ name: 'dayKey', required: false })
  @ApiQuery({ name: 'studentId', required: false })
  listBlockers(@Query('dayKey') dayKey?: string, @Query('studentId') studentId?: string) {
    return this.blockers.list(dayKey, studentId);
  }
}
