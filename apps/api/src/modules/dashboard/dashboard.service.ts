import { Injectable } from '@nestjs/common';
import {
  CACHE_TTL,
  SYNC_STATUS_LABELS,
  completionPercentage,
  isTrustworthySync,
  selectAssignmentForScope,
  summarizeBucketAttempts,
  summarizeProblemStatuses,
  type AssignmentSummary,
  type DashboardBatchBreakdown,
  type DashboardCampusBreakdown,
  type DashboardStats,
  type DayKey,
  type MentorBatchSection,
  type MentorBucket,
  type MentorBucketRow,
  type MentorDashboard,
  type MentorProblemOutcome,
  type ProblemStatus,
  type SyncStatus,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { AssignmentsService } from '../assignments/assignments.service';

/**
 * Options every dashboard read accepts.
 *
 * `null`/absent widens: no `campusId` is every campus, no `batchId` is every batch. The
 * two are always applied together against the values *frozen on the day's rows*, never
 * against the student's current campus or batch (§17).
 */
export interface DashboardFilter {
  campusId?: string | null;
  batchId?: string | null;
  /** Narrow to students with no batch assigned. See `ResolvedScope.onlyUnassigned`. */
  onlyUnassigned?: boolean;
  squadId?: string;
}

/** The composite key a `Campus → Batch` grouping is bucketed under. */
function scopeKey(campusId: string | null, batchId: string | null): string {
  return `${campusId ?? '-'}|${batchId ?? '-'}`;
}

/**
 * A `DailyStatus` row joined to the student fields the dashboard renders.
 *
 * Note `campusId` and `batchId` on the row itself: they are the campus and batch the
 * student was in *on that day*, frozen by the rollup. Every grouping below uses them
 * rather than `student.campusId`/`student.batchId`, which is why a student who moved or
 * transferred yesterday still appears under yesterday's campus and batch (§7, §17).
 */
type DetailedStatusRow = Awaited<ReturnType<DashboardService['loadStatusesWithProblems']>>[number];

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly time: ProgramTimeService,
    private readonly assignments: AssignmentsService,
  ) {}

  async getStats(dayKey?: DayKey, filter: DashboardFilter = {}): Promise<DashboardStats> {
    const day = dayKey ?? this.time.today();
    const campusId = filter.campusId ?? null;
    const batchId = filter.batchId ?? null;
    const cacheKey = `dashboard:${day}:stats:${campusId ?? 'all'}:${batchId ?? 'all'}`;

    return this.cache.remember(cacheKey, CACHE_TTL.dashboard, async () => {
      const [assignments, totalStudents, statuses, lastJob] = await Promise.all([
        this.assignments.findAllByDay(day),
        this.prisma.student.count({
          where: {
            status: 'ACTIVE',
            ...(campusId ? { campusId } : {}),
            ...(batchId ? { batchId } : {}),
            ...(filter.onlyUnassigned ? { batchId: null } : {}),
          },
        }),
        // With-problems, not the lighter `loadStatuses`: the attempted/not-attempted
        // split below needs each student's per-problem outcomes, not just the totals.
        // Both halves of the scope, not just the batch. Dropping `campusId` here made
        // `?campus=VELS` return every campus's rows — the filter looked applied (the
        // headline count changed) while the breakdowns silently showed everyone.
        this.loadStatusesWithProblems(day, { campusId, batchId }),
        this.prisma.syncJob.findFirst({
          where: { status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS'] } },
          orderBy: { finishedAt: 'desc' },
        }),
      ]);

      const active = statuses;

      // Per-batch first: each batch is bucketed against *its own* problem count, so a
      // 5-problem Intermediate day and a 4-problem Foundation day are both reported
      // honestly instead of being flattened to one denominator (§10).
      const batchBreakdown = this.buildBatchBreakdown(active, assignments, campusId, batchId);
      const campusBreakdown = await this.buildCampusBreakdown(active, campusId);

      // The overall bucket array spans the largest assignment of the day, so no student
      // is dropped into a bucket that does not exist.
      const maxAssigned = Math.max(0, ...active.map((s) => s.assignedCount));
      const buckets = new Array<number>(Math.max(maxAssigned, 4) + 1).fill(0);
      for (const status of active) {
        const index = Math.min(status.solvedCount, buckets.length - 1);
        buckets[index] = (buckets[index] ?? 0) + 1;
      }

      const totalSolved = active.reduce((n, s) => n + s.solvedCount, 0);
      const totalAssigned = active.reduce((n, s) => n + s.assignedCount, 0);

      // Of the students who did not clear the whole assignment, how many actually tried
      // the rest versus never submitted anything for it — never inferred from the solved
      // count alone, always read back from each problem's own recorded status.
      const { studentsAttemptedCount: attemptedNotSolvedStudents, studentsNotAttemptedCount: notAttemptedStudents } =
        summarizeBucketAttempts(
          active.map((status) => summarizeProblemStatuses(status.problemStatuses)),
        );

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
      const topSquad = await this.findTopSquad(day);

      return {
        dayKey: day,
        campusId,
        batchId,
        totalStudents,
        activeStudents: active.length,
        campusBreakdown,
        batchBreakdown,
        // Only meaningful when a single problem set is in view. On an unfiltered day
        // where batches were given different sets, any one of them would misreport that
        // batch's problems as everyone's, so it is null and `batchBreakdown` carries the
        // per-batch truth instead.
        assignment: batchId
          ? this.findAssignmentFor(assignments, { campusId, batchId })
          : assignments.length === 1
            ? assignments[0]!
            : null,
        solvedBuckets: buckets,
        completionPercent: completionPercentage(totalSolved, totalAssigned),
        attemptedNotSolvedStudents,
        notAttemptedStudents,
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
        topSquad,
        lastSyncAt: lastJob?.finishedAt?.toISOString() ?? null,
        lastSyncStatus: (lastJob?.status as DashboardStats['lastSyncStatus']) ?? null,
        unreliableSyncCounts: unreliable,
      } satisfies DashboardStats;
    });
  }

  /**
   * The daily tracker: five "solved N" tables, split by batch.
   *
   * Every row carries a `reason`. A student showing zero because their username is
   * misspelled is a data problem for the admin; a student showing zero because they did
   * not work is a conversation for the mentor. Collapsing both into "Reason Unknown"
   * makes the table actively misleading, so we resolve it wherever we can.
   */
  async getMentorDashboard(
    dayKey?: DayKey,
    filter: DashboardFilter = {},
  ): Promise<MentorDashboard> {
    const day = dayKey ?? this.time.today();
    const campusId = filter.campusId ?? null;
    const batchId = filter.batchId ?? null;
    const cacheKey = `mentor:${day}:${filter.squadId ?? 'all'}:${campusId ?? 'all'}:${
      batchId ?? 'all'
    }`;

    return this.cache.remember(cacheKey, CACHE_TTL.dashboard, async () => {
      const [assignments, statuses, ranks] = await Promise.all([
        this.assignments.findAllByDay(day),
        this.loadStatusesWithProblems(day, filter),
        this.prisma.leaderboardEntry.findMany({
          where: { period: 'DAILY', periodKey: day },
          select: { studentId: true, rank: true },
        }),
      ]);

      const rankByStudent = new Map(ranks.map((r) => [r.studentId, r.rank]));
      const rows = statuses.map((status) => this.toBucketRow(status, rankByStudent));

      // Group by the *historical* campus and batch on the row, so a student who has since
      // moved or transferred is still listed under where they were on this day. The key is
      // the pair: SRM Foundation and Vels Foundation are separate sections with separate
      // problem sets, and merging them would misreport both (§11, §17).
      const byScope = new Map<
        string,
        { campusId: string | null; batchId: string | null; rows: MentorBucketRow[] }
      >();
      for (const [index, row] of rows.entries()) {
        const status = statuses[index]!;
        const key = scopeKey(status.campusId, status.batchId);
        const group =
          byScope.get(key) ?? { campusId: status.campusId, batchId: status.batchId, rows: [] };
        group.rows.push(row);
        byScope.set(key, group);
      }

      const [batchOrder, campusOrder] = await Promise.all([this.batchOrder(), this.campusOrder()]);
      const sections: MentorBatchSection[] = [...byScope.values()]
        .sort(
          (a, b) =>
            (campusOrder.get(a.campusId) ?? 999) - (campusOrder.get(b.campusId) ?? 999) ||
            (batchOrder.get(a.batchId) ?? 999) - (batchOrder.get(b.batchId) ?? 999),
        )
        .map((group) => {
          const assignment = this.findAssignmentFor(assignments, group);
          const assignedCount = assignment?.problems.length ?? 0;
          return {
            campusId: group.campusId,
            campusName: assignment?.campusName ?? group.rows[0]?.campusName ?? null,
            campusCode: assignment?.campusCode ?? group.rows[0]?.campusCode ?? null,
            batchId: group.batchId,
            batchName: assignment?.batchName ?? group.rows[0]?.batchName ?? null,
            batchCode: assignment?.batchCode ?? group.rows[0]?.batchCode ?? null,
            assignment,
            assignedCount,
            buckets: this.bucketise(group.rows, assignedCount),
            totalStudents: group.rows.length,
          };
        });

      const maxAssigned = Math.max(0, ...rows.map((row) => row.assignedCount));

      return {
        dayKey: day,
        campusId,
        batchId,
        sections,
        assignment: batchId
          ? this.findAssignmentFor(assignments, { campusId, batchId })
          : null,
        buckets: this.bucketise(rows, maxAssigned),
        totalStudents: rows.length,
      } satisfies MentorDashboard;
    });
  }

  // -------------------------------------------------------------------------

  /**
   * The day's `DailyStatus` rows for current students, optionally narrowed to a batch,
   * plus the per-problem detail the "which questions are missing" column *and* the
   * attempted/not-attempted split both need.
   *
   * Batch filtering is applied to `DailyStatus.batchId` — the historical batch — not to
   * the student's current one. Asking for "Foundation on 10 Aug" therefore returns who
   * was in Foundation on 10 Aug, which is the only reading that stays stable when people
   * move (§7). Archived students are excluded: they are not part of the current
   * programme, though their rows remain in the table (§24).
   */
  private async loadStatusesWithProblems(dayKey: DayKey, filter: DashboardFilter) {
    return this.prisma.dailyStatus.findMany({
      where: this.statusWhere(dayKey, filter),
      include: {
        ...this.statusInclude(),
        problemStatuses: { include: { problem: { select: { title: true } } } },
      },
    });
  }

  private statusWhere(dayKey: DayKey, filter: DashboardFilter) {
    return {
      dayKey,
      ...(filter.campusId ? { campusId: filter.campusId } : {}),
      ...(filter.batchId ? { batchId: filter.batchId } : {}),
      ...(filter.onlyUnassigned ? { batchId: null } : {}),
      student: {
        status: 'ACTIVE' as const,
        ...(filter.squadId ? { squadId: filter.squadId } : {}),
      },
    };
  }

  private statusInclude() {
    return {
      student: {
        include: {
          squad: { select: { name: true } },
          batch: { select: { name: true, code: true } },
          campus: { select: { name: true, code: true } },
          syncState: { select: { status: true, lastError: true } },
        },
      },
      batch: { select: { name: true, code: true } },
      campus: { select: { name: true, code: true } },
    };
  }

  private buildBatchBreakdown(
    statuses: DetailedStatusRow[],
    assignments: AssignmentSummary[],
    filterCampusId: string | null,
    filterBatchId: string | null,
  ): DashboardBatchBreakdown[] {
    const byScope = new Map<
      string,
      { campusId: string | null; batchId: string | null; rows: DetailedStatusRow[] }
    >();
    for (const status of statuses) {
      const key = scopeKey(status.campusId, status.batchId);
      const group =
        byScope.get(key) ?? { campusId: status.campusId, batchId: status.batchId, rows: [] };
      group.rows.push(status);
      byScope.set(key, group);
    }

    // A group with an assignment but no students yet still deserves a row, otherwise the
    // dashboard silently omits an audience that was in fact given work.
    if (filterBatchId === null) {
      for (const assignment of assignments) {
        if (filterCampusId !== null && assignment.campusId !== filterCampusId) continue;
        const key = scopeKey(assignment.campusId, assignment.batchId);
        if (!byScope.has(key)) {
          byScope.set(key, {
            campusId: assignment.campusId,
            batchId: assignment.batchId,
            rows: [],
          });
        }
      }
    }

    return [...byScope.values()]
      .map((group) => {
        const assignment = this.findAssignmentFor(assignments, group);
        const assignedCount = assignment?.problems.length ?? 0;
        const buckets = new Array<number>(Math.max(assignedCount, 1) + 1).fill(0);
        for (const row of group.rows) {
          const index = Math.min(row.solvedCount, buckets.length - 1);
          buckets[index] = (buckets[index] ?? 0) + 1;
        }

        const attemptCounts = summarizeBucketAttempts(
          group.rows.map((row) => summarizeProblemStatuses(row.problemStatuses)),
        );

        return {
          campusId: group.campusId,
          campusName: assignment?.campusName ?? group.rows[0]?.campus?.name ?? null,
          campusCode: assignment?.campusCode ?? group.rows[0]?.campus?.code ?? null,
          batchId: group.batchId,
          batchName: assignment?.batchName ?? group.rows[0]?.batch?.name ?? null,
          batchCode: assignment?.batchCode ?? group.rows[0]?.batch?.code ?? null,
          activeStudents: group.rows.length,
          assignedCount,
          solvedBuckets: buckets,
          completionPercent: completionPercentage(
            group.rows.reduce((n, r) => n + r.solvedCount, 0),
            group.rows.reduce((n, r) => n + r.assignedCount, 0),
          ),
          attemptedNotSolvedStudents: attemptCounts.studentsAttemptedCount,
          notAttemptedStudents: attemptCounts.studentsNotAttemptedCount,
        } satisfies DashboardBatchBreakdown;
      })
      .sort(
        (a, b) =>
          (a.campusCode ?? 'zz').localeCompare(b.campusCode ?? 'zz') ||
          (a.batchCode ?? 'zz').localeCompare(b.batchCode ?? 'zz'),
      );
  }

  /**
   * Per-campus figures for the day.
   *
   * Computed from the day's rows directly rather than summed from `batchBreakdown`: a
   * campus total must count every student at that campus, including those in a batch that
   * had no assignment and those still awaiting placement, and a sum over batch rows would
   * quietly drop whichever of those the batch grouping did not produce a row for (§32).
   */
  private async buildCampusBreakdown(
    statuses: DetailedStatusRow[],
    filterCampusId: string | null,
  ): Promise<DashboardCampusBreakdown[]> {
    const byCampus = new Map<string | null, DetailedStatusRow[]>();
    for (const status of statuses) {
      const list = byCampus.get(status.campusId) ?? [];
      list.push(status);
      byCampus.set(status.campusId, list);
    }

    // Every active campus gets a row even on a day it had no work, so the dashboard shows
    // "SRM — 0 assigned" rather than omitting the campus and looking like it does not exist.
    const campuses = await this.prisma.campus.findMany({
      where: { status: 'ACTIVE', ...(filterCampusId ? { id: filterCampusId } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true },
    });
    for (const campus of campuses) {
      if (!byCampus.has(campus.id)) byCampus.set(campus.id, []);
    }

    // Unassigned is the absence of a batch, not a batch of its own — and it is counted
    // from *the day's own rows*, exactly like `activeStudents` beside it.
    //
    // Counting it from the student table instead would make the two numbers on one card
    // disagree: a student imported today has no status row yet, so the card would read
    // "92 active, 98 unassigned". Worse, on a historical day it would report today's
    // roster against a past day's activity, which is the historical rewrite §21 forbids.
    const unassignedByCampus = new Map<string | null, number>();
    for (const status of statuses) {
      if (status.batchId !== null) continue;
      unassignedByCampus.set(status.campusId, (unassignedByCampus.get(status.campusId) ?? 0) + 1);
    }

    const byId = new Map(campuses.map((campus) => [campus.id, campus]));
    const order = new Map(campuses.map((campus, index) => [campus.id, index]));

    return [...byCampus.entries()]
      .map(([campusId, rows]) => {
        const attemptCounts = summarizeBucketAttempts(
          rows.map((row) => summarizeProblemStatuses(row.problemStatuses)),
        );
        const solvedTotal = rows.reduce((n, r) => n + r.solvedCount, 0);
        const assignedTotal = rows.reduce((n, r) => n + r.assignedCount, 0);
        const campus = campusId ? byId.get(campusId) : null;

        return {
          campusId,
          campusName: campus?.name ?? rows[0]?.campus?.name ?? null,
          campusCode: campus?.code ?? rows[0]?.campus?.code ?? null,
          activeStudents: rows.length,
          assignedTotal,
          solvedTotal,
          completionPercent: completionPercentage(solvedTotal, assignedTotal),
          attemptedNotSolvedStudents: attemptCounts.studentsAttemptedCount,
          notAttemptedStudents: attemptCounts.studentsNotAttemptedCount,
          unassignedStudents: unassignedByCampus.get(campusId) ?? 0,
        } satisfies DashboardCampusBreakdown;
      })
      .sort((a, b) => (order.get(a.campusId ?? '') ?? 999) - (order.get(b.campusId ?? '') ?? 999));
  }

  /**
   * The assignment applying to one `Campus → Batch` group.
   *
   * Delegates to the shared three-tier resolver rather than re-implementing it, so the
   * dashboard's idea of "what was assigned" and the rollup's are guaranteed identical.
   */
  private findAssignmentFor(
    assignments: AssignmentSummary[],
    scope: { campusId: string | null; batchId: string | null },
  ): AssignmentSummary | null {
    return selectAssignmentForScope(assignments, scope);
  }

  private async campusOrder(): Promise<Map<string | null, number>> {
    const campuses = await this.prisma.campus.findMany({
      select: { id: true, sortOrder: true },
      orderBy: { sortOrder: 'asc' },
    });
    const order = new Map<string | null, number>(campuses.map((c) => [c.id, c.sortOrder]));
    // Pre-campus rows sort last — a historical remnant, not a current campus.
    order.set(null, 998);
    return order;
  }

  private async batchOrder(): Promise<Map<string | null, number>> {
    const batches = await this.prisma.batch.findMany({
      select: { id: true, sortOrder: true },
      orderBy: { sortOrder: 'asc' },
    });
    const order = new Map<string | null, number>(batches.map((b) => [b.id, b.sortOrder]));
    // Pre-batch rows sort last — they are a historical remnant, not a current batch.
    order.set(null, 998);
    return order;
  }

  private toBucketRow(
    status: DetailedStatusRow,
    rankByStudent: Map<string, number>,
  ): MentorBucketRow {
    const syncStatus = (status.student.syncState?.status ?? 'NEVER_SYNCED') as SyncStatus;

    const problems: MentorProblemOutcome[] = status.problemStatuses
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((p) => ({
        problemId: p.problemId,
        position: p.position,
        title: p.problem.title,
        status: p.status as ProblemStatus,
        attempts: p.attempts,
        solvedAt: p.solvedAt ? p.solvedAt.toISOString() : null,
      }));

    // Read straight from the stored per-problem status, never inferred from the
    // absence of an accepted submission — see `summarizeProblemStatuses` (§ submission-
    // attempt tracking). `solvedCount` above already agrees with this by construction.
    const { attemptedNotSolvedCount, notAttemptedCount } = summarizeProblemStatuses(
      status.problemStatuses,
    );

    const missing = problems.filter((p) => p.status !== 'ACCEPTED').map((p) => p.title);

    return {
      studentId: status.studentId,
      name: status.student.name,
      email: status.student.email,
      squadName: status.student.squad?.name ?? null,
      // The campus recorded on the row (historical), falling back to the student's
      // current campus only for pre-campus rows that never had one.
      campusName: status.campus?.name ?? status.student.campus?.name ?? null,
      campusCode: status.campus?.code ?? status.student.campus?.code ?? null,
      // The batch recorded on the row (historical), falling back to the student's
      // current batch only for pre-batch rows that never had one.
      batchName: status.batch?.name ?? status.student.batch?.name ?? null,
      batchCode: status.batch?.code ?? status.student.batch?.code ?? null,
      cohort: status.student.cohort,
      maxBeltLevel: status.student.maxBeltLevel,
      leetcodeUsername: status.student.leetcodeUsername,
      solvedCount: status.solvedCount,
      assignedCount: status.assignedCount,
      attemptedNotSolvedCount,
      notAttemptedCount,
      completionTime: this.time.localTime(status.completedAt),
      currentStreak: status.student.currentStreak,
      score: status.score,
      rank: rankByStudent.get(status.studentId) ?? null,
      missingProblems: missing,
      problems,
      syncStatus,
      reason: this.explain(status.solvedCount, syncStatus, status.problemStatuses),
    };
  }

  /** Buckets from `assignedCount` down to 0, sized to the actual assignment (§10). */
  private bucketise(rows: MentorBucketRow[], assignedCount: number): MentorBucket[] {
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

      const { studentsAttemptedCount, studentsNotAttemptedCount } = summarizeBucketAttempts(
        students,
      );

      buckets.push({
        solvedCount: solved,
        studentsAttemptedCount,
        studentsNotAttemptedCount,
        label:
          solved === assignedCount && assignedCount > 0
            ? `Completed all ${assignedCount}`
            : `Solved ${solved}`,
        students,
      });
    }

    return buckets;
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

  private async findTopSquad(dayKey: DayKey): Promise<DashboardStats['topSquad']> {
    const entry = await this.prisma.squadLeaderboardEntry.findFirst({
      where: { period: 'DAILY', periodKey: dayKey, rank: 1 },
      include: { squad: { select: { name: true } } },
    });

    if (!entry) return null;
    return {
      squadId: entry.squadId,
      name: entry.squad.name,
      averageCompletion: entry.averageCompletion,
    };
  }
}
