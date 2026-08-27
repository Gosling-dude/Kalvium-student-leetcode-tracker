/**
 * Baseline tests — creation, eligibility, attempts, grading and reporting.
 *
 * Kept structurally apart from daily assignments (§25, §39). Nothing in this file writes
 * to `DailyStatus`, `Student.currentStreak`, `Student.totalScore` or `LeaderboardEntry`,
 * and nothing in the daily path reads a baseline table. That separation is the feature:
 * a baseline measures whether a student can solve something unaided, and if its result
 * could also nudge a completion percentage or extend a streak, neither number would mean
 * what it says any more.
 *
 * The single thing baseline grading shares with the rest of the system is the submission
 * mirror it *reads*. Grading an attempt is a range query over `Submission` inside the
 * attempt's window, so the existing LeetCode sync stays the only ingestion path and no
 * second provider integration exists to drift out of step.
 *
 * Two projections of every entity exist — mentor and student — and they are separate
 * methods returning separate types rather than one method with a flag. `riskFlags`,
 * `riskScore`, `adminNotes` and everyone else's results are absent from the student
 * shape by construction, so "we remembered to strip it" is not a thing anyone has to
 * keep remembering (§22, §35).
 */

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  assessRisk,
  attemptExpiry,
  baselinePercent,
  computeGeneralPerformance,
  countSolved,
  isPerformanceKnown,
  BASELINE_RISK_SIGNAL_LABELS,
  BASELINE_RISK_THRESHOLDS,
  describeScope,
  extractProblemSlug,
  gradeAttempt,
  isTestOpen,
  rankBaselineEntries,
  scopeApplies,
  type AudienceScope,
  type BaselineAttemptProblemResult,
  type BaselineAttemptStatus,
  type BaselineAttemptSummary,
  type BaselineLeaderboard,
  type BaselineLeaderboardRow,
  type BaselineProblemOutcome,
  type BaselineProblemPerformance,
  type BaselineProblemStat,
  type BaselineScopeBreakdown,
  type BaselineStudentResult,
  type BaselineTestReport,
  type BaselineTestSummary,
  type DayKey,
  type ProblemStatus,
  type SyncStatus,
  type StudentBaselineTest,
} from '@dsa/shared';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';
import type { CampusScope } from '../campuses/mentor-scope.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { CampusesService } from '../campuses/campuses.service';
import { SUBMISSION_PROVIDER, type SubmissionProvider } from '../providers/provider.types';
import { ProviderProblemNotFoundError } from '../providers/provider.errors';
import type {
  BaselineTestQueryDto,
  CreateBaselineTestDto,
  ReviewAttemptDto,
  UpdateBaselineTestDto,
} from './dto/baseline-test.dto';

/** How much of a solve window counts as "comparable history" for the pace signal. */
const HISTORY_LOOKBACK_DAYS = 30;

/** An eligible student, carrying the names the report groups and labels by. */
interface EligibleStudent {
  id: string;
  name: string;
  email: string | null;
  squadName: string | null;
  campusId: string | null;
  batchId: string | null;
  campusName: string | null;
  batchName: string | null;
}

@Injectable()
export class BaselineTestsService {
  private readonly logger = new Logger(BaselineTestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    private readonly campuses: CampusesService,
    @Inject(SUBMISSION_PROVIDER) private readonly provider: SubmissionProvider,
  ) {}

  // -------------------------------------------------------------------------
  // Admin: authoring
  // -------------------------------------------------------------------------

  async create(dto: CreateBaselineTestDto, userId: string): Promise<BaselineTestSummary> {
    if (!this.time.isValid(dto.dayKey)) {
      throw new BadRequestException(`"${dto.dayKey}" is not a valid date (expected YYYY-MM-DD)`);
    }

    const scope = await this.campuses.resolveScope({ campus: dto.campus, batch: dto.batch });
    const problems = await this.resolveProblems(dto.problems);

    const test = await this.prisma.baselineTest.create({
      data: {
        name: dto.name,
        dayKey: dto.dayKey,
        description: dto.description ?? null,
        instructions: dto.instructions ?? null,
        adminNotes: dto.adminNotes ?? null,
        campusId: scope.campusId,
        batchId: scope.batchId,
        durationMinutes: dto.durationMinutes ?? 60,
        opensAt: dto.opensAt ? new Date(dto.opensAt) : null,
        closesAt: dto.closesAt ? new Date(dto.closesAt) : null,
        createdById: userId,
        problems: {
          create: problems.map((problem, index) => ({
            problemId: problem.id,
            position: index + 1,
            points: problem.points,
            difficulty: problem.difficulty,
          })),
        },
      },
    });

    this.logger.log(`Created baseline test ${test.id} (${test.name}) for ${dto.dayKey}`);
    return this.findById(test.id);
  }

