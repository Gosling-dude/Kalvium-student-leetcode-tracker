/**
 * Infosys Preparation's recompute engine — the write path for `InfosysDailyStatus` /
 * `InfosysDailyProblemStatus`. See the schema.prisma section banner above
 * `InfosysEnrollment` for why this is a separate service from `RollupService` rather
 * than an extension of it.
 *
 * Idempotent by construction: every write is an upsert keyed on `(studentId, dayKey)`
 * for the status row and `(infosysDailyStatusId, problemId)` for its problem rows, so
 * running a recompute twice in a row produces byte-identical results (§5: "repeated
 * sync must produce the same result").
 */

import { Injectable, Logger } from '@nestjs/common';
import type { DayKey } from '@dsa/shared';
import { evaluateInfosysDay, type InfosysAssignedProblemRef } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

export type InfosysProfileState = 'OK' | 'PROFILE_NOT_LINKED' | 'DATA_UNAVAILABLE';

export interface InfosysRecomputeSummary {
  dayKey: DayKey;
  studentsProcessed: number;
  assignedCount: number;
}

/** Sync outcomes that mean "we tried and could not read this profile reliably" —
 * distinct from `PROFILE_MISSING` (no handle at all, handled separately by
 * `leetcodeUsername === null`) and from a genuinely clean `OK`. `NEVER_SYNCED` is
 * treated the same as a failure here, not as a real zero: until at least one sync has
 * actually run for this student, there is no basis for claiming they solved nothing —
 * see §6/§13's ban on ever converting `DATA_UNAVAILABLE` into `0`. */
function resolveProfileState(student: {
  leetcodeUsername: string | null;
  syncState: { status: string } | null;
}): InfosysProfileState {
  if (!student.leetcodeUsername) return 'PROFILE_NOT_LINKED';
  if (!student.syncState || student.syncState.status !== 'OK') return 'DATA_UNAVAILABLE';
  return 'OK';
}

@Injectable()
export class InfosysRollupService {
  private readonly logger = new Logger(InfosysRollupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
  ) {}

  /**
   * The Infosys tracking start date — `MIN(InfosysAssignment.dayKey)`, computed live.
   * Not stored anywhere (see the schema banner): the date something was entered into
   * the tool must never be confused with the date it was assigned, and the only honest
   * source for "assigned" is the earliest assignment row itself.
   */
  async trackingStartDate(): Promise<DayKey | null> {
    const earliest = await this.prisma.infosysAssignment.findFirst({
      orderBy: { dayKey: 'asc' },
      select: { dayKey: true },
    });
    return (earliest?.dayKey as DayKey | undefined) ?? null;
  }

  /**
   * Every program day with an `InfosysAssignment`, from the tracking start date to
   * (and including) today — the full set a "recompute everything" sweep needs.
   */
  async allAssignedDays(): Promise<DayKey[]> {
    const rows = await this.prisma.infosysAssignment.findMany({
      select: { dayKey: true },
      orderBy: { dayKey: 'asc' },
    });
    return rows.map((r) => r.dayKey as DayKey);
  }

