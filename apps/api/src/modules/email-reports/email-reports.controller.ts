/**
 * Daily email reporting API (§19).
 *
 * Restricted to ADMIN/MENTOR — a VIEWER can see the dashboard elsewhere in the app but
 * has no business generating or sending campus-wide email, per the spec's access rule.
 * Every mutating route is `@Audit`-logged by the global `AuditInterceptor`.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { EXPORT_FORMATS, type ExportFormat } from '@dsa/shared';

import { Audit, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { ReportsService } from '../reports/reports.service';
import { CampusesService } from '../campuses/campuses.service';
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
    private readonly campuses: CampusesService,
  ) {}

  // --- Report reconstruction ------------------------------------------------

  @Get('daily/:date')
  @ApiOperation({ summary: 'Full daily report for one date — summary, buckets, action items, blockers' })
  @ApiQuery({ name: 'squadId', required: false })
  @ApiQuery({ name: 'campus', required: false, description: 'Campus id or code' })
  @ApiQuery({ name: 'batch', required: false, description: 'Batch id, code (A/B) or alias' })
  async daily(
    @Param('date') date: string,
    @Query('squadId') squadId?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    const scope = await this.campuses.resolveScope({ campus, batch });
    return this.dailyReport.build(date, {
      squadId,
      campusId: scope.campusId,
      batchId: scope.batchId,
    });
  }

  @Get('daily/:date/summary')
  @ApiOperation({ summary: 'Just the summary card numbers for one date' })
  @ApiQuery({ name: 'campus', required: false, description: 'Campus id or code' })
  @ApiQuery({ name: 'batch', required: false })
  async summary(
    @Param('date') date: string,
    @Query('squadId') squadId?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    const scope = await this.campuses.resolveScope({ campus, batch });
    const report = await this.dailyReport.build(date, {
      squadId,
      campusId: scope.campusId,
      batchId: scope.batchId,
    });
    return report.summary;
  }

  @Get('daily/:date/students')
  @ApiOperation({ summary: 'The student table for one date' })
  @ApiQuery({ name: 'tier', required: false, description: 'Filter by action tier' })
  @ApiQuery({ name: 'campus', required: false, description: 'Campus id or code' })
  @ApiQuery({ name: 'batch', required: false })
  async students(
    @Param('date') date: string,
    @Query('squadId') squadId?: string,
    @Query('tier') tier?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    const scope = await this.campuses.resolveScope({ campus, batch });
    const report = await this.dailyReport.build(date, {
      squadId,
      campusId: scope.campusId,
      batchId: scope.batchId,
    });
    return tier ? report.students.filter((s) => s.actionTier === tier) : report.students;
  }

  @Get('daily/:date/export')
  @ApiOperation({ summary: 'Download the student table (CSV/XLSX)' })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({ name: 'campus', required: false, description: 'Campus id or code' })
  @ApiQuery({ name: 'batch', required: false })
  @ApiQuery({ name: 'cohort', required: false, description: 'Restrict the export to one cohort' })
  async exportDaily(
    @Res() res: Response,
    @Param('date') date: string,
    @Query('format') format: ExportFormat = 'CSV',
    @Query('squadId') squadId?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
    @Query('cohort') cohort?: string,
  ): Promise<void> {
    const scope = await this.campuses.resolveScope({ campus, batch });
    const report = await this.dailyReport.build(date, {
      squadId,
      campusId: scope.campusId,
      batchId: scope.batchId,
    });

    // Cohort narrowing happens here rather than in the report build: the report is the
    // batch's full picture, and an export is a slice of it (§5).
    const cohortNumber = cohort ? Number.parseInt(cohort, 10) : null;
    if (cohort && Number.isNaN(cohortNumber)) {
      throw new BadRequestException(`"${cohort}" is not a cohort number.`);
    }

    const exported = cohortNumber
      ? report.students.filter((s) => s.cohort === cohortNumber)
      : report.students;

    const rows = exported.map((s) => ({
      student: s.name,
      email: s.email,
      squad: s.squadName ?? '',
      batch: s.batchName ?? '',
      cohort: s.cohort ?? '',
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
      [
        'daily-email-report',
        report.summary.dayKey,
        report.summary.batchCode ? `batch-${report.summary.batchCode}` : null,
        cohortNumber ? `cohort-${cohortNumber}` : null,
      ]
        .filter(Boolean)
        .join('-'),
      [
        { header: 'Student', key: 'student', width: 26 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Squad', key: 'squad', width: 14 },
        { header: 'Batch', key: 'batch', width: 20 },
        { header: 'Cohort', key: 'cohort', width: 8 },
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
  async history(@Query() query: ListEmailHistoryDto) {
    const scope = await this.campuses.resolveScope({ campus: query.campus, batch: query.batch });
    return this.emailReports.history({
      ...query,
      campusId: scope.campusId,
      batchId: scope.batchId,
    });
  }

  @Get('email/status')
  @ApiOperation({ summary: 'Whether a date already has a sent (or in-flight) report' })
  @ApiQuery({ name: 'dayKey', required: true })
  @ApiQuery({ name: 'campus', required: false, description: 'Campus id or code' })
  @ApiQuery({ name: 'batch', required: false })
  async status(
    @Query('dayKey') dayKey: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    const scope = await this.campuses.resolveScope({ campus, batch });
    return this.emailReports.statusForDay(dayKey, scope.batchId, scope.campusId);
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
