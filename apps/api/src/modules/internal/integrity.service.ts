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

import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';

export interface IntegrityFinding {
  /** Stable key, so a smoke test asserts on this rather than on prose. */
  check: string;
  /** What was counted. Zero is healthy for every `shouldBeZero` finding. */
  count: number;
  /** True when a non-zero count means something is wrong. */
  shouldBeZero: boolean;
  /**
   * How loudly to react.
   *
   * `data` means stored records disagree with each other — students are being reported
   * wrongly right now, and it blocks. `config` means a feature cannot run until someone
   * sets an environment variable; real, and worth saying every time, but not a reason to
   * fail a build.
   *
   * They are separated because mixing them destroys the signal that matters most. A
   * config gap nobody can fix today would leave the check permanently red, and a check
   * that is always red is one nobody reads — so the next genuine data regression would
   * scroll past unnoticed. Keeping data failures rare is what keeps them meaningful.
   */
  severity: 'data' | 'config';
  detail: string;
}

export interface IntegrityReport {
  ok: boolean;
  checkedAt: string;
  programDay: string;
  /**
   * The commit this process is running, or `null` when the host injected nothing. A
   * deployment check compares it against the commit it just pushed; without it, the only
   * available signal is "the endpoint exists", which stops distinguishing anything after
   * the first release.
   */
  commit: string | null;
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
  /**
   * Per baseline test: what participation records say, next to what the submission mirror
   * actually holds for the same problems. The two disagreeing is the whole bug this
   * section exists to make visible — a test can read "0 solved" across the cohort purely
   * because nobody clicked Start, while the mirror holds hundreds of accepted solutions
   * for those exact problems.
   */
  baseline: {
    testId: string;
    name: string;
    dayKey: string;
    problems: number;
    eligibleStudents: number;
    attempts: number;
    /** Distinct eligible students with an accepted submission for at least one problem. */
    studentsWithAnyAcceptedSolution: number;
    /** Accepted submissions held for this test's problems, by eligible students. */
    acceptedSubmissions: number;
    perProblem: { titleSlug: string; title: string; solvedByStudents: number }[];
  }[];

  email: {
    pendingApproval: number;
    sentLast7Days: number;
    /** Whether the nightly automation can actually produce a report. */
    fromConfigured: boolean;
    defaultRecipients: number;
    providerConfigured: boolean;
  };
  findings: IntegrityFinding[];
}

