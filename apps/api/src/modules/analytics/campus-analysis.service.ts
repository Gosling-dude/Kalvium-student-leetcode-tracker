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

import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  analysisWeeks,
  categoriseStudent,
  CAMPUS_CATEGORIES,
  CAMPUS_CATEGORY_LABELS,
  CAMPUS_CATEGORY_MEANINGS,
  CAMPUS_CATEGORY_RULES,
  resolveObservedFromDay,
  assertQuestionTotalsReconcile,
  type CampusAnalysisPeriod,
  type CampusAnalysisSummary,
  type CampusCategory,
  type CampusQuestion,
  type CampusQuestionWeek,
  type DayKey,
  type StudentAnalysis,
  type StudentWeek,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { MentorScopeService, type CampusScope } from '../campuses/mentor-scope.service';
import { CampusesService } from '../campuses/campuses.service';
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

@Injectable()
export class CampusAnalysisService {
  private readonly logger = new Logger(CampusAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    private readonly mentorScope: MentorScopeService,
    private readonly campuses: CampusesService,
  ) {}

  /**
   * Resolve the period, defaulting to the programme so far.
   *
   * `from` defaults to the first day any assignment exists for rather than a fixed date,
   * so the analysis does not silently start reporting from a hard-coded August after the
   * programme moves on.
   */
  async resolvePeriod(from?: string, to?: string): Promise<CampusAnalysisPeriod> {
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
    period: CampusAnalysisPeriod,
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

  /**
   * Every distinct question set for these campuses, week by week, with its outcome.
   *
   * This is the fix for the number that started as `students x questions`. The old campus
   * summary added up per-student rows, so a week where 98 students each received the same
   * 20 problems reported 1,960 "questions assigned". It was counting student-question
   * pairs and calling them questions.
   *
   * Here the unit is the question. `assigned` selects DISTINCT lowercased slug per campus
   * per week straight from the assignment records, so it cannot depend on how many
   * students are in the campus — a problem set twice in a week, or set to two batches of
   * the same campus, is still one question. `outcomes` then asks, per question, what the
   * students it was actually set for did with it, and `count(DISTINCT "studentId")` means
   * a student who submitted six times is one student.
   *
   * The three outcomes are a partition, in this order: solved if **any** targeted student
   * has an accepted solution; otherwise attempted-not-solved if any submitted without one;
   * otherwise not attempted. Mutually exclusive and exhaustive, so
   * `solved + attemptedNotSolved + notAttempted = assigned` holds without being arranged.
   *
   * One query for the whole set of campuses and weeks, not one per campus-week.
   */
  private async questionsFor(
    campusIds: string[],
    weeks: { weekNumber: number; from: string; to: string }[],
  ): Promise<Map<string, CampusQuestion[]>> {
    if (campusIds.length === 0 || weeks.length === 0) return new Map();

    // The week grid, passed in rather than derived in SQL, so the campus summary and the
    // student rows are bucketed by the identical boundaries.
    const weekValues = Prisma.join(
      weeks.map((w) => Prisma.sql`(${w.weekNumber}::int, ${w.from}::text, ${w.to}::text)`),
    );

    const rows = await this.prisma.$queryRaw<
      {
        campusId: string;
        weekNumber: number;
        slug: string;
        title: string;
        dayKeys: string[];
        solvedStudents: bigint;
        attemptedStudents: bigint;
        targetedStudents: bigint;
      }[]
    >`
      WITH wk(week_number, from_day, to_day) AS (VALUES ${weekValues}),
      assigned AS (
        SELECT a."campusId",
               w.week_number,
               lower(p."titleSlug") AS slug,
               min(p."title")        AS title,
               array_agg(DISTINCT a."dayKey" ORDER BY a."dayKey") AS day_keys
        FROM "assignments" a
        JOIN "assignment_problems" ap ON ap."assignmentId" = a.id
        JOIN "problems" p ON p.id = ap."problemId"
        JOIN wk w ON a."dayKey" >= w.from_day AND a."dayKey" <= w.to_day
        WHERE a."campusId" = ANY(${campusIds}::uuid[])
        GROUP BY 1, 2, 3
      ),
      outcomes AS (
        SELECT a."campusId",
               w.week_number,
               lower(p."titleSlug") AS slug,
               count(DISTINCT ds."studentId") FILTER (WHERE dps."status" = 'ACCEPTED')               AS solved_students,
               count(DISTINCT ds."studentId") FILTER (WHERE dps."status" = 'ATTEMPTED_NOT_ACCEPTED') AS attempted_students,
               count(DISTINCT ds."studentId")                                                        AS targeted_students
        FROM "daily_statuses" ds
        JOIN "assignments" a ON a.id = ds."assignmentId"
        JOIN wk w ON ds."dayKey" >= w.from_day AND ds."dayKey" <= w.to_day
        JOIN "daily_problem_statuses" dps ON dps."dailyStatusId" = ds.id
        JOIN "problems" p ON p.id = dps."problemId"
        WHERE a."campusId" = ANY(${campusIds}::uuid[])
        GROUP BY 1, 2, 3
      )
      SELECT asg."campusId"                        AS "campusId",
             asg.week_number                       AS "weekNumber",
             asg.slug                              AS "slug",
             asg.title                             AS "title",
             asg.day_keys                          AS "dayKeys",
             coalesce(o.solved_students, 0)        AS "solvedStudents",
             coalesce(o.attempted_students, 0)     AS "attemptedStudents",
             coalesce(o.targeted_students, 0)      AS "targetedStudents"
      FROM assigned asg
      LEFT JOIN outcomes o
        ON o."campusId" = asg."campusId"
       AND o.week_number = asg.week_number
       AND o.slug = asg.slug
      ORDER BY asg."campusId", asg.week_number, asg.slug
    `;

    const byCampus = new Map<string, CampusQuestion[]>();
    for (const row of rows) {
      const solvedStudents = Number(row.solvedStudents);
      const attemptedStudents = Number(row.attemptedStudents);
      const studentsAssigned = Number(row.targetedStudents);
      const list = byCampus.get(row.campusId) ?? [];
      list.push({
        slug: row.slug,
        title: row.title,
        weekNumber: Number(row.weekNumber),
        dayKeys: row.dayKeys as DayKey[],
        outcome:
          solvedStudents > 0 ? 'SOLVED'
            : attemptedStudents > 0 ? 'ATTEMPTED_NOT_SOLVED'
              : 'NOT_ATTEMPTED',
        studentsAssigned,
        studentsSolved: solvedStudents,
        studentsAttemptedNotSolved: attemptedStudents,
        studentsNotAttempted: Math.max(0, studentsAssigned - solvedStudents - attemptedStudents),
      });
      byCampus.set(row.campusId, list);
    }
    return byCampus;
  }

  /** Roll a set of questions into the three counts and their percentages. */
  private tally(questions: CampusQuestion[]): {
    assigned: number;
    solved: number;
    attemptedNotSolved: number;
    notAttempted: number;
    solvePercent: number | null;
    attemptPercent: number | null;
    notAttemptedPercent: number | null;
  } {
    const assigned = questions.length;
    const solved = questions.filter((q) => q.outcome === 'SOLVED').length;
    const attemptedNotSolved = questions.filter((q) => q.outcome === 'ATTEMPTED_NOT_SOLVED').length;
    const notAttempted = questions.filter((q) => q.outcome === 'NOT_ATTEMPTED').length;
    const share = (n: number): number | null => (assigned === 0 ? null : n / assigned);
    return {
      assigned,
      solved,
      attemptedNotSolved,
      notAttempted,
      solvePercent: share(solved),
      attemptPercent: share(solved + attemptedNotSolved),
      notAttemptedPercent: share(notAttempted),
    };
  }

  /**
   * Mean share of targeted students who solved each question.
   *
   * Computed over student-question pairs, which is the one place that unit is correct:
   * it is the denominator of a rate, never a count of questions. Summing both sides and
   * dividing weights each question by how many students received it, which is what makes
   * it comparable across campuses of different sizes.
   */
  private studentCompletion(questions: CampusQuestion[]): number | null {
    const assigned = questions.reduce((total, q) => total + q.studentsAssigned, 0);
    if (assigned === 0) return null;
    return questions.reduce((total, q) => total + q.studentsSolved, 0) / assigned;
  }

  /**
   * Period totals, deduplicated across weeks.
   *
   * Not the sum of the weekly tallies: a problem set in week 2 and again in week 5 is one
   * question over the period. Summing the columns would re-introduce the double counting
   * this whole change removes, one level up.
   */
  private tallyPeriod(questions: CampusQuestion[]) {
    const bySlug = new Map<string, CampusQuestion>();
    for (const q of questions) {
      const existing = bySlug.get(q.slug);
      // Solved anywhere in the period wins; attempted beats never touched.
      if (
        !existing ||
        (existing.outcome !== 'SOLVED' && q.outcome === 'SOLVED') ||
        (existing.outcome === 'NOT_ATTEMPTED' && q.outcome === 'ATTEMPTED_NOT_SOLVED')
      ) {
        bySlug.set(q.slug, q);
      }
    }
    return this.tally([...bySlug.values()]);
  }

  /**
   * The campuses this user may read, as ids. Throws only when they may read none.
   *
   * "Every campus" here means every campus with real Coding-Hours activity (an active
   * student or an active batch) — `CampusesService.findAll`'s already-tested
   * `hasCodingHoursActivity` filter, the same one the Coding-Hours campus picker and the
   * main Dashboard's per-campus card grid already use (see `aedec6e`'s fix for the
   * identical bug on the Dashboard). A campus that exists only for a different program
   * (Infosys Preparation — zero Coding-Hours students, zero batches) must not turn into
   * an empty "0 active students" card here either; nothing about that campus's own,
   * unrelated data is touched by excluding it from this list.
   */
  private async scopeFor(user: RequestUser, requestedCampusId?: string): Promise<string[]> {
    const allowed: CampusScope = await this.mentorScope.allowedCampusIds(user);
    const active = await this.campuses.findAll(false, null, true);
    const everything = active.map((c) => c.id);

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
  ): Promise<{ period: CampusAnalysisPeriod; campuses: CampusAnalysisSummary[] }> {
    const period = await this.resolvePeriod(options.from, options.to);
    const campusIds = await this.scopeFor(user, options.campusId);

    const weeks = analysisWeeks(period.from, period.to);
    const [campuses, analyses, questionsByCampus] = await Promise.all([
      this.prisma.campus.findMany({
        where: { id: { in: campusIds } },
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      }),
      // Student rows still drive the categories — "is this student improving" is a
      // question about a student, and always was. What they no longer drive is the
      // question counts.
      this.weeklyRowsFor(period, { campusIds }),
      this.questionsFor(campusIds, weeks),
    ]);

    const summaries = campuses.map((campus) => {
      // Campus isolation is a filter on the canonical rows, applied once, here — not a
      // parameter each caller remembers to pass.
      const cohort = analyses.filter((a) => a.campusId === campus.id);
      const usable = cohort.filter((a) => a.dataAvailable);
      const questions = questionsByCampus.get(campus.id) ?? [];

      const weekRows: CampusQuestionWeek[] = weeks.map((w) => {
        const inWeek = questions.filter((q) => q.weekNumber === w.weekNumber);
        // Student participation stays a student figure and stays in its own columns.
        const cells = cohort.map((a) => a.weeks[w.weekNumber - 1]!).filter((c) => c.observed);
        return {
          weekNumber: w.weekNumber,
          from: w.from as DayKey,
          to: w.to as DayKey,
          ...this.tally(inWeek),
          studentCompletionPercent: this.studentCompletion(inWeek),
          studentsActive: cells.filter((c) => c.solved > 0).length,
          studentsObserved: cells.length,
        };
      });

      // Checked rather than asserted. The three outcomes partition the week by
      // construction, but "by construction" describes the code as written, not as edited,
      // and a silently broken partition is the class of bug this whole change is fixing.
      for (const week of weekRows) {
        const complaint = assertQuestionTotalsReconcile(week);
        if (complaint) {
          this.logger.error(`${campus.code} question totals do not reconcile — ${complaint}`);
        }
      }

      return {
        campusId: campus.id,
        campusCode: campus.code,
        campusName: campus.name,
        activeStudents: cohort.length,
        studentsWithUsableData: usable.length,
        ...this.tallyPeriod(questions),
        studentCompletionPercent: this.studentCompletion(questions),
        categories: CAMPUS_CATEGORIES.map((category) => ({
          category,
          label: CAMPUS_CATEGORY_LABELS[category],
          meaning: CAMPUS_CATEGORY_MEANINGS[category],
          rule: CAMPUS_CATEGORY_RULES[category],
          students: cohort.filter((a) => a.verdict.category === category).length,
          isPerformanceCategory: category !== 'NOT_OBSERVED' && category !== 'DATA_UNAVAILABLE',
        })),
        weeks: weekRows,
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
    period: CampusAnalysisPeriod;
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
   * Every student across every category, for whichever campuses this user may read (all
   * of them, scoped, if `campusId` is omitted) — the same `weeklyRowsFor` rows `drillDown`
   * filters down to one category, exposed here unfiltered for a caller that needs the
   * whole cohort's category alongside it (the Daily Report's category filter) without a
   * second implementation of "which students, which category".
   */
  async allStudents(
    user: RequestUser,
    options: { from?: string; to?: string; campusId?: string } = {},
  ): Promise<{ period: CampusAnalysisPeriod; students: StudentAnalysis[] }> {
    const period = await this.resolvePeriod(options.from, options.to);
    const campusIds = await this.scopeFor(user, options.campusId);
    const analyses = await this.weeklyRowsFor(period, { campusIds });
    return { period, students: analyses };
  }

  /**
   * Every question set for one campus, with what the students it was set for did with it.
   *
   * The supporting view the question-level headline needs. "20 of 20 questions solved"
   * at a 98-student campus is true and nearly content-free — it only says each question
   * reached somebody. This is where "Two Sum: 73 of 98 solved it" lives, which is the
   * number that actually separates a question the campus handled from one that one
   * student happened to clear.
   *
   * Same `questionsFor` call the summary counted, so the totals here and the numbers on
   * the campus card are the same rows.
   */
  async questions(
    user: RequestUser,
    campusId: string,
    options: { from?: string; to?: string; weekNumber?: number } = {},
  ): Promise<{
    period: CampusAnalysisPeriod;
    campusId: string;
    totals: ReturnType<CampusAnalysisService['tally']>;
    questions: CampusQuestion[];
  }> {
    const period = await this.resolvePeriod(options.from, options.to);
    const [scoped] = await this.scopeFor(user, campusId);
    const weeks = analysisWeeks(period.from, period.to);
    const all = (await this.questionsFor([scoped!], weeks)).get(scoped!) ?? [];

    const questions =
      options.weekNumber === undefined
        ? all
        : all.filter((q) => q.weekNumber === options.weekNumber);

    return {
      period,
      campusId,
      // Week-scoped totals tally that week; unscoped totals deduplicate across weeks,
      // because a problem set twice in the period is still one question.
      totals: options.weekNumber === undefined ? this.tallyPeriod(questions) : this.tally(questions),
      questions: [...questions].sort(
        (a, b) => a.weekNumber - b.weekNumber || b.studentsSolved - a.studentsSolved || a.slug.localeCompare(b.slug),
      ),
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
    period: CampusAnalysisPeriod;
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