  /**
   * Recompute one program day for every Infosys-enrolled student.
   *
   * A day with no `InfosysAssignment` has nothing to score and is a no-op — there is
   * deliberately no "0 assigned" row written for it, the same way Coding Hours' rollup
   * only ever scores days that were actually assigned.
   */
  async recomputeDay(dayKey: DayKey): Promise<InfosysRecomputeSummary> {
    const trackingStart = await this.trackingStartDate();
    const assignment = await this.prisma.infosysAssignment.findUnique({
      where: { dayKey },
      include: {
        problems: {
          include: { problem: { select: { id: true, titleSlug: true } } },
          orderBy: { position: 'asc' },
        },
      },
    });

    if (!assignment || assignment.problems.length === 0 || !trackingStart) {
      return { dayKey, studentsProcessed: 0, assignedCount: 0 };
    }

    const assigned: InfosysAssignedProblemRef[] = assignment.problems.map((link) => ({
      problemId: link.problem.id,
      titleSlug: link.problem.titleSlug,
      position: link.position,
    }));
    const slugs = [...new Set(assigned.map((a) => a.titleSlug.toLowerCase()))];

    const enrollments = await this.prisma.infosysEnrollment.findMany({
      select: {
        studentId: true,
        campusId: true,
        student: {
          select: { leetcodeUsername: true, syncState: { select: { status: true } } },
        },
      },
    });

    const trackingStartAt = this.time.bounds(trackingStart).start;

    // Bounded to the assigned slugs and this program's enrolled students — a few
    // hundred rows even at full roster size, not the whole submission mirror. The
    // window floor is enforced here too (belt-and-suspenders with
    // `evaluateInfosysDay`'s own re-check): a query that silently dropped this filter
    // in a future edit must not be the only thing standing between the system and
    // counting pre-window activity.
    const submissions = await this.prisma.submission.findMany({
      where: {
        titleSlug: { in: slugs },
        submittedAt: { gte: trackingStartAt },
        studentId: { in: enrollments.map((e) => e.studentId) },
      },
      select: { studentId: true, titleSlug: true, status: true, submittedAt: true },
    });

    const submissionsByStudent = new Map<string, typeof submissions>();
    for (const submission of submissions) {
      const list = submissionsByStudent.get(submission.studentId) ?? [];
      list.push(submission);
      submissionsByStudent.set(submission.studentId, list);
    }

    let processed = 0;
    for (const enrollment of enrollments) {
      const profileState = resolveProfileState(enrollment.student);
      const outcomes =
        profileState === 'OK'
          ? evaluateInfosysDay(assigned, submissionsByStudent.get(enrollment.studentId) ?? [], trackingStartAt)
          : assigned.map((a) => ({
              problemId: a.problemId,
              position: a.position,
              status: 'NOT_ATTEMPTED' as const,
              solvedAt: null,
              attempts: 0,
            }));

      await this.persist({
        studentId: enrollment.studentId,
        campusId: enrollment.campusId,
        dayKey,
        infosysAssignmentId: assignment.id,
        profileState,
        outcomes,
      });
      processed += 1;
    }

    this.logger.log(
      `Recomputed Infosys ${dayKey}: ${processed} student(s) across ${assigned.length} problem(s).`,
    );
    return { dayKey, studentsProcessed: processed, assignedCount: assigned.length };
  }

  /** Every assigned day, for every enrolled student — the full sweep after a schema/
   * threshold change, or the initial backfill after the first assignment is entered. */
  async recomputeAll(): Promise<InfosysRecomputeSummary[]> {
    const days = await this.allAssignedDays();
    const summaries: InfosysRecomputeSummary[] = [];
    for (const day of days) summaries.push(await this.recomputeDay(day));
    return summaries;
  }

  /**
   * Every assigned day, for one student only — what runs when a LeetCode profile is
   * added or corrected (§14), so a newly-linked profile's whole Infosys history is
   * evaluated without recomputing the other 204 students who did not change.
   */
  async recomputeStudent(studentId: string): Promise<InfosysRecomputeSummary[]> {
    const enrollment = await this.prisma.infosysEnrollment.findUnique({ where: { studentId } });
    if (!enrollment) return [];

    const trackingStart = await this.trackingStartDate();
    if (!trackingStart) return [];

    const student = await this.prisma.student.findUniqueOrThrow({
      where: { id: studentId },
      select: { leetcodeUsername: true, syncState: { select: { status: true } } },
    });
    const profileState = resolveProfileState(student);

    const assignments = await this.prisma.infosysAssignment.findMany({
      include: {
        problems: { include: { problem: { select: { id: true, titleSlug: true } } }, orderBy: { position: 'asc' } },
      },
      orderBy: { dayKey: 'asc' },
    });

    const trackingStartAt = this.time.bounds(trackingStart).start;
    const allSlugs = [
      ...new Set(assignments.flatMap((a) => a.problems.map((p) => p.problem.titleSlug.toLowerCase()))),
    ];

    const submissions =
      profileState === 'OK'
        ? await this.prisma.submission.findMany({
            where: { studentId, titleSlug: { in: allSlugs }, submittedAt: { gte: trackingStartAt } },
            select: { titleSlug: true, status: true, submittedAt: true },
          })
        : [];

    const summaries: InfosysRecomputeSummary[] = [];
    for (const assignment of assignments) {
      const assigned: InfosysAssignedProblemRef[] = assignment.problems.map((link) => ({
        problemId: link.problem.id,
        titleSlug: link.problem.titleSlug,
        position: link.position,
      }));
      const outcomes =
        profileState === 'OK'
          ? evaluateInfosysDay(assigned, submissions, trackingStartAt)
          : assigned.map((a) => ({
              problemId: a.problemId,
              position: a.position,
              status: 'NOT_ATTEMPTED' as const,
              solvedAt: null,
              attempts: 0,
            }));

      await this.persist({
        studentId,
        campusId: enrollment.campusId,
        dayKey: assignment.dayKey as DayKey,
        infosysAssignmentId: assignment.id,
        profileState,
        outcomes,
      });
      summaries.push({
        dayKey: assignment.dayKey as DayKey,
        studentsProcessed: 1,
        assignedCount: assigned.length,
      });
    }

    this.logger.log(
      `Recomputed Infosys history for student ${studentId}: ${assignments.length} day(s), profile ${profileState}.`,
    );
    return summaries;
  }

