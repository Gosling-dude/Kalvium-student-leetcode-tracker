/**
 * Derived-state engine.
 *
 * Everything a mentor looks at — daily status, streaks, scores, leaderboards, student
 * totals — is *derived* from two stored facts: the submission mirror and the assignment
 * list. This service is the only place that derivation happens, which is what makes
 * "recalculate scores" after a formula change a safe, repeatable operation rather than
 * a migration.
 *
 * Everything here is idempotent. Running a rollup twice produces the same result.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  computeDailyScore,
  computeStreaks,
  rankEntries,
  rankSquads,
  requiredSolvedForStreak,
  type DayKey,
  type Difficulty,
  type ProblemStatus,
  type RankableEntry,
  type ScoringConfig,
  type StreakDay,
  type SyncStatus,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { ScoringConfigService } from './scoring-config.service';

/** How far back streak computation looks. Beyond this, a streak is not meaningfully "current". */
const STREAK_HISTORY_DAYS = 400;

interface StudentDayResult {
  studentId: string;
  solvedCount: number;
  firstSolvedAt: Date | null;
  lastSolvedAt: Date | null;
  completedAt: Date | null;
  problemStatuses: {
    problemId: string;
    position: number;
    status: ProblemStatus;
    solvedAt: Date | null;
    language: string | null;
    attempts: number;
  }[];
}

@Injectable()
export class RollupService {
  private readonly logger = new Logger(RollupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly time: ProgramTimeService,
    private readonly scoringConfig: ScoringConfigService,
  ) {}

