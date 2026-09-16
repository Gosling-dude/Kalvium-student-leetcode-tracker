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
  ASSIGNMENT_LOOKBACK_DAYS,
  assignmentWindow,
  calculateAssignmentCompletion,
  COMPLETION_RULES_VERSION,
  computeDailyScore,
  computeStreaks,
  isCurrentStudent,
  isPerfectDay,
  rankEntries,
  selectAssignmentForScope,
  rankSquads,
  resolveFrozenField,
  type AssignedProblemRef,
  type CompletionSubmission,
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
import { StudentMetricsService } from './student-metrics.service';
import { BatchesService } from '../batches/batches.service';
import { CampusesService } from '../campuses/campuses.service';
import { EnrolmentService } from '../../common/services/enrolment.service';

/** How far back streak computation looks. Beyond this, a streak is not meaningfully "current". */
const STREAK_HISTORY_DAYS = 400;

/**
 * The longest span `reconcileAssignmentDay` will rewrite inside the request that
 * triggered it.
 *
 * Thirty days covers every realistic "I forgot to enter last week's assignments" while
 * staying well inside an HTTP timeout at cohort size. Anything longer is a deliberate
 * admin operation with its own progress reporting (`POST /admin/recompute`).
 */
const MAX_INLINE_RECONCILE_DAYS = 30;

