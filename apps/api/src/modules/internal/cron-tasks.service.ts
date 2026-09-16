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
import { BatchesService } from '../batches/batches.service';

/**
 * Why a daily-report run produced nothing, when it produced nothing.
 *
 * `null` alongside a non-empty `generated` is the healthy case. The named reasons exist so
 * the caller can fail loudly: an automation that quietly generates zero reports every
 * night is indistinguishable from one that is working, unless it says so.
 */
export type DailyReportSkipReason = 'EMAIL_NOT_CONFIGURED' | 'GENERATION_FAILED';

export interface DailyReportGenerationResult {
  generated: EmailReportRecord[];
  skipped: DailyReportSkipReason | null;
}

export interface RollupResult {
  dayKey: string;
  prunedTokens: number;
  prunedAuditLogs: number;
  prunedSystemLogs: number;
  /** Days re-derived because their stored figures came from a superseded rule set. */
  supersededDaysHealed: number;
  /** How many such days are still outstanding after this run. */
  supersededDaysRemaining: number;
}

/**
 * How many superseded days one nightly rollup will re-derive.
 *
 * Small enough that the nightly job keeps its shape — a day-close, not a rebuild — and
 * large enough to clear a six-week programme's backlog within a week of a rule change.
 * `POST /admin/recompute/stale` clears the whole backlog at once when somebody wants it
 * now rather than by the weekend.
 */
const SUPERSEDED_DAYS_PER_NIGHT = 7;

/**
 * How many superseded days one *explicit* backlog run will re-derive.
 *
 * Larger than the nightly budget because this is somebody deliberately clearing a
 * backlog, and smaller than "all of them" because the free-tier instance and the HTTP
 * request in front of it both have limits, and a run that dies halfway through a
 * 40-day rebuild is worse than four runs that each finish. The caller loops on
 * `remaining`; each day is stamped as it is written, so a killed run loses only the day
 * it was on.
 */
