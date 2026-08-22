/**
 * The student portal's entire backend surface is composition, not calculation.
 *
 * Every number here is produced by the same services and cached tables the admin/mentor
 * screens read — `StudentsService.getProfile` (streak, totalSolved, heatmap, weekly/
 * monthly completion), `AssignmentsService` (campus + batch aware assignment resolution),
 * `LeaderboardService` (rank) and the `DailyProblemStatus` rows `RollupService` already
 * writes. Nothing is recomputed a second way, and identity is never taken from a request
 * parameter — every method here takes the authenticated `RequestUser` and resolves
 * `studentId` from it (§18, §19).
 *
 * With two campuses, that last property becomes load-bearing rather than tidy. The
 * student's audience — their campus *and* batch — is read from their own record on the
 * server every time, so there is no campus parameter for a student to change (§40). The
 * cross-campus checks below are defence in depth on top of that: an SRM student asking
 * for a Vels assignment by id gets the same 404 as for an id that does not exist, which
 * means they cannot even probe whether it exists.
 */

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { scopeApplies } from '@dsa/shared';
import type {
  AssignmentSummary,
  LeaderboardRow,
  Paginated,
  StudentAssignmentHistoryRow,
  StudentAssignmentView,
  StudentDashboard,
  StudentPortalProfile,
  StudentProblemOutcome,
  StudentSummary,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import type { RequestUser } from '../../common/decorators';
import { StudentsService } from '../students/students.service';
import { AssignmentsService } from '../assignments/assignments.service';
import { LeaderboardService, type Period } from '../leaderboard/leaderboard.service';
import type { StudentAssignmentQueryDto, StudentLeaderboardQueryDto } from './dto/student-portal.dto';

@Injectable()
export class StudentPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    private readonly students: StudentsService,
    private readonly assignments: AssignmentsService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  /**
   * The one place that turns a session into a student id. `RolesGuard` already keeps
   * every route in this controller to `role: 'STUDENT'`, but a STUDENT-role account with
   * no `studentId` (should never happen — see `student-accounts.service.ts` — but "should
   * never happen" is exactly what this line is for) gets a clean 403, not a crash three
   * calls deep into a Prisma query with `studentId: undefined`.
   */
  private requireStudentId(user: RequestUser): string {
    if (!user.studentId) {
      throw new ForbiddenException('This account is not linked to a student record.');
    }
    return user.studentId;
  }

  async me(user: RequestUser): Promise<StudentSummary> {
    return this.students.findOne(this.requireStudentId(user));
  }

  async profile(user: RequestUser): Promise<StudentPortalProfile> {
    const full = await this.students.getProfile(this.requireStudentId(user));
    // `notes` is `MentorNote[]` — private mentor observations. Every other field on
    // `StudentProfile` is either the student's own data or already-safe aggregates.
    const { notes: _notes, ...portalProfile } = full;
    return portalProfile;
  }

  async dashboard(user: RequestUser): Promise<StudentDashboard> {
    const studentId = this.requireStudentId(user);
    const today = this.time.today();

    const profile = await this.students.getProfile(studentId);
    const week = this.time.weekBounds(today);
    const month = this.time.monthBounds(today);

    const weeklySolved = profile.heatmap
      .filter((d) => d.dayKey >= week.from && d.dayKey <= week.to)
      .reduce((sum, d) => sum + d.solvedCount, 0);
    const monthlySolved = profile.heatmap
      .filter((d) => d.dayKey >= month.from && d.dayKey <= month.to)
      .reduce((sum, d) => sum + d.solvedCount, 0);

    const [todayAssignmentSummary, rank] = await Promise.all([
      // The audience is the student's own campus and batch, read from their record —
      // never from anything the request carried.
      this.assignments.findByDay(today, {
        campusId: profile.campusId,
        batchId: profile.batchId,
      }),
      this.leaderboard.myRank(studentId, 'WEEKLY', today),
    ]);

    const todayAssignment = todayAssignmentSummary
      ? await this.withOutcome(todayAssignmentSummary, studentId)
      : null;

    return {
      name: profile.name,
      campusId: profile.campusId,
      campusName: profile.campusName,
      campusCode: profile.campusCode,
      batchName: profile.batchName,
      batchCode: profile.batchCode,
      squadNumber: profile.squadNumber,
      cohort: profile.cohort,
      maxBeltLevel: profile.maxBeltLevel,
      currentStreak: profile.currentStreak,
      longestStreak: profile.longestStreak,
      totalSolved: profile.totalSolved,
      totalScore: profile.totalScore,
      todayAssignment,
      weeklySolved,
      monthlySolved,
      weeklyCompletionPercent: profile.weeklyCompletionPercent,
      monthlyCompletionPercent: profile.monthlyCompletionPercent,
      currentRank: rank
        ? {
            period: 'WEEKLY',
            rank: rank.rank,
            total: rank.total,
            globalRank: rank.globalRank,
            globalTotal: rank.globalTotal,
          }
        : null,
      recentDays: profile.recentDays.slice(0, 14).map((d) => ({
        dayKey: d.dayKey,
        solvedCount: d.solvedCount,
        assignedCount: d.assignedCount,
        isPerfect: d.assignedCount > 0 && d.solvedCount >= d.assignedCount,
      })),
    };
  }

  async assignmentHistory(
    user: RequestUser,
    query: StudentAssignmentQueryDto,
  ): Promise<Paginated<StudentAssignmentHistoryRow>> {
    const studentId = this.requireStudentId(user);
    const student = await this.students.findOne(studentId);

    const page = await this.assignments.findAll({
      page: query.page,
      pageSize: query.pageSize,
      scope: { campusId: student.campusId, batchId: student.batchId },
    });

    // One indexed query for the whole page's outcomes, not one per row (§34).
    const dayKeys = page.items.map((a) => a.dayKey);
    const statuses = await this.prisma.dailyStatus.findMany({
      where: { studentId, dayKey: { in: dayKeys } },
      select: {
        dayKey: true,
        solvedCount: true,
        assignedCount: true,
        isPerfect: true,
        score: true,
        completedAt: true,
      },
    });
    const byDay = new Map(statuses.map((s) => [s.dayKey, s]));

    return {
      ...page,
      items: page.items.map((a): StudentAssignmentHistoryRow => {
        const status = byDay.get(a.dayKey);
        return {
          id: a.id,
          dayKey: a.dayKey,
          title: a.title,
          topic: a.topic,
          difficulty: a.difficulty,
          assignedCount: status?.assignedCount ?? a.problems.length,
          solvedCount: status?.solvedCount ?? 0,
          isPerfect: status?.isPerfect ?? false,
          score: status?.score ?? 0,
          completedAt: status?.completedAt?.toISOString() ?? null,
        };
      }),
    };
  }

  async assignmentDetail(user: RequestUser, assignmentId: string): Promise<StudentAssignmentView> {
    const studentId = this.requireStudentId(user);
    const student = await this.students.findOne(studentId);

    const assignment = await this.assignments.findById(assignmentId);
    if (!assignment) throw new NotFoundException('Assignment not found');

    // An assignment aimed at an audience this student is not in is not a 403 — it is
    // treated exactly like it does not exist, so a student cannot tell the difference
    // between "wrong id" and "another campus's assignment", and therefore cannot use this
    // endpoint to enumerate what other campuses were set (§9, §19, §40).
    //
    // `scopeApplies` is the same predicate the resolver uses, so what a student may read
    // and what they were actually assigned can never drift apart.
    const applies = scopeApplies(
      { campusId: assignment.campusId, batchId: assignment.batchId },
      { campusId: student.campusId, batchId: student.batchId },
    );
    if (!applies) throw new NotFoundException('Assignment not found');

    return this.withOutcome(assignment, studentId);
  }

  /**
   * The leaderboard, at whichever of the three scopes the student asked for.
   *
   * Students may legitimately see all three (§15): the global board across every campus,
   * their own campus's, and their own batch's. What they may *not* do is name someone
   * else's scope — `campus` and `batch` are never read from the request. `scope` selects
   * between "everyone", "my campus" and "my batch", and the ids come from the student's
   * own record, so there is no parameter to tamper with (§40).
   */
  async myLeaderboard(
    user: RequestUser,
    query: StudentLeaderboardQueryDto,
  ): Promise<{ rows: LeaderboardRow[]; myStudentId: string; scope: string }> {
    const studentId = this.requireStudentId(user);
    const scope = query.scope ?? 'campus';
    const student =
      scope === 'global' ? null : await this.students.findOne(studentId);

    const rows = await this.leaderboard.getLeaderboard(query.period as Period, undefined, {
      campusId: scope === 'global' ? undefined : (student?.campusId ?? undefined),
      // "mine" is the student's own batch; "campus" stops at the campus.
      batchId: scope === 'mine' ? (student?.batchId ?? undefined) : undefined,
    });
    return { rows, myStudentId: studentId, scope };
  }

  // -------------------------------------------------------------------------

  /** Merge one assignment's content with this student's own per-problem outcome. */
  private async withOutcome(
    assignment: AssignmentSummary,
    studentId: string,
  ): Promise<StudentAssignmentView> {
    const dailyStatus = await this.prisma.dailyStatus.findUnique({
      where: { studentId_dayKey: { studentId, dayKey: assignment.dayKey } },
      include: { problemStatuses: true },
    });

    const outcomeByProblem = new Map(
      (dailyStatus?.problemStatuses ?? []).map((s) => [
        s.problemId,
        { status: s.status, solvedAt: s.solvedAt },
      ]),
    );

    const myOutcome = dailyStatus
      ? {
          solvedCount: dailyStatus.solvedCount,
          assignedCount: dailyStatus.assignedCount,
          completionPercent:
            dailyStatus.assignedCount > 0
              ? Math.round((dailyStatus.solvedCount / dailyStatus.assignedCount) * 100)
              : 0,
          isPerfect: dailyStatus.isPerfect,
          completedAt: dailyStatus.completedAt?.toISOString() ?? null,
          problems: assignment.problems.map(
            (p): StudentProblemOutcome => ({
              problemId: p.problemId,
              position: p.position,
              title: p.title,
              titleSlug: p.titleSlug,
              url: p.url,
              difficulty: p.difficulty,
              status: outcomeByProblem.get(p.problemId)?.status ?? 'NOT_ATTEMPTED',
              solvedAt: outcomeByProblem.get(p.problemId)?.solvedAt?.toISOString() ?? null,
            }),
          ),
        }
      : null;

    return {
      id: assignment.id,
      dayKey: assignment.dayKey,
      campusId: assignment.campusId,
      campusName: assignment.campusName,
      campusCode: assignment.campusCode,
      batchId: assignment.batchId,
      batchName: assignment.batchName,
      batchCode: assignment.batchCode,
      title: assignment.title,
      topic: assignment.topic,
      difficulty: assignment.difficulty,
      problems: assignment.problems,
      myOutcome,
    };
  }
}
