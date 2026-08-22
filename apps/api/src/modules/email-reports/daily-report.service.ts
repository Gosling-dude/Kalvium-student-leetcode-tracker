/**
 * Historical report reconstruction for one program day.
 *
 * There is no stored "daily report" — every number here comes from `DashboardService`
 * (which already reads `Assignment` + `DailyStatus` keyed by `dayKey`, exactly the
 * mechanism that makes past days reconstructable — see schema.prisma's design notes)
 * plus this feature's own `Blocker` table. Reusing `getMentorDashboard` rather than
 * re-querying `DailyStatus` directly means this report can never disagree with the
 * mentor dashboard about who solved what.
 */

import { Injectable } from '@nestjs/common';
import {
  describeScope,
  ACTION_TIER_META,
  BLOCKER_SUMMARY_LABELS,
  BLOCKER_SUMMARY_ORDER,
  actionTierFor,
  buildActionRequiredText,
  buildBucketShapes,
  completionPercentage,
  formatDayKeyLong,
  formatDayKeyShort,
  overallCompletionPercent,
  summarizeBucketAttempts,
  type ActionTier,
  type BlockerRecord,
  type BlockerSummaryKey,
  type DailyEmailReport,
  type DailyEmailReportActionGroup,
  type DailyEmailReportBatchSection,
  type DailyEmailReportBucket,
  type DailyEmailReportStudentRow,
  type DayKey,
  type MentorBucketRow,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { DashboardService } from '../dashboard/dashboard.service';

@Injectable()
export class DailyReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    private readonly dashboard: DashboardService,
  ) {}

  /**
   * The full report — everything the dashboard page and the email body need.
   *
   * `filter.campusId` and `filter.batchId` scope the whole report, which is what produces
   * the separate "SRM University — Foundation" and "Vels — Intermediate" daily emails.
   * Omitting both produces the all-campuses report, whose per-audience blocks live in
   * `batchSections` because two groups with different problem counts have no single
   * meaningful denominator (§13, §33).
   *
   * The scope filter is applied all the way down to the `DailyStatus` rows, not to the
   * rendering: an SRM report is built from SRM's rows only, so a campus's statistics can
   * never be diluted by another's (§33, "Do not mix campus statistics accidentally").
   */
  async build(
    dayKey: DayKey,
    filter: { squadId?: string; campusId?: string | null; batchId?: string | null } = {},
  ): Promise<DailyEmailReport> {
    const today = this.time.today();
    const isFutureDate = dayKey > today;
    const campusId = filter.campusId ?? null;
    const batchId = filter.batchId ?? null;

    const [campus, batch] = await Promise.all([
      campusId
        ? this.prisma.campus.findUnique({
            where: { id: campusId },
            select: { name: true, code: true },
          })
        : null,
      batchId
        ? this.prisma.batch.findUnique({
            where: { id: batchId },
            select: { name: true, code: true },
          })
        : null,
    ]);

    const emptySummary = {
      dayKey,
      dayLabelLong: formatDayKeyLong(dayKey),
      dayLabelShort: formatDayKeyShort(dayKey),
      campusId,
      campusName: campus?.name ?? null,
      campusCode: campus?.code ?? null,
      batchId,
      batchName: batch?.name ?? null,
      batchCode: batch?.code ?? null,
      audienceLabel: describeScope(campus?.name ?? null, batch?.name ?? null),
      problemsAssigned: 0,
      studentsTracked: 0,
      bucketCounts: [],
      overallCompletionPercent: 0,
      generatedAt: new Date().toISOString(),
    };

    // Future dates cannot have real submission data yet — reconstructing a "report"
    // from an assignment that may exist but has no possible solves would misrepresent
    // it as a live day rather than a plan (§26).
    if (isFutureDate) {
      return {
        summary: emptySummary,
        hasAssignment: false,
        isFutureDate: true,
        excludedNotYetEnrolled: 0,
        problems: [],
        batchSections: [],
        buckets: [],
        students: [],
        actionGroups: [],
        blockerSummary: [],
      };
    }

    const mentor = await this.dashboard.getMentorDashboard(dayKey, {
      squadId: filter.squadId,
      campusId,
      batchId,
    });

    // A day counts as assigned when *any* batch in scope was given problems. Requiring a
    // single shared assignment would report an overall day as "no assignment" whenever
    // the batches had different sets, which is the normal case.
    const sectionsWithWork = mentor.sections.filter((section) => section.assignedCount > 0);

    if (sectionsWithWork.length === 0) {
      return {
        summary: emptySummary,
        hasAssignment: false,
        isFutureDate: false,
        excludedNotYetEnrolled: 0,
        problems: [],
        batchSections: [],
        buckets: [],
        students: [],
        actionGroups: [],
        blockerSummary: [],
      };
    }

    const allRows = sectionsWithWork.flatMap((section) =>
      section.buckets.flatMap((bucket) => bucket.students),
    );

    // Exclude students who joined after this program day closed — a historical report
    // must reflect who was actually enrolled at the time, not who is enrolled now (§26).
    const enrollment = await this.prisma.student.findMany({
      where: { id: { in: allRows.map((r) => r.studentId) } },
      select: { id: true, createdAt: true },
    });
    const enrolledDayKeyById = new Map(
      enrollment.map((s) => [s.id, this.time.dayKeyOf(s.createdAt)]),
    );
    const rows = allRows.filter((row) => (enrolledDayKeyById.get(row.studentId) ?? '') <= dayKey);
    const excludedNotYetEnrolled = allRows.length - rows.length;

    const blockers = await this.loadBlockers(dayKey, rows.map((r) => r.studentId));

    // Every student is classified against *their own batch's* problem count, taken from
    // the row itself. Using a single day-wide `assignedCount` would mark an Intermediate
    // student who solved 4 of 4 as incomplete on a day Foundation had 5 (§4, §10).
    const students: DailyEmailReportStudentRow[] = rows.map((row) => {
      const assignedCount = row.assignedCount;
      const tier = actionTierFor(row.solvedCount, assignedCount);
      const blocker = blockers.get(row.studentId) ?? null;
      return {
        studentId: row.studentId,
        name: row.name,
        email: row.email,
        squadName: row.squadName,
        batchName: row.batchName,
        batchCode: row.batchCode,
        cohort: row.cohort,
        leetcodeUsername: row.leetcodeUsername,
        assignedCount,
        solvedCount: row.solvedCount,
        attemptedNotSolvedCount: row.attemptedNotSolvedCount,
        notAttemptedCount: row.notAttemptedCount,
        completionPercent: completionPercentage(row.solvedCount, assignedCount),
        statusLabel: ACTION_TIER_META[tier].statusLabel,
        actionTier: tier,
        missingProblems: row.missingProblems,
        problems: row.problems,
        syncStatus: row.syncStatus,
        reason: row.reason,
        blocker,
        actionRequired: buildActionRequiredText(
          tier,
          blocker ? { category: blocker.category, description: blocker.description } : null,
        ),
      };
    });

    const studentById = new Map(students.map((student) => [student.studentId, student]));

    // One block per batch, each sized to that batch's own assignment.
    const batchSections: DailyEmailReportBatchSection[] = sectionsWithWork.map((section) => {
      const sectionStudents = section.buckets
        .flatMap((bucket) => bucket.students)
        .map((row) => studentById.get(row.studentId))
        .filter((student): student is DailyEmailReportStudentRow => student !== undefined);

      const sectionSolved = sectionStudents.reduce((sum, s) => sum + s.solvedCount, 0);
      const sectionAssigned = sectionStudents.reduce((sum, s) => sum + s.assignedCount, 0);

      return {
        campusId: section.campusId,
        campusName: section.campusName,
        campusCode: section.campusCode,
        audienceLabel: describeScope(section.campusName, section.batchName),
        batchId: section.batchId,
        batchName: section.batchName,
        batchCode: section.batchCode,
        assignedCount: section.assignedCount,
        studentsTracked: sectionStudents.length,
        completionPercent: overallCompletionPercent(sectionSolved, sectionAssigned),
        problems: section.assignment?.problems ?? [],
        buckets: this.buildBuckets(section.assignedCount, sectionStudents),
      };
    });

    // The overall bucket list spans the largest assignment in scope, so nobody falls
    // outside it on a day where the batches were given different numbers of problems.
    const maxAssigned = Math.max(0, ...students.map((student) => student.assignedCount));
    const buckets = this.buildBuckets(maxAssigned, students);
    const actionGroups = this.buildActionGroups(students);
    const blockerSummary = this.buildBlockerSummary(students);

    const totalSolved = students.reduce((sum, s) => sum + s.solvedCount, 0);
    const totalAssigned = students.reduce((sum, s) => sum + s.assignedCount, 0);

    // A single problem list is only true when one batch is in scope; on an overall
    // report spanning different sets, `batchSections` carries them per batch instead.
    const singleSection = batchSections.length === 1 ? batchSections[0] : null;

    return {
      summary: {
        dayKey,
        dayLabelLong: formatDayKeyLong(dayKey),
        dayLabelShort: formatDayKeyShort(dayKey),
        campusId,
        campusName: campus?.name ?? singleSection?.campusName ?? null,
        campusCode: campus?.code ?? singleSection?.campusCode ?? null,
        batchId,
        batchName: batch?.name ?? singleSection?.batchName ?? null,
        batchCode: batch?.code ?? singleSection?.batchCode ?? null,
        audienceLabel: describeScope(
          campus?.name ?? singleSection?.campusName ?? null,
          batch?.name ?? singleSection?.batchName ?? null,
        ),
        problemsAssigned: singleSection?.assignedCount ?? maxAssigned,
        studentsTracked: students.length,
        // "Solved 0" alone answers nothing about whether those students tried and
        // failed or never opened the problems — the breakdown is appended right onto
        // the label so it survives into every surface that only reads `bucketCounts`
        // (§ submission-attempt tracking, "17 students — 5 attempted, 12 not attempted").
        bucketCounts: buckets.map((b) => ({
          solvedCount: b.solvedCount,
          label: this.withAttemptBreakdown(b.label, b),
          count: b.count,
        })),
        overallCompletionPercent: overallCompletionPercent(totalSolved, totalAssigned),
        generatedAt: new Date().toISOString(),
      },
      hasAssignment: true,
      isFutureDate: false,
      excludedNotYetEnrolled,
      problems: singleSection?.problems ?? [],
      batchSections,
      buckets,
      students,
      actionGroups,
      blockerSummary,
    };
  }

  private async loadBlockers(
    dayKey: DayKey,
    studentIds: string[],
  ): Promise<Map<string, BlockerRecord>> {
    if (studentIds.length === 0) return new Map();

    const rows = await this.prisma.blocker.findMany({
      where: { dayKey, studentId: { in: studentIds } },
      include: {
        student: { select: { name: true } },
        recordedBy: { select: { name: true } },
      },
    });

    return new Map(
      rows.map((row) => [
        row.studentId,
        {
          id: row.id,
          studentId: row.studentId,
          studentName: row.student.name,
          dayKey: row.dayKey,
          solvedCount: row.solvedCount,
          assignedCount: row.assignedCount,
          category: row.category,
          description: row.description,
          actionTaken: row.actionTaken,
          followUpRequired: row.followUpRequired,
          followUpDate: row.followUpDate,
          mentorNotes: row.mentorNotes,
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
          recordedById: row.recordedById,
          recordedByName: row.recordedBy?.name ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        } satisfies BlockerRecord,
      ]),
    );
  }

  private buildBuckets(
    assignedCount: number,
    students: DailyEmailReportStudentRow[],
  ): DailyEmailReportBucket[] {
    return buildBucketShapes(assignedCount).map((shape) => {
      const bucketStudents = students
        .filter((s) => s.solvedCount === shape.solvedCount)
        .sort((a, b) => a.name.localeCompare(b.name));
      const { studentsAttemptedCount, studentsNotAttemptedCount } =
        summarizeBucketAttempts(bucketStudents);
      return {
        ...shape,
        count: bucketStudents.length,
        students: bucketStudents,
        studentsAttemptedCount,
        studentsNotAttemptedCount,
      };
    });
  }

  /** `"Solved 0"` + `(5 attempted, 12 not attempted)` when the bucket has anyone in it. */
  private withAttemptBreakdown(
    label: string,
    bucket: { studentsAttemptedCount: number; studentsNotAttemptedCount: number },
  ): string {
    const parts: string[] = [];
    if (bucket.studentsAttemptedCount > 0) parts.push(`${bucket.studentsAttemptedCount} attempted`);
    if (bucket.studentsNotAttemptedCount > 0) {
      parts.push(`${bucket.studentsNotAttemptedCount} not attempted`);
    }
    return parts.length > 0 ? `${label} (${parts.join(', ')})` : label;
  }

  private buildActionGroups(students: DailyEmailReportStudentRow[]): DailyEmailReportActionGroup[] {
    const order: ActionTier[] = ['URGENT', 'INTERVENTION', 'FOLLOW_UP', 'NEAR_COMPLETE', 'COMPLETE'];
    return order.map((tier) => {
      const meta = ACTION_TIER_META[tier];
      const inTier = students
        .filter((s) => s.actionTier === tier)
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        tier,
        emoji: meta.emoji,
        title: meta.title,
        count: inTier.length,
        students: inTier.map((s) => ({ studentId: s.studentId, name: s.name, email: s.email })),
      };
    });
  }

  private buildBlockerSummary(students: DailyEmailReportStudentRow[]) {
    const counts = new Map<BlockerSummaryKey, number>();
    for (const student of students) {
      // Only students who did not clear the day are counted — a completed student's
      // blocker state (if any, from an earlier partial day) is not this day's story.
      if (student.actionTier === 'COMPLETE' || student.actionTier === 'NOT_ASSIGNED') continue;
      const key: BlockerSummaryKey = student.blocker ? student.blocker.category : 'NOT_REPORTED';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return BLOCKER_SUMMARY_ORDER.filter((key) => (counts.get(key) ?? 0) > 0).map((key) => ({
      key,
      label: BLOCKER_SUMMARY_LABELS[key],
      count: counts.get(key) ?? 0,
    }));
  }
}
