/**
 * Scheduled work.
 *
 * The sync cron defaults to every three hours rather than once daily, and that is a
 * correctness requirement rather than a preference: LeetCode's submission window holds
 * only 20 rows, so a student who solves more than that between two syncs has
 * submissions we can never recover. Frequent small syncs keep the window from
 * overflowing.
 *
 * Cron expressions are evaluated in `PROGRAM_TIMEZONE`, so "00:30" means half past
 * midnight for the programme, not for whichever region the server happens to run in.
 */

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { RollupService } from '../scoring/rollup.service';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { SyncService } from './sync.service';

@Injectable()
export class SyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(SyncScheduler.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly sync: SyncService,
    private readonly rollup: RollupService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly time: ProgramTimeService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.sync.enabled) {
      this.logger.warn('Scheduled sync is disabled (SYNC_ENABLED=false)');
      return;
    }

    this.schedule('auto-sync', this.config.sync.cron, () => this.runAutoSync());
    this.schedule('nightly-rollup', this.config.sync.rollupCron, () => this.runNightlyRollup());

    this.logger.log(
      `Scheduled sync "${this.config.sync.cron}" and rollup "${this.config.sync.rollupCron}" ` +
        `in ${this.config.program.timezone}`,
    );
  }

  private schedule(name: string, expression: string, handler: () => Promise<void>): void {
    try {
      const job = new CronJob(
        expression,
        () => {
          void handler().catch((error) =>
            this.logger.error(`Scheduled task "${name}" failed: ${(error as Error).message}`),
          );
        },
        null,
        false,
        this.config.program.timezone,
      );

      this.registry.addCronJob(name, job as unknown as Parameters<SchedulerRegistry['addCronJob']>[1]);
      job.start();
    } catch (error) {
      // A malformed cron expression must not stop the API from booting — the platform
      // is still usable with manual syncs, and the operator needs to see the message.
      this.logger.error(
        `Could not schedule "${name}" with expression "${expression}": ${(error as Error).message}`,
      );
    }
  }

  private async runAutoSync(): Promise<void> {
    this.logger.log('Starting scheduled sync');
    try {
      await this.sync.start({ mode: 'INCREMENTAL', trigger: 'CRON' });
    } catch (error) {
      // "No active students" is the expected state before the first import, not an error.
      this.logger.warn(`Scheduled sync did not start: ${(error as Error).message}`);
    }
  }

  /**
   * Nightly close-out for the day that just ended, plus housekeeping.
   *
   * Runs against *yesterday* because it fires just after midnight: today has barely
   * begun and has nothing to finalise.
   */
  private async runNightlyRollup(): Promise<void> {
    const yesterday = this.time.yesterday();
    this.logger.log(`Running nightly rollup for ${yesterday}`);

    await this.rollup.recomputeDay(yesterday);
    await this.rollup.recomputeStudentAggregates();
    await this.rollup.rebuildLeaderboards(yesterday);

    const prunedTokens = await this.auth.pruneExpiredTokens();
    const prunedLogs = await this.audit.pruneOlderThan(180);

    await this.audit.log('INFO', 'SyncScheduler', `Nightly rollup for ${yesterday} complete`, {
      prunedTokens,
      prunedAuditLogs: prunedLogs.audit,
      prunedSystemLogs: prunedLogs.system,
    });
  }
}
