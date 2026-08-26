/**
 * Production data-integrity checks, in one query pass.
 *
 * This exists because "the deploy succeeded" and "the data is correct" are different
 * claims, and only the first one is visible from a build log. A 200 from `/health` says
 * the process is running; it says nothing about whether 250 students have a batch that any
 * report can actually see.
 *
 * Every check here is a property that has already been wrong at least once, or that a
 * migration is responsible for making true. Each returns a count that *should be zero* (or
 * a summary), so a smoke test can assert on the shape rather than eyeball a dashboard.
 *
 * Read-only. It never repairs anything — a check that quietly fixes what it measures stops
 * being a check.
 */

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

export interface IntegrityFinding {
  /** Stable key, so a smoke test asserts on this rather than on prose. */
  check: string;
  /** What was counted. Zero is healthy for every `shouldBeZero` finding. */
  count: number;
  /** True when a non-zero count means something is wrong. */
  shouldBeZero: boolean;
  detail: string;
}

export interface IntegrityReport {
  ok: boolean;
  checkedAt: string;
  programDay: string;
  roster: {
    totalStudents: number;
    activeStudents: number;
    studentsWithLeetcodeUsername: number;
    campuses: number;
    batches: number;
  };
  sync: {
    byStatus: Record<string, number>;
    lastSuccessfulSyncAt: string | null;
    /** Students whose last read succeeded — the ones today's report can be trusted for. */
    trustworthy: number;
  };
  content: {
    assignments: number;
    latestAssignmentDay: string | null;
    baselineTests: number;
    submissions: number;
  };
  email: {
    pendingApproval: number;
    sentLast7Days: number;
  };
  findings: IntegrityFinding[];
}

@Injectable()
export class IntegrityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
  ) {}

  async report(): Promise<IntegrityReport> {
    const today = this.time.today();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalStudents,
      activeStudents,
      withUsername,
      campuses,
      batches,
      syncStates,
      lastSuccess,
      assignments,
      latestAssignment,
      baselineTests,
      submissions,
      pendingApproval,
      sentRecently,
    ] = await Promise.all([
      this.prisma.student.count(),
      this.prisma.student.count({ where: { status: 'ACTIVE' } }),
      this.prisma.student.count({ where: { status: 'ACTIVE', leetcodeUsername: { not: null } } }),
      this.prisma.campus.count(),
      this.prisma.batch.count(),
      this.prisma.studentSyncState.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.studentSyncState.findFirst({
        where: { lastSuccessAt: { not: null } },
        orderBy: { lastSuccessAt: 'desc' },
        select: { lastSuccessAt: true },
      }),
      this.prisma.assignment.count(),
      this.prisma.assignment.findFirst({ orderBy: { dayKey: 'desc' }, select: { dayKey: true } }),
      this.prisma.baselineTest.count(),
      this.prisma.submission.count(),
      this.prisma.emailReport.count({ where: { status: 'PENDING_APPROVAL' } }),
      this.prisma.emailReport.count({ where: { status: 'SENT', sentAt: { gte: sevenDaysAgo } } }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of syncStates) byStatus[row.status] = row._count._all;

    const findings = await this.findings();

    return {
      ok: findings.every((finding) => !finding.shouldBeZero || finding.count === 0),
      checkedAt: new Date().toISOString(),
      programDay: today,
      roster: {
        totalStudents,
        activeStudents,
        studentsWithLeetcodeUsername: withUsername,
        campuses,
        batches,
      },
      sync: {
        byStatus,
        lastSuccessfulSyncAt: lastSuccess?.lastSuccessAt?.toISOString() ?? null,
        trustworthy: byStatus.OK ?? 0,
      },
      content: {
        assignments,
        latestAssignmentDay: latestAssignment?.dayKey ?? null,
        baselineTests,
        submissions,
      },
      email: { pendingApproval, sentLast7Days: sentRecently },
      findings,
    };
  }

  private async findings(): Promise<IntegrityFinding[]> {
    const [
      batchWithoutHistory,
      campusWithoutHistory,
      dailyStatusWithoutAssignment,
      orphanedActiveStudents,
      mentorsWithoutCampus,
      baselineResultsWithoutAttempt,
    ] = await Promise.all([
      // The spreadsheet-import bug: `Student.batchId` set, no placement ever recorded.
      // Every historical query reads the history table, so these students resolve to "no
      // batch on any day" and drop out of batch-targeted assignments.
      this.prisma.student.count({
        where: { batchId: { not: null }, batchHistory: { none: {} } },
      }),
      this.prisma.student.count({
        where: { campusId: { not: null }, campusHistory: { none: {} } },
      }),
      // A scored day that names no assignment *and* claims problems were assigned. The two
      // disagree: something was counted against a set that cannot be identified.
      this.prisma.dailyStatus.count({
        where: { assignmentId: null, assignedCount: { gt: 0 } },
      }),
      // An active student with no campus cannot be seen by any mentor and appears on no
      // campus report — present in the database and absent from the programme.
      this.prisma.student.count({ where: { status: 'ACTIVE', campusId: null } }),
      // A mentor with no grants sees no students. Correct as a rule, wrong as a state:
      // it means somebody has an account that shows them an empty system.
      this.prisma.user.count({ where: { role: 'MENTOR', mentorCampuses: { none: {} } } }),
      // Per-question results whose attempt no longer exists would be results about nobody.
      // The FK cascade should make this impossible; counted because "should be impossible"
      // is exactly the class of thing worth checking in production.
      this.prisma.baselineTestProblemResult.count({ where: { attempt: { is: undefined } } }),
    ]);

    return [
      {
        check: 'students_with_batch_but_no_placement_history',
        count: batchWithoutHistory,
        shouldBeZero: true,
        detail:
          'These students carry a batchId that no historical query can see, so batch-targeted ' +
          'assignments never select for them. Fixed by the placement-history backfill migration.',
      },
      {
        check: 'students_with_campus_but_no_placement_history',
        count: campusWithoutHistory,
        shouldBeZero: true,
        detail: 'Same problem as the batch case, for campus.',
      },
      {
        check: 'scored_days_naming_no_assignment',
        count: dailyStatusWithoutAssignment,
        shouldBeZero: true,
        detail:
          'A day claiming assigned problems while naming no assignment — the count cannot ' +
          'be reconciled against a problem set.',
      },
      {
        check: 'active_students_without_a_campus',
        count: orphanedActiveStudents,
        shouldBeZero: true,
        detail: 'Visible to no mentor and on no campus report. Assign them a campus.',
      },
      {
        check: 'mentors_without_any_campus_grant',
        count: mentorsWithoutCampus,
        shouldBeZero: true,
        detail:
          'These mentors log in to an empty system. Grant campuses via ' +
          'PUT /admin/mentors/:id/campuses.',
      },
      {
        check: 'baseline_results_without_an_attempt',
        count: baselineResultsWithoutAttempt,
        shouldBeZero: true,
        detail: 'Question-level results belonging to no attempt.',
      },
    ];
  }
}
