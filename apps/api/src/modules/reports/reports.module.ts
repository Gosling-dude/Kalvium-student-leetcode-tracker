import { Controller, Get, Module, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  BASELINE_ATTEMPT_STATUS_LABELS,
  displayAttemptStatus,
  EXPORT_FORMATS,
  type ExportFormat,
} from '@dsa/shared';

import { BadRequestException } from '@nestjs/common';
import { CurrentUser, type RequestUser } from '../../common/decorators';
import { BatchesModule } from '../batches/batches.module';
import { CampusesModule } from '../campuses/campuses.module';
import { CampusesService } from '../campuses/campuses.service';
import { DashboardModule } from '../dashboard/dashboard.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { BaselineTestsModule } from '../baseline-tests/baseline-tests.module';
import { BaselineTestsService } from '../baseline-tests/baseline-tests.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { ReportsService, type ReportScope } from './reports.service';


@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly campuses: CampusesService,
    private readonly baseline: BaselineTestsService,
    private readonly mentorScope: MentorScopeService,
  ) {}

  /**
   * The campus/batch slice this caller's report may cover.
   *
   * Every report route goes through this. The daily report and its export already
   * resolved a scope; the weekly, monthly, squad and attendance reports — and the
   * exports built from them — did not, so a mentor downloading an attendance matrix
   * received the whole programme. Routing them all through one helper is what stops the
   * next report added here from being the next one that forgets.
   */
  private async scopeFor(
    user: RequestUser,
    query: { campus?: string; batch?: string },
  ): Promise<ReportScope> {
    const resolved = await this.campuses.resolveScopeFor(user, {
      campus: query.campus,
      batch: query.batch,
    });
    const allowed = await this.mentorScope.allowedCampusIds(user);

    return {
      // A named campus has already been checked against the grants by `resolveScopeFor`;
      // with none named, a mentor is pinned to their grants rather than widened.
      campusIds: resolved.campusId ? [resolved.campusId] : allowed,
      batchId: resolved.batchId,
    };
  }

  /** Rejects a non-numeric cohort rather than silently exporting every cohort. */
  private parseCohort(cohort?: string): number | null {
    if (!cohort) return null;
    const parsed = Number.parseInt(cohort, 10);
    if (Number.isNaN(parsed)) {
      throw new BadRequestException(`"${cohort}" is not a cohort number.`);
    }
    return parsed;
  }

  @Get('daily')
  @ApiOperation({ summary: 'Daily report data, overall or for one campus/batch/cohort' })
  @ApiQuery({ name: 'dayKey', required: false })
  @ApiQuery({ name: 'campus', required: false, description: 'Campus id or code' })
  @ApiQuery({ name: 'batch', required: false, description: 'Batch id, code (A/B) or alias' })
  @ApiQuery({ name: 'cohort', required: false })
  async daily(
    @CurrentUser() user: RequestUser,
    @Query('dayKey') dayKey?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
    @Query('cohort') cohort?: string,
  ) {
    const scope = await this.campuses.resolveScopeFor(user, { campus, batch });
    return this.reports.dailyReport(dayKey, {
      campusId: scope.campusId,
      batchId: scope.batchId,
      cohort: this.parseCohort(cohort),
    });
  }

  @Get('weekly')
  @ApiOperation({ summary: 'Weekly report data' })
  @ApiQuery({ name: 'campus', required: false })
  @ApiQuery({ name: 'batch', required: false })
  async weekly(
    @CurrentUser() user: RequestUser,
    @Query('dayKey') dayKey?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    return this.reports.weeklyReport(dayKey, await this.scopeFor(user, { campus, batch }));
  }

  @Get('monthly')
  @ApiOperation({ summary: 'Monthly report data' })
  @ApiQuery({ name: 'campus', required: false })
  @ApiQuery({ name: 'batch', required: false })
  async monthly(
    @CurrentUser() user: RequestUser,
    @Query('dayKey') dayKey?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    return this.reports.monthlyReport(dayKey, await this.scopeFor(user, { campus, batch }));
  }

  @Get('squads')
  @ApiOperation({ summary: 'Squad report data' })
  async squads(@CurrentUser() user: RequestUser, @Query('dayKey') dayKey?: string) {
    // Squads carry their own campus, so this one narrows by grant directly rather than
    // through `scopeFor` — the squad board has no batch dimension to resolve.
    return this.reports.squadReport(dayKey, await this.mentorScope.allowedCampusIds(user));
  }

  @Get('attendance')
  @ApiOperation({ summary: 'Attendance matrix over a date range' })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  @ApiQuery({ name: 'campus', required: false })
  @ApiQuery({ name: 'batch', required: false })
  async attendance(
    @CurrentUser() user: RequestUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    return this.reports.attendanceReport(from, to, await this.scopeFor(user, { campus, batch }));
  }

  @Get('export/daily')
  @ApiOperation({ summary: 'Download the daily report' })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({ name: 'campus', required: false, description: 'Campus-wise export' })
  @ApiQuery({ name: 'batch', required: false, description: 'Batch-wise export' })
  @ApiQuery({ name: 'cohort', required: false, description: 'Cohort-wise export' })
  async exportDaily(
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
    @Query('dayKey') dayKey?: string,
    @Query('format') format: ExportFormat = 'XLSX',
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
    @Query('cohort') cohort?: string,
  ): Promise<void> {
    const resolved = await this.campuses.resolveScopeFor(user, { campus, batch });
    const cohortNumber = this.parseCohort(cohort);
    const report = await this.reports.dailyReport(dayKey, {
      campusId: resolved.campusId,
      batchId: resolved.batchId,
      cohort: cohortNumber,
    });

    // The filename names the slice, so a folder of exports stays self-describing — and
    // so two campuses' exports for the same day never collide in a downloads folder.
    const scope = [
      resolved.campusCode,
      report.sections.length === 1 ? report.sections[0]!.batchCode : null,
      cohortNumber ? `cohort-${cohortNumber}` : null,
    ]
      .filter(Boolean)
      .join('-');

    const payload = await this.reports.export(
      format,
      `daily-report-${report.dayKey}${scope ? `-${scope}` : ''}`,
      [
        { header: 'Student', key: 'name', width: 26 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Squad', key: 'squad', width: 16 },
        { header: 'Batch', key: 'batch', width: 20 },
        { header: 'Cohort', key: 'cohort', width: 8 },
        { header: 'Max Belt', key: 'maxBeltLevel', width: 10 },
        { header: 'LeetCode', key: 'leetcodeUsername', width: 20 },
        { header: 'Assigned', key: 'assigned', width: 10 },
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
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
    @Query('dayKey') dayKey?: string,
    @Query('format') format: ExportFormat = 'XLSX',
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ): Promise<void> {
    const report = await this.reports.weeklyReport(
      dayKey,
      await this.scopeFor(user, { campus, batch }),
    );
    const payload = await this.reports.export(
      format,
      `weekly-report-${report.from}-to-${report.to}`,
      [
        { header: 'Student', key: 'name', width: 26 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Squad', key: 'squad', width: 16 },
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
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('format') format: ExportFormat = 'XLSX',
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ): Promise<void> {
    const report = await this.reports.attendanceReport(
      from,
      to,
      await this.scopeFor(user, { campus, batch }),
    );
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

  @Get('export/baseline')
  @ApiOperation({
    summary: "Download one baseline test's student-wise results",
    description:
      'Every eligible student, in board order, including those who never started — the ' +
      'export has to reconcile with the leaderboard it was taken from, and a file that ' +
      'quietly drops the absent students does not.',
  })
  @ApiQuery({ name: 'testId', required: true })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({ name: 'squad', required: false })
  async exportBaseline(
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
    @Query('testId') testId: string,
    @Query('format') format: ExportFormat = 'XLSX',
    @Query('squad') squad?: string,
  ): Promise<void> {
    if (!testId) throw new BadRequestException('testId is required.');

    // An export is a read of the same board, so it needs the same check the board does.
    // Without it this route was the way to obtain another campus's baseline results in
    // full — names, emails, per-student scores — by naming its test id.
    this.mentorScope.assertEntityCampusAllowed(
      await this.baseline.findCampusOf(testId),
      await this.mentorScope.allowedCampusIds(user),
      { entity: 'Baseline test', id: testId },
    );

    const board = await this.baseline.leaderboard(testId, { squad });
    const payload = await this.reports.export(
      format,
      `baseline-${board.dayKey}-${board.testTitle}${squad ? `-${squad}` : ''}`,
      [
        { header: 'Rank', key: 'rank', width: 8 },
        { header: 'Student', key: 'studentName', width: 26 },
        { header: 'Email', key: 'studentEmail', width: 30 },
        { header: 'Squad', key: 'squadName', width: 16 },
        { header: 'Campus', key: 'campusName', width: 22 },
        { header: 'Batch', key: 'batchName', width: 20 },
        { header: 'Baseline Test', key: 'testTitle', width: 24 },
        { header: 'Total Questions', key: 'totalQuestions', width: 16 },
        { header: 'Solved', key: 'solvedCount', width: 10 },
        { header: 'Not Solved', key: 'notSolvedCount', width: 12 },
        { header: 'Score %', key: 'percent', width: 10 },
        // Participation is reported as the observation it is — whether anyone opened the
        // test in the portal — and never as an attendance mark. It does not enter the
        // score, and a student who never opened it can still be 3 of 4.
        { header: 'Opened In Portal', key: 'participation', width: 18 },
        { header: 'Sync Status', key: 'syncStatus', width: 16 },
        { header: 'Last Successful Sync', key: 'lastSuccessfulSyncAt', width: 24 },
      ],
      board.rows.map((row) => ({
        ...row,
        testTitle: board.testTitle,
        // Rank now describes performance, which every measured student has whether or not
        // they sat the test. Only an unmeasured student has no standing to report, and the
        // screen shows a dash there for the same reason.
        rank: row.performanceKnown ? row.rank : '—',
        solvedCount: row.performanceKnown ? row.solvedCount : '—',
        notSolvedCount: row.performanceKnown ? row.notSolvedCount : '—',
        percent: row.performanceKnown ? row.percent : 'not synced',
        participation: BASELINE_ATTEMPT_STATUS_LABELS[displayAttemptStatus(row.status)],
        lastSuccessfulSyncAt: row.lastSuccessfulSyncAt ?? '',
        syncStatus: row.syncStatus ?? '',
      })),
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
  imports: [
    DashboardModule,
    LeaderboardModule,
    BatchesModule,
    CampusesModule,
    // One-directional on purpose: reports may read baseline results, while
    // `BaselineTestsModule` still has no handle on leaderboards or scoring, so a baseline
    // score cannot reach a streak or a daily rank (§25, §39).
    BaselineTestsModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
