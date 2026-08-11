/**
 * The scheduled workloads, callable from anywhere.
 *
 * Both the HTTP cron endpoints (triggered by GitHub Actions) and the standalone
 * `dist/jobs/cron.js` entrypoint run exactly this code, so there is one definition of
 * "what a sync does" and "what a nightly rollup does" — not three subtly different ones.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DayKey, EmailReportRecord, SyncJobSummary } from '@dsa/shared';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { RollupService } from '../scoring/rollup.service';
import { SyncService } from '../sync/sync.service';
import { EmailReportsService } from '../email-reports/email-reports.service';
import { NotificationsService } from '../notifications/notifications.module';

export interface RollupResult {
  dayKey: string;
  prunedTokens: number;
  prunedAuditLogs: number;
  prunedSystemLogs: number;
}

@Injectable()
export class CronTasksService {
  private readonly logger = new Logger(CronTasksService.name);

  constructor(
    private readonly sync: SyncService,
    private readonly rollup: RollupService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly time: ProgramTimeService,
    private readonly emailReports: EmailReportsService,
    private readonly notifications: NotificationsService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /**
   * Run an incremental sync to completion.
   *
   * Returns the terminal job summary, or `null` when there is nothing to sync (no active
   * students yet) — an expected pre-import state, not a failure.
   */
  async runSync(): Promise<SyncJobSummary | null> {
    this.logger.log('Starting incremental sync');
    const result = await this.sync.runToCompletion({ mode: 'INCREMENTAL', trigger: 'CRON' });
    if (!result) {
      this.logger.warn('Sync skipped: no active students.');
      return null;
    }
    this.logger.log(
      `Sync ${result.status}: ${result.succeededStudents}/${result.totalStudents} ok, ` +
        `${result.newSubmissions} new submissions`,
    );
    return result;
  }

  /**
   * Nightly close-out for the day that just ended, plus housekeeping. Runs against
   * *yesterday* (in the program timezone) because it fires just after midnight.
   */
  async runNightlyRollup(): Promise<RollupResult> {
    const yesterday = this.time.yesterday();
    this.logger.log(`Running nightly rollup for ${yesterday}`);

    await this.rollup.recomputeDay(yesterday);
    await this.rollup.recomputeStudentAggregates();
    await this.rollup.rebuildLeaderboards(yesterday);

    const prunedTokens = await this.auth.pruneExpiredTokens();
    const prunedLogs = await this.audit.pruneOlderThan(180);

    await this.audit.log('INFO', 'CronTasks', `Nightly rollup for ${yesterday} complete`, {
      prunedTokens,
      prunedAuditLogs: prunedLogs.audit,
      prunedSystemLogs: prunedLogs.system,
    });

    this.logger.log(`Nightly rollup for ${yesterday} complete`);
    return {
      dayKey: yesterday,
      prunedTokens,
      prunedAuditLogs: prunedLogs.audit,
      prunedSystemLogs: prunedLogs.system,
    };
  }

  /**
   * Daily report automation (§15, §28): generate the report for the day that just
   * closed, render it as an email, and leave it `PENDING_APPROVAL`.
   *
   * This method never calls `EmailReportsService.send` and never will — the approval
   * gate is enforced inside that service regardless, but the point is that nothing on
   * this path even attempts it. A human still has to open the Email Reports page and
   * click Approve & Send.
   *
   * Runs against *yesterday* by default, same as the rollup, and should be scheduled
   * after it: this is only useful once that day's `DailyStatus` rows are final.
   */
  async runDailyReportGeneration(dayKey?: DayKey): Promise<EmailReportRecord | null> {
    const day = dayKey ?? this.time.yesterday();
    this.logger.log(`Generating daily report email for ${day}`);

    const { fromEmail, defaultTo, defaultCc } = this.config.email;
    if (!fromEmail || defaultTo.length === 0) {
      this.logger.warn(
        `Skipping automated report for ${day}: EMAIL_FROM and/or EMAIL_DEFAULT_TO are not configured.`,
      );
      return null;
    }

    const draft = await this.emailReports.generateDraft(
      day,
      { fromEmail, toRecipients: defaultTo, ccRecipients: defaultCc },
      null,
    );
    const pending = await this.emailReports.submitForApproval(draft.id);

    await this.notifications.dispatch({
      event: 'DAILY_REPORT_PENDING_APPROVAL',
      title: `Daily DSA report for ${day} is ready for approval`,
      body:
        `The automated daily report for ${day} has been generated and is waiting for a ` +
        `mentor or admin to review and send it from the Email Reports page.`,
      data: { dayKey: day, emailReportId: pending.id },
    });

    await this.audit.log('INFO', 'CronTasks', `Daily report for ${day} generated and pending approval`, {
      emailReportId: pending.id,
      toRecipients: defaultTo,
    });

    this.logger.log(`Daily report for ${day} is PENDING_APPROVAL (id ${pending.id})`);
    return pending;
  }
}
