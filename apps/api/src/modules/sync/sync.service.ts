/**
 * Sync orchestration.
 *
 * Fans a job out across students with bounded concurrency, records per-student outcomes
 * so "retry failed" knows exactly what to retry, and recomputes derived state once at
 * the end rather than per student.
 *
 * A job never throws its way out: a single student's failure is recorded against that
 * student and the run continues. One bad username must not cost 249 students their
 * daily report.
 */

import { Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  DayKey,
  Paginated,
  QueueHealth,
  SyncJobSummary,
  SyncMode,
  SyncTrigger,
} from '@dsa/shared';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { paginate } from '../../common/dto/pagination.dto';
import { RollupService } from '../scoring/rollup.service';
import { AuditService } from '../audit/audit.service';
import { StudentSyncService, type StudentSyncResult } from './student-sync.service';
import { SyncQueueService, type SyncJobPayload } from './sync.queue';

export interface StartSyncOptions {
  mode?: SyncMode;
  trigger?: SyncTrigger;
  dayKey?: DayKey;
  studentIds?: string[];
  userId?: string | null;
}

@Injectable()
export class SyncService implements OnModuleInit {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly time: ProgramTimeService,
    private readonly queue: SyncQueueService,
    private readonly studentSync: StudentSyncService,
    private readonly rollup: RollupService,
    private readonly audit: AuditService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.queue.register((payload) => this.execute(payload));
  }

  /** Create a job row and hand it to the queue. Returns immediately. */
  async start(options: StartSyncOptions = {}): Promise<SyncJobSummary> {
    const mode = options.mode ?? 'INCREMENTAL';
    const dayKey = options.dayKey ?? this.time.today();

    const studentIds = await this.resolveStudentIds(mode, options.studentIds);

    if (studentIds.length === 0) {
      throw new NotFoundException(
        mode === 'RETRY_FAILED'
          ? 'There are no failed students to retry.'
          : 'No active students to sync. Import students first.',
      );
    }

    const job = await this.prisma.syncJob.create({
      data: {
        status: 'QUEUED',
        mode,
        trigger: options.trigger ?? 'MANUAL',
        dayKey,
        totalStudents: studentIds.length,
        triggeredById: options.userId ?? null,
        items: {
          createMany: {
            data: studentIds.map((studentId) => ({ studentId, status: 'NEVER_SYNCED' })),
          },
        },
      },
    });

    await this.queue.dispatch({ syncJobId: job.id });

    return this.toSummary(job);
  }

  /**
   * Start a sync and resolve only once it reaches a terminal status.
   *
   * `start()` returns as soon as the job is dispatched; with the `inline` driver the
   * work then runs on a detached promise. A caller that must know the outcome — a cron
   * trigger, or the internal HTTP endpoint answering a GitHub Action — polls the job row
   * here rather than depending on shutdown-hook ordering to drain in-flight work.
   *
   * Returns `null` when there is nothing to sync (e.g. no active students yet), which is
   * an expected state before the first import, not an error.
   */
  async runToCompletion(
    options: StartSyncOptions = {},
    waitMs = 25 * 60 * 1000,
    pollIntervalMs = 3000,
  ): Promise<SyncJobSummary | null> {
    let job: SyncJobSummary;
    try {
      job = await this.start(options);
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.warn(`Sync did not start: ${(error as Error).message}`);
        return null;
      }
      throw error;
    }

    const terminal = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED']);
    const deadline = Date.now() + waitMs;

    for (;;) {
      const current = await this.findJob(job.id);
      if (terminal.has(current.status)) return current;
      if (Date.now() > deadline) {
        throw new Error(
          `Sync job ${job.id} did not finish within ${Math.round(waitMs / 60000)} minutes ` +
            `(last status: ${current.status}, ${current.processedStudents}/${current.totalStudents}).`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /** Execute a queued job. Invoked by the queue driver, never called directly. */
  async execute(payload: SyncJobPayload): Promise<void> {
    const job = await this.prisma.syncJob.findUnique({
      where: { id: payload.syncJobId },
      include: { items: true },
    });

    if (!job) {
      this.logger.error(`Sync job ${payload.syncJobId} no longer exists`);
      return;
    }

    if (job.status === 'RUNNING' || job.status === 'COMPLETED') {
      // Guards against a BullMQ retry re-running a job that already finished.
      this.logger.warn(`Sync job ${job.id} is already ${job.status}; skipping`);
      return;
    }

    const startedAt = new Date();
    await this.prisma.syncJob.update({
      where: { id: job.id },
      data: { status: 'RUNNING', startedAt },
    });

    const studentIds = job.items.map((item) => item.studentId);
    const results: StudentSyncResult[] = [];

    try {
      await this.forEachWithConcurrency(
        studentIds,
        this.config.provider.concurrency,
        async (studentId) => {
          const result = await this.studentSync.syncStudent(studentId);
          results.push(result);

          await this.prisma.syncJobItem.update({
            where: { syncJobId_studentId: { syncJobId: job.id, studentId } },
            data: {
              status: result.status,
              newSubmissions: result.newSubmissions,
              error: result.error,
              durationMs: result.durationMs,
              processedAt: new Date(),
              attempts: { increment: 1 },
            },
          });

          // Progress is written incrementally so the UI's progress bar is real.
          await this.prisma.syncJob.update({
            where: { id: job.id },
            data: {
              processedStudents: { increment: 1 },
              ...(result.status === 'OK'
                ? { succeededStudents: { increment: 1 } }
                : { failedStudents: { increment: 1 } }),
              newSubmissions: { increment: result.newSubmissions },
            },
          });
        },
      );

      // Derived state is rebuilt once, after all submissions have landed.
      const dayKey = job.dayKey ?? this.time.today();
      await this.rollup.recomputeDay(dayKey);
      await this.rollup.recomputeStudentAggregates();
      await this.rollup.rebuildLeaderboards(dayKey);
      await this.cache.flush();

      const failed = results.filter((r) => r.status !== 'OK').length;
      const finishedAt = new Date();

      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: failed === 0 ? 'COMPLETED' : 'COMPLETED_WITH_ERRORS',
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          errorDetail: this.summariseFailures(results) as Prisma.InputJsonValue,
        },
      });

      this.logger.log(
        `Sync ${job.id} finished: ${results.length - failed}/${results.length} succeeded, ` +
          `${results.reduce((n, r) => n + r.newSubmissions, 0)} new submissions`,
      );

      await this.audit.log('INFO', 'SyncService', `Sync ${job.id} completed`, {
        succeeded: results.length - failed,
        failed,
      });
    } catch (error) {
      const finishedAt = new Date();
      await this.prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          error: (error as Error).message,
        },
      });
      this.logger.error(`Sync job ${job.id} failed: ${(error as Error).message}`);
    }
  }

  async findJob(id: string): Promise<SyncJobSummary> {
    const job = await this.prisma.syncJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Sync job ${id} was not found`);
    return this.toSummary(job);
  }

  async listJobs(page: number, pageSize: number): Promise<Paginated<SyncJobSummary>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.syncJob.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.syncJob.count(),
    ]);
    return paginate(rows.map((row) => this.toSummary(row)), total, page, pageSize);
  }

  async latestJob(): Promise<SyncJobSummary | null> {
    const job = await this.prisma.syncJob.findFirst({ orderBy: { createdAt: 'desc' } });
    return job ? this.toSummary(job) : null;
  }

  /** Per-student detail for a job — powers the "which students failed and why" view. */
  async jobItems(jobId: string) {
    const items = await this.prisma.syncJobItem.findMany({
      where: { syncJobId: jobId },
      orderBy: { processedAt: 'desc' },
    });

    const students = await this.prisma.student.findMany({
      where: { id: { in: items.map((i) => i.studentId) } },
      select: { id: true, name: true, leetcodeUsername: true },
    });
    const byId = new Map(students.map((s) => [s.id, s]));

    return items.map((item) => ({
      studentId: item.studentId,
      name: byId.get(item.studentId)?.name ?? 'Unknown',
      leetcodeUsername: byId.get(item.studentId)?.leetcodeUsername ?? '',
      status: item.status,
      newSubmissions: item.newSubmissions,
      error: item.error,
      durationMs: item.durationMs,
      processedAt: item.processedAt?.toISOString() ?? null,
    }));
  }

  async cancel(id: string): Promise<SyncJobSummary> {
    const job = await this.prisma.syncJob.update({
      where: { id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    return this.toSummary(job);
  }

  queueHealth(): Promise<QueueHealth> {
    return this.queue.health();
  }

  // -------------------------------------------------------------------------

  private async resolveStudentIds(mode: SyncMode, explicit?: string[]): Promise<string[]> {
    if (explicit && explicit.length > 0) return explicit;

    if (mode === 'RETRY_FAILED') {
      // Retry only what is actually retryable. A misspelled username will fail
      // identically every time and would otherwise consume the whole retry budget.
      const failed = await this.prisma.studentSyncState.findMany({
        where: {
          status: { in: ['PROVIDER_ERROR', 'TIMEOUT', 'RATE_LIMITED'] },
          student: { status: 'ACTIVE' },
        },
        select: { studentId: true },
      });
      return failed.map((f) => f.studentId);
    }

    const students = await this.prisma.student.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });
    return students.map((s) => s.id);
  }

  /**
   * Bounded-concurrency map.
   *
   * A plain `Promise.all` over 250 students would open 250 simultaneous requests; the
   * provider's rate limiter would queue them, but the memory and socket pressure is
   * pointless. A fixed pool keeps the pipeline full without the spike.
   */
  private async forEachWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    const limit = Math.max(1, concurrency);
    let cursor = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item === undefined) continue;
        try {
          await worker(item);
        } catch (error) {
          // Already recorded per student; keep the pool alive.
          this.logger.error(`Unhandled sync worker error: ${(error as Error).message}`);
        }
      }
    });

    await Promise.all(runners);
  }

  private summariseFailures(results: StudentSyncResult[]): Record<string, unknown> {
    const byStatus: Record<string, number> = {};
    for (const result of results) {
      if (result.status === 'OK') continue;
      byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
    }
    return {
      byStatus,
      truncatedWindows: results.filter((r) => r.truncated).length,
      samples: results
        .filter((r) => r.status !== 'OK')
        .slice(0, 20)
        .map((r) => ({ username: r.username, status: r.status, error: r.error })),
    };
  }

  private toSummary(job: {
    id: string;
    status: string;
    mode: string;
    trigger: string;
    dayKey: string | null;
    totalStudents: number;
    processedStudents: number;
    succeededStudents: number;
    failedStudents: number;
    newSubmissions: number;
    startedAt: Date | null;
    finishedAt: Date | null;
    durationMs: number | null;
    error: string | null;
    createdAt: Date;
  }): SyncJobSummary {
    return {
      id: job.id,
      status: job.status as SyncJobSummary['status'],
      mode: job.mode as SyncMode,
      trigger: job.trigger as SyncTrigger,
      dayKey: job.dayKey,
      totalStudents: job.totalStudents,
      processedStudents: job.processedStudents,
      succeededStudents: job.succeededStudents,
      failedStudents: job.failedStudents,
      newSubmissions: job.newSubmissions,
      progressPercent:
        job.totalStudents > 0
          ? Math.round((job.processedStudents / job.totalStudents) * 100)
          : 0,
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      durationMs: job.durationMs,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
    };
  }
}