interface StudentDayResult {
  studentId: string;
  /** Distinct assigned problems solved at any time — the assignment-analysis figure. */
  solvedCount: number;
  /** The same, restricted to the lookback window — the only one streaks may read. */
  inWindowSolvedCount: number;
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
    inWindowStatus: ProblemStatus;
    solvedInWindowAt: Date | null;
    attemptsInWindow: number;
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
    private readonly metrics: StudentMetricsService,
    private readonly batches: BatchesService,
    private readonly campuses: CampusesService,
    private readonly enrolment: EnrolmentService,
  ) {}

  /**
   * Rebuild `DailyStatus` (and per-problem detail) for one program day, then refresh
   * the streaks, scores and leaderboards that depend on it.
   *
   * `force` bypasses the `batchId`/`assignmentId` freeze in `persistDailyStatus` — see
   * that method's comment. It exists for one purpose: correcting a day that was computed
   * *before* an upstream data-quality bug (e.g. a roster sync that back-dated a student's
   * placement to the wrong day) was fixed. An ordinary recompute deliberately cannot fix
   * such a day, because the whole point of the freeze is that admin actions taken *after*
   * a day closes — retargeting an assignment, moving a student — must never rewrite it.
   * A one-time data correction is a different thing: the frozen value was never correct to
   * begin with. `force` is therefore opt-in, admin-only (`POST /admin/recompute`), and
   * still refuses to touch a mentor's manual override (`isOverridden`) either way.
   */
  async recomputeDay(
    dayKey: DayKey,
    options: { force?: boolean } = {},
  ): Promise<{ students: number; assigned: number }> {
    const config = await this.scoringConfig.getActive();

    // Every audience's set for the day — each campus + batch combination, plus any
    // campus-wide and everyone rows. Which one applies to a given student is decided per
    // student below, from the campus *and* batch they were in **that day** — never from
    // the ones they are in now (§17).
    const assignments = await this.prisma.assignment.findMany({
      where: { dayKey },
      include: { problems: { include: { problem: true }, orderBy: { position: 'asc' } } },
    });

    const students = await this.prisma.student.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        leetcodeUsername: true,
        createdAt: true,
        campusId: true,
        batchId: true,
        syncState: { select: { status: true } },
      },
    });

    // The historical placement of every student on this day, resolved in two queries —
    // one per dimension, both batched across the whole roster. A per-student lookup here
    // would turn one day's recompute into hundreds of round trips (§27).
    const studentIds = students.map((student) => student.id);
    const [historicalBatch, historicalCampus, observedFromDay] = await Promise.all([
      this.batches.batchOnDayForStudents(studentIds, dayKey),
      this.campuses.campusOnDayForStudents(studentIds, dayKey),
      // Resolved once for the whole roster, so this skip and the dashboard's
      // "not observed" list cannot disagree about the same student.
      this.enrolment.observedFromDayByStudent(studentIds),
    ]);

    // Which assignment each student was already evaluated against for this exact day, if
    // this day has been computed before. Once a `DailyStatus` names an assignment, a later
    // recompute keeps using that same row — even if an admin has since retargeted its
    // batch (§9) — rather than re-resolving via `selectAssignmentForScope` and picking a
    // different (or no) assignment out from under an already-scored day.
    //
    // Skipped entirely under `force`: the whole point of a forced recompute is to let a
    // day whose frozen assignment/batch was wrong from the start (not retargeted after the
    // fact) be re-resolved from scratch. See `recomputeDay`'s doc comment.
    const frozenAssignmentByStudent = new Map<string, string>();
    if (!options.force) {
      const existingToday = await this.prisma.dailyStatus.findMany({
        where: { dayKey },
        select: { studentId: true, assignmentId: true },
      });
      for (const row of existingToday) {
        if (row.assignmentId) frozenAssignmentByStudent.set(row.studentId, row.assignmentId);
      }
    }

    // Evaluate once per distinct problem set rather than once per student: the students
    // in a batch all face the same problems, and the submission scan is the expensive part.
    const resultsByAssignment = new Map<string, Map<string, StudentDayResult>>();
    for (const assignment of assignments) {
      resultsByAssignment.set(
        assignment.id,
        await this.evaluateDay(dayKey, assignment.problems),
      );
    }

    const difficultyByProblem = new Map<string, Difficulty>(
      assignments.flatMap((assignment) =>
        assignment.problems.map(
          (link) => [link.problem.id, link.problem.difficulty as Difficulty] as const,
        ),
      ),
    );

    // Streaks need history, so load the window once for everyone rather than per student.
    const historyFrom = this.time.addDays(dayKey, -STREAK_HISTORY_DAYS);
    const history = await this.prisma.dailyStatus.findMany({
      where: { dayKey: { gte: historyFrom, lt: dayKey } },
      select: {
        studentId: true,
        dayKey: true,
        inWindowSolvedCount: true,
        assignedCount: true,
      },
    });

    const historyByStudent = new Map<string, StreakDay[]>();
    for (const row of history) {
      const list = historyByStudent.get(row.studentId) ?? [];
      list.push({
        dayKey: row.dayKey,
        // The window count, matching what today's row contributes below. Mixing the two
        // would make a streak depend on which side of this change a day was written on.
        solvedCount: row.inWindowSolvedCount,
        assignedCount: row.assignedCount,
      });
      historyByStudent.set(row.studentId, list);
    }

    let scored = 0;

    for (const student of students) {
      // A day before the student enrolled is not a day they scored zero on — it is a day
      // they were not in the programme. Writing a row for it invents a record: the whole
      // cohort imported mid-term lands on every earlier day's leaderboard at zero, and
      // because `campusOnDayForStudents` correctly reports "no campus" for those days,
      // those rows carry a null `campusId` — which reads as *every* campus, putting a
      // student on the global board for weeks their campus did not yet exist (§17).
      //
      // A day before the student's record existed is not a day they scored zero on — it
      // is a day nobody measured. `EnrolmentService` is the single definition, shared with
      // the dashboard's "not observed" list; `resolveObservedFromDay` records why neither
      // placement history nor a surviving submission is allowed to widen it, since both
      // look like fixes for the late-assignment problem and both fabricate results.
      const enrolledFromDayKey =
        observedFromDay.get(student.id) ?? this.time.dayKeyOf(student.createdAt);
      if (enrolledFromDayKey > dayKey) continue;

      // The batch that was true on this day. A student with no recorded placement by
      // then genuinely had none — their current batch is not a substitute, because using
      // it would re-file a closed day under a batch they joined later (§7).
      const batchIdOnDay = historicalBatch.get(student.id) ?? null;
      const campusIdOnDay = historicalCampus.get(student.id) ?? null;
      const scopeOnDay = { campusId: campusIdOnDay, batchId: batchIdOnDay };

      // Only sets aimed at this student's campus and batch are candidates, widening
      // through the campus-wide and everyone tiers. Another campus's or batch's problems
      // are never considered — unless this day was already scored against a specific
      // assignment, in which case that frozen choice wins outright (see
      // `frozenAssignmentByStudent` above).
      const frozenAssignmentId = frozenAssignmentByStudent.get(student.id);
      const assignment = frozenAssignmentId
        ? (assignments.find((a) => a.id === frozenAssignmentId) ??
            selectAssignmentForScope(assignments, scopeOnDay))
        : selectAssignmentForScope(assignments, scopeOnDay);

      // A day with no assignment for this student's batch still gets a row, with
      // assignedCount 0. Those days are neutral for streaks and must not be confused
      // with "assigned but missed".
      const assignedProblems = assignment?.problems ?? [];
      const assignedCount = assignedProblems.length;

      const result = assignment
        ? resultsByAssignment.get(assignment.id)?.get(student.id)
        : undefined;
      // Two counts, and which one each consumer gets is the whole point of this change.
      // `solvedCount` answers "has this student solved the assigned problems" and ignores
      // when; `inWindowSolvedCount` answers "did they work on them that week".
      const solvedCount = result?.solvedCount ?? 0;
      const inWindowSolvedCount = result?.inWindowSolvedCount ?? 0;

      // Streaks read the window. A problem solved in June is not a day practised in
      // September, and crediting it would manufacture a streak out of nothing — the same
      // class of error, in the opposite direction, as the zero this change removes.
      const days = [...(historyByStudent.get(student.id) ?? [])];
      days.push({ dayKey, solvedCount: inWindowSolvedCount, assignedCount });
      // Assignment days before the student joined are not misses — drop them rather
      // than let them zero out a streak the student never had a chance to earn.
      const streaks = computeStreaks(days, dayKey, config, { enrolledFromDayKey });

      const completionMinute = result?.completedAt
        ? this.time.minuteOfDay(result.completedAt)
        : null;

      // Scored on the window too, and for the same reason: the daily score is a measure
      // of that day's work, and the difficulty bonus must follow the problems actually
      // solved that week rather than everything the student has ever cleared.
      const solvedDifficulties = (result?.problemStatuses ?? [])
        .filter((p) => p.inWindowStatus === 'ACCEPTED')
        .map((p) => difficultyByProblem.get(p.problemId) ?? 'MEDIUM');

      const score = computeDailyScore(
        {
          solvedCount: inWindowSolvedCount,
          assignedCount,
          completionMinuteOfDay: completionMinute,
          solvedDifficulties,
          streakLength: streaks.current,
        },
        config,
      );

      // "Perfect" is always the whole assignment. It must not follow the streak
      // threshold, which is deliberately lenient (one problem is enough).
      //
      // Deliberately the ever-solved count: "perfect" means the assignment is cleared,
      // and a student who had already solved all four problems has cleared it. This is
      // the one place the two counts could reasonably go either way, and it follows the
      // assignment rather than the practice measure because that is what the word means
      // on the tracker.
      const isPerfect = isPerfectDay(solvedCount, assignedCount);

      await this.persistDailyStatus({
        studentId: student.id,
        dayKey,
        assignmentId: assignment?.id ?? null,
        campusId: campusIdOnDay,
        batchId: batchIdOnDay,
        assignedCount,
        solvedCount,
        inWindowSolvedCount,
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
        force: options.force ?? false,
      });
      scored += 1;
    }

    await this.cache.delByPrefix(`dashboard:${dayKey}`);
    await this.cache.delByPrefix(`mentor:${dayKey}`);

    const totalAssigned = assignments.reduce((n, a) => n + a.problems.length, 0);
    const notYetEnrolled = students.length - scored;
    this.logger.log(
      `Recomputed ${dayKey}: ${scored} students across ${assignments.length} assignment set(s), ${totalAssigned} problems assigned in total` +
        (notYetEnrolled > 0 ? ` (${notYetEnrolled} not yet enrolled on this day, skipped)` : ''),
    );

    return { students: scored, assigned: totalAssigned };
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

    const students = await this.prisma.student.findMany({
      select: { id: true, createdAt: true, totalSolved: true },
    });
    const observedFromDay = await this.enrolment.observedFromDayByStudent(
      students.map((student) => student.id),
    );

    const statuses = await this.prisma.dailyStatus.findMany({
      where: { dayKey: { gte: from, lte: today } },
      select: {
        studentId: true,
        dayKey: true,
        // The window count, because this feeds `computeStreaks`. `solvedCount` here would
        // credit a student with a streak day for a problem they solved months earlier.
        inWindowSolvedCount: true,
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

    // Lifetime solved comes from the submission mirror and the provider profile, never
    // from DailyStatus — `totalSolved` means "distinct LeetCode problems this student
    // has ever solved", not "assigned problems completed". Those are different numbers
    // and conflating them made the profile page show today's assignment count.
    const totalSolvedMap = await this.metrics.lifetimeSolvedByStudent();

    for (const student of students) {
      const rows = byStudent.get(student.id) ?? [];
      const streaks = computeStreaks(
        rows.map((r) => ({
          dayKey: r.dayKey,
          solvedCount: r.inWindowSolvedCount,
          assignedCount: r.assignedCount,
        })),
        today,
        config,
        {
          enrolledFromDayKey:
            observedFromDay.get(student.id) ?? this.time.dayKeyOf(student.createdAt),
        },
      );

      // A student absent from the canonical map has *no evidence* either way — no
      // accepted submission mirrored and no provider profile total. That is not a
      // measurement of zero, and overwriting a previously-known total with 0 is exactly
      // the "sync failure → 0 solved" conversion the design forbids. Keep what we last
      // knew; a successful sync will raise it, and a genuine 0 stays 0 because the map
      // does carry an entry for a student whose profile reports zero solved.
      const canonicalTotal = totalSolvedMap.get(student.id);
      const totalSolved = canonicalTotal ?? student.totalSolved;

      await this.prisma.student.update({
        where: { id: student.id },
        data: {
          currentStreak: streaks.current,
          longestStreak: Math.max(streaks.longest, streaks.current),
          totalScore: rows.reduce((n, r) => n + r.score, 0),
          totalSolved,
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
          select: {
            id: true,
            name: true,
            currentStreak: true,
            squadId: true,
            batchId: true,
            campusId: true,
            status: true,
          },
        },
      },
    });

    // Archived students are out of the current programme, so they are out of the current
    // leaderboard (§12, §24) — while their existing `LeaderboardEntry` rows for past
    // periods stay untouched, keeping historical standings correct.
    const active = rows.filter((row) => isCurrentStudent(row.student.status));

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
        batchId: string | null;
        campusId: string | null;
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
        batchId: null,
        campusId: null,
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

      // The batch this ranking belongs to is the one the student was in on the period's
      // closing day — a historical fact taken from `DailyStatus`, not from the student's
      // current batch, so re-ranking an old period after a move keeps the old grouping.
      if (row.batchId !== null && (entry.batchId === null || row.dayKey === to)) {
        entry.batchId = row.batchId;
      }

      // Campus is snapshotted the same way and for the same reason: a student who
      // transferred mid-period is ranked under the campus they finished it at, and
      // re-ranking that period later must not move them to their newest campus.
      if (row.campusId !== null && (entry.campusId === null || row.dayKey === to)) {
        entry.campusId = row.campusId;
      }

      byStudent.set(row.studentId, entry);
    }

    const rankable: (RankableEntry & {
      squadId: string | null;
      batchId: string | null;
      campusId: string | null;
      assignedCount: number;
    })[] = [...byStudent].map(([id, entry]) => ({
      id,
      displayName: entry.name,
      score: entry.score,
      solvedCount: entry.solved,
      completionMinuteOfDay: entry.completionMinute,
      currentStreak: entry.streak,
      consistency:
        entry.assigned > 0 ? Math.round((entry.solved / entry.assigned) * 10000) / 100 : 0,
      squadId: entry.squadId,
      batchId: entry.batchId,
      campusId: entry.campusId,
      assignedCount: entry.assigned,
    }));

    // Two independent rankings, computed from the same underlying scores.
    //
    // `globalRank` ranks every active student together, across every campus. `rank` ranks
    // each student within their own campus. Neither is derived from the other: a global
    // standing cannot be reconstructed by interleaving per-campus positions, and a campus
    // standing cannot be read off a global list without re-numbering it (§14). Computing
    // both here — from `rankEntries`, so ties and tiebreakers follow one definition — is
    // what lets a Vels student and an SRM student sit at #1 and #2 globally while each
    // also leads their own campus.
    const ranked = rankEntries(rankable);
    const globalRankById = new Map(ranked.map((row) => [row.entry.id, row.rank]));

    const campusRankById = new Map<string, number>();
    const byCampus = new Map<string | null, typeof rankable>();
    for (const entry of rankable) {
      const list = byCampus.get(entry.campusId) ?? [];
      list.push(entry);
      byCampus.set(entry.campusId, list);
    }
    for (const [, entries] of byCampus) {
      for (const row of rankEntries(entries)) campusRankById.set(row.entry.id, row.rank);
    }

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
          batchId: row.entry.batchId,
          campusId: row.entry.campusId,
          // `rank` is the student's position *within their campus*; `globalRank` is their
          // position across all of them. See the comment where both are computed.
          rank: campusRankById.get(row.entry.id) ?? row.rank,
          globalRank: globalRankById.get(row.entry.id) ?? row.rank,
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
    students: (RankableEntry & {
      squadId: string | null;
      batchId: string | null;
      campusId: string | null;
      assignedCount: number;
    })[],
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

  /**
   * Bring one assignment day's stored results up to date, the moment the assignment
   * changes.
   *
   * The supported answer to "I have just entered an assignment for a date in the past".
   * Creating a historical assignment used to leave the tracker showing nothing for that
   * date until the next sync happened to notice the day was stale — correct eventually,
   * but "eventually" is three hours, and the person who just typed the assignment in is
   * looking at the screen now.
   *
   * Three properties:
   *
   *  * **It fetches nothing.** Recomputation reads the submission mirror, so it cannot
   *    create, move or overwrite a submission. Re-running it is always safe.
   *  * **It recomputes `dayKey` through `today`, not just `dayKey`.** A day's
   *    `streakAtDay` is a function of the days before it: correcting 7 Sep from "solved
   *    nothing" to "solved everything" changes what the 8th and 9th say. Leaving them
   *    would trade one visibly-wrong number for several quietly-wrong ones.
   *  * **It is bounded.** A range longer than `maxSyncDays` is refused rather than run
   *    inline — recomputing a year of history inside an HTTP request would time out
   *    halfway and leave the range half-rewritten. The caller is told to use
   *    `POST /admin/recompute`, which runs in the background and says so.
   *
   * @returns the days actually recomputed, or `null` when the range was too long to run
   * inline — the caller decides whether that is an error or a note.
   */
  async reconcileAssignmentDay(
    dayKey: DayKey,
    options: { maxSyncDays?: number } = {},
  ): Promise<{ days: DayKey[] } | null> {
    const today = this.time.today();
    // A future-dated assignment has no history to reconcile; recompute the day itself so
    // the row exists, and stop there.
    const to = dayKey > today ? dayKey : today;
    const days = this.time.range(dayKey, to);

    const limit = options.maxSyncDays ?? MAX_INLINE_RECONCILE_DAYS;
    if (days.length > limit) return null;

    // Oldest first: each day's streak reads the corrected version of the one before it
    // rather than a stale one.
    for (const day of days) await this.recomputeDay(day);
    await this.recomputeStudentAggregates();
    for (const day of days) await this.rebuildLeaderboards(day);

    this.logger.log(
      `Reconciled assignment day ${dayKey}: recomputed ${days.length} day(s) through ${to}`,
    );
    return { days };
  }

  /** Full recompute over a range — the admin panel's "recalculate scores". */
  async recomputeRange(
    from: DayKey,
    to: DayKey,
    options: { force?: boolean } = {},
  ): Promise<{ days: number }> {
    const days = this.time.range(from, to);
    for (const dayKey of days) {
      await this.recomputeDay(dayKey, options);
    }
    await this.recomputeStudentAggregates();
    for (const dayKey of days) {
      await this.rebuildLeaderboards(dayKey);
    }
    await this.cache.flush();
    return { days: days.length };
  }

  /**
   * Days whose stored results no longer reflect the assignment they should be scored
   * against — the set a sync has to recompute beyond its own day.
   *
   * The invariant is deliberately general rather than a special case for late-added
   * assignments: **a day is stale when its assignment has been written more recently than
   * the day was last computed.** One condition covers every way a day can go out of date:
   *
   *  * the assignment was *added* after its own date (the reported bug — an assignment
   *    dated 20 Aug inserted on 22 Aug was never evaluated, because nothing recomputed
   *    20 Aug afterwards);
   *  * its problem list was edited;
   *  * its audience was retargeted;
   *  * the day was never computed at all, so there is no `computedAt` to compare against.
   *
   * It is also self-clearing: one recompute moves `computedAt` past `updatedAt` and the
   * day stops being reported, so a sync does not keep redoing settled work.
   *
   * The second query covers the one case the first structurally cannot: a **deleted**
   * assignment. `DailyStatus.assignmentId` is `SetNull`, so deleting an assignment leaves
   * rows that still claim `assignedCount = 4` while naming no assignment — 15 students
   * recorded as having missed four problems on a day that has no assignment at all. That
   * is a false zero on the report, the leaderboard and the streak. A query that starts
   * `FROM assignments` can never find those days, because the row it would have to find
   * them by is the one that was deleted. So they are found from the wreckage instead: a
   * scored day naming no assignment while claiming problems were assigned is, by
   * construction, a day whose assignment went away after it was computed — the rollup only
   * ever writes a non-zero `assignedCount` from an assignment it had in hand.
   *
   * Also self-clearing: the recompute finds no assignment, writes `assignedCount = 0`, and
   * the day stops matching.
   *
   * The third query covers the case neither of the others can see: the **rules** changed
   * while the data did not. When `solvedCount` was redefined from "solved in the window"
   * to "ever solved", every historical row was left holding the old figure — and was
   * invisible to the first query, because no assignment had been touched. That is the
   * shape of the reported bug: an assignment entered on the 11th for the 7th, whose
   * students had solved the problems on the 5th, going on reporting zero. Rows stamped
   * with a superseded `computedVersion` are stale by definition, so the ordinary
   * recompute path now heals a rule change without anyone remembering to ask it to.
   *
   * Self-clearing in the same way: the recompute stamps the current version and the day
   * stops matching, which is what makes running this five times produce one change and
   * four no-ops.
   *
   * `assignment.createdAt` is never used to filter *submissions* — that would discard
   * genuine work done before the assignment was entered, which is the very thing the
   * lookback window exists to allow. It is only ever used here, to decide *which days to
   * recompute*.
   */
  async findStaleAssignmentDays(from: DayKey, to: DayKey): Promise<DayKey[]> {
    const [edited, orphaned, superseded] = await Promise.all([
      this.prisma.$queryRaw<{ dayKey: string }[]>`
        SELECT DISTINCT a."dayKey"
        FROM "assignments" a
        WHERE a."dayKey" >= ${from}
          AND a."dayKey" <= ${to}
          AND a."updatedAt" > COALESCE(
            (SELECT MAX(d."computedAt") FROM "daily_statuses" d WHERE d."dayKey" = a."dayKey"),
            '-infinity'::timestamp
          )
        ORDER BY a."dayKey"
      `,
      this.prisma.$queryRaw<{ dayKey: string }[]>`
        SELECT DISTINCT d."dayKey"
        FROM "daily_statuses" d
        WHERE d."dayKey" >= ${from}
          AND d."dayKey" <= ${to}
          AND d."assignmentId" IS NULL
          AND d."assignedCount" > 0
        ORDER BY d."dayKey"
      `,
      // Rows written by a superseded rule set. Restricted to days that were actually
      // scored against an assignment: a day with nothing assigned has no completion
      // figure for a rule change to have invalidated, and sweeping those in would make
      // every empty weekend look stale for ever.
      this.prisma.$queryRaw<{ dayKey: string }[]>`
        SELECT DISTINCT d."dayKey"
        FROM "daily_statuses" d
        WHERE d."dayKey" >= ${from}
          AND d."dayKey" <= ${to}
          AND d."computedVersion" < ${COMPLETION_RULES_VERSION}
          AND d."assignedCount" > 0
        ORDER BY d."dayKey"
      `,
    ]);

    return [
      ...new Set([...edited, ...orphaned, ...superseded].map((row) => row.dayKey)),
    ].sort();
  }

  /**
   * Every scored day still holding results from a superseded rule set, over all history.
   *
   * Separate from `findStaleAssignmentDays` because it deliberately takes no date range.
   * A routine sync is bounded to a fortnight so it can never turn into a full rebuild,
   * and that bound is right — but a rule change reaches back to the first day of the
   * programme, and a fortnight-wide broom will never sweep it. This is what the operator
   * and the integrity check need to see: not "is recent data current" but "is any stored
   * figure still answering the old question".
   *
   * Cheap: `daily_statuses_computedVersion_dayKey_idx` makes it an index-only scan of the
   * rows below the current version, which is zero rows in the steady state.
   */
  async findSupersededDays(): Promise<DayKey[]> {
    const rows = await this.prisma.$queryRaw<{ dayKey: string }[]>`
      SELECT DISTINCT d."dayKey"
      FROM "daily_statuses" d
      WHERE d."computedVersion" < ${COMPLETION_RULES_VERSION}
        AND d."assignedCount" > 0
      ORDER BY d."dayKey"
    `;
    return rows.map((row) => row.dayKey as DayKey);
  }

  /** How much work `healSupersededDays` has outstanding — days and rows. */
  async countSupersededRows(): Promise<{ days: number; rows: number }> {
    const [row] = await this.prisma.$queryRaw<{ days: bigint; rows: bigint }[]>`
      SELECT COUNT(DISTINCT d."dayKey") AS days, COUNT(*) AS rows
      FROM "daily_statuses" d
      WHERE d."computedVersion" < ${COMPLETION_RULES_VERSION}
        AND d."assignedCount" > 0
    `;
    return { days: Number(row?.days ?? 0), rows: Number(row?.rows ?? 0) };
  }

  /**
   * Recompute every day still on a superseded rule set, oldest first.
   *
   * The operation the ever-solved change needed and did not have. It is idempotent by
   * construction rather than by promise: a day it recomputes is stamped with the current
   * version and no longer selected, so the second run finds nothing and the fifth run
   * finds nothing. Re-running it is a no-op, not a second correction.
   *
   * Oldest first so each day's streak reads the corrected version of the day before it,
   * and leaderboards are rebuilt afterwards rather than per day, because a day's rank
   * depends on every student's corrected figure for that day, not just the one being
   * written.
   */
  async healSupersededDays(
    options: { limit?: number } = {},
  ): Promise<{ days: DayKey[]; from: DayKey | null; to: DayKey | null; remaining: number }> {
    const all = await this.findSupersededDays();
    // Oldest first, so a bounded run always makes progress from the far end of the
    // backlog rather than re-treading the same recent days every night.
    const days = options.limit !== undefined ? all.slice(0, Math.max(0, options.limit)) : all;
    if (days.length === 0) return { days: [], from: null, to: null, remaining: 0 };

    for (const day of days) await this.recomputeDay(day);
    await this.recomputeStudentAggregates();
    for (const day of days) await this.rebuildLeaderboards(day);
    await this.cache.flush();

    const remaining = all.length - days.length;
    this.logger.log(
      `Healed ${days.length} day(s) computed under a superseded rule set ` +
        `(${days[0]}…${days[days.length - 1]}); now at version ${COMPLETION_RULES_VERSION}` +
        (remaining > 0 ? `; ${remaining} day(s) still outstanding` : ''),
    );
    return { days, from: days[0], to: days[days.length - 1], remaining };
  }

  // -------------------------------------------------------------------------

  /**
   * Match each student's accepted submissions against the day's assigned problems.
   *
   * The window is `[dayKey - ASSIGNMENT_LOOKBACK_DAYS, dayKey]`, not the single day:
   * assignments are routinely published a day or two after students have started, and
   * matching on the assignment date alone recorded already-solved problems as missed.
   * The actual matching rules (distinct problems, accepted-only, earliest solve wins)
   * live in `calculateAssignmentCompletion` so that every other surface in the app
   * derives completion the same way — see `StudentMetricsService`.
   *
   * One batched query covers every student, so this is O(1) queries per day rather than
   * O(students × problems).
   */
  private async evaluateDay(
    dayKey: DayKey,
    assignedProblems: {
      position: number;
      problem: { id: string; titleSlug: string };
    }[],
  ): Promise<Map<string, StudentDayResult>> {
    const assigned: AssignedProblemRef[] = assignedProblems.map((link) => ({
      problemId: link.problem.id,
      titleSlug: link.problem.titleSlug.toLowerCase(),
      position: link.position,
    }));

    // No date filter. The assignment *date* decides which day a question belongs to; the
    // student's whole LeetCode history decides whether it is solved. Narrowing this query
    // to the lookback window is precisely the bug — it caps `solvedCount` back to the
    // window before `calculateAssignmentCompletion` ever sees the rows, and no amount of
    // correctness downstream can recover a submission that was never loaded.
    //
    // Bounded by the assigned slugs (four per day) on `submissions_titleSlug_idx`, so
    // this reads a few hundred rows rather than the whole mirror.
    const submissions = await this.prisma.submission.findMany({
      where: {
        titleSlug: { in: assigned.map((a) => a.titleSlug) },
      },
      select: {
        studentId: true,
        problemId: true,
        titleSlug: true,
        status: true,
        submittedAt: true,
        dayKey: true,
        language: true,
      },
    });

    const byStudent = new Map<string, CompletionSubmission[]>();
    for (const submission of submissions) {
      const list = byStudent.get(submission.studentId) ?? [];
      list.push(submission);
      byStudent.set(submission.studentId, list);
    }

    const results = new Map<string, StudentDayResult>();

    for (const [studentId, rows] of byStudent) {
      const completion = calculateAssignmentCompletion(
        dayKey,
        assigned,
        rows,
        ASSIGNMENT_LOOKBACK_DAYS,
      );

      results.set(studentId, {
        studentId,
        solvedCount: completion.solvedCount,
        inWindowSolvedCount: completion.inWindowSolvedCount,
        firstSolvedAt: completion.firstSolvedAt,
        lastSolvedAt: completion.lastSolvedAt,
        completedAt: completion.completedAt,
        problemStatuses: completion.problems.map((p) => ({
          problemId: p.problemId,
          position: p.position,
          status: p.status as ProblemStatus,
          solvedAt: p.solvedAt,
          language: p.language,
          attempts: p.attempts,
          inWindowStatus: p.inWindowStatus as ProblemStatus,
          solvedInWindowAt: p.solvedInWindowAt,
          attemptsInWindow: p.attemptsInWindow,
        })),
      });
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
      inWindowStatus: 'NOT_ATTEMPTED' as ProblemStatus,
      solvedInWindowAt: null,
      attemptsInWindow: 0,
    }));
  }

  private async persistDailyStatus(input: {
    campusId?: string | null;
    studentId: string;
    dayKey: DayKey;
    assignmentId: string | null;
    batchId: string | null;
    assignedCount: number;
    solvedCount: number;
    inWindowSolvedCount: number;
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
    /** See `recomputeDay`'s doc comment. Defaults to false — the safe, normal path. */
    force?: boolean;
  }): Promise<void> {
    const existing = await this.prisma.dailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: input.studentId, dayKey: input.dayKey } },
      select: { id: true, isOverridden: true, batchId: true, campusId: true, assignmentId: true },
    });

    // A mentor's manual override is authoritative. Recomputing must never silently
    // undo a deliberate correction — `force` does not override an override.
    if (existing?.isOverridden) return;

    // The historical batch is written once and then frozen (§7), *unless* the caller has
    // explicitly asked to force-recompute this range because the frozen value was itself
    // wrong (e.g. a roster sync back-dated a placement to the wrong day and has since been
    // corrected). Recomputing 10 Aug after a student moved on 15 Aug must still not re-file
    // 10 Aug under the new batch — `batchOnDayForStudents` already returns the correct
    // historical answer for that case, which is exactly why the freeze is the default.
    const batchId = resolveFrozenField(existing?.batchId, input.batchId, input.force);
    // Campus follows exactly the same freeze rule, for exactly the same reason: a
    // transfer recorded on 20 Aug must not re-file 10 Aug under the new campus.
    const campusId = resolveFrozenField(
      existing?.campusId,
      input.campusId ?? null,
      input.force,
    );

    // Likewise the assignment a day was scored against is written once and then frozen
    // (§9), with the same `force` escape hatch and for the same reason.
    const assignmentId = resolveFrozenField(existing?.assignmentId, input.assignmentId, input.force);

    const data = {
      assignmentId,
      batchId,
      campusId,
      assignedCount: input.assignedCount,
      solvedCount: input.solvedCount,
      inWindowSolvedCount: input.inWindowSolvedCount,
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
      // Stamped on every write, never conditionally: a row is only as current as the
      // rules that produced it, and this row was just produced by these ones.
      computedVersion: COMPLETION_RULES_VERSION,
    };

    const status = await this.prisma.dailyStatus.upsert({
      where: { studentId_dayKey: { studentId: input.studentId, dayKey: input.dayKey } },
      create: { studentId: input.studentId, dayKey: input.dayKey, ...data },
      update: data,
    });

    // Drop any per-problem detail left over from a *different* problem set this day was
    // previously evaluated against — `assignedCount`/`solvedCount` above are already
    // correct for the current set, but without this a "missing questions" list could go
    // on showing a problem the student is no longer measured against. This is reachable
    // two ways: an admin edits an assignment's problem list (`PATCH /assignments/:id`),
    // or `assignmentId` itself legitimately changes — which normally can't happen once
    // frozen, but does under `force` (see above), which is exactly how this was found:
    // a day frozen to the wrong assignment before a data fix, force-recomputed onto the
    // right one, still showing the old assignment's problems as "missing" until this ran.
    const currentProblemIds = input.problemStatuses.map((p) => p.problemId);
    await this.prisma.dailyProblemStatus.deleteMany({
      where: {
        dailyStatusId: status.id,
        ...(currentProblemIds.length > 0 ? { problemId: { notIn: currentProblemIds } } : {}),
      },
    });

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
          inWindowStatus: problem.inWindowStatus,
          solvedInWindowAt: problem.solvedInWindowAt,
          attemptsInWindow: problem.attemptsInWindow,
        },
        update: {
          position: problem.position,
          status: problem.status,
          solvedAt: problem.solvedAt,
          language: problem.language,
          attempts: problem.attempts,
          inWindowStatus: problem.inWindowStatus,
          solvedInWindowAt: problem.solvedInWindowAt,
          attemptsInWindow: problem.attemptsInWindow,
        },
      });
    }
  }
}
