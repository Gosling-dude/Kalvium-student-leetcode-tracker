/**
 * Campus Analysis -> Attempts Analysis: how many times each student submitted each
 * assigned Coding-Hours problem during its assignment period, and whether they got it.
 *
 * Three reads, one derivation:
 *
 *  - **Who was assigned what** comes from `daily_statuses` (a non-null `assignmentId`)
 *    and its `daily_problem_statuses` rows — the same per-student, per-day assignment the
 *    tracker already resolved (campus and batch audience, enrolment gate, frozen against
 *    later retargets). A problem set for another batch or campus never reaches a
 *    student's rows, and neither does a problem the student merely happened to submit.
 *  - **What they submitted** comes from the `submissions` mirror for those students and
 *    those slugs. No LeetCode call is made.
 *  - **What that means** is `summariseAttempts` in `@dsa/shared`: the assignment period
 *    (assignment day until the same problem is next assigned to the same student),
 *    de-duplication by LeetCode submission id, failed attempts stopping at the first AC,
 *    and "no readable data" kept apart from "not attempted".
 *
 * Periods are derived from *all* of a student's assignments of a problem, before any
 * date filter is applied — narrowing the table to one week must not shorten a period.
 *
 * `DailyProblemStatus.attempts`/`status` are not read: they are ever-based (the Campus
 * Analysis "solved" rule), and this report is about the assignment period.
 *
 * Campus scope is `CampusAnalysisService.campusScope` — the campuses with real
 * Coding-Hours activity, narrowed by mentor grants. Infosys data lives in its own
 * `infosys_*` tables, which nothing here touches.
 *
 * The page, its summary, the student drill-down and all three Excel exports call
 * `computeRows`, so none of them can count differently from another.
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import {
  attemptWindows,
  compareAttemptRows,
  matchesAttemptView,
  summariseAttemptRows,
  summariseAttempts,
  summariseStudentAttempts,
  ATTEMPT_OUTCOME_LABELS,
  DEFAULT_ATTEMPT_VIEW,
  type AttemptDrillDownRow,
  type AttemptRow,
  type AttemptSubmission,
  type AttemptsAnalysisResponse,
  type AttemptsStudentResponse,
  type AttemptView,
  type DayKey,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import type { RequestUser } from '../../common/decorators';
import { CampusAnalysisService, UNRELIABLE_SYNC_STATES } from './campus-analysis.service';

export interface AttemptsFilters {
  campusId?: string | null;
  batch?: string | null;
  squad?: string | null;
  from?: string | null;
  to?: string | null;
  problem?: string | null;
  difficulty?: 'EASY' | 'MEDIUM' | 'HARD' | null;
  view?: AttemptView | null;
  minAttempts?: number | null;
  /** Solved in the period, 2+ attempts, 1+ failed before the first accepted. */
  multipleAttempts?: boolean | null;
  search?: string | null;
}

export type AttemptsExportMode = 'view' | 'unsolved' | 'multiple';

type Row = AttemptRow & { submissions: AttemptSubmission[] };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DIFFICULTY_LABELS = { EASY: 'Easy', MEDIUM: 'Medium', HARD: 'Hard' } as const;