const SUPERSEDED_DAYS_PER_BATCH = 10;

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
    private readonly batches: BatchesService,
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

    // Work off any backlog left by a rule change, oldest first and a few days per night.
    //
    // Bounded on purpose. A rule change invalidates every day back to the start of the
    // programme, and rebuilding all of them in one nightly job on a small instance is the
    // kind of operation that times out halfway and leaves the history in two different
    // states. A handful a night converges within a week, costs about as much as the
    // day-close it runs beside, and is safe to interrupt: each day is stamped as it is
    // written, so the next run resumes exactly where this one stopped.
    const healed = await this.rollup.healSupersededDays({ limit: SUPERSEDED_DAYS_PER_NIGHT });
    if (healed.days.length > 0) {
      this.logger.log(
        `Re-derived ${healed.days.length} day(s) left on a superseded rule set ` +
          `(${healed.from}…${healed.to}); ${healed.remaining} remaining`,
      );
    }

    const prunedTokens = await this.auth.pruneExpiredTokens();
    const prunedLogs = await this.audit.pruneOlderThan(180);

    await this.audit.log('INFO', 'CronTasks', `Nightly rollup for ${yesterday} complete`, {
      prunedTokens,
      prunedAuditLogs: prunedLogs.audit,
      prunedSystemLogs: prunedLogs.system,
      supersededDaysHealed: healed.days.length,
      supersededDaysRemaining: healed.remaining,
    });

    this.logger.log(`Nightly rollup for ${yesterday} complete`);
    return {
      dayKey: yesterday,
      prunedTokens,
      prunedAuditLogs: prunedLogs.audit,
      prunedSystemLogs: prunedLogs.system,
      supersededDaysHealed: healed.days.length,
      supersededDaysRemaining: healed.remaining,
    };
  }

  /**
   * Work off the backlog of days still computed under a superseded rule set.
   *
   * Exists as a task rather than only as an admin endpoint because of who can reach it.
   * `POST /admin/recompute/stale` needs an admin session in a browser; the thing that
   * actually notices the backlog is the Production Smoke Test, which runs unattended and
   * holds `CRON_SECRET`. Leaving the only remedy behind a human login is how a red check
   * stays red for a week — which is the failure mode this whole mechanism exists to
   * prevent, reintroduced one level up.
   *
   * Bounded and resumable: returns `remaining` so the caller loops until it reaches zero.
   * Idempotent, so an extra call is a no-op rather than a second correction.
   */
  async runSupersededRecompute(maxDays?: number): Promise<{
    healed: number;
    remaining: number;
    from: DayKey | null;
    to: DayKey | null;
  }> {
    const limit = Math.min(Math.max(1, maxDays ?? SUPERSEDED_DAYS_PER_BATCH), 40);
    const before = await this.rollup.countSupersededRows();
    if (before.days === 0) {
      this.logger.log('No days left on a superseded rule set.');
      return { healed: 0, remaining: 0, from: null, to: null };
    }

    this.logger.log(`Re-deriving up to ${limit} of ${before.days} superseded day(s)`);
    const result = await this.rollup.healSupersededDays({ limit });

    await this.audit.log(
      'INFO',
      'CronTasks',
      `Re-derived ${result.days.length} superseded day(s) ${result.from}…${result.to}; ` +
        `${result.remaining} remaining`,
      { healed: result.days.length, remaining: result.remaining },
    );

    return {
      healed: result.days.length,
      remaining: result.remaining,
      from: result.from,
      to: result.to,
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
  async runDailyReportGeneration(dayKey?: DayKey): Promise<DailyReportGenerationResult> {
    const day = dayKey ?? this.time.yesterday();

    const { fromEmail, defaultTo, defaultCc } = this.config.email;
    if (!fromEmail || defaultTo.length === 0) {
      // Reported as a distinct outcome rather than an empty list, because the caller has
      // to be able to fail on it. This ran nightly in production for days, returned
      // HTTP 200 with an empty result, and showed a green tick over an automation that
      // was producing nothing — the exact shape of failure that a status code cannot see.
      this.logger.error(
        `Skipping automated report for ${day}: EMAIL_FROM and/or EMAIL_DEFAULT_TO are not configured.`,
      );
      return { generated: [], skipped: 'EMAIL_NOT_CONFIGURED' };
    }

    // One report per active batch *that has students*, so mentors receive a Foundation
    // report and an Intermediate report rather than one email averaging two different
    // assignments together (§13). Each is generated, queued and approved independently.
    //
    // Empty batches are skipped deliberately. A batch that exists but holds nobody —
    // freshly created, or emptied by a roster change — would otherwise produce a report
    // about zero students every night, and a queue of empty approvals is how mentors
    // learn to ignore the ones that matter.
    const batches = (await this.batches.findAll()).filter((batch) => batch.studentCount > 0);

    // No batch holds anyone: fall back to a single overall report rather than sending
    // nothing, so a programme that has not been split into batches still gets its email.
    const targets: { batchId: string | null; label: string }[] =
      batches.length > 0
        ? batches.map((batch) => ({ batchId: batch.id, label: batch.name }))
        : [{ batchId: null, label: 'all students' }];

    this.logger.log(
      `Generating daily report email(s) for ${day}: ${targets.map((t) => t.label).join(', ')}`,
    );

    const generated: EmailReportRecord[] = [];

    for (const target of targets) {
      // One batch failing must not cost the others their report.
      try {
        const draft = await this.emailReports.generateDraft(
          day,
          {
            fromEmail,
            toRecipients: defaultTo,
            ccRecipients: defaultCc,
            ...(target.batchId ? { batchId: target.batchId } : {}),
          },
          null,
        );
        const pending = await this.emailReports.submitForApproval(draft.id);
        generated.push(pending);

        await this.notifications.dispatch({
          event: 'DAILY_REPORT_PENDING_APPROVAL',
          title: `Daily DSA report for ${day} (${target.label}) is ready for approval`,
          body:
            `The automated daily report for ${day} covering ${target.label} has been ` +
            `generated and is waiting for a mentor or admin to review and send it from ` +
            `the Email Reports page.`,
          data: { dayKey: day, emailReportId: pending.id, batchId: target.batchId },
        });

        await this.audit.log(
          'INFO',
          'CronTasks',
          `Daily report for ${day} (${target.label}) generated and pending approval`,
          { emailReportId: pending.id, batchId: target.batchId, toRecipients: defaultTo },
        );

        this.logger.log(
          `Daily report for ${day} (${target.label}) is PENDING_APPROVAL (id ${pending.id})`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to generate the ${target.label} report for ${day}: ${(error as Error).message}`,
        );
        await this.audit.log(
          'ERROR',
          'CronTasks',
          `Daily report generation failed for ${day} (${target.label})`,
          { batchId: target.batchId, error: (error as Error).message },
        );
      }
    }

    // Configured, targets resolved, and still nothing came back: every batch's generation
    // threw. Individually logged above, but the run as a whole did not do its job.
    return {
      generated,
      skipped: generated.length === 0 ? 'GENERATION_FAILED' : null,
    };
  }
}
