/**
 * Per-student incremental sync.
 *
 * The strategy that makes this scale: rather than re-reading a student's whole profile
 * every day, we keep a permanent local mirror of their submissions and fetch only what
 * is new since the last successful sync. One provider call per student per cycle,
 * regardless of how long they have been in the programme.
 *
 * The consequence of LeetCode's 20-row window is handled here and nowhere else:
 * `truncated` is surfaced as a warning so the operator learns that the sync interval
 * is too long for how much that student is solving.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { SyncStatus } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { SUBMISSION_PROVIDER, type SubmissionProvider } from '../providers/provider.types';
import { toSyncStatus } from '../providers/provider.errors';

export interface StudentSyncResult {
  studentId: string;
  username: string;
  status: SyncStatus;
  newSubmissions: number;
  /** True when the provider window was full, so older submissions may have been missed. */
  truncated: boolean;
  error: string | null;
  durationMs: number;
}

@Injectable()
export class StudentSyncService {
  private readonly logger = new Logger(StudentSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    @Inject(SUBMISSION_PROVIDER) private readonly provider: SubmissionProvider,
  ) {}

  async syncStudent(studentId: string): Promise<StudentSyncResult> {
    const startedAt = Date.now();

    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: { syncState: true },
    });

    if (!student) {
      return {
        studentId,
        username: '(unknown)',
        status: 'PROVIDER_ERROR',
        newSubmissions: 0,
        truncated: false,
        error: 'Student no longer exists',
        durationMs: Date.now() - startedAt,
      };
    }

    const username = student.leetcodeUsername;

    try {
      const since = student.syncState?.lastSubmissionAt ?? null;

      const page = await this.provider.fetchRecentSubmissions(username, {
        since,
        includeNonAccepted: true,
      });

      const written = await this.persistSubmissions(student.id, page.submissions);

      // Advance the cursor from the newest submission actually seen, not from "now" —
      // using a wall-clock cursor would skip anything submitted during the sync itself.
      const newest = page.submissions.reduce<Date | null>(
        (max, s) => (max === null || s.submittedAt > max ? s.submittedAt : max),
        null,
      );

      await this.updateSyncState(student.id, {
        status: 'OK',
        lastSubmissionAt: newest ?? since,
        lastError: null,
        consecutiveFailures: 0,
      });

      if (page.truncated && since !== null && written > 0) {
        this.logger.warn(
          `Provider window was full for "${username}" (${page.windowSize} rows). ` +
            'Submissions may have been missed — reduce SYNC_CRON interval.',
        );
      }

      return {
        studentId: student.id,
        username,
        status: 'OK',
        newSubmissions: written,
        truncated: page.truncated,
        error: null,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const status = toSyncStatus(error);
      const message = (error as Error).message;

      await this.updateSyncState(student.id, {
        status,
        lastError: message,
        incrementFailures: true,
      });

      // A wrong username is a data-quality problem the admin must fix; log it loudly
      // once rather than every cycle.
      if (status === 'USER_NOT_FOUND') {
        this.logger.warn(`LeetCode user "${username}" does not exist (student ${student.name})`);
      } else {
        this.logger.debug(`Sync failed for "${username}": ${message}`);
      }

      return {
        studentId: student.id,
        username,
        status,
        newSubmissions: 0,
        truncated: false,
        error: message,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /**
   * Append submissions to the mirror.
   *
   * `skipDuplicates` on the unique (student, provider, providerSubmissionId) index makes
   * this idempotent: re-running a sync writes nothing new and cannot double-count.
   */
  private async persistSubmissions(
    studentId: string,
    submissions: {
      id: string;
      titleSlug: string;
      title: string;
      status: string;
      submittedAt: Date;
      language: string | null;
      runtime: string | null;
      memory: string | null;
    }[],
  ): Promise<number> {
    if (submissions.length === 0) return 0;

    const slugs = [...new Set(submissions.map((s) => s.titleSlug.toLowerCase()))];
    const knownProblems = await this.prisma.problem.findMany({
      where: { titleSlug: { in: slugs } },
      select: { id: true, titleSlug: true },
    });
    const problemBySlug = new Map(knownProblems.map((p) => [p.titleSlug.toLowerCase(), p.id]));

    const rows: Prisma.SubmissionCreateManyInput[] = submissions.map((submission) => ({
      studentId,
      // Linked only when the problem is one we track. Students solve far more than we
      // assign, and fetching metadata for every one would multiply provider calls.
      problemId: problemBySlug.get(submission.titleSlug.toLowerCase()) ?? null,
      providerSubmissionId: submission.id,
      provider: this.provider.name,
      titleSlug: submission.titleSlug.toLowerCase(),
      title: submission.title,
      status: submission.status as Prisma.SubmissionCreateManyInput['status'],
      language: submission.language,
      runtime: submission.runtime,
      memory: submission.memory,
      submittedAt: submission.submittedAt,
      // Bucketed once, at write time, in the program timezone.
      dayKey: this.time.dayKeyOf(submission.submittedAt),
    }));

    const result = await this.prisma.submission.createMany({
      data: rows,
      skipDuplicates: true,
    });

    return result.count;
  }

  /** Refresh a student's cached provider profile statistics. */
  async refreshProfile(studentId: string): Promise<void> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, leetcodeUsername: true },
    });
    if (!student) return;

    try {
      const profile = await this.provider.fetchUserProfile(student.leetcodeUsername);

      await this.prisma.$transaction([
        this.prisma.student.update({
          where: { id: student.id },
          data: {
            leetcodeDisplayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            easySolved: profile.easySolved,
            mediumSolved: profile.mediumSolved,
            hardSolved: profile.hardSolved,
          },
        }),
        this.prisma.studentSyncState.upsert({
          where: { studentId: student.id },
          create: {
            studentId: student.id,
            providerTotalSolved: profile.totalSolved,
            providerEasySolved: profile.easySolved,
            providerMediumSolved: profile.mediumSolved,
            providerHardSolved: profile.hardSolved,
            providerRanking: profile.ranking,
          },
          update: {
            providerTotalSolved: profile.totalSolved,
            providerEasySolved: profile.easySolved,
            providerMediumSolved: profile.mediumSolved,
            providerHardSolved: profile.hardSolved,
            providerRanking: profile.ranking,
          },
        }),
      ]);
    } catch (error) {
      // Profile statistics are decoration; failing to refresh them must not fail a sync.
      this.logger.debug(
        `Could not refresh profile for "${student.leetcodeUsername}": ${(error as Error).message}`,
      );
    }
  }

  private async updateSyncState(
    studentId: string,
    input: {
      status: SyncStatus;
      lastSubmissionAt?: Date | null;
      lastError?: string | null;
      consecutiveFailures?: number;
      incrementFailures?: boolean;
    },
  ): Promise<void> {
    const now = new Date();
    const succeeded = input.status === 'OK';

    await this.prisma.studentSyncState.upsert({
      where: { studentId },
      create: {
        studentId,
        status: input.status,
        lastSyncedAt: now,
        lastSuccessAt: succeeded ? now : null,
        lastSubmissionAt: input.lastSubmissionAt ?? null,
        lastError: input.lastError ?? null,
        consecutiveFailures: succeeded ? 0 : 1,
        totalSyncs: 1,
      },
      update: {
        status: input.status,
        lastSyncedAt: now,
        ...(succeeded ? { lastSuccessAt: now } : {}),
        ...(input.lastSubmissionAt !== undefined
          ? { lastSubmissionAt: input.lastSubmissionAt }
          : {}),
        lastError: input.lastError ?? null,
        ...(input.incrementFailures
          ? { consecutiveFailures: { increment: 1 } }
          : { consecutiveFailures: input.consecutiveFailures ?? 0 }),
        totalSyncs: { increment: 1 },
      },
    });
  }
}
