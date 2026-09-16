/**
 * Campus-wise analysis: the same rows management reads in the weekly workbook, served by
 * the application that owns them.
 *
 * The workbook this replaces was produced by a script that no longer exists in the repo,
 * against a snapshot, with its own definition of "solved" — accepted between two dates.
 * The application's definition is "ever solved", because an assignment entered on the
 * 11th for the 7th has to credit a student who solved it on the 5th. Two definitions, two
 * artifacts, and the one management actually reads was the one nothing tested. That is
 * why this exists as an endpoint rather than a better script.
 *
 * The rule the whole module is built around: **the category counts and the drill-down
 * behind them are the same function of the same rows.** `weeklyRowsFor` is the only place
 * a weekly figure is derived; `summary` groups its output and `drillDown` lists it. A
 * summary card saying 5 and a detail table listing 4 students is not a display bug, it is
 * two implementations of one question, and there is only one here.
 *
 * Everything is read from `daily_statuses` / `daily_problem_statuses` — the canonical
 * derived state the dashboard, leaderboard, streaks and reports already read. No separate
 * analytics store, nothing precomputed on a different schedule and nothing that can drift
 * from the tracker while looking authoritative.
 */

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  analysisWeeks,
  categoriseStudent,
  CAMPUS_CATEGORIES,
  CAMPUS_CATEGORY_LABELS,
  CAMPUS_CATEGORY_MEANINGS,
  CAMPUS_CATEGORY_RULES,
  resolveObservedFromDay,
  type CampusCategory,
  type CategoryVerdict,
  type DayKey,
  type StudentWeek,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { MentorScopeService, type CampusScope } from '../campuses/mentor-scope.service';
import type { RequestUser } from '../../common/decorators';

/**
 * Sync states that mean we do not have a reliable reading of a student's submissions.
 *
 * `NEVER_SYNCED` is included deliberately: a student the sync has never reached has no
 * evidence either way, and the entire point of this module is that no evidence must not
 * render as a zero. `PROFILE_MISSING` is *not* here — that student has no LeetCode handle
 * at all, which is a roster gap the mentor can act on, and is reported as its own thing.
 */
const UNRELIABLE_SYNC_STATES = new Set(['NEVER_SYNCED', 'USER_NOT_FOUND', 'PROFILE_PRIVATE', 'RATE_LIMITED', 'PROVIDER_ERROR', 'TIMEOUT']);

export interface Period {
  from: DayKey;
  to: DayKey;
}

export interface StudentAnalysis {
  studentId: string;
  name: string;
  campusId: string | null;
  campusCode: string | null;
  squad: string | null;
  batch: string | null;
  leetcodeUsername: string | null;
  leetcodeUrl: string | null;
  /** Distinct assigned problems ever solved across the whole period. */
  solved: number;
  assigned: number;
  attemptedNotSolved: number;
  notAttempted: number;
  /** The tracker's canonical lifetime distinct-solved figure, not a per-period one. */
  totalSolvedAllTime: number;
  dataAvailable: boolean;
  /** Named when `dataAvailable` is false, so the drill-down can say *why*. */
  dataIssue: string | null;
  weeks: StudentWeek[];
  verdict: CategoryVerdict;
}

export interface CampusSummary {
  campusId: string;
  campusCode: string;
  campusName: string;
  activeStudents: number;
  studentsWithUsableData: number;
  assigned: number;
  solved: number;
  attemptedNotSolved: number;
  notAttempted: number;
  solvePercent: number | null;
  categories: {
    category: CampusCategory;
    label: string;
    meaning: string;
    rule: string;
    students: number;
    /** A category of zero is shown, not hidden — "nobody is consistent" is a finding. */
    isPerformanceCategory: boolean;
  }[];
  weeks: {
    weekNumber: number;
    from: DayKey;
    to: DayKey;
    assigned: number;
    solved: number;
    attemptedNotSolved: number;
    notAttempted: number;
    solvePercent: number | null;
    /** Students with at least one solve — the honest "participated" count. */
    studentsActive: number;
    studentsObserved: number;
  }[];
}