@Injectable()
export class CampusAttemptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    private readonly campusAnalysis: CampusAnalysisService,
  ) {}

  /**
   * Every student x assigned problem x assignment day in scope, with its attempt summary.
   * Every outcome is returned; callers choose the view.
   */
  private async computeRows(campusIds: string[], filters: AttemptsFilters, studentIds?: string[]): Promise<Row[]> {
    const needle = (filters.search ?? '').trim().toLowerCase();
    const students = (
      await this.prisma.student.findMany({
        where: {
          status: 'ACTIVE',
          campusId: { in: campusIds },
          ...(studentIds ? { id: { in: studentIds } } : {}),
          ...(filters.batch ? { batch: { name: filters.batch } } : {}),
          ...(filters.squad ? { squad: { name: filters.squad } } : {}),
        },
        select: {
          id: true,
          name: true,
          leetcodeUsername: true,
          campus: { select: { code: true } },
          batch: { select: { name: true } },
          squad: { select: { name: true } },
          syncState: { select: { status: true } },
        },
      })
    ).filter((s) => !needle || s.name.toLowerCase().includes(needle));
    if (students.length === 0) return [];
    const ids = students.map((s) => s.id);

    // Unfiltered by date/problem/difficulty on purpose: the periods need every
    // assignment of a problem to the student. Filters are applied after.
    const assigned = await this.prisma.$queryRaw<
      {
        studentId: string;
        dayKey: string;
        problemId: string;
        position: number;
        titleSlug: string;
        title: string;
        difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null;
      }[]
    >`
      SELECT ds."studentId", ds."dayKey", dps."problemId", dps."position",
             lower(p."titleSlug") AS "titleSlug", p."title", p."difficulty"
      FROM "daily_statuses" ds
      JOIN "daily_problem_statuses" dps ON dps."dailyStatusId" = ds.id
      JOIN "problems" p ON p.id = dps."problemId"
      WHERE ds."studentId" = ANY(${ids}::uuid[])
        AND ds."assignmentId" IS NOT NULL
    `;

    const daysByPair = new Map<string, DayKey[]>();
    for (const a of assigned) {
      const key = `${a.studentId}|${a.titleSlug}`;
      const list = daysByPair.get(key) ?? [];
      list.push(a.dayKey as DayKey);
      daysByPair.set(key, list);
    }

    const from = filters.from && this.time.isValid(filters.from) ? filters.from : null;
    const to = filters.to && this.time.isValid(filters.to) ? filters.to : null;
    const problem = filters.problem?.toLowerCase() ?? null;
    const selected = assigned.filter(
      (a) =>
        (!from || a.dayKey >= from) &&
        (!to || a.dayKey <= to) &&
        (!problem || a.titleSlug === problem) &&
        (!filters.difficulty || a.difficulty === filters.difficulty),
    );
    if (selected.length === 0) return [];

    const slugs = [...new Set(selected.map((a) => a.titleSlug))];
    // Every submission to these slugs, any date: the period is applied per pair, and an
    // accepted submission before the period decides "solved before assignment".
    const submissions = await this.prisma.$queryRaw<
      {
        studentId: string;
        titleSlug: string;
        providerSubmissionId: string;
        status: string;
        submittedAt: Date;
        dayKey: string;
        language: string | null;
      }[]
    >`
      SELECT s."studentId", lower(s."titleSlug") AS "titleSlug", s."providerSubmissionId",
             s."status"::text AS "status", s."submittedAt", s."dayKey", s."language"
      FROM "submissions" s
      WHERE s."studentId" = ANY(${ids}::uuid[])
        AND lower(s."titleSlug") = ANY(${slugs}::text[])
    `;
    const byPair = new Map<string, AttemptSubmission[]>();
    for (const s of submissions) {
      const key = `${s.studentId}|${s.titleSlug}`;
      const list = byPair.get(key) ?? [];
      list.push(s);
      byPair.set(key, list);
    }

    const windowsByPair = new Map<string, ReturnType<typeof attemptWindows>>();
    const studentById = new Map(students.map((s) => [s.id, s]));
    return selected.map((a) => {
      const student = studentById.get(a.studentId)!;
      const key = `${a.studentId}|${a.titleSlug}`;
      let windows = windowsByPair.get(key);
      if (!windows) {
        windows = attemptWindows(daysByPair.get(key)!);
        windowsByPair.set(key, windows);
      }
      const window = windows.get(a.dayKey as DayKey)!;
      const dataReadable =
        !!student.leetcodeUsername && !UNRELIABLE_SYNC_STATES.has(student.syncState?.status ?? 'NEVER_SYNCED');
      const result = summariseAttempts(window, byPair.get(key) ?? [], { dataReadable });
      return {
        studentId: student.id,
        name: student.name,
        campusCode: student.campus?.code ?? null,
        batch: student.batch?.name ?? null,
        squad: student.squad?.name ?? null,
        leetcodeUsername: student.leetcodeUsername,
        leetcodeUrl: student.leetcodeUsername ? `https://leetcode.com/u/${student.leetcodeUsername}/` : null,
        problemId: a.problemId,
        titleSlug: a.titleSlug,
        title: a.title,
        difficulty: a.difficulty,
        dayKey: a.dayKey as DayKey,
        windowEndDayKey: window.endDayKey,
        position: a.position,
        outcome: result.outcome,
        attempts: result.attempts,
        solved: result.solved,
        failedAttempts: result.failedAttempts,
        firstAttemptAt: result.firstAttemptAt?.toISOString() ?? null,
        firstAcceptedAt: result.firstAcceptedAt?.toISOString() ?? null,
        lastAttemptAt: result.lastAttemptAt?.toISOString() ?? null,
        submissions: result.submissions,
      };
    });
  }

  private publicRow(row: Row): AttemptRow {
    const { submissions: _submissions, ...rest } = row;
    return rest;
  }

  async analysis(user: RequestUser, filters: AttemptsFilters = {}): Promise<AttemptsAnalysisResponse> {
    const campusIds = await this.campusAnalysis.campusScope(user, filters.campusId ?? undefined);
    const all = await this.computeRows(campusIds, filters);

    // The Problem filter's choices ignore the problem/difficulty choice itself, so picking
    // one does not collapse the list to that one.
    const problemSource =
      filters.problem || filters.difficulty
        ? await this.computeRows(campusIds, { ...filters, problem: null, difficulty: null })
        : all;
    const problems = [...new Map(problemSource.map((r) => [r.titleSlug, { titleSlug: r.titleSlug, title: r.title }])).values()].sort(
      (a, b) => a.title.localeCompare(b.title),
    );

    const view = filters.view ?? DEFAULT_ATTEMPT_VIEW;
    const rows = all
      .filter((r) => matchesAttemptView(r.outcome, view))
      .filter((r) => !filters.minAttempts || r.attempts >= filters.minAttempts)
      .filter((r) => !filters.multipleAttempts || (r.solved && r.attempts >= 2 && r.failedAttempts >= 1))
      .sort(compareAttemptRows)
      .map((r) => this.publicRow(r));

    return { summary: summariseAttemptRows(all), problems, rows };
  }

  /** One student: header numbers, then every assigned problem with its submissions. */
  async student(
    user: RequestUser,
    studentId: string,
    filters: Pick<AttemptsFilters, 'from' | 'to'> = {},
  ): Promise<AttemptsStudentResponse> {
    const profile = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: {
        name: true,
        campusId: true,
        leetcodeUsername: true,
        status: true,
        campus: { select: { code: true } },
        batch: { select: { name: true } },
        squad: { select: { name: true } },
      },
    });
    if (!profile || !profile.campusId || profile.status !== 'ACTIVE') {
      throw new NotFoundException(`No active student ${studentId}.`);
    }
    // Not found, never forbidden, for a student outside the caller's active campuses.
    const campusIds = await this.campusAnalysis.campusScope(user, profile.campusId);
    const all = await this.computeRows(campusIds, { from: filters.from, to: filters.to }, [studentId]);

    const rows: AttemptDrillDownRow[] = all.sort(compareAttemptRows).map((r) => ({
      ...this.publicRow(r),
      submissions: r.submissions.map((s) => ({
        providerSubmissionId: s.providerSubmissionId,
        status: s.status,
        submittedAt: s.submittedAt.toISOString(),
        language: s.language ?? null,
      })),
    }));

    return {
      student: {
        studentId,
        name: profile.name,
        campusCode: profile.campus?.code ?? null,
        batch: profile.batch?.name ?? null,
        squad: profile.squad?.name ?? null,
        leetcodeUsername: profile.leetcodeUsername,
        leetcodeUrl: profile.leetcodeUsername ? `https://leetcode.com/u/${profile.leetcodeUsername}/` : null,
      },
      stats: summariseStudentAttempts(rows),
      rows,
    };
  }

  private formatDay(dayKey: string): string {
    const [year, month, day] = dayKey.split('-');
    return `${day} ${MONTHS[Number(month) - 1]} ${year}`;
  }

  /** "20 Sep 2026 10:12", in program time. */
  formatAttemptTime(iso: string | null): string {
    if (!iso) return '—';
    const date = new Date(iso);
    return `${this.formatDay(this.time.dayKeyOf(date))} ${this.time.localTime(date)}`;
  }

  /**
   * A workbook of `analysis`'s own rows, in its own order. `view` is the page as filtered;
   * `unsolved` forces Attempted But Not Solved; `multiple` forces Multiple Attempts To
   * Solve. The other filters apply to all three.
   */
  async buildWorkbook(user: RequestUser, filters: AttemptsFilters, mode: AttemptsExportMode = 'view'): Promise<Buffer> {
    if (!['view', 'unsolved', 'multiple'].includes(mode)) {
      throw new BadRequestException('mode must be view, unsolved or multiple.');
    }
    const effective: AttemptsFilters =
      mode === 'unsolved'
        ? { ...filters, view: 'ATTEMPTED_NOT_SOLVED', multipleAttempts: false }
        : mode === 'multiple'
          ? { ...filters, view: 'ALL', multipleAttempts: true }
          : filters;
    const { rows } = await this.analysis(user, effective);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'DSA Tracker';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(
      mode === 'unsolved' ? 'Unsolved Attempts' : mode === 'multiple' ? 'Multiple Attempts' : 'Attempts Analysis',
    );

    const columns: { header: string; width: number; value: (r: AttemptRow) => string | number }[] = [
      { header: 'Student', width: 28, value: (r) => r.name },
      { header: 'Campus', width: 11, value: (r) => r.campusCode ?? '' },
      { header: 'Batch', width: 18, value: (r) => r.batch ?? '' },
      { header: 'Squad', width: 12, value: (r) => r.squad ?? '' },
      { header: 'Problem', width: 34, value: (r) => r.title },
      { header: 'Difficulty', width: 11, value: (r) => (r.difficulty ? DIFFICULTY_LABELS[r.difficulty] : '') },
      { header: 'Assignment Date', width: 16, value: (r) => this.formatDay(r.dayKey) },
      { header: 'Attempts', width: 10, value: (r) => r.attempts },
      { header: 'Failed Attempts', width: 15, value: (r) => r.failedAttempts },
      { header: 'First Attempt', width: 20, value: (r) => this.formatAttemptTime(r.firstAttemptAt) },
      { header: 'First Accepted', width: 20, value: (r) => this.formatAttemptTime(r.firstAcceptedAt) },
      { header: 'Last Attempt', width: 20, value: (r) => this.formatAttemptTime(r.lastAttemptAt) },
      { header: 'Outcome', width: 26, value: (r) => ATTEMPT_OUTCOME_LABELS[r.outcome] },
    ];

    sheet.columns = columns.map((c) => ({ header: c.header, width: c.width }));
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) sheet.addRow(columns.map((c) => c.value(row)));
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(rows.length + 1, 1), column: columns.length } };

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
}
