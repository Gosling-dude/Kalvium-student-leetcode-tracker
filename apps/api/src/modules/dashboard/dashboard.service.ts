import { Injectable } from '@nestjs/common';
import {
  ASSIGNMENT_LOOKBACK_DAYS,
  CACHE_TTL,
  SYNC_STATUS_LABELS,
  assignmentWindow,
  completionPercentage,
  describeNotObserved,
  isTrustworthySync,
  resolveObservability,
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
  type MentorNotObservedRow,
  type MentorProblemOutcome,
  type ProblemStatus,
  type SyncHealthSummary,
  type SyncStatus,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { AssignmentsService } from '../assignments/assignments.service';
import { BatchesService } from '../batches/batches.service';
import { EnrolmentService } from '../../common/services/enrolment.service';
import { CampusesService } from '../campuses/campuses.service';

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
 * How many of *this* assignment's problems a student has proven accepted submissions for.
 *
 * The intersection is the point. `solvedSlugs` is gathered in one query spanning every
 * audience's problems for the day, so without narrowing to the assignment the student was
 * actually set, an SRM student who happened to solve a problem only Vels was given would
 * be credited for it — and the floor could exceed the number of problems they were set,
 * which is how this was caught (`>= 6 of 4`).
 */
function countProvenAgainst(
  solvedSlugs: Set<string> | undefined,
  assignment: AssignmentSummary,
): number {
  if (!solvedSlugs || solvedSlugs.size === 0) return 0;
  let proven = 0;
  for (const problem of assignment.problems) {
    if (solvedSlugs.has(problem.titleSlug.toLowerCase())) proven += 1;
  }
  return proven;
}

/** One scope's unobserved students, carrying the scope so a section can be built from it. */
interface NotObservedScope {
  campusId: string | null;
  batchId: string | null;
  rows: MentorNotObservedRow[];
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
    private readonly campuses: CampusesService,
    private readonly batches: BatchesService,
    private readonly enrolment: EnrolmentService,
  ) {}

  /**
   * What a caller who may see no campus gets.
   *
   * Answered as a real, empty result rather than a 403, matching the student directory:
   * "this campus is not yours" and "this campus does not exist" have to be indistinguishable,
   * or campus ids become an enumeration oracle. The shape is the full contract so the UI
   * renders its ordinary empty state instead of an error.
   *
   * Deliberately not cached and not derived from a query — there is nothing to query.
   */
  emptyStats(dayKey?: DayKey): DashboardStats {
    return {
      dayKey: dayKey ?? this.time.today(),
      campusId: null,
      batchId: null,
      totalStudents: 0,
      activeStudents: 0,
      campusBreakdown: [],
      batchBreakdown: [],
      assignment: null,
      assignmentCount: 0,
      solvedBuckets: [],
      completionPercent: 0,
      attemptedNotSolvedStudents: 0,
      notAttemptedStudents: 0,
      averageProblemsSolved: 0,
      streakChampion: null,
      topPerformer: null,
      topSquad: null,
      lastSyncAt: null,
      lastSyncStatus: null,
      unreliableSyncCounts: {},
      syncSummary: {
        activeStudents: 0,
        synced: 0,
        profileMissing: 0,
        awaitingFirstSync: 0,
        failed: 0,
        byStatus: {},
      },
    } satisfies DashboardStats;
  }

  /** The mentor-tracker equivalent of `emptyStats` — see there for why this is not a 403. */
  emptyMentorDashboard(dayKey?: DayKey): MentorDashboard {
    return {
      dayKey: dayKey ?? this.time.today(),
      campusId: null,
      batchId: null,
      sections: [],
      assignment: null,
      buckets: [],
      totalStudents: 0,
      notObserved: [],
      rosterTotal: 0,
    } satisfies MentorDashboard;
  }

  async getStats(dayKey?: DayKey, filter: DashboardFilter = {}): Promise<DashboardStats> {
    const day = dayKey ?? this.time.today();
    const campusId = filter.campusId ?? null;
    const batchId = filter.batchId ?? null;
    const cacheKey = `dashboard:${day}:stats:${campusId ?? 'all'}:${batchId ?? 'all'}`;

    /** The scope, as a roster predicate — no join to any day's rows. */
    const rosterScope = {
      status: 'ACTIVE' as const,
      ...(campusId ? { campusId } : {}),
      ...(batchId ? { batchId } : {}),
      ...(filter.onlyUnassigned ? { batchId: null } : {}),
    };

    return this.cache.remember(cacheKey, CACHE_TTL.dashboard, async () => {
      const [assignments, totalStudents, statuses, syncStates, lastJob] = await Promise.all([
        this.assignments.findAllByDay(day),
        this.prisma.student.count({ where: rosterScope }),
        // With-problems, not the lighter `loadStatuses`: the attempted/not-attempted
        // split below needs each student's per-problem outcomes, not just the totals.
        // Both halves of the scope, not just the batch. Dropping `campusId` here made
        // `?campus=VELS` return every campus's rows — the filter looked applied (the
        // headline count changed) while the breakdowns silently showed everyone.
        this.loadStatusesWithProblems(day, { campusId, batchId }),
        // Sync health is a property of the roster, not of the day.
        //
        // Grouped straight off the sync-state table rather than read from the day's
        // `DailyStatus` rows, so a student imported since the last rollup — who has no row
        // for today — is still counted. Otherwise the summary would quietly under-report
        // exactly the newest students, who are the ones most likely to be missing a
        // handle (§2, §5). One aggregate row per status, not one row per student, so this
        // stays flat as the roster grows (§21).
        this.prisma.studentSyncState.groupBy({
          by: ['status'],
          where: { student: rosterScope },
          _count: { _all: true },
        }),
        this.prisma.syncJob.findFirst({
          where: { status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS'] } },
          orderBy: { finishedAt: 'desc' },
        }),
      ]);

      const active = statuses;

      // The day's assignments that actually bear on the current filter. A campus-agnostic
      // set (`campusId: null`) is aimed at everyone, so it stays in scope for every
      // campus; another campus's set never does.
      const scopedAssignments =
        campusId === null
          ? assignments
          : assignments.filter((a) => a.campusId === null || a.campusId === campusId);

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
      //
      // Two separate questions, answered separately. `unreliable` is "whose zero should
      // I not read as effort?" — every non-OK status qualifies. `syncSummary` is "what
      // did the sync manage?", where a student with no linked handle is a roster gap and
      // not a failed read. Collapsing the second into the first is what produced
      // "22 students' data could not be read this sync" about 21 students the sync had
      // never once contacted (§5, §6).
      const unreliable: Partial<Record<SyncStatus, number>> = {};
      for (const status of active) {
        const syncStatus = (status.student.syncState?.status ?? 'NEVER_SYNCED') as SyncStatus;
        if (!isTrustworthySync(syncStatus)) {
          unreliable[syncStatus] = (unreliable[syncStatus] ?? 0) + 1;
        }
      }

      const syncSummary: SyncHealthSummary = {
        activeStudents: totalStudents,
        synced: 0,
        profileMissing: 0,
        awaitingFirstSync: 0,
        failed: 0,
        byStatus: {},
      };
      let withSyncRow = 0;
      for (const group of syncStates) {
        const syncStatus = group.status as SyncStatus;
        const count = group._count._all;
        withSyncRow += count;
        if (!isTrustworthySync(syncStatus)) syncSummary.byStatus[syncStatus] = count;
        if (syncStatus === 'OK') syncSummary.synced += count;
        else if (syncStatus === 'PROFILE_MISSING') syncSummary.profileMissing += count;
        else if (syncStatus === 'NEVER_SYNCED') syncSummary.awaitingFirstSync += count;
        else syncSummary.failed += count;
      }
      // A student imported but not yet synced has no sync-state row at all. They are
      // awaiting their first sync exactly as a NEVER_SYNCED row is, and counting them
      // keeps the four figures a partition of `activeStudents` rather than a subset that
      // silently loses the newest arrivals.
      const noSyncRow = Math.max(0, totalStudents - withSyncRow);
      if (noSyncRow > 0) {
        syncSummary.awaitingFirstSync += noSyncRow;
        syncSummary.byStatus.NEVER_SYNCED = (syncSummary.byStatus.NEVER_SYNCED ?? 0) + noSyncRow;
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
        //
        // Counted within the scope, not across the whole day: with a campus filter
        // applied, another campus's assignment is not a reason to withhold this one.
        // `assignments.length === 1` compared against every campus's sets at once, so
        // asking for one campus that had exactly one assignment still showed nothing
        // whenever any other campus also had work that day.
        assignment: batchId
          ? this.findAssignmentFor(assignments, { campusId, batchId })
          : scopedAssignments.length === 1
            ? scopedAssignments[0]!
            : null,
        // Lets the UI distinguish "nobody set today's work" from "each batch has its
        // own set". Both arrive as `assignment: null`, and reporting the second as the
        // first tells an admin to create an assignment that already exists.
        assignmentCount: scopedAssignments.length,
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
        syncSummary,
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

      // Students the day's assignments were aimed at but that we were not yet watching.
      // Kept entirely out of `rows` — they must never reach `bucketise`, which would
      // have to invent a `solvedCount` to place them.
      const notObservedByScope = await this.loadNotObserved(
        day,
        filter,
        new Set(statuses.map((status) => status.studentId)),
        assignments,
      );

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

      // A scope may be entirely unobserved — a batch where every student joined after
      // the day. It still deserves a section, so the mentor sees the assignment existed
      // and why it has no numbers, rather than the day appearing not to apply to them.
      for (const [key, group] of notObservedByScope) {
        if (byScope.has(key) || group.rows.length === 0) continue;
        byScope.set(key, { campusId: group.campusId, batchId: group.batchId, rows: [] });
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
          const notObserved = notObservedByScope.get(scopeKey(group.campusId, group.batchId))?.rows
            ?? [];
          return {
            campusId: group.campusId,
            campusName:
              assignment?.campusName ?? group.rows[0]?.campusName ?? notObserved[0]?.campusName
                ?? null,
            campusCode:
              assignment?.campusCode ?? group.rows[0]?.campusCode ?? notObserved[0]?.campusCode
                ?? null,
            batchId: group.batchId,
            batchName:
              assignment?.batchName ?? group.rows[0]?.batchName ?? notObserved[0]?.batchName ?? null,
            batchCode:
              assignment?.batchCode ?? group.rows[0]?.batchCode ?? notObserved[0]?.batchCode ?? null,
            assignment,
            assignedCount,
            buckets: this.bucketise(group.rows, assignedCount),
            // The denominator is the observed cohort. `rosterTotal` carries the rest, so
            // the UI can render "99 of 142 evaluated" instead of implying 99 is everyone.
            totalStudents: group.rows.length,
            notObserved,
            rosterTotal: group.rows.length + notObserved.length,
          };
        });

      const maxAssigned = Math.max(0, ...rows.map((row) => row.assignedCount));
      const allNotObserved = sections.flatMap((section) => section.notObserved);

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
        notObserved: allNotObserved,
        rosterTotal: rows.length + allNotObserved.length,
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

  /**
   * The students an assignment was aimed at on `dayKey` whom the tracker was not yet
   * watching — the `NOT_OBSERVED` cohort.
   *
   * Identified by the two dates being genuinely different (see `@dsa/shared`'s
   * `observability` module): `StudentCampusHistory` says they were on the roster that
   * day, `Student.createdAt` says we had not started mirroring them. A student who is
   * missing a `DailyStatus` row for any *other* reason is not swept in here — the
   * `createdAt` test is what distinguishes "we never watched" from "we watched and
   * wrote nothing", and only the first is unknowable.
   *
   * Returns rows without a `solvedCount`, deliberately. The only performance number
   * attached is `provenSolvedFloor`: distinct assigned problems we hold an accepted
   * submission for, which is a lower bound and is labelled as one everywhere it
   * surfaces. Everything else about their day is genuinely unknown and says so.
   */
  private async loadNotObserved(
    dayKey: DayKey,
    filter: DashboardFilter,
    observedStudentIds: Set<string>,
    assignments: AssignmentSummary[],
  ): Promise<Map<string, NotObservedScope>> {
    const byScope = new Map<string, NotObservedScope>();
    if (assignments.length === 0) return byScope;

    // Only students whose enrolment postdates the day can be unobserved, so the
    // `createdAt` bound does the heavy filtering in SQL rather than in memory.
    //
    // It is deliberately the *wider* of the two conditions: `createdAt` can only be later
    // than the day `EnrolmentService` resolves (an earlier mirrored submission moves it
    // back, never forward), so this over-selects and the authoritative rule below
    // narrows. Filtering on the resolved day in SQL is not possible — it is a join of two
    // sources — and filtering on the *narrower* one would drop students the real rule
    // would have kept.
    const dayEnd = this.time.bounds(dayKey).end;
    const candidates = await this.prisma.student.findMany({
      where: {
        status: 'ACTIVE',
        createdAt: { gt: dayEnd },
        ...(filter.squadId ? { squadId: filter.squadId } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        leetcodeUsername: true,
        squad: { select: { name: true } },
      },
    });

    const unseen = candidates.filter((student) => !observedStudentIds.has(student.id));
    if (unseen.length === 0) return byScope;

    // The authoritative observed-from day, from the same service the rollup skips on. If
    // the two disagreed, this list would name students the rollup had in fact scored —
    // the mentor would see the same person in a bucket *and* under "not observed".
    const observedFromDay = await this.enrolment.observedFromDayByStudent(
      unseen.map((student) => student.id),
    );

    // Where they were on the day — from placement history, not their campus now. A late
    // import back-dated to the cohort's enrolment resolves here; one with no placement
    // covering the day resolves to null and is dropped, because we cannot say which
    // assignment (if any) was aimed at them.
    const ids = unseen.map((s) => s.id);
    const [campusOnDay, batchOnDay, proven] = await Promise.all([
      this.campuses.campusOnDayForStudents(ids, dayKey),
      this.batches.batchOnDayForStudents(ids, dayKey),
      this.provenSolvedFloors(ids, dayKey, assignments),
    ]);

    for (const student of unseen) {
      const campusId = campusOnDay.get(student.id) ?? null;
      const batchId = batchOnDay.get(student.id) ?? null;
      if (campusId === null) continue;
      if (filter.campusId && campusId !== filter.campusId) continue;
      if (filter.batchId && batchId !== filter.batchId) continue;
      if (filter.onlyUnassigned && batchId !== null) continue;

      // Only report them against an assignment that actually targeted their scope.
      // Without one there is nothing unobserved to report: the day simply had no
      // problems for them, exactly as it does for an observed student.
      const assignment = selectAssignmentForScope(assignments, { campusId, batchId });
      if (!assignment) continue;

      // The SQL bound above already narrows to `createdAt > dayKey`, but the authoritative
      // rule lives in `@dsa/shared`. Re-asserting it here means a timezone edge in the
      // timestamp bound can only ever drop a row, never invent an unobserved one — and a
      // student whose mirror holds a submission from before this day is dropped here,
      // because the rollup scored them and they are not unobserved at all.
      const observedFromDayKey =
        observedFromDay.get(student.id) ?? this.time.dayKeyOf(student.createdAt);
      if (resolveObservability({ observedFromDayKey, dayKey }) === 'OBSERVED') continue;

      const key = scopeKey(campusId, batchId);
      const group = byScope.get(key) ?? { campusId, batchId, rows: [] };
      group.rows.push({
        studentId: student.id,
        name: student.name,
        email: student.email,
        squadName: student.squad?.name ?? null,
        campusName: assignment.campusName ?? null,
        campusCode: assignment.campusCode ?? null,
        batchName: assignment.batchName ?? null,
        batchCode: assignment.batchCode ?? null,
        leetcodeUsername: student.leetcodeUsername,
        observedFromDayKey,
        // Intersected with *this student's own* assignment, so the floor can never
        // exceed what they were actually set.
        provenSolvedFloor: countProvenAgainst(proven.get(student.id), assignment),
        assignedCount: assignment.problems.length,
        reason: describeNotObserved(observedFromDayKey),
      });
      byScope.set(key, group);
    }

    return byScope;
  }

  /**
   * Distinct assigned problems each unobserved student has a *stored* accepted
   * submission for, within the assignment's own matching window.
   *
   * Reads the local mirror only — never the provider. A first sync for a late-imported
   * student sometimes pulls submissions old enough to land in a past assignment's
   * window, and that is real evidence worth showing. It can only ever raise the floor:
   * the same short upstream window that surfaced one submission may have dropped three
   * others, so this proves "at least N" and never "exactly N".
   */
  private async provenSolvedFloors(
    studentIds: string[],
    dayKey: DayKey,
    assignments: AssignmentSummary[],
  ): Promise<Map<string, Set<string>>> {
    const floors = new Map<string, Set<string>>();
    const slugs = [
      ...new Set(assignments.flatMap((a) => a.problems.map((p) => p.titleSlug.toLowerCase()))),
    ];
    if (slugs.length === 0 || studentIds.length === 0) return floors;

    const { startDayKey, endDayKey } = assignmentWindow(dayKey, ASSIGNMENT_LOOKBACK_DAYS);
    const rows = await this.prisma.submission.findMany({
      where: {
        studentId: { in: studentIds },
        status: 'ACCEPTED',
        dayKey: { gte: startDayKey, lte: endDayKey },
        titleSlug: { in: slugs },
      },
      select: { studentId: true, titleSlug: true },
    });

    // Distinct problems, so five accepted runs at Two Sum still count once (§9).
    //
    // Returned as the *set of slugs*, not a count. One day carries several campuses' and
    // batches' assignments, and this query spans all their slugs in one round trip — so
    // counting here would credit an SRM student for a problem only Vels was set. The
    // caller intersects with the student's own assignment, which is the only scope that
    // can answer "of *their* four, how many can we prove" (§15).
    for (const row of rows) {
      const set = floors.get(row.studentId) ?? new Set<string>();
      set.add(row.titleSlug.toLowerCase());
      floors.set(row.studentId, set);
    }
    return floors;
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

    // Every active *Coding-Hours* campus gets a row even on a day it had no work, so
    // the dashboard shows "SRM — 0 assigned" rather than omitting the campus and
    // looking like it does not exist. "Coding-Hours campus" is not every `Campus` row,
    // though: Infosys-only campuses (zero Coding-Hours students, zero batches — see
    // the schema.prisma section banner above `InfosysEnrollment`) share the same
    // table, and calling this unfiltered showed all 10 of them as empty cards on the
    // main dashboard, found live. Reuses `CampusesService.findAll`'s
    // `hasCodingHoursActivity` option — the same, already-tested filter, not a second
    // copy of it.
    const campuses = (await this.campuses.findAll(false, null, true)).filter(
      (c) => !filterCampusId || c.id === filterCampusId,
    );
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
