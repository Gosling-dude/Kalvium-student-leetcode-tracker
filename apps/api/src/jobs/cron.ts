/**
 * Standalone entrypoint for the scheduled workloads.
 *
 * On the free hosting stack the schedule is driven by GitHub Actions hitting the
 * `/internal/sync` and `/internal/rollup` HTTP endpoints, so this script is not required
 * in production. It is retained for local and manual runs (`npm run cron:sync` /
 * `cron:rollup`) and for any always-on host that prefers an out-of-process job to an
 * HTTP trigger. It boots a Nest application context (no HTTP server), runs one task via
 * the same `CronTasksService` the endpoints use, and exits.
 *
 * Usage:
 *   node dist/jobs/cron.js sync
 *   node dist/jobs/cron.js rollup
 */

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { CronTasksService } from '../modules/internal/cron-tasks.service';

const logger = new Logger('CronJob');

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
    const tasks = app.get(CronTasksService);
    if (task === 'sync') {
      // runSync awaits the job to a terminal status, so the run is complete before we
      // close the context (and disconnect Prisma).
      await tasks.runSync();
    } else {
      await tasks.runNightlyRollup();
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  logger.error(`Cron task failed: ${(error as Error).message}`);
  process.exit(1);
});