@Injectable()
export class IntegrityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
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

    const baseline = await this.baselineSummary();
    const email = this.config.email;
    const findings = await this.findings({
      fromConfigured: Boolean(email.fromEmail),
      recipients: email.defaultTo.length,
    });

    return {
      // `ok` tracks data integrity only — see `IntegrityFinding.severity`. A config gap is
      // reported and surfaced, but it does not make the stored data wrong.
      ok: findings.every(
        (finding) => finding.severity !== 'data' || !finding.shouldBeZero || finding.count === 0,
      ),
      checkedAt: new Date().toISOString(),
      programDay: today,
      commit: this.config.build.commit,
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
      baseline,
      email: {
        pendingApproval,
        sentLast7Days: sentRecently,
        fromConfigured: Boolean(email.fromEmail),
        defaultRecipients: email.defaultTo.length,
        providerConfigured: email.provider !== 'none',
      },
      findings,
    };
  }

  /**
   * What each baseline test's participation records claim, beside what the submission
   * mirror holds for the same problems.
   *
   * Read-only and deliberately not filtered by any test window: the point is to show the
   * solutions a window-scoped view would hide.
   */
  private async baselineSummary(): Promise<IntegrityReport['baseline']> {
    const tests = await this.prisma.baselineTest.findMany({
      orderBy: { dayKey: 'desc' },
      take: 10,
      include: { problems: { include: { problem: true }, orderBy: { position: 'asc' } } },
    });

    const summaries: IntegrityReport['baseline'] = [];

    for (const test of tests) {
      const eligible = await this.prisma.student.findMany({
        where: {
          status: 'ACTIVE',
          ...(test.campusId ? { campusId: test.campusId } : {}),
          ...(test.batchId ? { batchId: test.batchId } : {}),
        },
        select: { id: true },
      });
      const studentIds = eligible.map((student) => student.id);
      const slugs = test.problems.map((problem) => problem.problem.titleSlug);

      const [attempts, accepted] = await Promise.all([
        this.prisma.baselineTestAttempt.count({ where: { testId: test.id } }),
        studentIds.length > 0 && slugs.length > 0
          ? this.prisma.submission.findMany({
              where: {
                studentId: { in: studentIds },
                titleSlug: { in: slugs },
                status: 'ACCEPTED',
              },
              select: { studentId: true, titleSlug: true },
            })
          : Promise.resolve([]),
      ]);

      const byProblem = new Map<string, Set<string>>();
      for (const row of accepted) {
        const set = byProblem.get(row.titleSlug) ?? new Set<string>();
        set.add(row.studentId);
        byProblem.set(row.titleSlug, set);
      }

      summaries.push({
        testId: test.id,
        name: test.name,
        dayKey: test.dayKey,
        problems: test.problems.length,
        eligibleStudents: studentIds.length,
        attempts,
        studentsWithAnyAcceptedSolution: new Set(accepted.map((row) => row.studentId)).size,
        acceptedSubmissions: accepted.length,
        perProblem: test.problems.map((problem) => ({
          titleSlug: problem.problem.titleSlug,
          title: problem.problem.title,
          solvedByStudents: byProblem.get(problem.problem.titleSlug)?.size ?? 0,
        })),
      });
    }

    return summaries;
  }

  private async findings(email: {
    fromConfigured: boolean;
    recipients: number;
  }): Promise<IntegrityFinding[]> {
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
        // Not a data defect — a configuration one, but it belongs here because it is
        // invisible everywhere else. The nightly report workflow answered HTTP 200 with an
        // empty result for days: a green tick over an automation producing nothing. A
        // status code cannot see that; this can.
        check: 'daily_report_automation_cannot_run',
        count: email.fromConfigured && email.recipients > 0 ? 0 : 1,
        shouldBeZero: true,
        severity: 'config',
        detail:
          'EMAIL_FROM and/or EMAIL_DEFAULT_TO are not set on the server, so the nightly ' +
          'report generates nothing. Set both, then re-run the Daily Report Generation ' +
          'workflow. (Sending additionally needs EMAIL_PROVIDER and EMAIL_API_KEY; ' +
          'without them a report is still generated and still waits for approval.)',
      },
      {
        check: 'students_with_batch_but_no_placement_history',
        count: batchWithoutHistory,
        shouldBeZero: true,
        severity: 'data',
        detail:
          'These students carry a batchId that no historical query can see, so batch-targeted ' +
          'assignments never select for them. Fixed by the placement-history backfill migration.',
      },
      {
        check: 'students_with_campus_but_no_placement_history',
        count: campusWithoutHistory,
        shouldBeZero: true,
        severity: 'data',
        detail: 'Same problem as the batch case, for campus.',
      },
      {
        check: 'scored_days_naming_no_assignment',
        count: dailyStatusWithoutAssignment,
        shouldBeZero: true,
        severity: 'data',
        detail:
          'A day claiming assigned problems while naming no assignment — the count cannot ' +
          'be reconciled against a problem set.',
      },
      {
        check: 'active_students_without_a_campus',
        count: orphanedActiveStudents,
        shouldBeZero: true,
        severity: 'data',
        detail: 'Visible to no mentor and on no campus report. Assign them a campus.',
      },
      {
        check: 'mentors_without_any_campus_grant',
        count: mentorsWithoutCampus,
        shouldBeZero: true,
        // An action someone needs to take, not stored data disagreeing with itself. An
        // admin who adds a mentor now and grants their campuses this afternoon is in this
        // state in between, which is perfectly normal and must not fail a build.
        severity: 'config',
        detail:
          'These mentors log in to an empty system. Grant campuses via ' +
          'PUT /admin/mentors/:id/campuses.',
      },
      {
        check: 'baseline_results_without_an_attempt',
        count: baselineResultsWithoutAttempt,
        shouldBeZero: true,
        severity: 'data',
        detail: 'Question-level results belonging to no attempt.',
      },
    ];
  }
}
