import { Injectable } from '@nestjs/common';
import {
  CACHE_TTL,
  SYNC_STATUS_LABELS,
  completionPercentage,
  isTrustworthySync,
  type DashboardStats,
  type DayKey,
  type MentorBucket,
  type MentorBucketRow,
  type MentorDashboard,
  type SyncStatus,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { AssignmentsService } from '../assignments/assignments.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly time: ProgramTimeService,
    private readonly assignments: AssignmentsService,
  ) {}

  async getStats(dayKey?: DayKey): Promise<DashboardStats> {
    const day = dayKey ?? this.time.today();

    return this.cache.remember(`dashboard:${day}:stats`, CACHE_TTL.dashboard, async () => {
      const [assignment, students, statuses, lastJob] = await Promise.all([
        this.assignments.findByDay(day),
        this.prisma.student.count({ where: { status: 'ACTIVE' } }),
        this.prisma.dailyStatus.findMany({
          where: { dayKey: day },
          include: {
            student: {
              select: {
                id: true,
                name: true,
                status: true,
                groupId: true,
                currentStreak: true,
                syncState: { select: { status: true } },
              },
            },
          },
        }),
        this.prisma.syncJob.findFirst({
          where: { status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS'] } },
          orderBy: { finishedAt: 'desc' },
        }),
      ]);

      const active = statuses.filter((s) => s.student.status === 'ACTIVE');
      const assignedCount = assignment?.problems.length ?? 0;

      // Buckets are indexed by solved count, so `solvedBuckets[4]` is "solved all four".
      // Sized to the assignment so a 3-problem day does not render a phantom column.
      const buckets = new Array<number>(Math.max(assignedCount, 4) + 1).fill(0);
      for (const status of active) {
        const index = Math.min(status.solvedCount, buckets.length - 1);
        buckets[index] = (buckets[index] ?? 0) + 1;
      }

      const totalSolved = active.reduce((n, s) => n + s.solvedCount, 0);
      const totalAssigned = active.reduce((n, s) => n + s.assignedCount, 0);

      // Count every reason a zero might not be a real zero, so the dashboard can warn
      // rather than quietly overstate how many students did nothing.
      const unreliable: Partial<Record<SyncStatus, number>> = {};
      for (const status of active) {
        const syncStatus = (status.student.syncState?.status ?? 'NEVER_SYNCED') as SyncStatus;
        if (!isTrustworthySync(syncStatus)) {
          unreliable[syncStatus] = (unreliable[syncStatus] ?? 0) + 1;
        }
      }

      const champion = [...active].sort(
        (a, b) => b.student.currentStreak - a.student.currentStreak,
      )[0];
      const topPerformer = [...active].sort((a, b) => b.score - a.score)[0];
      const topGroup = await this.findTopGroup(day);

      return {
        dayKey: day,
        totalStudents: students,
        activeStudents: active.length,
        assignment,
        solvedBuckets: buckets,
        completionPercent: completionPercentage(totalSolved, totalAssigned),
        averageProblemsSolved:
          active.length > 0 ? Math.round((totalSolved / active.length) * 100) / 100 : 0,
        streakChampion:
          champion && champion.student.currentStreak > 0
            ? {
                studentId: champion.student.id,
                name: champion.student.name,
                streak: champion.student.currentStreak,
              }
            : null,
        topPerformer:
          topPerformer && topPerformer.score > 0
            ? {
                studentId: topPerformer.student.id,
                name: topPerformer.student.name,
                score: topPerformer.score,
              }
            : null,
        topGroup,
        lastSyncAt: lastJob?.finishedAt?.toISOString() ?? null,
        lastSyncStatus: (lastJob?.status as DashboardStats['lastSyncStatus']) ?? null,
        unreliableSyncCounts: unreliable,
      } satisfies DashboardStats;
    });
  }

  /**
   * The five "solved N" tables.
   *
   * Every row carries a `reason`. A student showing zero because their username is
   * misspelled is a data problem for the admin; a student showing zero because they did
   * not work is a conversation for the mentor. Collapsing both into "Reason Unknown"
   * makes the table actively misleading, so we resolve it wherever we can.
   */
  async getMentorDashboard(dayKey?: DayKey, groupId?: string): Promise<MentorDashboard> {
    const day = dayKey ?? this.time.today();
    const cacheKey = `mentor:${day}:${groupId ?? 'all'}`;

    return this.cache.remember(cacheKey, CACHE_TTL.dashboard, async () => {
      const assignment = await this.assignments.findByDay(day);
      const assignedCount = assignment?.problems.length ?? 0;

      const statuses = await this.prisma.dailyStatus.findMany({
        where: {
          dayKey: day,
          student: { status: 'ACTIVE', ...(groupId ? { groupId } : {}) },
        },
        include: {
          student: {
            include: {
              group: { select: { name: true } },
              batch: { select: { name: true } },
              syncState: { select: { status: true, lastError: true } },
            },
          },
          problemStatuses: { include: { problem: { select: { title: true } } } },
        },
      });

      const ranks = await this.prisma.leaderboardEntry.findMany({
        where: { period: 'DAILY', periodKey: day },
        select: { studentId: true, rank: true },
      });
      const rankByStudent = new Map(ranks.map((r) => [r.studentId, r.rank]));

      const rows: MentorBucketRow[] = statuses.map((status) => {
        const syncStatus = (status.student.syncState?.status ?? 'NEVER_SYNCED') as SyncStatus;

        const missing = status.problemStatuses
          .filter((p) => p.status !== 'ACCEPTED')
          .sort((a, b) => a.position - b.position)
          .map((p) => p.problem.title);

        return {
          studentId: status.studentId,
          name: status.student.name,
          email: status.student.email,
          groupName: status.student.group?.name ?? null,
          batchName: status.student.batch?.name ?? null,
          leetcodeUsername: status.student.leetcodeUsername,
          solvedCount: status.solvedCount,
          completionTime: this.time.localTime(status.completedAt),
          currentStreak: status.student.currentStreak,
          score: status.score,
          rank: rankByStudent.get(status.studentId) ?? null,
          missingProblems: missing,
          syncStatus,
          reason: this.explain(status.solvedCount, syncStatus, status.problemStatuses),
        };
      });

      const maxBucket = Math.max(assignedCount, 4);
      const buckets: MentorBucket[] = [];

      for (let solved = maxBucket; solved >= 0; solved -= 1) {
        const students = rows
          .filter((row) => row.solvedCount === solved)
          .sort((a, b) => {
            // Within a bucket, whoever finished earliest leads; unfinished sort last.
            if (a.completionTime && b.completionTime) {
              return a.completionTime.localeCompare(b.completionTime);
            }
            if (a.completionTime) return -1;
            if (b.completionTime) return 1;
            return b.currentStreak - a.currentStreak || a.name.localeCompare(b.name);
          });

        buckets.push({
          solvedCount: solved,
          label:
            solved === assignedCount && assignedCount > 0
              ? `Completed all ${assignedCount}`
              : `Solved ${solved}`,
          students,
        });
      }

      return {
        dayKey: day,
        assignment,
        buckets,
        totalStudents: rows.length,
      } satisfies MentorDashboard;
    });
  }

  private explain(
    solvedCount: number,
    syncStatus: SyncStatus,
    problemStatuses: { status: string }[],
  ): string | null {
    if (solvedCount > 0) return null;

    if (!isTrustworthySync(syncStatus)) {
      // The zero is a data-quality artefact, not a fact about the student.
      return `${SYNC_STATUS_LABELS[syncStatus]} — this figure is not reliable`;
    }

    const attempted = problemStatuses.some((p) => p.status === 'ATTEMPTED_NOT_ACCEPTED');
    if (attempted) return 'Attempted but no accepted submission yet';

    return 'No submissions recorded for today';
  }

  private async findTopGroup(dayKey: DayKey): Promise<DashboardStats['topGroup']> {
    const entry = await this.prisma.groupLeaderboardEntry.findFirst({
      where: { period: 'DAILY', periodKey: dayKey, rank: 1 },
      include: { group: { select: { name: true } } },
    });

    if (!entry) return null;
    return {
      groupId: entry.groupId,
      name: entry.group.name,
      averageCompletion: entry.averageCompletion,
    };
  }
}
