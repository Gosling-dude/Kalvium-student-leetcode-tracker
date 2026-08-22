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
import type { DayKey, SyncStatus } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { SUBMISSION_PROVIDER, type SubmissionProvider } from '../providers/provider.types';
import { toSyncStatus } from '../providers/provider.errors';

/**
 * How long a cached provider profile stays fresh.
 *
 * The sync runs every 3 hours, so 12h means roughly two profile reads per student per
 * day instead of eight — enough to keep "Total Solved" current within a few hours,
 * without quadrupling calls to an API that has no published rate limit and no support
 * channel to appeal a block to.
 */
const PROFILE_TTL_MS = 12 * 60 * 60 * 1000;

export interface StudentSyncResult {
  studentId: string;
  username: string;
  status: SyncStatus;
  newSubmissions: number;
  /**
   * Program days that newly-mirrored submissions landed on.
   *
   * Reported so the sync knows which days' results just went stale. A submission is not
   * only relevant to the day it was made — under the assignment lookback it can also
   * satisfy an assignment dated up to two days later — so the caller widens these before
   * recomputing (see `assignmentDaysAffectedBy`).
   *
   * Empty when nothing new was written, which is the common case on a quiet cycle.
   */
  affectedDayKeys: DayKey[];
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
        affectedDayKeys: [],
        truncated: false,
        error: 'Student no longer exists',
        durationMs: Date.now() - startedAt,
      };
    }

    const username = student.leetcodeUsername;

    // No linked LeetCode account: there is nothing to fetch, and calling the provider
    // with an empty handle would return "user not found" — a misleading error about a
    // student whose data is simply not connected yet (§2). Reported as NEVER_SYNCED,
    // which the dashboard already renders as "this zero is not reliable".
    if (!username) {
      await this.updateSyncState(student.id, {
        status: 'NEVER_SYNCED',
        lastError: 'No LeetCode username is linked to this student',
      });
      return {
        studentId,
        username: '(none)',
        status: 'NEVER_SYNCED',
        newSubmissions: 0,
        affectedDayKeys: [],
        truncated: false,
        error: 'No LeetCode username is linked to this student',
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const since = student.syncState?.lastSubmissionAt ?? null;

      const page = await this.provider.fetchRecentSubmissions(username, {
        since,
        includeNonAccepted: true,
      });

      const { written, dayKeys } = await this.persistSubmissions(student.id, page.submissions);

      // Refresh the provider's lifetime stats when they are missing or stale. This is
      // what keeps "Total Solved" honest — see `refreshProfile`. Throttled rather than
      // run every cycle: the sync fires 8× a day and these totals barely move, so an
      // unconditional call would double provider traffic for no gain. A student with no
      // profile yet is always due, so existing rows self-heal on the next sync.
      if (this.isProfileStale(student.syncState?.providerProfileFetchedAt ?? null)) {
        await this.refreshProfile(student.id, username);
      }

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
        affectedDayKeys: dayKeys,
        truncated: page.truncated,
        error: null,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const status = toSyncStatus(error);
      const message = (error as Error).message;

      // The two calls fail independently: LeetCode hides a private account's *submission
      // list* while still serving its aggregate profile stats. Without this, such a
      // student's "Total Solved" stays 0 forever even though their real count is public.
      // Skipped when the account does not exist, where the profile call cannot succeed
      // either and would just burn a request.
      if (
        status !== 'USER_NOT_FOUND' &&
        this.isProfileStale(student.syncState?.providerProfileFetchedAt ?? null)
      ) {
        await this.refreshProfile(student.id, username);
      }

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
        affectedDayKeys: [],
        truncated: false,
        error: message,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /** Never fetched, or older than the TTL. */
  private isProfileStale(fetchedAt: Date | null): boolean {
    if (!fetchedAt) return true;
    return Date.now() - fetchedAt.getTime() > PROFILE_TTL_MS;
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
  ): Promise<{ written: number; dayKeys: DayKey[] }> {
    if (submissions.length === 0) return { written: 0, dayKeys: [] };

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

    // The days reported are those of every row *offered*, not only the ones that were
    // new. `createMany` with `skipDuplicates` cannot say which rows it skipped, and
    // over-reporting here is cheap and safe: recomputing a day that did not change is
    // idempotent, whereas under-reporting would leave a day silently wrong. Bounded in
    // practice by the provider's 20-row window.
    return { written: result.count, dayKeys: [...new Set(rows.map((row) => row.dayKey))] };
  }

  /**
   * Refresh a student's cached provider profile statistics.
   *
   * These are *not* decoration. `providerTotalSolved` is LeetCode's own count of
   * distinct problems the student has ever solved (`submitStats.acSubmissionNum` where
   * difficulty = "All"), and it is the only source for that number: the submission
   * mirror is capped by the provider's 20-row window, so it cannot see anything solved
   * before the student was first synced. `Student.totalSolved` reconciles the two, and
   * without this call it silently degrades to the mirror's undercount.
   *
   * Failure is still non-fatal — a profile we could not read must not fail the
   * submission sync, which is the part that cannot be re-fetched later.
   */
  async refreshProfile(studentId: string, username?: string): Promise<boolean> {
    let leetcodeUsername = username;

    if (!leetcodeUsername) {
      const student = await this.prisma.student.findUnique({
        where: { id: studentId },
        select: { leetcodeUsername: true },
      });
      if (!student?.leetcodeUsername) return false;
      leetcodeUsername = student.leetcodeUsername;
    }

    try {
      const profile = await this.provider.fetchUserProfile(leetcodeUsername);
      const fetchedAt = new Date();

      const stats = {
        providerTotalSolved: profile.totalSolved,
        providerEasySolved: profile.easySolved,
        providerMediumSolved: profile.mediumSolved,
        providerHardSolved: profile.hardSolved,
        providerRanking: profile.ranking,
        providerProfileFetchedAt: fetchedAt,
      };

      await this.prisma.$transaction([
        this.prisma.student.update({
          where: { id: studentId },
          data: {
            leetcodeDisplayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            // The difficulty split shown on the profile page. Previously never
            // populated, which is why it read 0/0/0 for everyone.
            easySolved: profile.easySolved,
            mediumSolved: profile.mediumSolved,
            hardSolved: profile.hardSolved,
          },
        }),
        this.prisma.studentSyncState.upsert({
          where: { studentId },
          create: { studentId, ...stats },
          update: stats,
        }),
      ]);
      return true;
    } catch (error) {
      this.logger.debug(
        `Could not refresh profile for "${leetcodeUsername}": ${(error as Error).message}`,
      );
      return false;
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