  /**
   * Edit a test.
   *
   * Problems and audience are only editable while the test is a `DRAFT`. Once it is
   * published, students may already have seen the problem list and started attempts, and
   * silently swapping a question — or the audience — would invalidate results that have
   * already been earned rather than "fixing" the test. Duplicating it is the supported
   * route to a corrected version.
   */
  async update(id: string, dto: UpdateBaselineTestDto): Promise<BaselineTestSummary> {
    const existing = await this.prisma.baselineTest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Baseline test ${id} was not found`);

    const structural = dto.problems !== undefined || dto.campus !== undefined || dto.batch !== undefined;
    if (structural && existing.status !== 'DRAFT') {
      throw new BadRequestException(
        `"${existing.name}" has been published, so its problems and audience are frozen. ` +
          'Duplicate it to build a corrected version.',
      );
    }

    const scope =
      dto.campus !== undefined || dto.batch !== undefined
        ? await this.campuses.resolveScope({ campus: dto.campus, batch: dto.batch })
        : null;
    const problems = dto.problems ? await this.resolveProblems(dto.problems) : null;

    await this.prisma.$transaction(async (tx) => {
      if (problems) {
        await tx.baselineTestProblem.deleteMany({ where: { testId: id } });
        await tx.baselineTestProblem.createMany({
          data: problems.map((problem, index) => ({
            testId: id,
            problemId: problem.id,
            position: index + 1,
            points: problem.points,
            difficulty: problem.difficulty,
          })),
        });
      }

      await tx.baselineTest.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.dayKey !== undefined ? { dayKey: dto.dayKey } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.instructions !== undefined ? { instructions: dto.instructions } : {}),
          ...(dto.adminNotes !== undefined ? { adminNotes: dto.adminNotes } : {}),
          ...(dto.durationMinutes !== undefined ? { durationMinutes: dto.durationMinutes } : {}),
          ...(dto.opensAt !== undefined ? { opensAt: dto.opensAt ? new Date(dto.opensAt) : null } : {}),
          ...(dto.closesAt !== undefined ? { closesAt: dto.closesAt ? new Date(dto.closesAt) : null } : {}),
          ...(scope ? { campusId: scope.campusId, batchId: scope.batchId } : {}),
        },
      });
    });

    return this.findById(id);
  }

  /**
   * Copy a test into a new draft — the supported way to run "Baseline #4" from #3's shape.
   *
   * Attempts, results and review notes are deliberately not copied: they belong to the
   * sitting that produced them, and a duplicate that carried them would report last
   * week's results as this week's.
   */
  async duplicate(id: string, userId: string): Promise<BaselineTestSummary> {
    const source = await this.prisma.baselineTest.findUnique({
      where: { id },
      include: { problems: { orderBy: { position: 'asc' } } },
    });
    if (!source) throw new NotFoundException(`Baseline test ${id} was not found`);

    const copy = await this.prisma.baselineTest.create({
      data: {
        name: `${source.name} (copy)`,
        dayKey: this.time.today(),
        description: source.description,
        instructions: source.instructions,
        adminNotes: source.adminNotes,
        campusId: source.campusId,
        batchId: source.batchId,
        durationMinutes: source.durationMinutes,
        status: 'DRAFT',
        createdById: userId,
        problems: {
          create: source.problems.map((problem) => ({
            problemId: problem.problemId,
            position: problem.position,
            points: problem.points,
            difficulty: problem.difficulty,
          })),
        },
      },
    });
    return this.findById(copy.id);
  }

  /**
   * Move a test through its lifecycle, rejecting transitions that would lose data.
   *
   * `CLOSED → ACTIVE` is refused outright: reopening a test whose report has been read
   * and acted on lets new attempts land against numbers people have already used. The
   * supported move is to duplicate it and run a fresh sitting.
   */
  async setStatus(
    id: string,
    status: 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'CLOSED',
  ): Promise<BaselineTestSummary> {
    const test = await this.prisma.baselineTest.findUnique({
      where: { id },
      include: { _count: { select: { problems: true } } },
    });
    if (!test) throw new NotFoundException(`Baseline test ${id} was not found`);

    if (status !== 'DRAFT' && test._count.problems === 0) {
      throw new BadRequestException(
        `"${test.name}" has no problems yet. Add at least one before publishing it.`,
      );
    }
    if (test.status === 'CLOSED' && status === 'ACTIVE') {
      throw new BadRequestException(
        `"${test.name}" is closed and its report is final. Duplicate it to run another sitting.`,
      );
    }

    await this.prisma.baselineTest.update({ where: { id }, data: { status } });

    // Closing grades everything one last time, so a submission that landed after the last
    // sync but before the close time still counts. Not closing over it would penalise a
    // student for the sync cadence.
    if (status === 'CLOSED') await this.gradeTest(id);

    return this.findById(id);
  }

  async remove(id: string): Promise<void> {
    const test = await this.prisma.baselineTest.findUnique({
      where: { id },
      include: { _count: { select: { attempts: true } } },
    });
    if (!test) throw new NotFoundException(`Baseline test ${id} was not found`);
    if (test._count.attempts > 0) {
      throw new BadRequestException(
        `"${test.name}" has ${test._count.attempts} attempt(s) and cannot be deleted — ` +
          'those are results students earned. Close it instead.',
      );
    }
    await this.prisma.baselineTest.delete({ where: { id } });
  }

  // -------------------------------------------------------------------------
  // Admin: reading
  // -------------------------------------------------------------------------

  async findAll(
    query: BaselineTestQueryDto,
    viewerCampusIds: CampusScope = null,
  ): Promise<BaselineTestSummary[]> {
    const scope = await this.campuses.resolveScope({ campus: query.campus, batch: query.batch });

    const tests = await this.prisma.baselineTest.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.from || query.to
          ? {
              dayKey: {
                ...(query.from ? { gte: query.from } : {}),
                ...(query.to ? { lte: query.to } : {}),
              },
            }
          : {}),
        // Each of these is an independent OR-group, so they are combined under `AND`
        // rather than spread as sibling `OR` keys. Object spread would have the later
        // ones silently overwrite the earlier — the campus filter and the batch filter
        // could never both apply, and whichever came last would be the only one in force.
        AND: [
          // A campus filter shows what that campus was set, including the all-campus tests
          // that also applied to them — the same widening the resolver uses.
          ...(scope.campusId
            ? [{ OR: [{ campusId: scope.campusId }, { campusId: null }] }]
            : []),
          ...(scope.batchId ? [{ OR: [{ batchId: scope.batchId }, { batchId: null }] }] : []),
          // The viewer's own grants, on top of whatever they filtered by. A programme-wide
          // test (`campusId: null`) stays listed: it genuinely was set for their campus too,
          // and its rows are narrowed to their students rather than the test being hidden.
          ...(viewerCampusIds !== null
            ? [{ OR: [{ campusId: { in: viewerCampusIds } }, { campusId: null }] }]
            : []),
        ],
      },
      include: this.include(),
      orderBy: [{ dayKey: 'desc' }, { createdAt: 'desc' }],
    });

    const counts = await this.attemptCounts(tests.map((test) => test.id));
    const eligibility = await this.eligibleCounts(tests);
    return tests.map((test) => this.toSummary(test, counts, eligibility));
  }

  /**
   * The campus a baseline test belongs to, or `undefined` when there is no such test.
   *
   * `null` (targeted at the whole programme) and `undefined` (no such row) are kept
   * distinct because the authorization check treats them differently — see
   * `MentorScopeService.assertCampusAllowed`.
   */
  async findCampusOf(id: string): Promise<string | null | undefined> {
    const row = await this.prisma.baselineTest.findUnique({
      where: { id },
      select: { campusId: true },
    });
    return row === null ? undefined : row.campusId;
  }

  /** The campus an attempt was sat under, or `undefined` when there is no such attempt. */
  async findAttemptCampus(attemptId: string): Promise<string | null | undefined> {
    const row = await this.prisma.baselineTestAttempt.findUnique({
      where: { id: attemptId },
      select: { campusId: true },
    });
    return row === null ? undefined : row.campusId;
  }

  async findById(id: string): Promise<BaselineTestSummary> {
    const test = await this.prisma.baselineTest.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!test) throw new NotFoundException(`Baseline test ${id} was not found`);

    const counts = await this.attemptCounts([id]);
    const eligibility = await this.eligibleCounts([test]);
    return this.toSummary(test, counts, eligibility);
  }

  // -------------------------------------------------------------------------
  // Student-facing
  // -------------------------------------------------------------------------

  /**
   * The tests a student may see — theirs and only theirs.
   *
   * Eligibility is evaluated against the campus and batch on the student's own record,
   * read server-side. Nothing about the audience comes from the request, so there is no
   * campus parameter for a student to change (§22, §40). Drafts are excluded entirely: a
   * test nobody has published is not something a student should know exists.
   */
  async listForStudent(studentId: string): Promise<StudentBaselineTest[]> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, campusId: true, batchId: true },
    });
    if (!student) throw new NotFoundException('Student not found');

    const tests = await this.prisma.baselineTest.findMany({
      where: { status: { in: ['SCHEDULED', 'ACTIVE', 'CLOSED'] } },
      include: {
        problems: { include: { problem: true }, orderBy: { position: 'asc' } },
        attempts: {
          where: { studentId },
          include: { results: true },
        },
      },
      orderBy: [{ dayKey: 'desc' }],
    });

    const scope: AudienceScope = { campusId: student.campusId, batchId: student.batchId };
    const visible = tests.filter((test) =>
      scopeApplies({ campusId: test.campusId, batchId: test.batchId }, scope),
    );

    // The same any-time performance the mentor's board shows. Without it a student who
    // never opened a test sees nothing while their mentor sees 3/4 — two screens
    // disagreeing about that student's own score, which is worse than either being wrong.
    // One query covers every visible test rather than one per test.
    const allSlugs = [
      ...new Set(
        visible.flatMap((test) =>
          test.problems.map((problem) => problem.problem.titleSlug.toLowerCase()),
        ),
      ),
    ];
    const performance = (await this.generalPerformance(allSlugs, [studentId])).get(studentId) ?? [];
    const solvedSlugs = new Set(
      performance.filter((problem) => problem.solved).map((problem) => problem.titleSlug),
    );

    return visible.map((test) =>
      this.toStudentTest(
        test,
        test.attempts[0] ?? null,
        test.problems.filter((problem) =>
          solvedSlugs.has(problem.problem.titleSlug.toLowerCase()),
        ).length,
      ),
    );
  }

  async getForStudent(studentId: string, testId: string): Promise<StudentBaselineTest> {
    const tests = await this.listForStudent(studentId);
    const test = tests.find((candidate) => candidate.id === testId);
    // Not a 403: a student must not be able to distinguish "wrong id" from "another
    // campus's test", or this endpoint becomes a way to enumerate other campuses' tests.
    if (!test) throw new NotFoundException('Baseline test not found');
    return test;
  }

  /**
   * Begin — or resume — a student's attempt.
   *
   * Resuming rather than restarting is the point of the unique `(testId, studentId)` key:
   * a refreshed browser must not reset the clock, and `expiresAt` is written once at the
   * first start so a later change to the test's duration cannot retroactively shorten or
   * extend an attempt already under way.
   */
  async startAttempt(studentId: string, testId: string): Promise<StudentBaselineTest> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, campusId: true, batchId: true },
    });
    if (!student) throw new NotFoundException('Student not found');

    const test = await this.prisma.baselineTest.findUnique({
      where: { id: testId },
      include: { problems: true },
    });
    if (
      !test ||
      !scopeApplies(
        { campusId: test.campusId, batchId: test.batchId },
        { campusId: student.campusId, batchId: student.batchId },
      )
    ) {
      throw new NotFoundException('Baseline test not found');
    }

    const now = new Date();
    const existing = await this.prisma.baselineTestAttempt.findUnique({
      where: { testId_studentId: { testId, studentId } },
    });
    if (existing) return this.getForStudent(studentId, testId);

    if (!isTestOpen({ status: test.status, opensAt: test.opensAt, closesAt: test.closesAt }, now)) {
      throw new ForbiddenException(
        test.status === 'CLOSED'
          ? 'This test has closed.'
          : 'This test is not open yet.',
      );
    }

    await this.prisma.baselineTestAttempt.create({
      data: {
        testId,
        studentId,
        // Frozen audience context, exactly like `DailyStatus`: the report for a past test
        // keeps grouping this student under the campus and batch they sat it in (§17).
        campusId: student.campusId,
        batchId: student.batchId,
        startedAt: now,
        expiresAt: attemptExpiry(now, test.durationMinutes, test.closesAt),
        maxScore: test.problems.reduce((total, problem) => total + problem.points, 0),
      },
    });

    return this.getForStudent(studentId, testId);
  }

  /**
   * Hand in an attempt.
   *
   * Grades before marking it submitted, so the recorded result reflects everything the
   * student had accepted at the moment they finished — including a submission that
   * landed since the last sync.
   */
  async submitAttempt(studentId: string, testId: string): Promise<StudentBaselineTest> {
    const attempt = await this.prisma.baselineTestAttempt.findUnique({
      where: { testId_studentId: { testId, studentId } },
    });
    if (!attempt) throw new NotFoundException('You have not started this test.');
    if (attempt.status === 'SUBMITTED') return this.getForStudent(studentId, testId);

    await this.gradeAttemptById(attempt.id);
    await this.prisma.baselineTestAttempt.update({
      where: { id: attempt.id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });

    return this.getForStudent(studentId, testId);
  }

  // -------------------------------------------------------------------------
  // Grading
  // -------------------------------------------------------------------------

  /** Re-grade every attempt on a test from the submission mirror. */
  async gradeTest(testId: string): Promise<{ graded: number }> {
    const attempts = await this.prisma.baselineTestAttempt.findMany({
      where: { testId },
      select: { id: true },
    });
    for (const attempt of attempts) await this.gradeAttemptById(attempt.id);
    return { graded: attempts.length };
  }

  /**
   * Grade one attempt from the submissions inside its window.
   *
   * The window is `[startedAt, min(expiresAt, submittedAt, now)]`. Submissions outside it
   * do not count towards the score — but an accepted submission from *before* the test
   * opened is still looked for, because "already solved this" is exactly the signal a
   * baseline is trying to surface, and silently ignoring it would hide it.
   */
  private async gradeAttemptById(attemptId: string): Promise<void> {
    const attempt = await this.prisma.baselineTestAttempt.findUnique({
      where: { id: attemptId },
      include: {
        test: { include: { problems: { include: { problem: true }, orderBy: { position: 'asc' } } } },
      },
    });
    if (!attempt) return;

    const windowStart = attempt.startedAt;
    const windowEnd = this.attemptWindowEnd(attempt);
    const slugs = attempt.test.problems.map((problem) => problem.problem.titleSlug);

    // Two reads, both indexed: everything inside the window, and whether any of these
    // problems was already accepted before the test opened.
    const [inWindow, priorAccepted] = await Promise.all([
      this.prisma.submission.findMany({
        where: {
          studentId: attempt.studentId,
          titleSlug: { in: slugs },
          submittedAt: { gte: windowStart, lte: windowEnd },
        },
        orderBy: { submittedAt: 'asc' },
      }),
      this.prisma.submission.findMany({
        where: {
          studentId: attempt.studentId,
          titleSlug: { in: slugs },
          status: 'ACCEPTED',
          submittedAt: { lt: attempt.test.opensAt ?? windowStart },
        },
        select: { titleSlug: true },
      }),
    ]);

    const preSolvedSlugs = new Set(priorAccepted.map((row) => row.titleSlug));
    const outcomes: BaselineProblemOutcome[] = [];
    const resultRows: Prisma.BaselineTestProblemResultCreateManyInput[] = [];

    for (const testProblem of attempt.test.problems) {
      const slug = testProblem.problem.titleSlug;
      const mine = inWindow.filter((submission) => submission.titleSlug === slug);
      const accepted = mine.find((submission) => submission.status === 'ACCEPTED') ?? null;
      const first = mine[0] ?? null;

      const timeToSolveSeconds = accepted
        ? Math.max(
            0,
            Math.round((accepted.submittedAt.getTime() - windowStart.getTime()) / 1000),
          )
        : null;

      const status: ProblemStatus = accepted
        ? 'ACCEPTED'
        : mine.length > 0
          ? 'ATTEMPTED_NOT_ACCEPTED'
          : 'NOT_ATTEMPTED';

      outcomes.push({
        testProblemId: testProblem.id,
        problemId: testProblem.problemId,
        points: testProblem.points,
        accepted: accepted !== null,
        attempts: mine.length,
        timeToSolveSeconds,
        solvedBeforeTest: preSolvedSlugs.has(slug),
      });

      resultRows.push({
        attemptId: attempt.id,
        testProblemId: testProblem.id,
        problemId: testProblem.problemId,
        status,
        attempts: mine.length,
        points: accepted ? testProblem.points : 0,
        firstSubmissionAt: first?.submittedAt ?? null,
        solvedAt: accepted?.submittedAt ?? null,
        timeToSolveSeconds,
        language: accepted?.language ?? first?.language ?? null,
      });
    }

    const grade = gradeAttempt(outcomes);
    const risk = assessRisk({
      outcomes,
      medianHistoricalSolveSeconds: await this.medianHistoricalPace(attempt.studentId),
    });

    const lastSolvedAt = resultRows
      .map((row) => row.solvedAt)
      .filter((date): date is Date => date instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    await this.prisma.$transaction([
      this.prisma.baselineTestProblemResult.deleteMany({ where: { attemptId: attempt.id } }),
      this.prisma.baselineTestProblemResult.createMany({ data: resultRows }),
      this.prisma.baselineTestAttempt.update({
        where: { id: attempt.id },
        data: {
          solvedCount: grade.solvedCount,
          attemptedCount: grade.attemptedCount,
          score: grade.score,
          maxScore: grade.maxScore,
          timeTakenSeconds: lastSolvedAt
            ? Math.max(0, Math.round((lastSolvedAt.getTime() - windowStart.getTime()) / 1000))
            : null,
          riskFlags: risk.signals,
          riskScore: risk.score,
          // Only ever *raises* the flag. A mentor who has already reviewed an attempt is
          // not sent back to it by a re-grade, and a human's `REVIEWED` is never undone
          // by a machine (§23).
          ...(risk.reviewRecommended && attempt.reviewStatus === 'NOT_REVIEWED'
            ? { reviewStatus: 'REVIEW_REQUIRED' as const }
            : {}),
          // An attempt whose window has passed without a hand-in is `EXPIRED`, not
          // `SUBMITTED` — the two mean different things to a mentor reading the report.
          ...(attempt.status === 'IN_PROGRESS' && windowEnd.getTime() <= Date.now()
            ? { status: 'EXPIRED' as const }
            : {}),
          gradedAt: new Date(),
        },
      }),
    ]);
  }

  private attemptWindowEnd(attempt: {
    submittedAt: Date | null;
    expiresAt: Date | null;
  }): Date {
    const candidates = [attempt.submittedAt, attempt.expiresAt, new Date()].filter(
      (date): date is Date => date instanceof Date,
    );
    return new Date(Math.min(...candidates.map((date) => date.getTime())));
  }

  /**
   * This student's own median seconds-to-solve on recent daily assignments.
   *
   * The comparison baseline for `INCONSISTENT_WITH_HISTORY`. Returns null when there is
   * not enough history, which makes the signal *not fire* rather than fire on an
   * assumption — a student with no track record has not done anything inconsistent.
   */
  private async medianHistoricalPace(studentId: string): Promise<number | null> {
    const from = this.time.addDays(this.time.today(), -HISTORY_LOOKBACK_DAYS);
    const rows = await this.prisma.dailyStatus.findMany({
      where: { studentId, dayKey: { gte: from }, firstSolvedAt: { not: null } },
      select: { firstSolvedAt: true, lastSolvedAt: true },
    });

    const spans = rows
      .filter((row) => row.firstSolvedAt && row.lastSolvedAt)
      .map((row) =>
        Math.round((row.lastSolvedAt!.getTime() - row.firstSolvedAt!.getTime()) / 1000),
      )
      .filter((seconds) => seconds > 0)
      .sort((a, b) => a - b);

    if (spans.length < 3) return null;
    return spans[Math.floor(spans.length / 2)] ?? null;
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  /**
   * The full report for one test (§24).
   *
   * "Not started" is derived from the eligible roster minus the attempts, not stored:
   * a student who never opened the test has no attempt row, and manufacturing one would
   * make "started" meaningless.
   */
  async report(testId: string, viewerCampusIds: CampusScope = null): Promise<BaselineTestReport> {
    const test = await this.prisma.baselineTest.findUnique({
      where: { id: testId },
      include: this.include(),
    });
    if (!test) throw new NotFoundException(`Baseline test ${testId} was not found`);

    const eligible = await this.eligibleStudents(test, viewerCampusIds);
    const attempts = await this.prisma.baselineTestAttempt.findMany({
      where: { testId },
      include: {
        student: { select: { id: true, name: true, email: true, squad: { select: { name: true } } } },
        campus: { select: { name: true } },
        batch: { select: { name: true } },
        reviewedBy: { select: { name: true } },
        results: true,
      },
    });

    // The same mirror-derived performance the board uses, so the report's headline figures
    // and its leaderboard can never tell a mentor two different stories.
    const performanceByStudent = await this.generalPerformance(
      test.problems.map((problem) => problem.problem.titleSlug.toLowerCase()),
      eligible.map((student) => student.id),
    );

    const summaries = attempts.map((attempt) => this.toAttemptSummary(attempt, test));
    const scored = summaries.filter((attempt) => attempt.status !== 'NOT_STARTED');
    const completed = summaries.filter((attempt) => attempt.status === 'SUBMITTED').length;

    // Score, median and time describe *the sitting*, so they come from the attempts and are
    // empty when nobody sat it — which is the honest answer to "how did the test go".
    const scores = scored.map((attempt) => attempt.score).sort((a, b) => a - b);
    const times = scored
      .map((attempt) => attempt.timeTakenSeconds)
      .filter((seconds): seconds is number => seconds !== null);

    // `averagePercent` is the headline "how is the cohort doing" figure and sits beside
    // solvedAll / attemptedNotSolved / notAttempted, all of which are performance-based —
    // so it is too, and it is computed exactly as the leaderboard computes it. Leaving it
    // attempt-based would put two different averages for one test on one screen.
    const measured = [...performanceByStudent.values()];
    const performancePercents = measured.map((performance) =>
      baselinePercent(countSolved(performance), test.problems.length),
    );

    const maxScore = test.problems.reduce((total, problem) => total + problem.points, 0);

    return {
      test: this.toSummary(
        test,
        await this.attemptCounts([testId]),
        new Map([[testId, eligible.length]]),
      ),
      totalEligible: eligible.length,
      started: scored.length,
      completed,
      notStarted: Math.max(0, eligible.length - scored.length),
      averageScore: average(scores),
      medianScore: median(scores),
      // Rounded exactly as the leaderboard rounds it. "Almost the same number" on two
      // views of one test is still two numbers to reconcile.
      averagePercent:
        performancePercents.length > 0 ? Math.round(average(performancePercents)) : 0,
      averageTimeTakenSeconds: times.length > 0 ? Math.round(average(times)) : null,
      // Ability across the whole eligible cohort, from the mirror — not "of those who sat
      // it". A student who solved all four last month counts here whether or not they
      // opened the test.
      solvedAll: [...performanceByStudent.values()].filter(
        (performance) =>
          test.problems.length > 0 && countSolved(performance) === test.problems.length,
      ).length,
      // "Tried and got nowhere" and "never opened it" are kept apart here for the same
      // reason they are in the daily tracker: they are different conversations, and the
      // students in the first group are usually the ones who most need one.
      attemptedNotSolved: [...performanceByStudent.values()].filter(
        (performance) =>
          countSolved(performance) === 0 &&
          performance.some((problem) => problem.attempts > 0),
      ).length,
      // Never touched any of these problems, ever — distinct from "sat the test and got
      // nowhere", which is `attemptedNotSolved` above.
      notAttempted: [...performanceByStudent.values()].filter((performance) =>
        performance.every((problem) => problem.attempts === 0),
      ).length,
      problems: this.problemStats(test, summaries, performanceByStudent, eligible.length),
      campusBreakdown: this.breakdown(
        summaries,
        eligible,
        (attempt) => attempt.campusId,
        (student) => student.campusId,
        (attempt) => attempt.campusName,
        (student) => student.campusName,
        maxScore,
      ),
      batchBreakdown: this.breakdown(
        summaries,
        eligible,
        (attempt) => attempt.batchId,
        (student) => student.batchId,
        (attempt) => attempt.batchName,
        (student) => student.batchName,
        maxScore,
      ),
      // Mentor-only, and ordered by signal strength so the strongest evidence is read
      // first. Never included in any student-facing projection.
      reviewQueue: summaries
        .filter((attempt) => attempt.riskFlags.length > 0)
        .sort((a, b) => b.riskScore - a.riskScore),
    };
  }

  /**
   * Every eligible student's standing against the test's problems, from their whole
   * submission history.
   *
   * **No time filter is applied here, deliberately.** Not the attempt window, not the
   * test's open/close times, not the program day. This is the query whose absence made an
   * entire cohort read 0/4: performance was being derived from `BaselineTestAttempt` rows,
   * which only exist once a student clicks Start in the portal — so a cohort that never
   * opened the test scored zero on problems many of them had solved weeks earlier.
   *
   * One query for the whole roster rather than one per student: at 250 students × 20
   * problems a per-student loop is 250 round trips for data a single indexed scan returns.
   */
  private async generalPerformance(
    titleSlugs: string[],
    studentIds: string[],
  ): Promise<Map<string, BaselineProblemPerformance[]>> {
    const performance = new Map<string, BaselineProblemPerformance[]>();
    if (studentIds.length === 0 || titleSlugs.length === 0) return performance;

    const rows = await this.prisma.submission.findMany({
      where: {
        studentId: { in: studentIds },
        // Slugs are stored lowercase by the sync; compared lowercase by the rule.
        titleSlug: { in: titleSlugs },
      },
      select: { studentId: true, titleSlug: true, status: true, submittedAt: true },
    });

    const byStudent = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byStudent.get(row.studentId) ?? [];
      list.push(row);
      byStudent.set(row.studentId, list);
    }

    for (const studentId of studentIds) {
      performance.set(
        studentId,
        computeGeneralPerformance(titleSlugs, byStudent.get(studentId) ?? []),
      );
    }
    return performance;
  }

  /**
   * Sync state per student, so a zero can be read in context.
   *
   * A student whose sync has never succeeded has *unmeasured* performance, not zero
   * performance. Rendering the two identically is the false zero the sync design exists to
   * prevent, and it reaches this board the same way it reaches the daily one.
   */
  private async syncStateByStudent(
    studentIds: string[],
  ): Promise<
    Map<string, { status: SyncStatus | null; lastSuccessAt: Date | null; hasSubmissions: boolean }>
  > {
    const states = new Map<
      string,
      { status: SyncStatus | null; lastSuccessAt: Date | null; hasSubmissions: boolean }
    >();
    if (studentIds.length === 0) return states;

    // Submission presence is queried alongside, because it is independent evidence that a
    // read once succeeded — see `isPerformanceKnown`. Grouped, so it stays one round trip
    // for the whole roster.
    const [rows, withSubmissions] = await Promise.all([
      this.prisma.studentSyncState.findMany({
        where: { studentId: { in: studentIds } },
        select: { studentId: true, status: true, lastSuccessAt: true },
      }),
      this.prisma.submission.groupBy({
        by: ['studentId'],
        where: { studentId: { in: studentIds } },
        _count: { _all: true },
      }),
    ]);

    const mirrored = new Set(withSubmissions.map((row) => row.studentId));
    for (const studentId of studentIds) {
      const state = rows.find((row) => row.studentId === studentId);
      states.set(studentId, {
        status: (state?.status as SyncStatus | undefined) ?? null,
        lastSuccessAt: state?.lastSuccessAt ?? null,
        hasSubmissions: mirrored.has(studentId),
      });
    }
    return states;
  }

  /**
   * The student-wise leaderboard for one baseline test.
   *
   * Computed on read rather than materialised. A baseline is graded once and then barely
   * changes, so there is nothing to gain from a stored board — and a stored one would have
   * to be invalidated by every re-grade, which is exactly the kind of staleness that makes
   * two screens disagree about a student's score.
   *
   * Built from the *eligible roster* rather than from the attempt rows, so a student who
   * never opened the test still has a line. Omitting them shrinks the denominator and
   * makes a test half the cohort skipped look like a test everybody took.
   *
   * Filtering and sorting happen after ranking, deliberately: a mentor filtering to one
   * squad wants to see that squad's members with their standing *in the cohort*, not
   * renumbered 1..n within the filter. Rank means "how many students did better", and it
   * must not change because someone typed in a search box.
   */
  async leaderboard(
    testId: string,
    query: {
      search?: string;
      squad?: string;
      campusId?: string;
      batchId?: string;
      status?: BaselineAttemptStatus | 'ALL';
      sort?: 'rank' | 'name' | 'squad' | 'solved' | 'percent';
      direction?: 'asc' | 'desc';
    } = {},
    viewerCampusIds: CampusScope = null,
  ): Promise<BaselineLeaderboard> {
    const test = await this.prisma.baselineTest.findUnique({
      where: { id: testId },
      include: this.include(),
    });
    if (!test) throw new NotFoundException(`Baseline test ${testId} was not found`);

    const [eligible, attempts] = await Promise.all([
      this.eligibleStudents(test, viewerCampusIds),
      this.prisma.baselineTestAttempt.findMany({
        where: { testId },
        include: {
          student: { select: { id: true, name: true, email: true, squad: { select: { name: true } } } },
          campus: { select: { name: true } },
          batch: { select: { name: true } },
          results: { select: { status: true } },
        },
      }),
    ]);

    const totalQuestions = test.problems.length;
    const maxScore = test.problems.reduce((total, problem) => total + problem.points, 0);
    const attemptByStudent = new Map(attempts.map((attempt) => [attempt.studentId, attempt]));

    // Performance comes from the submission mirror, not from the attempt rows. This is the
    // fix: with no attempts at all — which is the normal state of a test nobody opened in
    // the portal — the old code reported the entire cohort as 0 solved, on problems the
    // mirror held dozens of accepted solutions for.
    const studentIds = eligible.map((student) => student.id);
    const slugs = test.problems.map((problem) => problem.problem.titleSlug.toLowerCase());
    const [performanceByStudent, syncByStudent] = await Promise.all([
      this.generalPerformance(slugs, studentIds),
      this.syncStateByStudent(studentIds),
    ]);

    // One entry per eligible student. An attempt belonging to a student who has since left
    // the roster is intentionally not resurrected here — the board describes the cohort as
    // it stands, and `report()` is where historical attempt counts live.
    const entries = eligible.map((student) => {
      const attempt = attemptByStudent.get(student.id);
      const performance = performanceByStudent.get(student.id) ?? [];
      const sync = syncByStudent.get(student.id) ?? {
        status: null,
        lastSuccessAt: null,
        hasSubmissions: false,
      };

      // The headline number: distinct problems from this set the student has solved at any
      // time. Independent of whether they sat the test.
      const solvedCount = countSolved(performance);
      // What the test itself measured — solved inside their own attempt window. Zero for
      // anyone who never sat it, which is correct and is a different fact.
      const inWindowSolvedCount = attempt?.solvedCount ?? 0;
      const score = attempt?.score ?? 0;

      return {
        studentId: student.id,
        studentName: student.name,
        studentEmail: student.email,
        // Preferring the attempt's frozen campus/batch keeps a past test grouping the
        // student under where they sat it, not where they are now (§17).
        squadName: attempt?.student.squad?.name ?? student.squadName,
        campusName: attempt?.campus?.name ?? student.campusName,
        batchName: attempt?.batch?.name ?? student.batchName,
        totalQuestions,
        solvedCount,
        notSolvedCount: Math.max(0, totalQuestions - solvedCount),
        inWindowSolvedCount,
        // Problems touched without an accepted answer, from the whole history.
        attemptedCount: performance.filter((problem) => !problem.solved && problem.attempts > 0)
          .length,
        score,
        maxScore: attempt?.maxScore || maxScore,
        // Questions solved, not points earned. The three columns either side of this one
        // are counts — total, solved, not solved — so a reader works out 3 of 4 and
        // expects 75%. Weighting by difficulty made the same row say 67%, disagreeing with
        // itself. The weighted figure is still carried as `score`/`maxScore` for the
        // mentor report, which is where difficulty is the point.
        percent: baselinePercent(solvedCount, totalQuestions),
        timeTakenSeconds: attempt?.timeTakenSeconds ?? null,
        submittedAt: attempt?.submittedAt?.toISOString() ?? null,
        status: (attempt?.status ?? 'NOT_STARTED') as BaselineAttemptStatus,
        attempted: attempt !== undefined,
        syncStatus: sync.status,
        lastSuccessfulSyncAt: sync.lastSuccessAt?.toISOString() ?? null,
        // A student we have never successfully read has unmeasured performance, not zero
        // performance. The UI renders the two differently for exactly this reason.
        performanceKnown: isPerformanceKnown({
          syncStatus: sync.status,
          lastSuccessAt: sync.lastSuccessAt,
          hasSubmissions: sync.hasSubmissions,
        }),
      };
    });

    const ranked = rankBaselineEntries(entries).map(
      (row): BaselineLeaderboardRow => ({ rank: row.rank, isTied: row.isTied, ...row.entry }),
    );

    // Summary statistics describe the whole cohort and are computed before filtering — a
    // squad filter narrows who is listed, not what the test's average was.
    //
    // Participation and performance are summarised separately, because they answer
    // different questions and a reader needs both: "35 started, 25 finished, 64 absent"
    // beside "12 students can solve all four".
    const sat = ranked.filter((row) => row.attempted);
    const measured = ranked.filter((row) => row.performanceKnown);
    const percents = measured.map((row) => row.percent);

    // Index n holds the number of students who solved exactly n problems.
    const performanceDistribution = Array.from({ length: totalQuestions + 1 }, () => 0);
    for (const row of measured) {
      const index = Math.min(row.solvedCount, totalQuestions);
      performanceDistribution[index] = (performanceDistribution[index] ?? 0) + 1;
    }

    const filtered = this.filterLeaderboard(ranked, query);

    return {
      testId: test.id,
      testTitle: test.name,
      dayKey: test.dayKey,
      totalQuestions,
      maxScore,
      totalStudents: ranked.length,
      attemptedStudents: sat.length,
      notStartedStudents: ranked.length - sat.length,
      // Averaged over students we actually hold data for. An unmeasured student is not a
      // zero in the average — they are not a measurement at all.
      averagePercent:
        percents.length > 0
          ? Math.round(percents.reduce((total, p) => total + p, 0) / percents.length)
          : 0,
      highestPercent: percents.length > 0 ? Math.max(...percents) : 0,
      lowestPercent: percents.length > 0 ? Math.min(...percents) : 0,
      performanceDistribution,
      performanceUnknownStudents: ranked.length - measured.length,
      rows: filtered,
    };
  }

  /** Search, scope and sort — applied after ranking so `rank` keeps its cohort meaning. */
  private filterLeaderboard(
    rows: BaselineLeaderboardRow[],
    query: {
      search?: string;
      squad?: string;
      campusId?: string;
      batchId?: string;
      status?: BaselineAttemptStatus | 'ALL';
      sort?: 'rank' | 'name' | 'squad' | 'solved' | 'percent';
      direction?: 'asc' | 'desc';
    },
  ): BaselineLeaderboardRow[] {
    let result = rows;

    const search = query.search?.trim().toLowerCase();
    if (search) {
      result = result.filter(
        (row) =>
          row.studentName.toLowerCase().includes(search) ||
          (row.studentEmail?.toLowerCase().includes(search) ?? false) ||
          (row.squadName?.toLowerCase().includes(search) ?? false),
      );
    }

    if (query.squad) {
      const squad = query.squad.toLowerCase();
      result = result.filter((row) => row.squadName?.toLowerCase() === squad);
    }
    if (query.status && query.status !== 'ALL') {
      result = result.filter((row) => row.status === query.status);
    }

    const sort = query.sort ?? 'rank';
    // Rank already encodes the meaningful ordering, so ascending rank is the natural
    // default; the other columns each get the direction a reader expects when they click
    // it once (best first for numbers, A–Z for text).
    const direction =
      query.direction ?? (sort === 'name' || sort === 'squad' ? 'asc' : sort === 'rank' ? 'asc' : 'desc');
    const sign = direction === 'asc' ? 1 : -1;

    const compare = (a: BaselineLeaderboardRow, b: BaselineLeaderboardRow): number => {
      switch (sort) {
        case 'name':
          return sign * a.studentName.localeCompare(b.studentName);
        case 'squad':
          return sign * (a.squadName ?? '').localeCompare(b.squadName ?? '');
        case 'solved':
          return sign * (a.solvedCount - b.solvedCount);
        case 'percent':
          return sign * (a.percent - b.percent);
        default:
          return sign * (a.rank - b.rank);
      }
    };

    // Rank is the tiebreak for every other column, so equal values stay in board order
    // rather than in whatever order the database happened to return them.
    return [...result].sort((a, b) => compare(a, b) || a.rank - b.rank);
  }

  /**
   * One student's result on one test, with the per-question breakdown.
   *
   * `rank` is resolved from the same board `leaderboard()` builds rather than recomputed
   * locally, so the number here and the number in the table can never disagree.
   */
  async studentResult(
    testId: string,
    studentId: string,
    viewerCampusIds: CampusScope = null,
  ): Promise<BaselineStudentResult> {
    const test = await this.prisma.baselineTest.findUnique({
      where: { id: testId },
      include: this.include(),
    });
    if (!test) throw new NotFoundException(`Baseline test ${testId} was not found`);

    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        name: true,
        email: true,
        campusId: true,
        squad: { select: { name: true } },
        campus: { select: { name: true } },
        batch: { select: { name: true } },
      },
    });
    // "Not yours" is answered identically to "does not exist", so a mentor cannot walk
    // student ids to learn who is enrolled at another campus. A student with no campus
    // matches no mentor's grants, which is the safe direction for the one group nobody
    // is accountable for.
    const outsideViewerScope =
      viewerCampusIds !== null &&
      (student === null ||
        student.campusId === null ||
        !viewerCampusIds.includes(student.campusId));
    if (!student || outsideViewerScope) {
      throw new NotFoundException(`Student ${studentId} was not found`);
    }

    const attempt = await this.prisma.baselineTestAttempt.findUnique({
      where: { testId_studentId: { testId, studentId } },
      include: {
        student: { select: { id: true, name: true, email: true, squad: { select: { name: true } } } },
        campus: { select: { name: true } },
        batch: { select: { name: true } },
        reviewedBy: { select: { name: true } },
        results: true,
      },
    });

    const board = await this.leaderboard(testId);
    const row = board.rows.find((candidate) => candidate.studentId === studentId) ?? null;

    const totalQuestions = test.problems.length;
    const maxScore = test.problems.reduce((total, problem) => total + problem.points, 0);

    // The same source as the board: the whole submission history, no window.
    const slugs = test.problems.map((problem) => problem.problem.titleSlug.toLowerCase());
    const [performanceMap, syncMap] = await Promise.all([
      this.generalPerformance(slugs, [studentId]),
      this.syncStateByStudent([studentId]),
    ]);
    const performance = performanceMap.get(studentId) ?? [];
    const sync = syncMap.get(studentId) ?? {
      status: null,
      lastSuccessAt: null,
      hasSubmissions: false,
    };
    const performanceBySlug = new Map(performance.map((problem) => [problem.titleSlug, problem]));

    const solvedCount = countSolved(performance);

    // In-window results, when the student actually sat the test. Used only to enrich a
    // problem line with what happened during the attempt — never to decide `solved`.
    const inWindowByProblem = new Map(
      attempt ? this.toAttemptSummary(attempt, test).results.map((r) => [r.testProblemId, r]) : [],
    );

    const problems: BaselineAttemptProblemResult[] = test.problems.map((problem) => {
      const solvedAnyTime = performanceBySlug.get(problem.problem.titleSlug.toLowerCase());
      const inWindow = inWindowByProblem.get(problem.id);
      const solved = solvedAnyTime?.solved ?? false;

      return {
        testProblemId: problem.id,
        problemId: problem.problemId,
        position: problem.position,
        title: problem.problem.title,
        difficulty: problem.difficulty as BaselineAttemptProblemResult['difficulty'],
        points: problem.points,
        // Points follow the same evidence the ✓ does, so a solved problem never shows as
        // solved while contributing nothing.
        awardedPoints: solved ? problem.points : 0,
        // "Tried and never got it" stays distinct from "never touched it": they are
        // different conversations, and collapsing them loses the students who need one.
        status: (solved
          ? 'ACCEPTED'
          : (solvedAnyTime?.attempts ?? 0) > 0
            ? 'ATTEMPTED_NOT_ACCEPTED'
            : 'NOT_ATTEMPTED') as BaselineAttemptProblemResult['status'],
        attempts: solvedAnyTime?.attempts ?? 0,
        solvedAt: solvedAnyTime?.firstAcceptedAt?.toISOString() ?? null,
        firstAcceptedAt: solvedAnyTime?.firstAcceptedAt?.toISOString() ?? null,
        latestAcceptedAt: solvedAnyTime?.latestAcceptedAt?.toISOString() ?? null,
        // Only meaningful for a problem solved during the attempt itself.
        timeToSolveSeconds: inWindow?.timeToSolveSeconds ?? null,
      };
    });

    return {
      testId: test.id,
      testTitle: test.name,
      dayKey: test.dayKey,
      studentId: student.id,
      studentName: student.name,
      studentEmail: student.email,
      squadName: student.squad?.name ?? null,
      campusName: attempt?.campus?.name ?? student.campus?.name ?? null,
      batchName: attempt?.batch?.name ?? student.batch?.name ?? null,
      rank: row?.rank ?? null,
      totalQuestions,
      solvedCount,
      notSolvedCount: Math.max(0, totalQuestions - solvedCount),
      attemptedCount: performance.filter((problem) => !problem.solved && problem.attempts > 0)
        .length,
      score: attempt?.score ?? 0,
      maxScore: attempt?.maxScore || maxScore,
      // Same definition as the leaderboard row, so the detail view and the board it was
      // opened from cannot disagree about a student's score.
      percent: baselinePercent(solvedCount, totalQuestions),
      timeTakenSeconds: attempt?.timeTakenSeconds ?? null,
      startedAt: attempt?.startedAt?.toISOString() ?? null,
      submittedAt: attempt?.submittedAt?.toISOString() ?? null,
      status: (attempt?.status ?? 'NOT_STARTED') as BaselineAttemptStatus,
      attempted: attempt !== null,
      inWindowSolvedCount: attempt?.solvedCount ?? 0,
      syncStatus: sync.status,
      lastSuccessfulSyncAt: sync.lastSuccessAt?.toISOString() ?? null,
      performanceKnown: isPerformanceKnown({
        syncStatus: sync.status,
        lastSuccessAt: sync.lastSuccessAt,
        hasSubmissions: sync.hasSubmissions,
      }),
      problems,
    };
  }

  /** Every attempt on a test, for the mentor-facing results table. */
  async attempts(
    testId: string,
    viewerCampusIds: CampusScope = null,
  ): Promise<BaselineAttemptSummary[]> {
    const test = await this.prisma.baselineTest.findUnique({
      where: { id: testId },
      include: this.include(),
    });
    if (!test) throw new NotFoundException(`Baseline test ${testId} was not found`);

    const rows = await this.prisma.baselineTestAttempt.findMany({
      where: { testId },
      include: {
        student: { select: { id: true, name: true, email: true, squad: { select: { name: true } } } },
        campus: { select: { name: true } },
        batch: { select: { name: true } },
        reviewedBy: { select: { name: true } },
        results: true,
      },
      orderBy: [{ score: 'desc' }, { timeTakenSeconds: 'asc' }],
    });
    // Attempts carry the campus the student sat under, frozen on the row, so this filters
    // on what was true at the time rather than on where the student is now.
    const visible =
      viewerCampusIds === null
        ? rows
        : rows.filter(
            (attempt) => attempt.campusId !== null && viewerCampusIds.includes(attempt.campusId),
          );
    return visible.map((attempt) => this.toAttemptSummary(attempt, test));
  }

  /**
   * Record a mentor's conclusion on a flagged attempt.
   *
   * `REVIEWED` is only ever set here, by a person, with their note attached. The system
   * raises `REVIEW_REQUIRED`; it never clears it on its own and never records a verdict
   * about the student (§23).
   */
  async review(
    attemptId: string,
    dto: ReviewAttemptDto,
    user: { id: string; name: string },
  ): Promise<BaselineAttemptSummary> {
    const attempt = await this.prisma.baselineTestAttempt.findUnique({
      where: { id: attemptId },
      select: { id: true, testId: true },
    });
    if (!attempt) throw new NotFoundException(`Attempt ${attemptId} was not found`);

    await this.prisma.baselineTestAttempt.update({
      where: { id: attemptId },
      data: {
        reviewStatus: dto.reviewStatus,
        reviewNote: dto.note?.trim() || null,
        reviewedById: user.id,
        reviewedAt: new Date(),
      },
    });

    const all = await this.attempts(attempt.testId);
    const updated = all.find((row) => row.id === attemptId);
    if (!updated) throw new NotFoundException(`Attempt ${attemptId} was not found`);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The active students a test applies to, resolved against **current** campus and batch.
   *
   * Current rather than historical, deliberately: eligibility answers "who should sit
   * this", which is a question about now. Where a student *was* matters for the frozen
   * `campusId`/`batchId` on their attempt, which is what the report groups by.
   */
  private async eligibleStudents(
    test: {
      campusId: string | null;
      batchId: string | null;
    },
    /**
     * The campuses the *viewer* may read, or `null` for an admin.
     *
     * Intersected with the test's own audience rather than replacing it. The two are
     * different questions — "who sat this test" and "whose results may you see" — and a
     * programme-wide test (`campusId: null`) is exactly where they diverge: its audience
     * is everyone, so without this a mentor opening it would get every campus's students
     * on the leaderboard. Narrowing the *rows* rather than hiding the test is the right
     * shape, because the test genuinely does apply to their campus too.
     */
    viewerCampusIds: CampusScope = null,
  ): Promise<EligibleStudent[]> {
    // Names come along for the ride so a group with *no attempts yet* can still be
    // labelled. Reading the name off the attempts alone made "0 of 92 started" render as
    // "Unassigned — 0 of 92", which is the single most useful line in the report and the
    // one most likely to be read before anyone has sat the test.
    const rows = await this.prisma.student.findMany({
      where: {
        status: 'ACTIVE',
        ...(test.campusId ? { campusId: test.campusId } : {}),
        ...(test.batchId ? { batchId: test.batchId } : {}),
        // `[]` is a mentor with no grants and must match nobody. Prisma's `in: []` does
        // exactly that, which is the safe direction — the dangerous one would be treating
        // an empty list as "no filter".
        ...(viewerCampusIds !== null ? { campusId: { in: viewerCampusIds } } : {}),
      },
      select: {
        id: true,
        // Name, email and squad ride along for the leaderboard, which has to render a row
        // for a student who never opened the test and so has no attempt to read them from.
        name: true,
        email: true,
        campusId: true,
        batchId: true,
        squad: { select: { name: true } },
        campus: { select: { name: true } },
        batch: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      squadName: row.squad?.name ?? null,
      campusId: row.campusId,
      batchId: row.batchId,
      campusName: row.campus?.name ?? null,
      batchName: row.batch?.name ?? null,
    }));
  }

  /**
   * Eligible headcount per test, in one grouped query rather than one per test.
   *
   * A per-test count would be an N+1 on the list page, and the list page is the first
   * thing an admin opens (§27).
   */
  private async eligibleCounts(
    tests: { id: string; campusId: string | null; batchId: string | null }[],
  ): Promise<Map<string, number>> {
    if (tests.length === 0) return new Map();

    const groups = await this.prisma.student.groupBy({
      by: ['campusId', 'batchId'],
      where: { status: 'ACTIVE' },
      _count: { _all: true },
    });

    const counts = new Map<string, number>();
    for (const test of tests) {
      let total = 0;
      for (const group of groups) {
        if (test.campusId !== null && group.campusId !== test.campusId) continue;
        if (test.batchId !== null && group.batchId !== test.batchId) continue;
        total += group._count._all;
      }
      counts.set(test.id, total);
    }
    return counts;
  }

  private async attemptCounts(
    testIds: string[],
  ): Promise<Map<string, { started: number; completed: number; reviewRequired: number }>> {
    if (testIds.length === 0) return new Map();

    const groups = await this.prisma.baselineTestAttempt.groupBy({
      by: ['testId', 'status', 'reviewStatus'],
      where: { testId: { in: testIds } },
      _count: { _all: true },
    });

    const counts = new Map<string, { started: number; completed: number; reviewRequired: number }>();
    for (const group of groups) {
      const entry = counts.get(group.testId) ?? { started: 0, completed: 0, reviewRequired: 0 };
      entry.started += group._count._all;
      if (group.status === 'SUBMITTED') entry.completed += group._count._all;
      if (group.reviewStatus === 'REVIEW_REQUIRED') entry.reviewRequired += group._count._all;
      counts.set(group.testId, entry);
    }
    return counts;
  }

  /**
   * How the cohort fared on each problem, counted from the submission mirror.
   *
   * Previously derived from attempt rows, which is why every problem read "Solved 0" on a
   * test nobody opened in the portal — while the mirror held dozens of accepted solutions
   * for those same problems. Timing still comes from the attempts, since "how long did it
   * take" is only meaningful for a problem solved under test conditions.
   */
  private problemStats(
    test: { problems: { id: string; position: number; points: number; difficulty: string; problem: { title: string; titleSlug: string } }[] },
    attempts: BaselineAttemptSummary[],
    performanceByStudent: Map<string, BaselineProblemPerformance[]>,
    eligible: number,
  ): BaselineProblemStat[] {
    // Slug → how many eligible students solved it, and how many tried without solving it.
    const solvedBySlug = new Map<string, number>();
    const triedBySlug = new Map<string, number>();
    for (const performance of performanceByStudent.values()) {
      for (const problem of performance) {
        if (problem.solved) {
          solvedBySlug.set(problem.titleSlug, (solvedBySlug.get(problem.titleSlug) ?? 0) + 1);
        } else if (problem.attempts > 0) {
          triedBySlug.set(problem.titleSlug, (triedBySlug.get(problem.titleSlug) ?? 0) + 1);
        }
      }
    }

    return test.problems.map((testProblem): BaselineProblemStat => {
      const slug = testProblem.problem.titleSlug.toLowerCase();
      const solvedCount = solvedBySlug.get(slug) ?? 0;
      const attemptedNotSolvedCount = triedBySlug.get(slug) ?? 0;

      const times = attempts
        .map((attempt) => attempt.results.find((r) => r.testProblemId === testProblem.id))
        .filter((result): result is NonNullable<typeof result> => result !== undefined)
        .filter((result) => result.status === 'ACCEPTED')
        .map((result) => result.timeToSolveSeconds)
        .filter((seconds): seconds is number => seconds !== null);

      return {
        testProblemId: testProblem.id,
        position: testProblem.position,
        title: testProblem.problem.title,
        difficulty: testProblem.difficulty as BaselineProblemStat['difficulty'],
        points: testProblem.points,
        solvedCount,
        attemptedNotSolvedCount,
        // Everyone eligible who did not solve it and did not fail at it — including the
        // students who never started, who are the largest and most important slice.
        notAttemptedCount: Math.max(0, eligible - solvedCount - attemptedNotSolvedCount),
        successRatePercent:
          eligible > 0 ? Math.round((solvedCount / eligible) * 10000) / 100 : 0,
        // In-window only: how long a problem took is meaningful under test conditions and
        // meaningless for a solution written on some other day.
        averageTimeToSolveSeconds: times.length > 0 ? Math.round(average(times)) : null,
      };
    });
  }

  private breakdown(
    attempts: BaselineAttemptSummary[],
    eligible: EligibleStudent[],
    attemptKey: (attempt: BaselineAttemptSummary) => string | null,
    studentKey: (student: EligibleStudent) => string | null,
    label: (attempt: BaselineAttemptSummary) => string | null,
    studentLabel: (student: EligibleStudent) => string | null,
    maxScore: number,
  ): BaselineScopeBreakdown[] {
    const eligibleByKey = new Map<string | null, number>();
    const nameByKey = new Map<string | null, string>();
    for (const student of eligible) {
      const key = studentKey(student);
      eligibleByKey.set(key, (eligibleByKey.get(key) ?? 0) + 1);
      const name = studentLabel(student);
      if (name && !nameByKey.has(key)) nameByKey.set(key, name);
    }

    const byKey = new Map<string | null, BaselineAttemptSummary[]>();
    for (const attempt of attempts) {
      const key = attemptKey(attempt);
      const list = byKey.get(key) ?? [];
      list.push(attempt);
      byKey.set(key, list);
    }
    // A group with eligible students but no attempts still gets a row — "0 of 41 started"
    // is the most useful line in the report, and omitting it hides the problem.
    for (const key of eligibleByKey.keys()) if (!byKey.has(key)) byKey.set(key, []);

    return [...byKey.entries()].map(([key, group]): BaselineScopeBreakdown => {
      const scores = group.map((attempt) => attempt.score);
      return {
        scopeId: key,
        scopeName:
          group.map(label).find((name): name is string => !!name) ??
          nameByKey.get(key) ??
          'Unassigned',
        eligible: eligibleByKey.get(key) ?? group.length,
        started: group.length,
        completed: group.filter((attempt) => attempt.status === 'SUBMITTED').length,
        notStarted: Math.max(0, (eligibleByKey.get(key) ?? group.length) - group.length),
        averageScore: average(scores),
        averagePercent: maxScore > 0 ? Math.round((average(scores) / maxScore) * 10000) / 100 : 0,
      };
    });
  }

  /**
   * Turn pasted problem URLs into `Problem` rows, reusing the same slug extraction and
   * metadata fetch the assignment path uses — one definition of "what is a LeetCode
   * problem", not two.
   */
  private async resolveProblems(
    input: { url: string; points?: number }[],
  ): Promise<{ id: string; points: number; difficulty: 'EASY' | 'MEDIUM' | 'HARD' }[]> {
    const resolved: { id: string; points: number; difficulty: 'EASY' | 'MEDIUM' | 'HARD' }[] = [];
    const seen = new Set<string>();

    for (const [index, entry] of input.entries()) {
      const slug = extractProblemSlug(entry.url);
      if (!slug) {
        throw new BadRequestException(
          `Problem ${index + 1}: could not read a slug from "${entry.url}". ` +
            'Expected a link like https://leetcode.com/problems/two-sum/',
        );
      }
      if (seen.has(slug)) {
        throw new BadRequestException(`The same problem was added more than once: ${slug}`);
      }
      seen.add(slug);

      let problem = await this.prisma.problem.findUnique({ where: { titleSlug: slug } });
      if (!problem) {
        try {
          const metadata = await this.provider.fetchProblemMetadata(slug);
          problem = await this.prisma.problem.upsert({
            where: { titleSlug: slug },
            create: {
              titleSlug: metadata.titleSlug,
              title: metadata.title,
              questionId: metadata.questionId,
              questionFrontendId: metadata.questionFrontendId,
              difficulty: metadata.difficulty,
              acceptanceRate: metadata.acceptanceRate,
              isPaidOnly: metadata.isPaidOnly,
              topicTags: metadata.topicTags,
              companyTags: metadata.companyTags,
              url: metadata.url,
              metadataFetchedAt: new Date(),
            },
            update: {},
          });
        } catch (error) {
          if (error instanceof ProviderProblemNotFoundError) {
            throw new BadRequestException(
              `No LeetCode problem exists with the slug "${slug}". Check the URL.`,
            );
          }
          throw error;
        }
      }

      resolved.push({
        id: problem.id,
        // Default weights follow difficulty, so "2 Easy, 2 Medium" scores sensibly
        // without an admin having to hand-enter points every week.
        points: entry.points ?? defaultPoints(problem.difficulty),
        difficulty: problem.difficulty as 'EASY' | 'MEDIUM' | 'HARD',
      });
    }

    return resolved;
  }

  private include() {
    return {
      problems: { include: { problem: true }, orderBy: { position: 'asc' as const } },
      campus: { select: { name: true, code: true } },
      batch: { select: { name: true, code: true } },
      createdBy: { select: { name: true } },
    };
  }

  private toSummary(
    test: {
      id: string;
      name: string;
      dayKey: string;
      description: string | null;
      instructions: string | null;
      adminNotes: string | null;
      campusId: string | null;
      campus?: { name: string; code: string } | null;
      batchId: string | null;
      batch?: { name: string; code: string } | null;
      durationMinutes: number;
      opensAt: Date | null;
      closesAt: Date | null;
      status: string;
      createdAt: Date;
      updatedAt: Date;
      createdBy?: { name: string } | null;
      problems: {
        id: string;
        position: number;
        points: number;
        difficulty: string;
        problemId: string;
        problem: { title: string; titleSlug: string; url: string };
      }[];
    },
    counts: Map<string, { started: number; completed: number; reviewRequired: number }>,
    eligibility: Map<string, number>,
  ): BaselineTestSummary {
    const count = counts.get(test.id) ?? { started: 0, completed: 0, reviewRequired: 0 };
    return {
      id: test.id,
      name: test.name,
      dayKey: test.dayKey,
      description: test.description,
      instructions: test.instructions,
      adminNotes: test.adminNotes,
      campusId: test.campusId,
      campusName: test.campus?.name ?? null,
      campusCode: test.campus?.code ?? null,
      batchId: test.batchId,
      batchName: test.batch?.name ?? null,
      batchCode: test.batch?.code ?? null,
      audienceLabel: describeScope(test.campus?.name ?? null, test.batch?.name ?? null),
      durationMinutes: test.durationMinutes,
      opensAt: test.opensAt?.toISOString() ?? null,
      closesAt: test.closesAt?.toISOString() ?? null,
      status: test.status as BaselineTestSummary['status'],
      problems: test.problems.map((problem) => ({
        id: problem.id,
        position: problem.position,
        problemId: problem.problemId,
        title: problem.problem.title,
        titleSlug: problem.problem.titleSlug,
        url: problem.problem.url,
        difficulty: problem.difficulty as BaselineTestSummary['problems'][number]['difficulty'],
        points: problem.points,
      })),
      eligibleStudentCount: eligibility.get(test.id) ?? 0,
      startedCount: count.started,
      completedCount: count.completed,
      reviewRequiredCount: count.reviewRequired,
      createdByName: test.createdBy?.name ?? null,
      createdAt: test.createdAt.toISOString(),
      updatedAt: test.updatedAt.toISOString(),
    };
  }

  /**
   * The student-facing projection.
   *
   * The problem list is withheld until the student's own attempt has started, so a
   * scheduled test does not leak its questions in advance. `adminNotes`, every risk field
   * and every other student's data are absent from the *type*, not merely omitted here.
   */
  private toStudentTest(
    test: {
      id: string;
      name: string;
      dayKey: string;
      description: string | null;
      instructions: string | null;
      durationMinutes: number;
      opensAt: Date | null;
      closesAt: Date | null;
      status: string;
      problems: {
        id: string;
        position: number;
        points: number;
        difficulty: string;
        problemId: string;
        problem: { title: string; titleSlug: string; url: string };
      }[];
    },
    attempt: {
      id: string;
      status: string;
      startedAt: Date;
      submittedAt: Date | null;
      expiresAt: Date | null;
      solvedCount: number;
      attemptedCount: number;
      score: number;
      maxScore: number;
      results: {
        testProblemId: string;
        problemId: string;
        status: string;
        solvedAt: Date | null;
      }[];
    } | null,
    /** Problems solved at any time — see `StudentBaselineTest.generalSolvedCount`. */
    generalSolvedCount = 0,
  ): StudentBaselineTest {
    const now = new Date();
    const open = isTestOpen(
      {
        status: test.status as StudentBaselineTest['status'],
        opensAt: test.opensAt,
        closesAt: test.closesAt,
      },
      now,
    );

    const problems = attempt
      ? test.problems.map((problem) => ({
          id: problem.id,
          position: problem.position,
          problemId: problem.problemId,
          title: problem.problem.title,
          titleSlug: problem.problem.titleSlug,
          url: problem.problem.url,
          difficulty: problem.difficulty as StudentBaselineTest['problems'][number]['difficulty'],
          points: problem.points,
        }))
      : [];

    const resultByProblem = new Map(
      (attempt?.results ?? []).map((result) => [result.testProblemId, result]),
    );

    return {
      id: test.id,
      name: test.name,
      dayKey: test.dayKey,
      description: test.description,
      instructions: test.instructions,
      durationMinutes: test.durationMinutes,
      opensAt: test.opensAt?.toISOString() ?? null,
      closesAt: test.closesAt?.toISOString() ?? null,
      status: test.status as StudentBaselineTest['status'],
      problemCount: test.problems.length,
      problems,
      attempt: attempt
        ? {
            id: attempt.id,
            status: attempt.status as StudentBaselineTest['attempt'] extends null
              ? never
              : NonNullable<StudentBaselineTest['attempt']>['status'],
            startedAt: attempt.startedAt.toISOString(),
            submittedAt: attempt.submittedAt?.toISOString() ?? null,
            expiresAt: attempt.expiresAt?.toISOString() ?? null,
            solvedCount: attempt.solvedCount,
            attemptedCount: attempt.attemptedCount,
            score: attempt.score,
            maxScore: attempt.maxScore,
            results: test.problems.map((problem) => ({
              testProblemId: problem.id,
              problemId: problem.problemId,
              position: problem.position,
              title: problem.problem.title,
              url: problem.problem.url,
              difficulty: problem.difficulty as StudentBaselineTest['problems'][number]['difficulty'],
              points: problem.points,
              status: (resultByProblem.get(problem.id)?.status ??
                'NOT_ATTEMPTED') as ProblemStatus,
              solvedAt: resultByProblem.get(problem.id)?.solvedAt?.toISOString() ?? null,
            })),
          }
        : null,
      generalSolvedCount,
      generalTotalQuestions: test.problems.length,
      canStart: open && attempt === null,
      blockedReason:
        attempt !== null
          ? null
          : test.status === 'CLOSED'
            ? 'This test has closed.'
            : !open && test.opensAt && now < test.opensAt
              ? `Opens ${test.opensAt.toISOString()}`
              : !open
                ? 'This test is not open.'
                : null,
    };
  }

  private toAttemptSummary(
    attempt: {
      id: string;
      testId: string;
      studentId: string;
      student: { id: string; name: string; email: string | null; squad: { name: string } | null };
      campusId: string | null;
      campus?: { name: string } | null;
      batchId: string | null;
      batch?: { name: string } | null;
      status: string;
      startedAt: Date;
      submittedAt: Date | null;
      expiresAt: Date | null;
      solvedCount: number;
      attemptedCount: number;
      score: number;
      maxScore: number;
      timeTakenSeconds: number | null;
      riskFlags: string[];
      riskScore: number;
      reviewStatus: string;
      reviewNote: string | null;
      reviewedBy?: { name: string } | null;
      reviewedAt: Date | null;
      gradedAt: Date | null;
      results: {
        testProblemId: string;
        problemId: string;
        status: string;
        attempts: number;
        points: number;
        solvedAt: Date | null;
        timeToSolveSeconds: number | null;
      }[];
    },
    test: {
      problems: {
        id: string;
        position: number;
        points: number;
        difficulty: string;
        problem: { title: string };
      }[];
    },
  ): BaselineAttemptSummary {
    const resultByProblem = new Map(attempt.results.map((r) => [r.testProblemId, r]));

    return {
      id: attempt.id,
      testId: attempt.testId,
      studentId: attempt.studentId,
      studentName: attempt.student.name,
      studentEmail: attempt.student.email,
      campusId: attempt.campusId,
      campusName: attempt.campus?.name ?? null,
      batchId: attempt.batchId,
      batchName: attempt.batch?.name ?? null,
      squadName: attempt.student.squad?.name ?? null,
      status: attempt.status as BaselineAttemptSummary['status'],
      startedAt: attempt.startedAt.toISOString(),
      submittedAt: attempt.submittedAt?.toISOString() ?? null,
      expiresAt: attempt.expiresAt?.toISOString() ?? null,
      solvedCount: attempt.solvedCount,
      attemptedCount: attempt.attemptedCount,
      score: attempt.score,
      maxScore: attempt.maxScore,
      percent:
        attempt.maxScore > 0
          ? Math.round((attempt.score / attempt.maxScore) * 10000) / 100
          : 0,
      timeTakenSeconds: attempt.timeTakenSeconds,
      riskFlags: attempt.riskFlags as BaselineAttemptSummary['riskFlags'],
      riskScore: attempt.riskScore,
      // Re-derived from the stored signals so a mentor always sees *why*, never a bare
      // flag. A flag without its evidence is an accusation; with it, it is an observation.
      riskEvidence: (attempt.riskFlags as BaselineAttemptSummary['riskFlags']).map(
        (signal) => BASELINE_RISK_SIGNAL_LABELS[signal],
      ),
      reviewStatus: attempt.reviewStatus as BaselineAttemptSummary['reviewStatus'],
      reviewNote: attempt.reviewNote,
      reviewedByName: attempt.reviewedBy?.name ?? null,
      reviewedAt: attempt.reviewedAt?.toISOString() ?? null,
      gradedAt: attempt.gradedAt?.toISOString() ?? null,
      results: test.problems.map((problem) => {
        const result = resultByProblem.get(problem.id);
        return {
          testProblemId: problem.id,
          problemId: result?.problemId ?? '',
          position: problem.position,
          title: problem.problem.title,
          difficulty: problem.difficulty as BaselineAttemptSummary['results'][number]['difficulty'],
          points: problem.points,
          awardedPoints: result?.points ?? 0,
          status: (result?.status ?? 'NOT_ATTEMPTED') as ProblemStatus,
          attempts: result?.attempts ?? 0,
          solvedAt: result?.solvedAt?.toISOString() ?? null,
          // This projection is strictly *in-window*: it describes the attempt, so the
          // any-time evidence fields are not applicable here and stay null. The
          // general-performance view is `studentResult`.
          firstAcceptedAt: null,
          latestAcceptedAt: null,
          timeToSolveSeconds: result?.timeToSolveSeconds ?? null,
        };
      }),
    };
  }
}

/** Points a problem is worth when the admin does not override them. */
function defaultPoints(difficulty: string): number {
  switch (difficulty) {
    case 'EASY':
      return 10;
    case 'HARD':
      return 30;
    default:
      return 20;
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Math.round((((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2) * 100) / 100;
}

// `BASELINE_RISK_THRESHOLDS` is re-exported so the admin UI can explain what a flag means
// using the same numbers that produced it, rather than a hard-coded copy in the client.
export { BASELINE_RISK_THRESHOLDS };