  /**
   * Rebuild `DailyStatus` (and per-problem detail) for one program day, then refresh
   * the streaks, scores and leaderboards that depend on it.
   */
  async recomputeDay(dayKey: DayKey): Promise<{ students: number; assigned: number }> {
    const config = await this.scoringConfig.getActive();

    const assignment = await this.prisma.assignment.findUnique({
      where: { dayKey },
      include: { problems: { include: { problem: true }, orderBy: { position: 'asc' } } },
    });

    const students = await this.prisma.student.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, leetcodeUsername: true, syncState: { select: { status: true } } },
    });

    // A day with no assignment still gets rows, all with assignedCount 0. Those days
    // are neutral for streaks and must not be confused with "assigned but missed".
    const assignedProblems = assignment?.problems ?? [];
    const assignedCount = assignedProblems.length;

    const results = assignment
      ? await this.evaluateDay(dayKey, assignedProblems)
      : new Map<string, StudentDayResult>();

    // Streaks need history, so load the window once for everyone rather than per student.
    const historyFrom = this.time.addDays(dayKey, -STREAK_HISTORY_DAYS);
    const history = await this.prisma.dailyStatus.findMany({
      where: { dayKey: { gte: historyFrom, lt: dayKey } },
      select: { studentId: true, dayKey: true, solvedCount: true, assignedCount: true },
    });

    const historyByStudent = new Map<string, StreakDay[]>();
    for (const row of history) {
      const list = historyByStudent.get(row.studentId) ?? [];
      list.push({
        dayKey: row.dayKey,
        solvedCount: row.solvedCount,
        assignedCount: row.assignedCount,
      });
      historyByStudent.set(row.studentId, list);
    }

    const difficultyBySlug = new Map<string, Difficulty>(
      assignedProblems.map((link) => [link.problem.id, link.problem.difficulty as Difficulty]),
    );

    for (const student of students) {
      const result = results.get(student.id);
      const solvedCount = result?.solvedCount ?? 0;

      const days = [...(historyByStudent.get(student.id) ?? [])];
      days.push({ dayKey, solvedCount, assignedCount });
      const streaks = computeStreaks(days, dayKey, config);

      const completionMinute = result?.completedAt
        ? this.time.minuteOfDay(result.completedAt)
        : null;

      const solvedDifficulties = (result?.problemStatuses ?? [])
        .filter((p) => p.status === 'ACCEPTED')
        .map((p) => difficultyBySlug.get(p.problemId) ?? 'MEDIUM');

      const score = computeDailyScore(
        {
          solvedCount,
          assignedCount,
          completionMinuteOfDay: completionMinute,
          solvedDifficulties,
          streakLength: streaks.current,
        },
        config,
      );

      const isPerfect =
        assignedCount > 0 && solvedCount >= requiredSolvedForStreak(assignedCount, config);

      await this.persistDailyStatus({
        studentId: student.id,
        dayKey,
        assignmentId: assignment?.id ?? null,
        assignedCount,
        solvedCount,
        score: score.total,
        scoreBreakdown: score.components,
        completedAt: result?.completedAt ?? null,
        completionMinute,
        firstSolvedAt: result?.firstSolvedAt ?? null,
        lastSolvedAt: result?.lastSolvedAt ?? null,
        isPerfect,
        streakAtDay: streaks.current,
        syncStatus: (student.syncState?.status ?? 'NEVER_SYNCED') as SyncStatus,
        problemStatuses: result?.problemStatuses ?? this.emptyStatuses(assignedProblems),
      });
    }

    await this.cache.delByPrefix(`dashboard:${dayKey}`);
    await this.cache.delByPrefix(`mentor:${dayKey}`);

    this.logger.log(
      `Recomputed ${dayKey}: ${students.length} students, ${assignedCount} problems assigned`,
    );

    return { students: students.length, assigned: assignedCount };
  }

  /**
   * Refresh each student's cached aggregates (streaks, totals, score).
   *
   * These live on `Student` purely so list views need no joins; they are always
   * rebuildable from `DailyStatus` and `Submission`.
   */
  async recomputeStudentAggregates(): Promise<number> {
    const config = await this.scoringConfig.getActive();
    const today = this.time.today();
    const from = this.time.addDays(today, -STREAK_HISTORY_DAYS);

    const students = await this.prisma.student.findMany({ select: { id: true } });

    const statuses = await this.prisma.dailyStatus.findMany({
      where: { dayKey: { gte: from, lte: today } },
      select: {
        studentId: true,
        dayKey: true,
        solvedCount: true,
        assignedCount: true,
        score: true,
      },
    });

    const byStudent = new Map<string, typeof statuses>();
    for (const row of statuses) {
      const list = byStudent.get(row.studentId) ?? [];
      list.push(row);
      byStudent.set(row.studentId, list);
    }

    // All-time solved counts come from the submission mirror, not from DailyStatus:
    // students solve far more problems than we assign, and the profile page shows
    // their whole LeetCode output.
    const solvedByDifficulty = await this.prisma.submission.groupBy({
      by: ['studentId'],
      where: { status: 'ACCEPTED' },
      _count: { _all: true },
    });
    const totalSolvedMap = new Map(
      solvedByDifficulty.map((row) => [row.studentId, row._count._all]),
    );

    for (const student of students) {
      const rows = byStudent.get(student.id) ?? [];
      const streaks = computeStreaks(
        rows.map((r) => ({
          dayKey: r.dayKey,
          solvedCount: r.solvedCount,
          assignedCount: r.assignedCount,
        })),
        today,
        config,
      );

      await this.prisma.student.update({
        where: { id: student.id },
        data: {
          currentStreak: streaks.current,
          longestStreak: Math.max(streaks.longest, streaks.current),
          totalScore: rows.reduce((n, r) => n + r.score, 0),
          totalSolved: totalSolvedMap.get(student.id) ?? 0,
        },
      });
    }

    return students.length;
  }

  /** Materialise the daily, weekly and monthly leaderboards for a day. */
  async rebuildLeaderboards(dayKey: DayKey): Promise<void> {
    await this.buildLeaderboard('DAILY', dayKey, dayKey, dayKey);

    const week = this.time.weekBounds(dayKey);
    await this.buildLeaderboard('WEEKLY', this.time.weekKey(dayKey), week.from, week.to);

    const month = this.time.monthBounds(dayKey);
    await this.buildLeaderboard('MONTHLY', this.time.monthKey(dayKey), month.from, month.to);

    await this.cache.delByPrefix('leaderboard:');
  }

  private async buildLeaderboard(
    period: 'DAILY' | 'WEEKLY' | 'MONTHLY',
    periodKey: string,
    from: DayKey,
    to: DayKey,
  ): Promise<void> {
    const rows = await this.prisma.dailyStatus.findMany({
      where: { dayKey: { gte: from, lte: to } },
      include: {
        student: {
          select: { id: true, name: true, currentStreak: true, squadId: true, status: true },
        },
      },
    });

    const active = rows.filter((row) => row.student.status === 'ACTIVE');

    const byStudent = new Map<
      string,
      {
        name: string;
        score: number;
        solved: number;
        assigned: number;
        qualifying: number;
        streak: number;
        completionMinute: number | null;
        squadId: string | null;
      }
    >();

    for (const row of active) {
      const entry = byStudent.get(row.studentId) ?? {
        name: row.student.name,
        score: 0,
        solved: 0,
        assigned: 0,
        qualifying: 0,
        streak: row.student.currentStreak,
        completionMinute: null,
        squadId: row.student.squadId,
      };

      entry.score += row.score;
      entry.solved += row.solvedCount;
      entry.assigned += row.assignedCount;
      if (row.isPerfect) entry.qualifying += 1;

      // Over a multi-day window the tiebreaker is the *latest* day's completion time,
      // which is the only one comparable across students for the period being ranked.
      if (row.dayKey === to && row.completionMinute !== null) {
        entry.completionMinute = row.completionMinute;
      }

      byStudent.set(row.studentId, entry);
    }

    const rankable: (RankableEntry & { squadId: string | null; assignedCount: number })[] = [
      ...byStudent,
    ].map(([id, entry]) => ({
      id,
      displayName: entry.name,
      score: entry.score,
      solvedCount: entry.solved,
      completionMinuteOfDay: entry.completionMinute,
      currentStreak: entry.streak,
      consistency:
        entry.assigned > 0 ? Math.round((entry.solved / entry.assigned) * 10000) / 100 : 0,
      squadId: entry.squadId,
      assignedCount: entry.assigned,
    }));

    const ranked = rankEntries(rankable);

    // Previous ranks power the "moved up 3 places" indicator.
    const previous = await this.prisma.leaderboardEntry.findMany({
      where: { period, periodKey },
      select: { studentId: true, rank: true },
    });
    const previousRanks = new Map(previous.map((p) => [p.studentId, p.rank]));

    await this.prisma.$transaction([
      this.prisma.leaderboardEntry.deleteMany({ where: { period, periodKey } }),
      this.prisma.leaderboardEntry.createMany({
        data: ranked.map((row) => ({
          period,
          periodKey,
          studentId: row.entry.id,
          rank: row.rank,
          previousRank: previousRanks.get(row.entry.id) ?? null,
          score: Math.round(row.entry.score),
          solvedCount: row.entry.solvedCount,
          currentStreak: row.entry.currentStreak,
          completionMinute: row.entry.completionMinuteOfDay,
          consistency: row.entry.consistency,
          isTied: row.isTied,
        })),
      }),
    ]);

    await this.buildSquadLeaderboard(period, periodKey, rankable);
  }

  private async buildSquadLeaderboard(
    period: 'DAILY' | 'WEEKLY' | 'MONTHLY',
    periodKey: string,
    students: (RankableEntry & { squadId: string | null; assignedCount: number })[],
  ): Promise<void> {
    const squads = await this.prisma.squad.findMany({ select: { id: true, name: true } });

    const membersBySquad = new Map<
      string,
      (RankableEntry & { assignedCount: number })[]
    >();
    for (const student of students) {
      if (!student.squadId) continue;
      const list = membersBySquad.get(student.squadId) ?? [];
      list.push(student);
      membersBySquad.set(student.squadId, list);
    }

    const inputs = squads
      .filter((squad) => (membersBySquad.get(squad.id)?.length ?? 0) > 0)
      .map((squad) => {
        const members = membersBySquad.get(squad.id) ?? [];
        // Average problems assigned per member over the window — the denominator for
        // squad completion. Averaged rather than summed so unequal squad sizes compare.
        const assignedPerMember = Math.max(
          1,
          Math.round(members.reduce((n, m) => n + m.assignedCount, 0) / members.length),
        );
        return { squadId: squad.id, squadName: squad.name, members, assignedPerMember };
      });

    const ranked = rankSquads(inputs);

    const previous = await this.prisma.squadLeaderboardEntry.findMany({
      where: { period, periodKey },
      select: { squadId: true, rank: true },
    });
    const previousRanks = new Map(previous.map((p) => [p.squadId, p.rank]));

    await this.prisma.$transaction([
      this.prisma.squadLeaderboardEntry.deleteMany({ where: { period, periodKey } }),
      this.prisma.squadLeaderboardEntry.createMany({
        data: ranked.map((row) => ({
          period,
          periodKey,
          squadId: row.entry.squadId,
          rank: row.rank,
          previousRank: previousRanks.get(row.entry.squadId) ?? null,
          memberCount: row.entry.memberCount,
          averageCompletion: row.entry.averageCompletion,
          totalSolved: row.entry.totalSolved,
          averageStreak: row.entry.averageStreak,
          averageScore: row.entry.averageScore,
          isTied: row.isTied,
        })),
      }),
    ]);
  }

  /** Full recompute over a range — the admin panel's "recalculate scores". */
  async recomputeRange(from: DayKey, to: DayKey): Promise<{ days: number }> {
    const days = this.time.range(from, to);
    for (const dayKey of days) {
      await this.recomputeDay(dayKey);
    }
    await this.recomputeStudentAggregates();
    for (const dayKey of days) {
      await this.rebuildLeaderboards(dayKey);
    }
    await this.cache.flush();
    return { days: days.length };
  }

  // -------------------------------------------------------------------------

  /** Match each student's accepted submissions for the day against the assigned problems. */
  private async evaluateDay(
    dayKey: DayKey,
    assignedProblems: {
      position: number;
      problem: { id: string; titleSlug: string };
    }[],
  ): Promise<Map<string, StudentDayResult>> {
    const { start, end } = this.time.bounds(dayKey);
    const slugToProblem = new Map(
      assignedProblems.map((link) => [
        link.problem.titleSlug.toLowerCase(),
        { problemId: link.problem.id, position: link.position },
      ]),
    );

    const submissions = await this.prisma.submission.findMany({
      where: {
        // Filter on the precomputed dayKey *and* the timestamp bounds. The dayKey is
        // the indexed fast path; the bounds guard against a stale dayKey written by an
        // earlier run under a different program timezone.
        dayKey,
        submittedAt: { gte: start, lt: end },
        titleSlug: { in: [...slugToProblem.keys()] },
      },
      orderBy: { submittedAt: 'asc' },
    });

    const results = new Map<string, StudentDayResult>();

    for (const submission of submissions) {
      const assigned = slugToProblem.get(submission.titleSlug.toLowerCase());
      if (!assigned) continue;

      const result =
        results.get(submission.studentId) ??
        ({
          studentId: submission.studentId,
          solvedCount: 0,
          firstSolvedAt: null,
          lastSolvedAt: null,
          completedAt: null,
          problemStatuses: assignedProblems.map((link) => ({
            problemId: link.problem.id,
            position: link.position,
            status: 'NOT_ATTEMPTED' as ProblemStatus,
            solvedAt: null,
            language: null,
            attempts: 0,
          })),
        } satisfies StudentDayResult);

      const slot = result.problemStatuses.find((p) => p.problemId === assigned.problemId);
      if (!slot) continue;

      slot.attempts += 1;

      if (submission.status === 'ACCEPTED') {
        // Keep the *earliest* accepted submission: re-solving a problem later in the
        // day must not push the student's completion time backwards.
        if (slot.status !== 'ACCEPTED') {
          slot.status = 'ACCEPTED';
          slot.solvedAt = submission.submittedAt;
          slot.language = submission.language;
        }
      } else if (slot.status === 'NOT_ATTEMPTED') {
        slot.status = 'ATTEMPTED_NOT_ACCEPTED';
        slot.language = submission.language;
      }

      results.set(submission.studentId, result);
    }

    for (const result of results.values()) {
      const accepted = result.problemStatuses.filter((p) => p.status === 'ACCEPTED');
      result.solvedCount = accepted.length;

      const times = accepted
        .map((p) => p.solvedAt)
        .filter((d): d is Date => d !== null)
        .sort((a, b) => a.getTime() - b.getTime());

      result.firstSolvedAt = times[0] ?? null;
      result.lastSolvedAt = times[times.length - 1] ?? null;
      // "Completed" means the whole assignment; the timestamp is the last one needed.
      result.completedAt =
        accepted.length === assignedProblems.length ? (result.lastSolvedAt ?? null) : null;
    }

    return results;
  }

  private emptyStatuses(
    assignedProblems: { position: number; problem: { id: string } }[],
  ): StudentDayResult['problemStatuses'] {
    return assignedProblems.map((link) => ({
      problemId: link.problem.id,
      position: link.position,
      status: 'NOT_ATTEMPTED' as ProblemStatus,
      solvedAt: null,
      language: null,
      attempts: 0,
    }));
  }

  private async persistDailyStatus(input: {
    studentId: string;
    dayKey: DayKey;
    assignmentId: string | null;
    assignedCount: number;
    solvedCount: number;
    score: number;
    scoreBreakdown: unknown;
    completedAt: Date | null;
    completionMinute: number | null;
    firstSolvedAt: Date | null;
    lastSolvedAt: Date | null;
    isPerfect: boolean;
    streakAtDay: number;
    syncStatus: SyncStatus;
    problemStatuses: StudentDayResult['problemStatuses'];
  }): Promise<void> {
    const existing = await this.prisma.dailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: input.studentId, dayKey: input.dayKey } },
      select: { id: true, isOverridden: true },
    });

    // A mentor's manual override is authoritative. Recomputing must never silently
    // undo a deliberate correction.
    if (existing?.isOverridden) return;

    const data = {
      assignmentId: input.assignmentId,
      assignedCount: input.assignedCount,
      solvedCount: input.solvedCount,
      score: input.score,
      scoreBreakdown: input.scoreBreakdown as Prisma.InputJsonValue,
      completedAt: input.completedAt,
      completionMinute: input.completionMinute,
      firstSolvedAt: input.firstSolvedAt,
      lastSolvedAt: input.lastSolvedAt,
      isPerfect: input.isPerfect,
      streakAtDay: input.streakAtDay,
      syncStatus: input.syncStatus,
      computedAt: new Date(),
    };

    const status = await this.prisma.dailyStatus.upsert({
      where: { studentId_dayKey: { studentId: input.studentId, dayKey: input.dayKey } },
      create: { studentId: input.studentId, dayKey: input.dayKey, ...data },
      update: data,
    });

    if (input.problemStatuses.length === 0) return;

    for (const problem of input.problemStatuses) {
      await this.prisma.dailyProblemStatus.upsert({
        where: {
          dailyStatusId_problemId: { dailyStatusId: status.id, problemId: problem.problemId },
        },
        create: {
          dailyStatusId: status.id,
          problemId: problem.problemId,
          position: problem.position,
          status: problem.status,
          solvedAt: problem.solvedAt,
          language: problem.language,
          attempts: problem.attempts,
        },
        update: {
          position: problem.position,
          status: problem.status,
          solvedAt: problem.solvedAt,
          language: problem.language,
          attempts: problem.attempts,
        },
      });
    }
  }
}
