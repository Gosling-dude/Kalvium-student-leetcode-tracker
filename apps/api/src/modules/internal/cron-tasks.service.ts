/**
 * The scheduled workloads, callable from anywhere.
 *
 * Both the HTTP cron endpoints (triggered by GitHub Actions) and the standalone
 * `dist/jobs/cron.js` entrypoint run exactly this code, so there is one definition of
 * "what a sync does" and "what a nightly rollup does" — not three subtly different ones.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { SyncJobSummary } from '@dsa/shared';

import { ProgramTimeService } from '../../common/services/program-time.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { RollupService } from '../scoring/rollup.service';
import { SyncService } from '../sync/sync.service';

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
}
