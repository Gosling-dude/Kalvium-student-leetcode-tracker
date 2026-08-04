import { Injectable } from '@nestjs/common';
import {
  CACHE_TTL,
  levelForXp,
  topBadges,
  type DayKey,
  type GroupLeaderboardRow,
  type LeaderboardRow,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

export type Period = 'DAILY' | 'WEEKLY' | 'MONTHLY';

@Injectable()
export class LeaderboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly time: ProgramTimeService,
  ) {}

  async getLeaderboard(
    period: Period,
    dayKey?: DayKey,
    options: { groupId?: string; batchId?: string; limit?: number } = {},
  ): Promise<LeaderboardRow[]> {
    const day = dayKey ?? this.time.today();
    const periodKey = this.periodKey(period, day);
    const cacheKey = `leaderboard:${period}:${periodKey}:${options.groupId ?? 'all'}:${
      options.batchId ?? 'all'
    }:${options.limit ?? 'all'}`;

    return this.cache.remember(cacheKey, CACHE_TTL.leaderboard, async () => {
      const entries = await this.prisma.leaderboardEntry.findMany({
        where: {
          period,
          periodKey,
          student: {
            status: 'ACTIVE',
            ...(options.groupId ? { groupId: options.groupId } : {}),
            ...(options.batchId ? { batchId: options.batchId } : {}),
          },
        },
        include: {
          student: {
            include: {
              group: { select: { name: true } },
              batch: { select: { name: true } },
            },
          },
        },
        orderBy: { rank: 'asc' },
        ...(options.limit ? { take: options.limit } : {}),
      });

      return entries.map((entry): LeaderboardRow => {
        const student = entry.student;
        return {
          rank: entry.rank,
          isTied: entry.isTied,
          studentId: student.id,
          name: student.name,
          groupName: student.group?.name ?? null,
          batchName: student.batch?.name ?? null,
          avatarUrl: student.avatarUrl,
          solvedCount: entry.solvedCount,
          currentStreak: entry.currentStreak,
          score: entry.score,
          completionTime: this.minuteToClock(entry.completionMinute),
          consistency: entry.consistency,
          badges: topBadges({
            currentStreak: student.currentStreak,
            longestStreak: student.longestStreak,
            totalSolved: student.totalSolved,
            perfectDays: 0,
            perfectWeeks: 0,
            earlyFinishes: 0,
            weekendPerfectDays: 0,
            bestDailyRank: entry.rank,
            scoreImprovement: 0,
            hardSolved: student.hardSolved,
            mediumSolved: student.mediumSolved,
            distinctTopics: 0,
            activeDays: 0,
          }),
          level: levelForXp(student.totalScore),
          // Positive means the student climbed: an improvement from rank 8 to 3 is +5.
          rankDelta: entry.previousRank !== null ? entry.previousRank - entry.rank : null,
        };
      });
    });
  }

  async getGroupLeaderboard(period: Period, dayKey?: DayKey): Promise<GroupLeaderboardRow[]> {
    const day = dayKey ?? this.time.today();
    const periodKey = this.periodKey(period, day);

    return this.cache.remember(
      `leaderboard:group:${period}:${periodKey}`,
      CACHE_TTL.leaderboard,
      async () => {
        const entries = await this.prisma.groupLeaderboardEntry.findMany({
          where: { period, periodKey },
          include: { group: { select: { name: true } } },
          orderBy: { rank: 'asc' },
        });

        // Daily/weekly/monthly scores for the same group, so one table can show all three.
        const [daily, weekly, monthly] = await Promise.all([
          this.groupScores('DAILY', day),
          this.groupScores('WEEKLY', day),
          this.groupScores('MONTHLY', day),
        ]);

        return entries.map(
          (entry): GroupLeaderboardRow => ({
            rank: entry.rank,
            isTied: entry.isTied,
            groupId: entry.groupId,
            name: entry.group.name,
            memberCount: entry.memberCount,
            averageCompletion: entry.averageCompletion,
            totalSolved: entry.totalSolved,
            averageStreak: entry.averageStreak,
            averageScore: entry.averageScore,
            dailyScore: daily.get(entry.groupId) ?? 0,
            weeklyScore: weekly.get(entry.groupId) ?? 0,
            monthlyScore: monthly.get(entry.groupId) ?? 0,
          }),
        );
      },
    );
  }

  private async groupScores(period: Period, dayKey: DayKey): Promise<Map<string, number>> {
    const entries = await this.prisma.groupLeaderboardEntry.findMany({
      where: { period, periodKey: this.periodKey(period, dayKey) },
      select: { groupId: true, averageScore: true },
    });
    return new Map(entries.map((e) => [e.groupId, Math.round(e.averageScore * 100) / 100]));
  }

  private periodKey(period: Period, dayKey: DayKey): string {
    switch (period) {
      case 'WEEKLY':
        return this.time.weekKey(dayKey);
      case 'MONTHLY':
        return this.time.monthKey(dayKey);
      default:
        return dayKey;
    }
  }

  private minuteToClock(minute: number | null): string | null {
    if (minute === null) return null;
    const hours = Math.floor(minute / 60);
    const minutes = minute % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
}
