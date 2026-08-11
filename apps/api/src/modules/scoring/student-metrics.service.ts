/**
 * The three student metrics that the rest of the app must not compute for itself.
 *
 * Every surface — dashboard, daily/email reports, student details, leaderboards,
 * analytics — reads these, so they cannot drift apart the way they did when each
 * controller derived its own numbers. The rules themselves are pure functions in
 * `@dsa/shared`; this service only supplies the database reads.
 *
 * The three are deliberately separate quantities and must never be substituted for one
 * another:
 *
 *  - `calculateStudentLeetcodeTotalSolved` — lifetime distinct LeetCode problems solved.
 *  - `calculateAssignmentCompletion`       — assigned problems cleared for one day (X/Y).
 *  - `calculateStudentDsaStreak`           — consecutive assignment days with ≥1 solved.
 *
 * Batch variants exist for every one of them because the cohort is ~250 students: a
 * per-student query inside a loop is the difference between one report and 250 of them.
 */

import { Injectable } from '@nestjs/common';
import {
  ASSIGNMENT_LOOKBACK_DAYS,
  assignmentWindow,
  calculateAssignmentCompletion,
  computeStreaks,
  selectAssignmentForBatch,
  type AssignedProblemRef,
  type AssignmentCompletionResult,
  type CompletionSubmission,
  type DayKey,
  type StreakDay,
  type StreakResult,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { ScoringConfigService } from './scoring-config.service';
import { BatchesService } from '../batches/batches.service';

/** How far back a streak is traced. Beyond this it is not meaningfully "current". */
const STREAK_HISTORY_DAYS = 400;

export interface StudentAssignmentMetrics {
  dayKey: DayKey;
  assignedCount: number;
  solvedCount: number;
  completionPercent: number;
  hasAssignment: boolean;
}

@Injectable()
export class StudentMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    private readonly scoringConfig: ScoringConfigService,
    private readonly batches: BatchesService,
  ) {}

  // --- 1. Lifetime LeetCode solved -----------------------------------------

  /**
   * Distinct LeetCode problems a student has ever solved.
   *
   * Two sources are reconciled, and the larger wins:
   *
   *  - The **submission mirror**, counted as `COUNT(DISTINCT titleSlug)` over accepted
   *    rows. Exact for everything we have observed, but a floor rather than the truth:
   *    LeetCode's public submission list only exposes the 20 most recent entries, so
   *    anything solved before this student was first synced was never observable.
   *  - The provider's **own lifetime total** from the profile query
   *    (`StudentSyncState.providerTotalSolved`), which covers all of history but is only
   *    as fresh as the last profile refresh.
   *
   * Taking the maximum means a newly-imported student immediately shows their real
   * LeetCode count, while a student who solves something between profile refreshes is
   * still credited for it. Neither source can make the number go down spuriously.
   */
  async calculateStudentLeetcodeTotalSolved(studentId: string): Promise<number> {
    const map = await this.lifetimeSolvedByStudent([studentId]);
    return map.get(studentId) ?? 0;
  }

  /** Batch form of {@link calculateStudentLeetcodeTotalSolved}. Two queries, any cohort size. */
  async lifetimeSolvedByStudent(studentIds?: string[]): Promise<Map<string, number>> {
    const scoped = studentIds && studentIds.length > 0;

    // Prisma has no COUNT(DISTINCT x) GROUP BY, and `distinct` on findMany would pull
    // every accepted row into memory. One grouped raw query keeps it in the database.
    const mirrorRows = scoped
      ? await this.prisma.$queryRaw<{ studentId: string; count: bigint }[]>`
          SELECT "studentId", COUNT(DISTINCT "titleSlug") AS count
          FROM "submissions"
          WHERE "status" = 'ACCEPTED' AND "studentId"::text = ANY(${studentIds})
          GROUP BY "studentId"
        `
      : await this.prisma.$queryRaw<{ studentId: string; count: bigint }[]>`
          SELECT "studentId", COUNT(DISTINCT "titleSlug") AS count
          FROM "submissions"
          WHERE "status" = 'ACCEPTED'
          GROUP BY "studentId"
        `;

    const totals = new Map<string, number>();
    for (const row of mirrorRows) {
      totals.set(row.studentId, Number(row.count));
    }

    const profiles = await this.prisma.studentSyncState.findMany({
      where: {
        providerTotalSolved: { not: null },
        ...(scoped ? { studentId: { in: studentIds } } : {}),
      },
      select: { studentId: true, providerTotalSolved: true },
    });

    for (const profile of profiles) {
      const fromProvider = profile.providerTotalSolved ?? 0;
      const fromMirror = totals.get(profile.studentId) ?? 0;
      totals.set(profile.studentId, Math.max(fromProvider, fromMirror));
    }

    return totals;
  }

  // --- 2. Assignment completion for a day ----------------------------------

  /**
   * Whether a student cleared each of one day's assigned problems, honouring the
   * backwards lookback window (see `calculateAssignmentCompletion` in `@dsa/shared`).
   *
   * Returns `null` when there was no assignment that day — which is *not* the same as
   * "solved nothing", and callers must not treat it as a zero.
   *
   * The problem set is the one belonging to the batch the student was in *on that day*,
   * resolved from their placement history. A Foundation student is never measured
   * against Intermediate's problems, and a student who has since moved is still measured
   * against the set they were actually given (§4, §7).
   */
  async calculateAssignmentCompletionForStudent(
    studentId: string,
    dayKey: DayKey,
  ): Promise<AssignmentCompletionResult | null> {
    const batchIdOnDay = await this.batches.batchOnDay(studentId, dayKey);

    const candidates = await this.prisma.assignment.findMany({
      where: {
        dayKey,
        ...(batchIdOnDay ? { OR: [{ batchId: batchIdOnDay }, { batchId: null }] } : { batchId: null }),
      },
      include: { problems: { include: { problem: true }, orderBy: { position: 'asc' } } },
    });

    const assignment = selectAssignmentForBatch(candidates, batchIdOnDay);
    if (!assignment || assignment.problems.length === 0) return null;

    const assigned: AssignedProblemRef[] = assignment.problems.map((link) => ({
      problemId: link.problem.id,
      titleSlug: link.problem.titleSlug.toLowerCase(),
      position: link.position,
    }));

    const submissions = await this.loadWindowSubmissions(dayKey, assigned, [studentId]);
    return calculateAssignmentCompletion(
      dayKey,
      assigned,
      submissions.get(studentId) ?? [],
      ASSIGNMENT_LOOKBACK_DAYS,
    );
  }

  /**
   * The "Today's Assignment — X / Y" figure for the student profile.
   *
   * Reads the materialised `DailyStatus` row when one exists (it is rebuilt by the
   * rollup from exactly the same rules) and falls back to computing it live, so a day
   * that has not been rolled up yet still reports honestly instead of showing 0.
   */
  async assignmentMetricsFor(
    studentId: string,
    dayKey: DayKey,
  ): Promise<StudentAssignmentMetrics> {
    const status = await this.prisma.dailyStatus.findUnique({
      where: { studentId_dayKey: { studentId, dayKey } },
      select: { assignedCount: true, solvedCount: true },
    });

    if (status && status.assignedCount > 0) {
      return {
        dayKey,
        assignedCount: status.assignedCount,
        solvedCount: status.solvedCount,
        completionPercent: percent(status.solvedCount, status.assignedCount),
        hasAssignment: true,
      };
    }

    const live = await this.calculateAssignmentCompletionForStudent(studentId, dayKey);
    if (!live) {
      return {
        dayKey,
        assignedCount: 0,
        solvedCount: 0,
        completionPercent: 0,
        hasAssignment: false,
      };
    }

    return {
      dayKey,
      assignedCount: live.assignedCount,
      solvedCount: live.solvedCount,
      completionPercent: percent(live.solvedCount, live.assignedCount),
      hasAssignment: true,
    };
  }

  // --- 3. DSA streak --------------------------------------------------------

  /**
   * Consecutive assignment days, ending at the latest relevant one, on which the student
   * solved at least one assigned problem.
   *
   * Only days that actually had an assignment participate — a gap in the schedule is
   * neutral, not a miss — and days before the student joined are excluded entirely.
   */
  async calculateStudentDsaStreak(
    studentId: string,
    referenceDay?: DayKey,
  ): Promise<StreakResult> {
    const today = referenceDay ?? this.time.today();
    const from = this.time.addDays(today, -STREAK_HISTORY_DAYS);

    const [student, config, rows] = await Promise.all([
      this.prisma.student.findUnique({
        where: { id: studentId },
        select: { createdAt: true },
      }),
      this.scoringConfig.getActive(),
      this.prisma.dailyStatus.findMany({
        where: { studentId, dayKey: { gte: from, lte: today } },
        select: { dayKey: true, solvedCount: true, assignedCount: true },
      }),
    ]);

    const days: StreakDay[] = rows.map((r) => ({
      dayKey: r.dayKey,
      solvedCount: r.solvedCount,
      assignedCount: r.assignedCount,
    }));

    return computeStreaks(days, today, config, {
      enrolledFromDayKey: student ? this.time.dayKeyOf(student.createdAt) : null,
    });
  }

  /**
   * Total assigned problems this student has ever completed — the optional
   * programme-specific metric. Distinct from lifetime LeetCode solved, which counts
   * everything they solve including problems we never assigned.
   */
  async totalAssignmentProblemsCompleted(studentId: string): Promise<number> {
    const result = await this.prisma.dailyStatus.aggregate({
      where: { studentId, assignedCount: { gt: 0 } },
      _sum: { solvedCount: true },
    });
    return result._sum.solvedCount ?? 0;
  }

  // -------------------------------------------------------------------------

  /** Submissions inside an assignment's lookback window, grouped by student. */
  private async loadWindowSubmissions(
    dayKey: DayKey,
    assigned: AssignedProblemRef[],
    studentIds?: string[],
  ): Promise<Map<string, CompletionSubmission[]>> {
    const { startDayKey, endDayKey } = assignmentWindow(dayKey, ASSIGNMENT_LOOKBACK_DAYS);

    const rows = await this.prisma.submission.findMany({
      where: {
        dayKey: { gte: startDayKey, lte: endDayKey },
        submittedAt: {
          gte: this.time.bounds(startDayKey).start,
          lt: this.time.bounds(endDayKey).end,
        },
        titleSlug: { in: assigned.map((a) => a.titleSlug) },
        ...(studentIds && studentIds.length > 0 ? { studentId: { in: studentIds } } : {}),
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

    const grouped = new Map<string, CompletionSubmission[]>();
    for (const row of rows) {
      const list = grouped.get(row.studentId) ?? [];
      list.push(row);
      grouped.set(row.studentId, list);
    }
    return grouped;
  }
}

function percent(solved: number, assigned: number): number {
  if (assigned <= 0) return 0;
  return Math.round((Math.min(solved, assigned) / assigned) * 10000) / 100;
}
