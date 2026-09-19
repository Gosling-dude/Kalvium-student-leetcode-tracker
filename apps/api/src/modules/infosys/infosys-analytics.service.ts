/**
 * Infosys student/dashboard analysis — read-only, computed live from
 * `InfosysDailyStatus` + `InfosysDailyProblemStatus` (the materialised rows
 * `InfosysRollupService` writes, so this never live-fetches LeetCode, §13 of the
 * simplification brief).
 *
 * One cohort, not campus-divided — see the header comment on
 * `packages/shared/src/domain/infosys-analysis.ts`. There is deliberately no
 * `MentorScopeService` here and no campus filter parameter: ADMIN, MENTOR and VIEWER
 * all see the same, whole Infosys cohort (enforced by the controller's `@Roles`
 * decorator, not by a scoping query here — there is nothing left to scope by).
 */

import { Injectable } from '@nestjs/common';
import {
  analysisWeeks,
  categoriseInfosysStudent,
  type InfosysCategory,
  type InfosysCohortWeek,
  type InfosysDashboardSummary,
  type InfosysProfileState,
  type InfosysStudentAnalysis,
  type InfosysStudentWeek,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { InfosysRollupService } from './infosys-rollup.service';

const ALL_CATEGORIES: InfosysCategory[] = [
  'CONSISTENT_SOLVER',
  'INCONSISTENT',
  'TRYING_BUT_STRUGGLING',
  'IMPROVING',
  'DECLINING',
  'NOT_PARTICIPATING',
  'PROFILE_NOT_LINKED',
  'DATA_UNAVAILABLE',
];

@Injectable()
export class InfosysAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rollup: InfosysRollupService,
  ) {}

  /** The program window every Infosys analysis call is measured over: the tracking
   * start date through today, or `null` when no assignment has ever been entered. */
  private async period(): Promise<{ from: string; to: string } | null> {
    const from = await this.rollup.trackingStartDate();
    if (!from) return null;
    const to = new Date().toISOString().slice(0, 10);
    return { from, to: to > from ? to : from };
  }

  /**
   * One dashboard for the whole Infosys cohort — no campus breakdown.
   *
   * `assigned`/`solved`/`attemptedNotSolved`/`notAttempted` here count **distinct
   * questions**, never student-question pairs (§10 of the brief: the same problem
   * assigned to 205 students is 1 question, not 205 — the exact bug already found and
   * fixed once for Coding Hours' campus-analysis, commit acd7a67). A question's
   * cohort-wide outcome is SOLVED if any enrolled student solved it in the period,
   * ATTEMPTED_NOT_SOLVED if not but someone attempted it, else NOT_ATTEMPTED. This is
   * deliberately a different question from "how many students solved it" — that
   * figure lives on the student list (`studentAnalysis()`), never here.
   */
  async dashboard(): Promise<InfosysDashboardSummary> {
    const totalStudents = await this.prisma.infosysEnrollment.count();
    const profilesLinked = await this.prisma.student.count({
      where: { infosysEnrollment: { isNot: null }, leetcodeUsername: { not: null } },
    });

    const period = await this.period();
    if (!period) {
      return {
        totalStudents,
        profilesLinked,
        assigned: 0,
        solved: 0,
        attemptedNotSolved: 0,
        notAttempted: 0,
        solvePercent: null,
        attemptPercent: null,
        categories: ALL_CATEGORIES.map((category) => ({ category, label: category, rule: '', students: 0 })),
        weeks: [],
      };
    }

    const weeks = analysisWeeks(period.from, period.to);

    const cohortWeeks: InfosysCohortWeek[] = [];
    for (const week of weeks) {
      const stats = await this.questionStats(week.from, week.to);
      cohortWeeks.push({
        weekNumber: week.weekNumber,
        from: week.from,
        to: week.to,
        ...stats,
        solvePercent: stats.assigned === 0 ? null : stats.solved / stats.assigned,
        attemptPercent: stats.assigned === 0 ? null : (stats.solved + stats.attemptedNotSolved) / stats.assigned,
      });
    }

    const overall = await this.questionStats(period.from, period.to);

    const enrollments = await this.prisma.infosysEnrollment.findMany({ select: { studentId: true } });
    const analyses = await this.studentAnalyses(
      enrollments.map((e) => e.studentId),
      weeks,
      period,
    );
    const categoryCounts = new Map<InfosysCategory, number>();
    for (const analysis of analyses) {
      categoryCounts.set(analysis.verdict.category, (categoryCounts.get(analysis.verdict.category) ?? 0) + 1);
    }

    return {
      totalStudents,
      profilesLinked,
      assigned: overall.assigned,
      solved: overall.solved,
      attemptedNotSolved: overall.attemptedNotSolved,
      notAttempted: overall.notAttempted,
      solvePercent: overall.assigned === 0 ? null : overall.solved / overall.assigned,
      attemptPercent: overall.assigned === 0 ? null : (overall.solved + overall.attemptedNotSolved) / overall.assigned,
      categories: ALL_CATEGORIES.map((category) => ({
        category,
        label: category,
        rule: '',
        students: categoryCounts.get(category) ?? 0,
      })),
      weeks: cohortWeeks,
    };
  }

  /** Distinct-question outcome counts for `[from, to]` — the one place "assigned"
   * means a count of `Problem` rows, never students × problems. */
  private async questionStats(
    from: string,
    to: string,
  ): Promise<{ assigned: number; solved: number; attemptedNotSolved: number; notAttempted: number }> {
    const assignedProblems = await this.prisma.infosysAssignmentProblem.findMany({
      where: { infosysAssignment: { dayKey: { gte: from, lte: to } } },
      select: { problemId: true },
      distinct: ['problemId'],
    });
    const problemIds = assignedProblems.map((p) => p.problemId);
    if (problemIds.length === 0) {
      return { assigned: 0, solved: 0, attemptedNotSolved: 0, notAttempted: 0 };
    }

    const statuses = await this.prisma.infosysDailyProblemStatus.findMany({
      where: {
        problemId: { in: problemIds },
        infosysDailyStatus: { dayKey: { gte: from, lte: to } },
      },
      select: { problemId: true, status: true },
    });

    const statusesByProblem = new Map<string, Set<string>>();
    for (const row of statuses) {
      const set = statusesByProblem.get(row.problemId) ?? new Set<string>();
      set.add(row.status);
      statusesByProblem.set(row.problemId, set);
    }

    let solved = 0;
    let attemptedNotSolved = 0;
    let notAttempted = 0;
    for (const problemId of problemIds) {
      const outcomes = statusesByProblem.get(problemId) ?? new Set<string>();
      if (outcomes.has('SOLVED')) solved += 1;
      else if (outcomes.has('ATTEMPTED_NOT_SOLVED')) attemptedNotSolved += 1;
      else notAttempted += 1;
    }

    return { assigned: problemIds.length, solved, attemptedNotSolved, notAttempted };
  }

  /** Every Infosys student, whole cohort, no campus filter. */
  async studentAnalysis(): Promise<InfosysStudentAnalysis[]> {
    const period = await this.period();
    if (!period) return [];
    const weeks = analysisWeeks(period.from, period.to);

    const enrollments = await this.prisma.infosysEnrollment.findMany({ select: { studentId: true } });
    return this.studentAnalyses(
      enrollments.map((e) => e.studentId),
      weeks,
      period,
    );
  }

  /** One Infosys student, for a STUDENT-role caller viewing their own data, or an
   * ADMIN/MENTOR looking one up directly. `null` if they are not Infosys-enrolled. */
  async studentAnalysisFor(studentId: string): Promise<InfosysStudentAnalysis | null> {
    const period = await this.period();
    if (!period) return null;
    const weeks = analysisWeeks(period.from, period.to);
    const [analysis] = await this.studentAnalyses([studentId], weeks, period);
    return analysis ?? null;
  }

  private async studentAnalyses(
    studentIds: string[],
    weeks: { weekNumber: number; from: string; to: string }[],
    period: { from: string; to: string },
  ): Promise<InfosysStudentAnalysis[]> {
    if (studentIds.length === 0) return [];

    const students = await this.prisma.student.findMany({
      where: { id: { in: studentIds } },
      select: {
        id: true,
        name: true,
        email: true,
        leetcodeUsername: true,
        infosysEnrollment: { select: { campus: { select: { name: true } } } },
      },
    });

    const statuses = await this.prisma.infosysDailyStatus.findMany({
      where: { studentId: { in: studentIds }, dayKey: { gte: period.from, lte: period.to } },
      select: {
        studentId: true,
        dayKey: true,
        assignedCount: true,
        solvedCount: true,
        attemptedNotSolvedCount: true,
        notAttemptedCount: true,
        profileNotLinkedCount: true,
        dataUnavailableCount: true,
      },
    });

    const byStudent = new Map<string, typeof statuses>();
    for (const status of statuses) {
      const list = byStudent.get(status.studentId) ?? [];
      list.push(status);
      byStudent.set(status.studentId, list);
    }

    return students.map((student) => {
      const rows = byStudent.get(student.id) ?? [];

      const weeklyRows: InfosysStudentWeek[] = weeks.map((week) => {
        const inWeek = rows.filter((r) => r.dayKey >= week.from && r.dayKey <= week.to);
        return {
          weekNumber: week.weekNumber,
          from: week.from,
          to: week.to,
          assigned: inWeek.reduce((s, r) => s + r.assignedCount, 0),
          solved: inWeek.reduce((s, r) => s + r.solvedCount, 0),
          attemptedNotSolved: inWeek.reduce((s, r) => s + r.attemptedNotSolvedCount, 0),
          notAttempted: inWeek.reduce((s, r) => s + r.notAttemptedCount, 0),
        };
      });

      const totalProfileNotLinked = rows.reduce((s, r) => s + r.profileNotLinkedCount, 0);
      const totalDataUnavailable = rows.reduce((s, r) => s + r.dataUnavailableCount, 0);
      const profileState: InfosysProfileState = !student.leetcodeUsername
        ? 'PROFILE_NOT_LINKED'
        : totalDataUnavailable > 0 && totalDataUnavailable >= totalProfileNotLinked
          ? 'DATA_UNAVAILABLE'
          : 'OK';

      const verdict = categoriseInfosysStudent({ weeks: weeklyRows, profileState });

      const assigned = weeklyRows.reduce((s, w) => s + w.assigned, 0);
      const solved = weeklyRows.reduce((s, w) => s + w.solved, 0);
      const attemptedNotSolved = weeklyRows.reduce((s, w) => s + w.attemptedNotSolved, 0);
      const notAttempted = weeklyRows.reduce((s, w) => s + w.notAttempted, 0);

      return {
        studentId: student.id,
        name: student.name,
        email: student.email,
        campusName: student.infosysEnrollment?.campus.name ?? null,
        leetcodeUsername: student.leetcodeUsername,
        profileState,
        assigned,
        solved,
        attemptedNotSolved,
        notAttempted,
        solvePercent: assigned === 0 ? null : solved / assigned,
        attemptPercent: assigned === 0 ? null : (solved + attemptedNotSolved) / assigned,
        weeks: weeklyRows,
        verdict,
      };
    });
  }
}
