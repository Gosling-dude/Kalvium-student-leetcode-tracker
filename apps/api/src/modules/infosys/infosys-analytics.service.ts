/**
 * Infosys student/campus analysis — read-only, computed live from `InfosysDailyStatus` +
 * `InfosysDailyProblemStatus` (the materialised rows `InfosysRollupService` writes, so
 * this never live-fetches LeetCode, §21) and scoped through the exact same
 * `MentorScopeService` every other campus-aware endpoint in this codebase uses. A mentor's
 * existing `MentorCampus` grants apply to Infosys data too — see the schema.prisma
 * section banner above `InfosysEnrollment` for why that reuse is deliberate.
 */

import { Injectable } from '@nestjs/common';
import type { UserRole } from '@dsa/shared';
import {
  analysisWeeks,
  categoriseInfosysStudent,
  type InfosysCampusSummary,
  type InfosysCategory,
  type InfosysProfileState,
  type InfosysStudentAnalysis,
  type InfosysStudentWeek,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { InfosysRollupService } from './infosys-rollup.service';

interface RequestUser {
  id: string;
  role: UserRole;
}

@Injectable()
export class InfosysAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: MentorScopeService,
    private readonly rollup: InfosysRollupService,
  ) {}

  /** The program window every Infosys analysis call is measured over: the tracking start
   * date through today, or `null` when no assignment has ever been entered. */
  private async period(): Promise<{ from: string; to: string } | null> {
    const from = await this.rollup.trackingStartDate();
    if (!from) return null;
    const to = new Date().toISOString().slice(0, 10);
    return { from, to: to > from ? to : from };
  }

  /**
   * One card per campus the caller may see. Reuses the identical scoping contract as
   * `CampusAnalysisService.summary` — `null` = every campus, `[]` = none, a list = exactly
   * those.
   */
  async campusSummary(user: RequestUser, campusId?: string): Promise<InfosysCampusSummary[]> {
    const allowed = await this.scope.allowedCampusIds(user);
    const narrowed = this.scope.narrow(campusId, allowed);
    if (narrowed.deny) return [];

    const period = await this.period();
    if (!period) return [];
    const weeks = analysisWeeks(period.from, period.to);

    const campusWhere = narrowed.campusId
      ? { id: narrowed.campusId }
      : narrowed.campusIds
        ? { id: { in: narrowed.campusIds } }
        : {};

    const enrollments = await this.prisma.infosysEnrollment.findMany({
      where: { campus: campusWhere },
      select: {
        campusId: true,
        campus: { select: { id: true, name: true } },
        studentId: true,
      },
    });

    const campusIds = [...new Set(enrollments.map((e) => e.campusId))];
    const summaries: InfosysCampusSummary[] = [];

    for (const campusId of campusIds) {
      const campus = enrollments.find((e) => e.campusId === campusId)!.campus;
      const studentIds = enrollments.filter((e) => e.campusId === campusId).map((e) => e.studentId);
      const analyses = await this.studentAnalyses(studentIds, weeks, period);

      let assigned = 0;
      let solved = 0;
      let attemptedNotSolved = 0;
      let notAttempted = 0;
      let studentsImproving = 0;
      let studentsStruggling = 0;
      let studentsNotParticipating = 0;
      let profilesNotLinked = 0;
      let dataUnavailable = 0;
      const categoryCounts = new Map<InfosysCategory, number>();

      for (const analysis of analyses) {
        assigned += analysis.assigned;
        solved += analysis.solved;
        attemptedNotSolved += analysis.attemptedNotSolved;
        notAttempted += analysis.notAttempted;
        categoryCounts.set(analysis.verdict.category, (categoryCounts.get(analysis.verdict.category) ?? 0) + 1);
        if (analysis.verdict.category === 'IMPROVING') studentsImproving += 1;
        if (analysis.verdict.category === 'TRYING_BUT_STRUGGLING') studentsStruggling += 1;
        if (analysis.verdict.category === 'NOT_PARTICIPATING') studentsNotParticipating += 1;
        if (analysis.verdict.category === 'PROFILE_NOT_LINKED') profilesNotLinked += 1;
        if (analysis.verdict.category === 'DATA_UNAVAILABLE') dataUnavailable += 1;
      }

      summaries.push({
        campusId,
        campusName: campus.name,
        students: analyses.length,
        assigned,
        solved,
        attemptedNotSolved,
        notAttempted,
        solvePercent: assigned === 0 ? null : solved / assigned,
        attemptPercent: assigned === 0 ? null : (solved + attemptedNotSolved) / assigned,
        studentsImproving,
        studentsStruggling,
        studentsNotParticipating,
        profilesNotLinked,
        dataUnavailable,
        categories: (
          ['CONSISTENT_SOLVER', 'INCONSISTENT', 'TRYING_BUT_STRUGGLING', 'IMPROVING', 'DECLINING', 'NOT_PARTICIPATING', 'PROFILE_NOT_LINKED', 'DATA_UNAVAILABLE'] as InfosysCategory[]
        ).map((category) => ({
          category,
          label: category,
          rule: '',
          students: categoryCounts.get(category) ?? 0,
        })),
        weeks: [],
      });
    }

    return summaries;
  }

  /** Every student the caller may see, with their weekly rows and category verdict — the
   * same rows every summary card's drill-down must open into (§12). */
  async studentAnalysis(user: RequestUser, campusId?: string): Promise<InfosysStudentAnalysis[]> {
    const allowed = await this.scope.allowedCampusIds(user);
    const narrowed = this.scope.narrow(campusId, allowed);
    if (narrowed.deny) return [];

    const period = await this.period();
    if (!period) return [];
    const weeks = analysisWeeks(period.from, period.to);

    const campusWhere = narrowed.campusId
      ? { id: narrowed.campusId }
      : narrowed.campusIds
        ? { id: { in: narrowed.campusIds } }
        : {};

    const enrollments = await this.prisma.infosysEnrollment.findMany({
      where: { campus: campusWhere },
      select: { studentId: true },
    });

    return this.studentAnalyses(
      enrollments.map((e) => e.studentId),
      weeks,
      period,
    );
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
        infosysEnrollment: { select: { campus: { select: { id: true, name: true } } } },
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
      const profileState: InfosysProfileState =
        totalProfileNotLinked > 0 && totalDataUnavailable === 0
          ? 'PROFILE_NOT_LINKED'
          : !student.leetcodeUsername
            ? 'PROFILE_NOT_LINKED'
            : totalDataUnavailable > 0
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
        campusId: student.infosysEnrollment?.campus.id ?? null,
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
