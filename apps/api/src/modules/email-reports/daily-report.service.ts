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
  type ActionTier,
  type BlockerRecord,
  type BlockerSummaryKey,
  type DailyEmailReport,
  type DailyEmailReportActionGroup,
  type DailyEmailReportBucket,
  type DailyEmailReportStudentRow,
  type DayKey,
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

  /** The full report — everything the dashboard page and the email body need. */
  async build(dayKey: DayKey, squadId?: string): Promise<DailyEmailReport> {
    const today = this.time.today();
    const isFutureDate = dayKey > today;

    const emptySummary = {
      dayKey,
      dayLabelLong: formatDayKeyLong(dayKey),
      dayLabelShort: formatDayKeyShort(dayKey),
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
        buckets: [],
        students: [],
        actionGroups: [],
        blockerSummary: [],
      };
    }

    const mentor = await this.dashboard.getMentorDashboard(dayKey, squadId);
    const assignment = mentor.assignment;

    if (!assignment) {
      return {
        summary: emptySummary,
        hasAssignment: false,
        isFutureDate: false,
        excludedNotYetEnrolled: 0,
        problems: [],
        buckets: [],
        students: [],
        actionGroups: [],
        blockerSummary: [],
      };
    }

    const assignedCount = assignment.problems.length;
    const allRows = mentor.buckets.flatMap((bucket) => bucket.students);

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

    const students: DailyEmailReportStudentRow[] = rows.map((row) => {
      const tier = actionTierFor(row.solvedCount, assignedCount);
      const blocker = blockers.get(row.studentId) ?? null;
      return {
        studentId: row.studentId,
        name: row.name,
        email: row.email,
        squadName: row.squadName,
        batchName: row.batchName,
        leetcodeUsername: row.leetcodeUsername,
        assignedCount,
        solvedCount: row.solvedCount,
        completionPercent: completionPercentage(row.solvedCount, assignedCount),
        statusLabel: ACTION_TIER_META[tier].statusLabel,
        actionTier: tier,
        missingProblems: row.missingProblems,
        syncStatus: row.syncStatus,
        reason: row.reason,
        blocker,
        actionRequired: buildActionRequiredText(
          tier,
          blocker ? { category: blocker.category, description: blocker.description } : null,
        ),
      };
    });

    const buckets = this.buildBuckets(assignedCount, students);
    const actionGroups = this.buildActionGroups(students);
    const blockerSummary = this.buildBlockerSummary(students);

    const totalSolved = students.reduce((sum, s) => sum + s.solvedCount, 0);
    const totalAssigned = students.reduce((sum, s) => sum + s.assignedCount, 0);

    return {
      summary: {
        dayKey,
        dayLabelLong: formatDayKeyLong(dayKey),
        dayLabelShort: formatDayKeyShort(dayKey),
        problemsAssigned: assignedCount,
        studentsTracked: students.length,
        bucketCounts: buckets.map((b) => ({
          solvedCount: b.solvedCount,
          label: b.label,
          count: b.count,
        })),
        overallCompletionPercent: overallCompletionPercent(totalSolved, totalAssigned),
        generatedAt: new Date().toISOString(),
      },
      hasAssignment: true,
      isFutureDate: false,
      excludedNotYetEnrolled,
      problems: assignment.problems,
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
      return { ...shape, count: bucketStudents.length, students: bucketStudents };
    });
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
