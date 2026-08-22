/**
 * Leaderboards at three scopes: global, campus, and campus + batch.
 *
 * The three are different orderings of the same underlying scores, and the distinction
 * matters enough to be worth stating (§14, §26):
 *
 *  * **Global** ranks every active student across every campus, from `globalRank`, which
 *    the rollup computes over the whole population. It is never assembled by merging or
 *    interleaving per-campus boards — that produces a different, wrong ordering.
 *  * **Campus** ranks within one campus, from the `rank` column the rollup computes per
 *    campus. A student's global standing travels with every row regardless, so narrowing
 *    to a campus never makes someone's overall position disappear.
 *  * **Campus + batch** is re-numbered in memory from the campus's snapshot rows, using
 *    the same `rankEntries` tie rules. Storing a third materialised rank would mean
 *    recomputing it on every batch move for no benefit at these sizes.
 */

import { Injectable } from '@nestjs/common';
import {
  CACHE_TTL,
  levelForXp,
  rankEntries,
  topBadges,
  type DayKey,
  type SquadLeaderboardRow,
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
    options: {
      squadId?: string;
      campusId?: string | null;
      batchId?: string | null;
      limit?: number;
    } = {},
  ): Promise<LeaderboardRow[]> {
    const day = dayKey ?? this.time.today();
    const periodKey = this.periodKey(period, day);
    const cacheKey = `leaderboard:${period}:${periodKey}:${options.squadId ?? 'all'}:${
      options.campusId ?? 'all'
    }:${options.batchId ?? 'all'}:${options.limit ?? 'all'}`;

    // Which materialised column orders this request. A global board reads `globalRank`;
    // anything campus-scoped reads the per-campus `rank`. Reading the wrong one is how a
    // campus board ends up starting at #4 because #1–#3 are at the other campus.
    const scoped = Boolean(options.campusId || options.batchId || options.squadId);

    return this.cache.remember(cacheKey, CACHE_TTL.leaderboard, async () => {
      const entries = await this.prisma.leaderboardEntry.findMany({
        where: {
          period,
          periodKey,
          // Campus and batch filtering use the values snapshotted on the *entry* — who
          // was ranked as part of that campus/batch for this period — not the student's
          // current ones. Filtering on the student would move an old ranking between
          // leaderboards the moment someone transfers or changes batch, silently
          // rewriting settled standings (§12, §17).
          ...(options.campusId ? { campusId: options.campusId } : {}),
          ...(options.batchId ? { batchId: options.batchId } : {}),
          student: {
            // Archived students are out of the current programme, so out of current
            // leaderboards (§12). Their past entries stay in the table untouched.
            status: 'ACTIVE',
            ...(options.squadId ? { squadId: options.squadId } : {}),
          },
        },
        include: {
          student: {
            include: {
              squad: { select: { name: true } },
              batch: { select: { name: true, code: true } },
              campus: { select: { name: true, code: true } },
            },
          },
          batch: { select: { name: true, code: true } },
          campus: { select: { name: true, code: true } },
        },
        orderBy: scoped ? { rank: 'asc' } : [{ globalRank: 'asc' }, { rank: 'asc' }],
        ...(options.limit ? { take: options.limit } : {}),
      });

      // A batch or squad filter selects a *subset* of a campus's board, so the stored
      // ranks come back with gaps (#2, #5, #9…). Re-numbering the subset through the same
      // `rankEntries` used to build the snapshot keeps ties and tiebreakers identical
      // while giving the narrowed board a contiguous 1..n.
      const needsRenumbering = Boolean(options.batchId || options.squadId);
      const renumbered = needsRenumbering
        ? new Map(
            rankEntries(
              entries.map((entry) => ({
                id: entry.studentId,
                displayName: entry.student.name,
                score: entry.score,
                solvedCount: entry.solvedCount,
                completionMinuteOfDay: entry.completionMinute,
                currentStreak: entry.currentStreak,
                consistency: entry.consistency,
              })),
            ).map((row) => [row.entry.id, { rank: row.rank, isTied: row.isTied }]),
          )
        : null;

      return entries.map((entry): LeaderboardRow => {
        const student = entry.student;
        const scopedRank = renumbered?.get(entry.studentId);
        return {
          rank:
            scopedRank?.rank ??
            (scoped ? entry.rank : (entry.globalRank ?? entry.rank)),
          // Always present, whatever the scope: a student's overall standing must not
          // vanish because someone narrowed the filter to a campus (§14).
          globalRank: entry.globalRank,
          isTied: scopedRank?.isTied ?? entry.isTied,
          studentId: student.id,
          name: student.name,
          squadName: student.squad?.name ?? null,
          // The campus this ranking belongs to, falling back to the student's current
          // campus only for entries snapshotted before the column existed.
          campusId: entry.campusId ?? student.campusId,
          campusName: entry.campus?.name ?? student.campus?.name ?? null,
          campusCode: entry.campus?.code ?? student.campus?.code ?? null,
          // The batch this ranking belongs to, falling back to the student's current
          // batch only for entries snapshotted before the column existed.
          batchName: entry.batch?.name ?? student.batch?.name ?? null,
          batchCode: entry.batch?.code ?? student.batch?.code ?? null,
          cohort: student.cohort,
          maxBeltLevel: student.maxBeltLevel,
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

  /**
   * One student's rank for a period, without pulling the rest of the board — the
   * dashboard's "Current Rank" tile needs exactly this, not all 31 students' rows.
   * Both queries are point lookups on the entry table's indexed keys. `null` means no
   * snapshot has been computed for this period yet, which is different from "unranked".
   */
  async myRank(
    studentId: string,
    period: Period,
    dayKey?: DayKey,
  ): Promise<{
    rank: number;
    total: number;
    globalRank: number | null;
    globalTotal: number;
  } | null> {
    const day = dayKey ?? this.time.today();
    const periodKey = this.periodKey(period, day);

    const entry = await this.prisma.leaderboardEntry.findUnique({
      where: { period_periodKey_studentId: { period, periodKey, studentId } },
      select: { rank: true, globalRank: true, campusId: true },
    });
    if (!entry) return null;

    // Two totals, because "#4 of 31" and "#4 of 162" are different claims and the portal
    // shows both: the campus standing the student competes in day to day, and the global
    // one that tells them where they sit in the whole programme.
    const [campusTotal, globalTotal] = await Promise.all([
      this.prisma.leaderboardEntry.count({
        where: {
          period,
          periodKey,
          student: { status: 'ACTIVE' },
          ...(entry.campusId ? { campusId: entry.campusId } : {}),
        },
      }),
      this.prisma.leaderboardEntry.count({
        where: { period, periodKey, student: { status: 'ACTIVE' } },
      }),
    ]);

    return {
      rank: entry.rank,
      total: campusTotal,
      globalRank: entry.globalRank,
      globalTotal,
    };
  }

  async getSquadLeaderboard(period: Period, dayKey?: DayKey): Promise<SquadLeaderboardRow[]> {
    const day = dayKey ?? this.time.today();
    const periodKey = this.periodKey(period, day);

    return this.cache.remember(
      `leaderboard:squad:${period}:${periodKey}`,
      CACHE_TTL.leaderboard,
      async () => {
        const entries = await this.prisma.squadLeaderboardEntry.findMany({
          where: { period, periodKey },
          include: { squad: { select: { name: true } } },
          orderBy: { rank: 'asc' },
        });

        // Daily/weekly/monthly scores for the same squad, so one table can show all three.
        const [daily, weekly, monthly] = await Promise.all([
          this.squadScores('DAILY', day),
          this.squadScores('WEEKLY', day),
          this.squadScores('MONTHLY', day),
        ]);

        return entries.map(
          (entry): SquadLeaderboardRow => ({
            rank: entry.rank,
            isTied: entry.isTied,
            squadId: entry.squadId,
            name: entry.squad.name,
            memberCount: entry.memberCount,
            averageCompletion: entry.averageCompletion,
            totalSolved: entry.totalSolved,
            averageStreak: entry.averageStreak,
            averageScore: entry.averageScore,
            dailyScore: daily.get(entry.squadId) ?? 0,
            weeklyScore: weekly.get(entry.squadId) ?? 0,
            monthlyScore: monthly.get(entry.squadId) ?? 0,
          }),
        );
      },
    );
  }

  private async squadScores(period: Period, dayKey: DayKey): Promise<Map<string, number>> {
    const entries = await this.prisma.squadLeaderboardEntry.findMany({
      where: { period, periodKey: this.periodKey(period, dayKey) },
      select: { squadId: true, averageScore: true },
    });
    return new Map(entries.map((e) => [e.squadId, Math.round(e.averageScore * 100) / 100]));
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
