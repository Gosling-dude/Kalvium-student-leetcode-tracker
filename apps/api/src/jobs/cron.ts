/**
 * Out-of-process scheduled work — the entrypoint Render Cron Jobs invoke.
 *
 * Why this exists separately from the in-process `SyncScheduler`:
 *
 * The API's scheduler (`@nestjs/schedule`) only fires while the API process is alive.
 * On a platform where the web service can be suspended when idle (e.g. a free-tier
 * Render Web Service), those timers never fire and syncs silently stop. Running the
 * same work from a dedicated, scheduled process removes that dependency entirely: the
 * cron container is spun up on schedule, does one job, and exits — regardless of
 * whether the web service happens to be awake.
 *
 * When these cron jobs are in use, set `SYNC_ENABLED=false` on the web service so the
 * in-process scheduler does not run the same work twice.
 *
 * Usage:
 *   node dist/jobs/cron.js sync     # incremental submission sync
 *   node dist/jobs/cron.js rollup   # nightly close-out for yesterday + housekeeping
 *
 * Both are safe to re-run: the sync is idempotent on (student, submission) and the
 * rollup recomputes derived state from the permanent submission mirror.
 */

import 'reflect-metadata';
import { Logger, NotFoundException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { AuditService } from '../modules/audit/audit.service';
import { AuthService } from '../modules/auth/auth.service';
import { RollupService } from '../modules/scoring/rollup.service';
import { ProgramTimeService } from '../common/services/program-time.service';
import { SyncService } from '../modules/sync/sync.service';

/** A sync job is finished once it leaves these two live states. */
const TERMINAL_STATUSES = new Set([
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
]);

/** Hard ceiling so a wedged sync can never hold the cron container open forever. */
const MAX_WAIT_MS = 25 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;

const logger = new Logger('CronJob');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an incremental sync and wait for it to actually finish.
 *
 * The `inline` queue driver dispatches the run onto a fire-and-forget promise, so we
 * must not exit — nor let Nest tear the DB connection down — until the job row reaches
 * a terminal status. Polling the job (rather than relying on shutdown-hook ordering to
 * drain the in-flight work) keeps this correct no matter which queue driver is used.
 */
async function runSync(sync: SyncService): Promise<void> {
  let jobId: string;
  try {
    const job = await sync.start({ mode: 'INCREMENTAL', trigger: 'CRON' });
    jobId = job.id;
  } catch (error) {
    // "No active students" before the first import is the expected state, not a
    // failure. Exit cleanly so the cron run is not marked red.
    if (error instanceof NotFoundException) {
      logger.warn(`Sync did not start: ${error.message}`);
      return;
    }
    throw error;
  }

  logger.log(`Sync job ${jobId} started; waiting for completion`);

  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const current = await sync.findJob(jobId);
    if (TERMINAL_STATUSES.has(current.status)) {
      logger.log(
        `Sync job ${jobId} finished: ${current.status} — ` +
          `${current.succeededStudents}/${current.totalStudents} ok, ` +
          `${current.newSubmissions} new submissions`,
      );
      if (current.status === 'FAILED') {
        throw new Error(`Sync job ${jobId} failed: ${current.error ?? 'unknown error'}`);
      }
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Sync job ${jobId} did not finish within ${Math.round(MAX_WAIT_MS / 60000)} minutes ` +
          `(last status: ${current.status}, ${current.processedStudents}/${current.totalStudents}).`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Nightly close-out. Mirrors `SyncScheduler.runNightlyRollup` exactly — runs against
 * *yesterday* (in the program timezone), because it is meant to fire just after
 * midnight when today has barely begun.
 */
async function runRollup(
  rollup: RollupService,
  auth: AuthService,
  audit: AuditService,
  time: ProgramTimeService,
): Promise<void> {
  const yesterday = time.yesterday();
  logger.log(`Running nightly rollup for ${yesterday}`);

  await rollup.recomputeDay(yesterday);
  await rollup.recomputeStudentAggregates();
  await rollup.rebuildLeaderboards(yesterday);

  const prunedTokens = await auth.pruneExpiredTokens();
  const prunedLogs = await audit.pruneOlderThan(180);

  await audit.log('INFO', 'CronJob', `Nightly rollup for ${yesterday} complete`, {
    prunedTokens,
    prunedAuditLogs: prunedLogs.audit,
    prunedSystemLogs: prunedLogs.system,
  });

  logger.log(`Nightly rollup for ${yesterday} complete`);
}

async function main(): Promise<void> {
  const task = (process.argv[2] ?? '').toLowerCase();
  if (task !== 'sync' && task !== 'rollup') {
    logger.error(`Unknown cron task "${task}". Expected "sync" or "rollup".`);
    process.exitCode = 2;
    return;
  }

  // No HTTP server: this is a one-shot job, not a listener.
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();

  try {
    if (task === 'sync') {
      await runSync(app.get(SyncService));
    } else {
      await runRollup(
        app.get(RollupService),
        app.get(AuthService),
        app.get(AuditService),
        app.get(ProgramTimeService),
      );
    }
  } finally {
    // The sync has already reached a terminal status by here, so closing the context
    // (and disconnecting Prisma) cannot cut a run short.
    await app.close();
  }
}

main().catch((error) => {
  logger.error(`Cron task failed: ${(error as Error).message}`);
  process.exit(1);
});