@Injectable()
export class CampusAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    private readonly mentorScope: MentorScopeService,
  ) {}

  /**
   * Resolve the period, defaulting to the programme so far.
   *
   * `from` defaults to the first day any assignment exists for rather than a fixed date,
   * so the analysis does not silently start reporting from a hard-coded August after the
   * programme moves on.
   */
  async resolvePeriod(from?: string, to?: string): Promise<Period> {
    const today = this.time.today();
    const end = (to && this.time.isValid(to) ? to : today) as DayKey;
    if (from && this.time.isValid(from)) return { from: from as DayKey, to: end };

    const earliest = await this.prisma.assignment.findFirst({
      orderBy: { dayKey: 'asc' },
      select: { dayKey: true },
    });
    return { from: (earliest?.dayKey ?? this.time.addDays(end, -41)) as DayKey, to: end };
  }

  /**
   * The one derivation. Everything public on this service is a view over its output.
   *
   * Two queries regardless of how many students or weeks are asked for: one for the
   * roster, one for the scored days. The per-problem detail is only loaded by
   * `studentDetail`, because a campus summary does not need 200 students x 40 days of
   * per-problem rows to count categories and the difference is seconds per request.
   */
  private async weeklyRowsFor(
    period: Period,
    scope: { campusIds?: string[]; studentIds?: string[] },
  ): Promise<StudentAnalysis[]> {
    const weeks = analysisWeeks(period.from, period.to);

    const students = await this.prisma.student.findMany({
      where: {
        status: 'ACTIVE',
        ...(scope.campusIds ? { campusId: { in: scope.campusIds } } : {}),
        ...(scope.studentIds ? { id: { in: scope.studentIds } } : {}),
      },
      select: {
        id: true,
        name: true,
        campusId: true,
        leetcodeUsername: true,
        totalSolved: true,
        createdAt: true,
        campus: { select: { code: true } },
        squad: { select: { name: true } },
        batch: { select: { name: true } },
        syncState: { select: { status: true, lastError: true } },
      },
      orderBy: { name: 'asc' },
    });
    if (students.length === 0) return [];

    const studentIds = students.map((s) => s.id);

    // Scored days, with just enough per-problem aggregation to separate "tried and did not
    // solve" from "never opened it". Grouped in SQL rather than loaded row by row: at 219
    // students over 41 days the per-problem table is tens of thousands of rows, and the
    // three numbers this needs from them are counts.
    const rows = await this.prisma.$queryRaw<
      {
        studentId: string;
        dayKey: string;
        assignedCount: number;
        solvedCount: number;
        attempted: bigint;
      }[]
    >`
      SELECT d."studentId",
             d."dayKey",
             d."assignedCount",
             d."solvedCount",
             COUNT(p.*) FILTER (WHERE p."status" = 'ATTEMPTED_NOT_ACCEPTED') AS attempted
      FROM "daily_statuses" d
      LEFT JOIN "daily_problem_statuses" p ON p."dailyStatusId" = d.id
      WHERE d."studentId" = ANY(${studentIds}::uuid[])
        AND d."dayKey" >= ${period.from}
        AND d."dayKey" <= ${period.to}
      GROUP BY d."studentId", d."dayKey", d."assignedCount", d."solvedCount"
    `;

    const byStudent = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byStudent.get(row.studentId) ?? [];
      list.push(row);
      byStudent.set(row.studentId, list);
    }

    return students.map((student) => {
      // The same observed-from rule the dashboard and rollup use, so a student cannot be
      // "not observed" on one screen and scored on another.
      const observedFrom = resolveObservedFromDay({
        createdAtDayKey: this.time.dayKeyOf(student.createdAt),
      });
      const days = byStudent.get(student.id) ?? [];

      const weekRows: StudentWeek[] = weeks.map((w) => {
        const inWeek = days.filter((d) => d.dayKey >= w.from && d.dayKey <= w.to);
        const assigned = inWeek.reduce((sum, d) => sum + d.assignedCount, 0);
        const solved = inWeek.reduce((sum, d) => sum + d.solvedCount, 0);
        const attemptedNotSolved = inWeek.reduce((sum, d) => sum + Number(d.attempted), 0);
        return {
          weekNumber: w.weekNumber,
          from: w.from,
          to: w.to,
          assigned,
          solved,
          attemptedNotSolved,
          notAttempted: Math.max(0, assigned - solved - attemptedNotSolved),
          // Observed when any part of the week falls on or after the student's first day.
          observed: observedFrom <= (w.to as DayKey),
        };
      });

      const syncStatus = student.syncState?.status ?? 'NEVER_SYNCED';
      const noHandle = !student.leetcodeUsername;
      const unreliable = UNRELIABLE_SYNC_STATES.has(syncStatus);
      const dataAvailable = !noHandle && !unreliable;
      const dataIssue = noHandle
        ? 'No LeetCode handle is linked to this student, so nothing can be read for them.'
        : unreliable
          ? `Last sync reported ${syncStatus}${student.syncState?.lastError ? `: ${student.syncState.lastError}` : ''}.`
          : null;

      const total = (pick: (w: StudentWeek) => number) =>
        weekRows.filter((w) => w.observed).reduce((sum, w) => sum + pick(w), 0);

      return {
        studentId: student.id,
        name: student.name,
        campusId: student.campusId,
        campusCode: student.campus?.code ?? null,
        squad: student.squad?.name ?? null,
        batch: student.batch?.name ?? null,
        leetcodeUsername: student.leetcodeUsername,
        leetcodeUrl: student.leetcodeUsername
          ? `https://leetcode.com/u/${student.leetcodeUsername}/`
          : null,
        assigned: total((w) => w.assigned),
        solved: total((w) => w.solved),
        attemptedNotSolved: total((w) => w.attemptedNotSolved),
        notAttempted: total((w) => w.notAttempted),
        totalSolvedAllTime: student.totalSolved,
        dataAvailable,
        dataIssue,
        weeks: weekRows,
        verdict: categoriseStudent({ weeks: weekRows, dataAvailable }),
      };
    });
  }

  /** The campuses this user may read, as ids. Throws only when they may read none. */
  private async scopeFor(user: RequestUser, requestedCampusId?: string): Promise<string[]> {
    const allowed: CampusScope = await this.mentorScope.allowedCampusIds(user);
    const all = await this.prisma.campus.findMany({ select: { id: true }, orderBy: { code: 'asc' } });
    const everything = all.map((c) => c.id);

    const visible = allowed === null ? everything : everything.filter((id) => allowed.includes(id));
    if (visible.length === 0) {
      throw new ForbiddenException(
        'No campus has been granted to this account, so there is nothing to analyse. ' +
          'An admin grants campuses via PUT /admin/mentors/:id/campuses.',
      );
    }
    if (!requestedCampusId) return visible;
    // Answered as "not found" rather than "forbidden" on purpose: a mentor probing ids
    // should not be able to tell a campus they may not see from one that does not exist.
    if (!visible.includes(requestedCampusId)) {
      throw new NotFoundException(`No campus ${requestedCampusId}.`);
    }
    return [requestedCampusId];
  }

  /** Campus cards: one row per campus, with the category counts that open a drill-down. */
  async summary(
    user: RequestUser,
    options: { from?: string; to?: string; campusId?: string } = {},
  ): Promise<{ period: Period; campuses: CampusSummary[] }> {
    const period = await this.resolvePeriod(options.from, options.to);
    const campusIds = await this.scopeFor(user, options.campusId);

    const [campuses, analyses] = await Promise.all([
      this.prisma.campus.findMany({
        where: { id: { in: campusIds } },
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      }),
      this.weeklyRowsFor(period, { campusIds }),
    ]);

    const weeks = analysisWeeks(period.from, period.to);
    const summaries = campuses.map((campus) => {
      // Campus isolation is a filter on the canonical rows, applied once, here — not a
      // parameter each caller remembers to pass.
      const cohort = analyses.filter((a) => a.campusId === campus.id);
      const usable = cohort.filter((a) => a.dataAvailable);
      const sum = (pick: (a: StudentAnalysis) => number) => cohort.reduce((t, a) => t + pick(a), 0);
      const assigned = sum((a) => a.assigned);
      const solved = sum((a) => a.solved);

      return {
        campusId: campus.id,
        campusCode: campus.code,
        campusName: campus.name,
        activeStudents: cohort.length,
        studentsWithUsableData: usable.length,
        assigned,
        solved,
        attemptedNotSolved: sum((a) => a.attemptedNotSolved),
        notAttempted: sum((a) => a.notAttempted),
        solvePercent: assigned === 0 ? null : solved / assigned,
        categories: CAMPUS_CATEGORIES.map((category) => ({
          category,
          label: CAMPUS_CATEGORY_LABELS[category],
          meaning: CAMPUS_CATEGORY_MEANINGS[category],
          rule: CAMPUS_CATEGORY_RULES[category],
          students: cohort.filter((a) => a.verdict.category === category).length,
          isPerformanceCategory: category !== 'NOT_OBSERVED' && category !== 'DATA_UNAVAILABLE',
        })),
        weeks: weeks.map((w) => {
          const cells = cohort.map((a) => a.weeks[w.weekNumber - 1]!).filter((c) => c.observed);
          const wAssigned = cells.reduce((t, c) => t + c.assigned, 0);
          const wSolved = cells.reduce((t, c) => t + c.solved, 0);
          return {
            weekNumber: w.weekNumber,
            from: w.from as DayKey,
            to: w.to as DayKey,
            assigned: wAssigned,
            solved: wSolved,
            attemptedNotSolved: cells.reduce((t, c) => t + c.attemptedNotSolved, 0),
            notAttempted: cells.reduce((t, c) => t + c.notAttempted, 0),
            solvePercent: wAssigned === 0 ? null : wSolved / wAssigned,
            studentsActive: cells.filter((c) => c.solved > 0).length,
            studentsObserved: cells.length,
          };
        }),
      };
    });

    return { period, campuses: summaries };
  }

  /**
   * The students behind one category card.
   *
   * Reads `weeklyRowsFor` and filters — the identical call the summary counted — so the
   * number on the card and the length of this list cannot disagree.
   */
  async drillDown(
    user: RequestUser,
    campusId: string,
    category: CampusCategory,
    options: { from?: string; to?: string } = {},
  ): Promise<{
    period: Period;
    campusId: string;
    category: CampusCategory;
    label: string;
    meaning: string;
    rule: string;
    students: StudentAnalysis[];
  }> {
    const period = await this.resolvePeriod(options.from, options.to);
    const [scoped] = await this.scopeFor(user, campusId);
    const analyses = await this.weeklyRowsFor(period, { campusIds: [scoped!] });

    return {
      period,
      campusId,
      category,
      label: CAMPUS_CATEGORY_LABELS[category],
      meaning: CAMPUS_CATEGORY_MEANINGS[category],
      rule: CAMPUS_CATEGORY_RULES[category],
      students: analyses
        .filter((a) => a.verdict.category === category)
        .sort((a, b) => b.solved - a.solved || a.name.localeCompare(b.name)),
    };
  }

  /**
   * One student, day by day and question by question — the bottom of the drill-down.
   *
   * Each question carries where the evidence came from: when it was accepted, and how
   * many times it was submitted. A mentor disputing a row should be able to check it
   * against the student's LeetCode profile without asking anyone.
   */
  async studentDetail(
    user: RequestUser,
    studentId: string,
    options: { from?: string; to?: string } = {},
  ): Promise<{
    period: Period;
    student: StudentAnalysis;
    days: {
      dayKey: DayKey;
      assigned: number;
      solved: number;
      problems: {
        titleSlug: string;
        title: string;
        position: number;
        status: string;
        solvedAt: Date | null;
        /** True when the accepted submission predates the assignment's own date. */
        solvedBeforeAssignmentDate: boolean;
        attempts: number;
      }[];
    }[];
  }> {
    const period = await this.resolvePeriod(options.from, options.to);

    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, campusId: true },
    });
    if (!student) throw new NotFoundException(`No student ${studentId}.`);

    // A student may read themselves and nobody else; everyone else is campus-scoped.
    if (user.role === 'STUDENT') {
      if (user.studentId !== studentId) {
        throw new ForbiddenException('A student may only read their own analysis.');
      }
    } else {
      await this.scopeFor(user, student.campusId ?? undefined);
    }

    const [analysis] = await this.weeklyRowsFor(period, { studentIds: [studentId] });
    if (!analysis) throw new NotFoundException(`No active student ${studentId}.`);

    const days = await this.prisma.dailyStatus.findMany({
      where: { studentId, dayKey: { gte: period.from, lte: period.to }, assignedCount: { gt: 0 } },
      orderBy: { dayKey: 'asc' },
      select: {
        dayKey: true,
        assignedCount: true,
        solvedCount: true,
        problemStatuses: {
          orderBy: { position: 'asc' },
          select: {
            position: true,
            status: true,
            solvedAt: true,
            attempts: true,
            problem: { select: { titleSlug: true, title: true } },
          },
        },
      },
    });

    return {
      period,
      student: analysis,
      days: days.map((d) => ({
        dayKey: d.dayKey as DayKey,
        assigned: d.assignedCount,
        solved: d.solvedCount,
        problems: d.problemStatuses.map((p) => ({
          titleSlug: p.problem.titleSlug,
          title: p.problem.title,
          position: p.position,
          status: p.status,
          solvedAt: p.solvedAt,
          // Surfaced rather than hidden: this is the case the tracker used to score as a
          // miss, and a mentor looking at a corrected number deserves to see which rows
          // the correction came from.
          solvedBeforeAssignmentDate: p.solvedAt !== null && this.time.dayKeyOf(p.solvedAt) < d.dayKey,
          attempts: p.attempts,
        })),
      })),
    };
  }
}
