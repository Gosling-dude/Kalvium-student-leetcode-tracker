/**
 * Job dispatch, with two interchangeable drivers.
 *
 * `bullmq` is the production driver: jobs survive restarts, run in separate worker
 * processes, and can be scaled horizontally. It requires Redis.
 *
 * `inline` runs the same job function in-process on the next tick. It exists so the
 * platform is fully operable without Redis — a genuine deployment option for a single
 * instance, and the reason the test suite and local development need no broker. It
 * gives up durability across restarts and cross-process concurrency, which is stated
 * plainly rather than hidden.
 *
 * Both satisfy one interface, so no calling code knows which is in use.
 */

import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions, type JobsOptions } from 'bullmq';
import type { QueueHealth } from '@dsa/shared';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';

export const SYNC_QUEUE_NAME = 'dsa-sync';

export interface SyncJobPayload {
  syncJobId: string;
}

export type SyncJobHandler = (payload: SyncJobPayload) => Promise<void>;

@Injectable()
export class SyncQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(SyncQueueService.name);
  private queue: Queue<SyncJobPayload> | null = null;
  private worker: Worker<SyncJobPayload> | null = null;
  private handler: SyncJobHandler | null = null;
  /** Tracks inline work so shutdown can wait for it rather than abandoning a sync. */
  private readonly inflight = new Set<Promise<void>>();

  constructor(@Inject(CONFIG_TOKEN) private readonly config: AppConfig) {}

  get driver(): 'bullmq' | 'inline' {
    return this.config.redis.driver;
  }

  /**
   * Register the function that executes a job, and start consuming.
   *
   * Called once by `SyncService` at boot. Keeping the handler out of this class is what
   * lets the queue stay ignorant of what a sync actually does.
   */
  register(handler: SyncJobHandler): void {
    this.handler = handler;
    if (this.driver === 'bullmq') this.startBullWorker();
  }

  async dispatch(payload: SyncJobPayload): Promise<void> {
    if (this.driver === 'inline') {
      this.runInline(payload);
      return;
    }

    try {
      const queue = this.ensureQueue();
      const options: JobsOptions = {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        // Keep recent history for the queue-monitoring UI, but bound it.
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      };
      await queue.add('sync', payload, options);
    } catch (error) {
      // Redis being unreachable must not lose the operator's sync request. Fall back
      // to running in-process and say so.
      this.logger.error(
        `Could not enqueue to BullMQ (${(error as Error).message}). Running inline instead.`,
      );
      this.runInline(payload);
    }
  }

  async health(): Promise<QueueHealth> {
    if (this.driver === 'inline') {
      return {
        driver: 'inline',
        connected: true,
        waiting: 0,
        active: this.inflight.size,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: false,
      };
    }

    try {
      const queue = this.ensureQueue();
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      );
      return {
        driver: 'bullmq',
        connected: true,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
        paused: await queue.isPaused(),
      };
    } catch {
      return {
        driver: 'bullmq',
        connected: false,
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: false,
      };
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Let in-process work finish so a shutdown mid-sync does not leave a job stuck
    // in RUNNING forever.
    if (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
    await this.worker?.close();
    await this.queue?.close();
  }

  // -------------------------------------------------------------------------

  private runInline(payload: SyncJobPayload): void {
    if (!this.handler) {
      this.logger.error('No sync handler registered; dropping job');
      return;
    }

    const task = this.handler(payload)
      .catch((error) => {
        this.logger.error(`Inline sync job failed: ${(error as Error).message}`);
      })
      .finally(() => {
        this.inflight.delete(task);
      });

    this.inflight.add(task);
  }

  private ensureQueue(): Queue<SyncJobPayload> {
    if (!this.queue) {
      this.queue = new Queue<SyncJobPayload>(SYNC_QUEUE_NAME, {
        connection: this.connection(),
        prefix: this.config.redis.prefix,
      });
    }
    return this.queue;
  }

  private startBullWorker(): void {
    if (this.worker || !this.handler) return;

    const handler = this.handler;
    this.worker = new Worker<SyncJobPayload>(
      SYNC_QUEUE_NAME,
      async (job) => handler(job.data),
      {
        connection: this.connection(),
        prefix: this.config.redis.prefix,
        // One job at a time per worker: a job already fans out across students with
        // its own bounded concurrency, so running several jobs at once would multiply
        // the provider request rate past what the rate limiter is configured for.
        concurrency: 1,
      },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Sync job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
    this.worker.on('error', (error) => {
      this.logger.error(`Sync worker error: ${error.message}`);
    });
  }

  private connection(): ConnectionOptions {
    return {
      url: this.config.redis.url,
      // BullMQ requires this to be null; it manages its own retry semantics.
      maxRetriesPerRequest: null,
    } as unknown as ConnectionOptions;
  }
}
