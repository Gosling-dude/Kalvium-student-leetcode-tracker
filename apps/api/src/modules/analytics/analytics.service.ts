import { Injectable } from '@nestjs/common';
import {
  CACHE_TTL,
  completionPercentage,
  rankImprovement,
  type AnalyticsOverview,
  type AnalyticsPoint,
  type DayKey,
  type Difficulty,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

/**
 * The audience an analytics query is narrowed to. Absent halves widen, as everywhere else.
 */
export interface AnalyticsScope {
  campusId?: string | null;
  batchId?: string | null;
}

type ScopeWhere = { campusId?: string; batchId?: string };

/**
 * The `where` fragment for a scope, applied to the **frozen** columns on `DailyStatus`.
 *
 * Filtering here rather than through `student` is what keeps a trend stable: reading the
 * student's *current* campus would silently re-file every past day of anyone who has
 * transferred, changing a chart that describes a settled period (§17).
 */
function scopeWhere(scope: AnalyticsScope): ScopeWhere {
  return {
    ...(scope.campusId ? { campusId: scope.campusId } : {}),
    ...(scope.batchId ? { batchId: scope.batchId } : {}),
  };
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly time: ProgramTimeService,
  ) {}

  /**
   * `scope` narrows every series to a campus and/or batch, filtering on
   * `DailyStatus.campusId`/`batchId` — the campus and batch each student was in *on that
   * day*. A student who moved or transferred mid-range therefore contributes their
   * pre-move days to their old group's trend and their later days to the new one, which
   * is what makes a group's history stable (§5, §7, §17).
   */
  async overview(from?: DayKey, to?: DayKey, scope: AnalyticsScope = {}): Promise<AnalyticsOverview> {
    const end = to ?? this.time.today();
    const start = from ?? this.time.addDays(end, -29);
    const where = scopeWhere(scope);

    return this.cache.remember(
      `analytics:${start}:${end}:${scope.campusId ?? 'all'}:${scope.batchId ?? 'all'}`,
      CACHE_TTL.analytics,
      async (): Promise<AnalyticsOverview> => {
        const statuses = await this.prisma.dailyStatus.findMany({
          where: {
            dayKey: { gte: start, lte: end },
            ...where,
            student: { status: 'ACTIVE' },
          },
          include: { student: { select: { id: true, name: true, squadId: true } } },
        });

        const daily = this.buildDailySeries(statuses, start, end);

        return {
          range: { from: start, to: end },
          daily,
          weekly: this.bucketBy(daily, (d) => this.time.weekKey(d.dayKey)),
          monthly: this.bucketBy(daily, (d) => this.time.monthKey(d.dayKey)),
          byDifficulty: await this.byDifficulty(start, end, where),
          byTopic: await this.byTopic(start, end, where),
          squadComparison: await this.squadComparison(statuses),
          topImprovers: await this.improvers(start, end, 'TOP', where),
          bottomPerformers: this.bottomPerformers(statuses),
        };
      },
    );
  }

  /** Contribution-style heatmap over a date range, aggregated across all students. */
  async heatmap(days = 120, scope: AnalyticsScope = {}) {
    const end = this.time.today();
    const start = this.time.addDays(end, -(days - 1));

    const rows = await this.prisma.dailyStatus.groupBy({
      by: ['dayKey'],
      where: { dayKey: { gte: start, lte: end }, ...scopeWhere(scope) },
      _sum: { solvedCount: true, assignedCount: true },
      _count: { _all: true },
    });

    const byDay = new Map(rows.map((r) => [r.dayKey, r]));

    return this.time.range(start, end).map((dayKey) => {
      const row = byDay.get(dayKey);
      const solved = row?._sum.solvedCount ?? 0;
      const assigned = row?._sum.assignedCount ?? 0;
      return {
        dayKey,
        solvedCount: solved,
        assignedCount: assigned,
        completionPercent: completionPercentage(solved, assigned),
        studentCount: row?._count._all ?? 0,
      };
    });
  }

  private buildDailySeries(
    statuses: { dayKey: string; solvedCount: number; assignedCount: number; score: number }[],
    start: DayKey,
    end: DayKey,
  ): AnalyticsPoint[] {
    const byDay = new Map<string, { solved: number; assigned: number; score: number; active: number }>();

    for (const status of statuses) {
      const bucket = byDay.get(status.dayKey) ?? { solved: 0, assigned: 0, score: 0, active: 0 };
      bucket.solved += status.solvedCount;
      bucket.assigned += status.assignedCount;
      bucket.score += status.score;
      if (status.solvedCount > 0) bucket.active += 1;
      byDay.set(status.dayKey, bucket);
    }

    // Emit every day in the range, including empty ones — a gap in a trend line must
    // read as "nobody solved anything", not as missing data.
    return this.time.range(start, end).map((dayKey) => {
      const bucket = byDay.get(dayKey);
      return {
        dayKey,
        label: dayKey.slice(5),
        completionPercent: completionPercentage(bucket?.solved ?? 0, bucket?.assigned ?? 0),
        solvedCount: bucket?.solved ?? 0,
        activeStudents: bucket?.active ?? 0,
        averageScore:
          bucket && bucket.active > 0 ? Math.round((bucket.score / bucket.active) * 100) / 100 : 0,
      };
    });
  }

  private bucketBy(daily: AnalyticsPoint[], keyOf: (point: AnalyticsPoint) => string) {
    const buckets = new Map<string, { completion: number[]; score: number[] }>();

    for (const point of daily) {
      const key = keyOf(point);
      const bucket = buckets.get(key) ?? { completion: [], score: [] };
      bucket.completion.push(point.completionPercent);
      bucket.score.push(point.averageScore);
      buckets.set(key, bucket);
    }

    return [...buckets]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, bucket]) => ({
        label,
        completionPercent: this.average(bucket.completion),
        averageScore: this.average(bucket.score),
      }));
  }

  private async byDifficulty(start: DayKey, end: DayKey, where: ScopeWhere) {
    const rows = await this.prisma.dailyProblemStatus.findMany({
      where: {
        dailyStatus: {
          dayKey: { gte: start, lte: end },
          ...where,
        },
      },
      include: { problem: { select: { difficulty: true } } },
    });

    const buckets = new Map<Difficulty, { assigned: number; solved: number }>();
    for (const row of rows) {
      const difficulty = row.problem.difficulty as Difficulty;
      const bucket = buckets.get(difficulty) ?? { assigned: 0, solved: 0 };
      bucket.assigned += 1;
      if (row.status === 'ACCEPTED') bucket.solved += 1;
      buckets.set(difficulty, bucket);
    }

    return (['EASY', 'MEDIUM', 'HARD'] as Difficulty[]).map((difficulty) => {
      const bucket = buckets.get(difficulty) ?? { assigned: 0, solved: 0 };
      return {
        difficulty,
        assignedCount: bucket.assigned,
        solvedCount: bucket.solved,
        completionPercent: completionPercentage(bucket.solved, bucket.assigned),
      };
    });
  }

  private async byTopic(start: DayKey, end: DayKey, where: ScopeWhere) {
    const rows = await this.prisma.dailyProblemStatus.findMany({
      where: {
        dailyStatus: {
          dayKey: { gte: start, lte: end },
          ...where,
        },
      },
      include: { problem: { select: { topicTags: true } } },
    });

    const buckets = new Map<string, { assigned: number; solved: number }>();
    for (const row of rows) {
      for (const topic of row.problem.topicTags) {
        const bucket = buckets.get(topic) ?? { assigned: 0, solved: 0 };
        bucket.assigned += 1;
        if (row.status === 'ACCEPTED') bucket.solved += 1;
        buckets.set(topic, bucket);
      }
    }

    return [...buckets]
      .map(([topic, bucket]) => ({
        topic,
        assignedCount: bucket.assigned,
        solvedCount: bucket.solved,
        completionPercent: completionPercentage(bucket.solved, bucket.assigned),
      }))
      .sort((a, b) => b.assignedCount - a.assignedCount)
      .slice(0, 20);
  }

  private async squadComparison(
    statuses: {
      solvedCount: number;
      assignedCount: number;
      score: number;
      student: { id: string; squadId: string | null };
    }[],
  ) {
    const squads = await this.prisma.squad.findMany({ select: { id: true, name: true } });

    return squads
      .map((squad) => {
        const rows = statuses.filter((s) => s.student.squadId === squad.id);
        const members = new Set(rows.map((r) => r.student.id));
        const solved = rows.reduce((n, r) => n + r.solvedCount, 0);
        const assigned = rows.reduce((n, r) => n + r.assignedCount, 0);
        const score = rows.reduce((n, r) => n + r.score, 0);

        return {
          squadId: squad.id,
          squadName: squad.name,
          averageCompletion: completionPercentage(solved, assigned),
          averageScore:
            members.size > 0 ? Math.round((score / members.size) * 100) / 100 : 0,
          averageStreak: 0,
          memberCount: members.size,
        };
      })
      .filter((squad) => squad.memberCount > 0)
      .sort((a, b) => b.averageCompletion - a.averageCompletion);
  }

  /** Compares a window against the equally-sized window immediately before it. */
  private async improvers(
    start: DayKey,
    end: DayKey,
    direction: 'TOP' | 'BOTTOM',
    where: ScopeWhere,
  ) {
    const span = this.time.diffDays(start, end);
    const previousEnd = this.time.addDays(start, -1);
    const previousStart = this.time.addDays(previousEnd, -span);

    const [current, previous] = await Promise.all([
      this.prisma.dailyStatus.groupBy({
        by: ['studentId'],
        where: { dayKey: { gte: start, lte: end }, ...where },
        _sum: { score: true },
      }),
      this.prisma.dailyStatus.groupBy({
        by: ['studentId'],
        where: {
          dayKey: { gte: previousStart, lte: previousEnd },
          ...where,
        },
        _sum: { score: true },
      }),
    ]);

    const previousByStudent = new Map(previous.map((r) => [r.studentId, r._sum.score ?? 0]));

    const students = await this.prisma.student.findMany({
      where: { id: { in: current.map((r) => r.studentId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(students.map((s) => [s.id, s.name]));

    const ranked = rankImprovement(
      current.map((row) => ({
        id: row.studentId,
        displayName: nameById.get(row.studentId) ?? 'Unknown',
        previousScore: previousByStudent.get(row.studentId) ?? 0,
        currentScore: row._sum.score ?? 0,
      })),
      direction,
      10,
    );

    return ranked.map((row) => ({
      studentId: row.id,
      name: row.displayName,
      delta: row.delta,
    }));
  }

  private bottomPerformers(
    statuses: {
      solvedCount: number;
      assignedCount: number;
      student: { id: string; name: string };
    }[],
  ) {
    const byStudent = new Map<string, { name: string; solved: number; assigned: number }>();

    for (const status of statuses) {
      const bucket = byStudent.get(status.student.id) ?? {
        name: status.student.name,
        solved: 0,
        assigned: 0,
      };
      bucket.solved += status.solvedCount;
      bucket.assigned += status.assignedCount;
      byStudent.set(status.student.id, bucket);
    }

    return [...byStudent]
      // Only students who were actually assigned work can be "underperforming".
      .filter(([, bucket]) => bucket.assigned > 0)
      .map(([studentId, bucket]) => ({
        studentId,
        name: bucket.name,
        completionPercent: completionPercentage(bucket.solved, bucket.assigned),
      }))
      .sort((a, b) => a.completionPercent - b.completionPercent)
      .slice(0, 10);
  }

  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return Math.round((values.reduce((n, v) => n + v, 0) / values.length) * 100) / 100;
  }
}