  private async persist(input: {
    studentId: string;
    campusId: string;
    dayKey: DayKey;
    infosysAssignmentId: string;
    profileState: InfosysProfileState;
    outcomes: {
      problemId: string;
      position: number;
      status: 'SOLVED' | 'ATTEMPTED_NOT_SOLVED' | 'NOT_ATTEMPTED';
      solvedAt: Date | null;
      attempts: number;
    }[];
  }): Promise<void> {
    const { studentId, campusId, dayKey, infosysAssignmentId, profileState, outcomes } = input;

    const counts = {
      assignedCount: outcomes.length,
      solvedCount: 0,
      attemptedNotSolvedCount: 0,
      notAttemptedCount: 0,
      profileNotLinkedCount: 0,
      dataUnavailableCount: 0,
    };

    if (profileState === 'PROFILE_NOT_LINKED') {
      counts.profileNotLinkedCount = outcomes.length;
    } else if (profileState === 'DATA_UNAVAILABLE') {
      counts.dataUnavailableCount = outcomes.length;
    } else {
      for (const outcome of outcomes) {
        if (outcome.status === 'SOLVED') counts.solvedCount += 1;
        else if (outcome.status === 'ATTEMPTED_NOT_SOLVED') counts.attemptedNotSolvedCount += 1;
        else counts.notAttemptedCount += 1;
      }
    }

    const dailyStatus = await this.prisma.infosysDailyStatus.upsert({
      where: { studentId_dayKey: { studentId, dayKey } },
      create: { studentId, campusId, dayKey, infosysAssignmentId, ...counts },
      update: { infosysAssignmentId, ...counts },
    });

    const problemStatus: 'SOLVED' | 'ATTEMPTED_NOT_SOLVED' | 'NOT_ATTEMPTED' | 'PROFILE_NOT_LINKED' | 'DATA_UNAVAILABLE' =
      profileState === 'OK' ? 'NOT_ATTEMPTED' : profileState;

    for (const outcome of outcomes) {
      const status = profileState === 'OK' ? outcome.status : problemStatus;
      await this.prisma.infosysDailyProblemStatus.upsert({
        where: {
          infosysDailyStatusId_problemId: { infosysDailyStatusId: dailyStatus.id, problemId: outcome.problemId },
        },
        create: {
          infosysDailyStatusId: dailyStatus.id,
          problemId: outcome.problemId,
          position: outcome.position,
          status,
          solvedAt: profileState === 'OK' ? outcome.solvedAt : null,
          attempts: profileState === 'OK' ? outcome.attempts : 0,
        },
        update: {
          status,
          solvedAt: profileState === 'OK' ? outcome.solvedAt : null,
          attempts: profileState === 'OK' ? outcome.attempts : 0,
        },
      });
    }
  }
}
