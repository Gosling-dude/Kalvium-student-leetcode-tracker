/**
 * Production cross-check for Attempts Analysis, for the smoke test.
 *
 * Runs the real `CampusAttemptsService` (what the page, drill-down and exports serve) and
 * an independent SQL implementation of the same rules — assignment period from the
 * assignment day until the same problem is next assigned to the student, submissions
 * de-duplicated by the mirror's own unique key, failed attempts stopping at the first
 * accepted — against the live database, and reports whether they agree.
 *
 * Aggregates only. This repository and its workflow logs are public, so nothing here
 * names a student or a LeetCode handle; a single student can be checked by id.
 */

import { Injectable } from '@nestjs/common';
import type { AttemptRow } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import type { RequestUser } from '../../common/decorators';
import { CampusAnalysisService } from '../analytics/campus-analysis.service';
import { CampusAttemptsService } from '../analytics/campus-attempts.service';

const SYSTEM: RequestUser = { id: '', email: 'integrity@internal', name: 'Integrity', role: 'ADMIN', studentId: null } as RequestUser;

interface Totals {
  attemptedNotSolved: number;
  solvedAfterAttempts: number;
  solvedFirstAttempt: number;
  totalFailedAttempts: number;
  attemptedPairs: number;
}

@Injectable()
export class AttemptsCheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campusAnalysis: CampusAnalysisService,
    private readonly attempts: CampusAttemptsService,
  ) {}

  private totals(rows: AttemptRow[]): Totals {
    return {
      attemptedNotSolved: rows.filter((r) => r.outcome === 'ATTEMPTED_NOT_SOLVED').length,
      solvedAfterAttempts: rows.filter((r) => r.outcome === 'SOLVED_AFTER_ATTEMPTS').length,
      solvedFirstAttempt: rows.filter((r) => r.outcome === 'SOLVED_FIRST_ATTEMPT').length,
      totalFailedAttempts: rows.reduce((sum, r) => sum + r.failedAttempts, 0),
      attemptedPairs: rows.filter((r) => r.attempts > 0).length,
    };
  }

  private async independent(campusIds: string[]): Promise<Totals> {
    const [row] = await this.prisma.$queryRaw<
      { ans: bigint; saa: bigint; sfa: bigint; failed: bigint | null; attempted: bigint }[]
    >`
      WITH pairs AS (
        SELECT DISTINCT ds."studentId", ds."dayKey" AS d, lower(p."titleSlug") AS slug
        FROM "daily_statuses" ds
        JOIN "daily_problem_statuses" dps ON dps."dailyStatusId" = ds.id
        JOIN "problems" p ON p.id = dps."problemId"
        JOIN "students" st ON st.id = ds."studentId"
        WHERE ds."assignmentId" IS NOT NULL
          AND st."status" = 'ACTIVE'
          AND st."campusId" = ANY(${campusIds}::uuid[])
      ), win AS (
        SELECT *, lead(d) OVER (PARTITION BY "studentId", slug ORDER BY d) AS next_d FROM pairs
      ), subs AS (
        SELECT w."studentId", w.d, w.slug, s."submittedAt",
               min(s."submittedAt") FILTER (WHERE s."status" = 'ACCEPTED')
                 OVER (PARTITION BY w."studentId", w.d, w.slug) AS first_ac
        FROM win w
        JOIN "submissions" s
          ON s."studentId" = w."studentId" AND lower(s."titleSlug") = w.slug
         AND s."dayKey" >= w.d AND (w.next_d IS NULL OR s."dayKey" < w.next_d)
      ), agg AS (
        SELECT "studentId", d, slug, max(first_ac) AS first_ac,
               count(*) FILTER (WHERE first_ac IS NULL OR "submittedAt" < first_ac) AS failed
        FROM subs GROUP BY 1, 2, 3
      )
      SELECT count(*) FILTER (WHERE first_ac IS NULL)                  AS ans,
             count(*) FILTER (WHERE first_ac IS NOT NULL AND failed > 0) AS saa,
             count(*) FILTER (WHERE first_ac IS NOT NULL AND failed = 0) AS sfa,
             sum(failed)                                                 AS failed,
             count(*)                                                    AS attempted
      FROM agg
    `;
    return {
      attemptedNotSolved: Number(row?.ans ?? 0),
      solvedAfterAttempts: Number(row?.saa ?? 0),
      solvedFirstAttempt: Number(row?.sfa ?? 0),
      totalFailedAttempts: Number(row?.failed ?? 0),
      attemptedPairs: Number(row?.attempted ?? 0),
    };
  }

  async report(studentId?: string) {
    const campusIds = await this.campusAnalysis.campusScope(SYSTEM);
    const campuses = await this.prisma.campus.findMany({
      where: { id: { in: campusIds } },
      select: { id: true, code: true },
      orderBy: { code: 'asc' },
    });

    const all = await this.attempts.analysis(SYSTEM, { view: 'ALL' });
    const service = this.totals(all.rows);
    const independent = await this.independent(campusIds);

    const byCampus = [];
    for (const campus of campuses) {
      const cut = await this.attempts.analysis(SYSTEM, { view: 'ALL', campusId: campus.id });
      const unsolved5 = await this.attempts.analysis(SYSTEM, { view: 'ATTEMPTED_NOT_SOLVED', campusId: campus.id, minAttempts: 5 });
      byCampus.push({
        campusCode: campus.code,
        campusCodesInRows: [...new Set(cut.rows.map((r) => r.campusCode))],
        ...this.totals(cut.rows),
        attemptedNotSolved5Plus: unsolved5.rows.length,
        summary: cut.summary,
      });
    }

    const weekly = (await this.campusAnalysis.summary(SYSTEM)).campuses.map((c) => ({
      campusCode: c.campusCode,
      questionsAssigned: c.assigned,
      questionsSolved: c.questionsSolved,
      studentQuestions: c.studentQuestions,
      solved: c.solved,
      attemptedNotSolved: c.attemptedNotSolved,
      notAttempted: c.notAttempted,
      noData: c.noData,
      weeksWithAttemptedNotSolved: c.weeks.filter((w) => w.attemptedNotSolved > 0).length,
      weeksWithQuestions: c.weeks.filter((w) => w.assigned > 0).length,
    }));

    let student = null;
    if (studentId) {
      const detail = await this.attempts.student(SYSTEM, studentId);
      student = {
        studentId,
        stats: detail.stats,
        // Counts and slugs only: no name, no handle.
        attemptedNotSolved: detail.rows
          .filter((r) => r.outcome === 'ATTEMPTED_NOT_SOLVED')
          .map((r) => ({ dayKey: r.dayKey, titleSlug: r.titleSlug, attempts: r.attempts, failedAttempts: r.failedAttempts })),
        solvedAfterAttempts: detail.rows
          .filter((r) => r.outcome === 'SOLVED_AFTER_ATTEMPTS')
          .map((r) => ({ dayKey: r.dayKey, titleSlug: r.titleSlug, attempts: r.attempts, failedAttempts: r.failedAttempts })),
      };
    }

    const lastSync = await this.prisma.studentSyncState.aggregate({ _max: { lastSuccessAt: true } });
    return {
      lastSuccessfulSyncAt: lastSync._max.lastSuccessAt,
      activeCampusCodes: campuses.map((c) => c.code),
      service,
      independent,
      agree: JSON.stringify(service) === JSON.stringify(independent),
      byCampus,
      weekly,
      student,
    };
  }
}
