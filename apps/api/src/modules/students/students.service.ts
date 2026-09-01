import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Student } from '@prisma/client';
import {
  completionPercentage,
  evaluateAchievements,
  heatmapIntensity,
  levelProgress,
  normaliseSquadNumber,
  type BatchHistoryEntry,
  type CampusHistoryEntry,
  type Paginated,
  type StudentProfile,
  type StudentSummary,
  type SyncStatus,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { StudentMetricsService } from '../scoring/student-metrics.service';
import { BatchesService } from '../batches/batches.service';
import { paginate, safeSortField } from '../../common/dto/pagination.dto';
import type { CreateStudentDto, StudentQueryDto, UpdateStudentDto } from './dto/student.dto';

const SORTABLE = [
  'name',
  'email',
  'createdAt',
  'currentStreak',
  'longestStreak',
  'totalSolved',
  'totalScore',
] as const;

type StudentWithRelations = Student & {
  batch: { id: string; name: string; code: string } | null;
  campus: { id: string; name: string; code: string } | null;
  squad: { id: string; name: string } | null;
  syncState: { status: string; lastSyncedAt: Date | null } | null;
};

/**
 * The relations every student projection needs.
 *
 * Named once rather than repeated at each call site: the five `include` blocks that used
 * to be written out by hand are exactly where a new relation gets forgotten on one route
 * and the campus column silently renders blank on that screen alone.
 */
const STUDENT_INCLUDE = {
  batch: true,
  campus: true,
  squad: true,
  syncState: true,
} as const;

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    private readonly metrics: StudentMetricsService,
    private readonly batches: BatchesService,
  ) {}

  /**
   * `scope` is authorization, not filtering, which is why it is a separate argument rather
   * than a field on `StudentQueryDto`. The DTO is parsed from the query string under
   * `forbidNonWhitelisted`, so anything declared on it is something a client is allowed to
   * send — and "which campuses may you read" is precisely the one value a caller must not
   * be able to supply.
   */
  async findAll(
    query: StudentQueryDto,
    scope: { campusIds?: string[] } = {},
  ): Promise<Paginated<StudentSummary>> {
    const where = this.buildWhere(query, scope);
    const sortBy = safeSortField(query.sortBy, SORTABLE, 'name');

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.student.findMany({
        where,
        include: STUDENT_INCLUDE,
        orderBy: { [sortBy]: query.sortOrder },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.student.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toSummary(row as StudentWithRelations)),
      total,
      query.page,
      query.pageSize,
    );
  }

  /**
   * Which campus a student sits at, or `undefined` when there is no such student.
   *
   * The two are kept apart so the caller can answer both with the *same* response —
   * "not found" and "not yours" must be indistinguishable, or student ids become an
   * oracle for which students exist at campuses you cannot see.
   */
  async campusOf(id: string): Promise<string | null | undefined> {
    const student = await this.prisma.student.findUnique({
      where: { id },
      select: { campusId: true },
    });
    return student === null ? undefined : student.campusId;
  }

  /**
   * A well-formed empty page, for a caller whose scope excludes everything they asked for.
   *
   * Returned instead of running the query at all: an empty result and a 403 tell a prober
   * different things, and only one of them is the caller's business. Built with the same
   * `paginate` helper as a real result so the two can never disagree about the envelope.
   */
  emptyPage(query: StudentQueryDto): Paginated<StudentSummary> {
    return paginate([], 0, query.page, query.pageSize);
  }

  async findOne(id: string): Promise<StudentSummary> {
    const student = await this.prisma.student.findUnique({
      where: { id },
      include: STUDENT_INCLUDE,
    });
    if (!student) throw new NotFoundException(`Student ${id} was not found`);
    return this.toSummary(student as StudentWithRelations);
  }

  async create(dto: CreateStudentDto): Promise<StudentSummary> {
    const student = await this.prisma.student.create({
      data: {
        name: dto.name,
        email: dto.email.toLowerCase(),
        phone: dto.phone ?? null,
        leetcodeUsername: dto.leetcodeUsername?.toLowerCase() ?? null,
        campusId: dto.campusId ?? null,
        batchId: dto.batchId ?? null,
        squadId: dto.squadId ?? null,
        cohort: dto.cohort ?? null,
        maxBeltLevel: dto.maxBeltLevel ?? null,
        status: dto.status ?? 'ACTIVE',
        syncState: { create: { status: 'NEVER_SYNCED' } },
        // A student created straight into a campus or batch starts their placement
        // history there, so a later report about today can resolve both without guessing.
        ...(dto.campusId
          ? {
              campusHistory: {
                create: {
                  toCampusId: dto.campusId,
                  effectiveFromDayKey: this.time.today(),
                  source: 'MANUAL' as const,
                  reason: 'Initial campus at creation',
                },
              },
            }
          : {}),
        ...(dto.batchId
          ? {
              batchHistory: {
                create: {
                  toBatchId: dto.batchId,
                  effectiveFromDayKey: this.time.today(),
                  source: 'MANUAL' as const,
                  reason: 'Initial placement at creation',
                },
              },
            }
          : {}),
      },
      include: STUDENT_INCLUDE,
    });
    return this.toSummary(student as StudentWithRelations);
  }

  async update(id: string, dto: UpdateStudentDto): Promise<StudentSummary> {
    const before = await this.prisma.student.findUnique({
      where: { id },
      select: { id: true, batchId: true, campusId: true, status: true, createdAt: true },
    });
    if (!before) throw new NotFoundException(`Student ${id} was not found`);

    // Changing the LeetCode handle invalidates the sync cursor: submissions already
    // mirrored belong to the *old* account, and the new one must be re-read from scratch.
    const usernameChanged = dto.leetcodeUsername !== undefined;

    // A batch change through this route is still a batch change: it must leave the same
    // history trail as `POST /students/:id/move-batch`, or a placement made here would
    // be invisible to every historical query.
    const batchChanged = dto.batchId !== undefined && dto.batchId !== before.batchId;

    // Same rule for campus. A campus change here must leave the same trail as
    // `POST /students/:id/transfer-campus`, or a transfer made through this route would
    // be invisible to every historical query and to the audit log (§16).
    const campusChanged = dto.campusId !== undefined && dto.campusId !== before.campusId;

    // Archiving through this route records *when*, so "removed from the programme" is a
    // dated fact rather than an inference from the current status.
    const archiving = dto.status === 'ARCHIVED' && before.status !== 'ARCHIVED';
    const unarchiving = dto.status !== undefined && dto.status !== 'ARCHIVED' && before.status === 'ARCHIVED';

    // A first classification states what has been true since enrolment; a genuine move is
    // a decision about today. Same rule as the bulk path and the roster importer.
    const batchEffectiveFrom = batchChanged
      ? await this.batches.defaultPlacementDay(before.id, before.createdAt)
      : this.time.today();

    const student = await this.prisma.student.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.email !== undefined ? { email: dto.email.toLowerCase() } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.leetcodeUsername !== undefined
          ? { leetcodeUsername: dto.leetcodeUsername.toLowerCase() }
          : {}),
        ...(dto.campusId !== undefined ? { campusId: dto.campusId } : {}),
        ...(dto.batchId !== undefined ? { batchId: dto.batchId } : {}),
        ...(dto.squadId !== undefined ? { squadId: dto.squadId } : {}),
        ...(dto.cohort !== undefined ? { cohort: dto.cohort } : {}),
        ...(dto.maxBeltLevel !== undefined ? { maxBeltLevel: dto.maxBeltLevel } : {}),
        ...(archiving ? { archivedAt: new Date() } : {}),
        ...(unarchiving ? { archivedAt: null, archivedReason: null } : {}),
        ...(campusChanged
          ? {
              campusHistory: {
                create: {
                  fromCampusId: before.campusId,
                  toCampusId: dto.campusId ?? null,
                  effectiveFromDayKey: this.time.today(),
                  source: 'MANUAL' as const,
                  reason: 'Campus changed via student update',
                },
              },
            }
          : {}),
        ...(batchChanged
          ? {
              batchHistory: {
                create: {
                  fromBatchId: before.batchId,
                  toBatchId: dto.batchId ?? null,
                  effectiveFromDayKey: batchEffectiveFrom,
                  source: 'MANUAL' as const,
                  reason: 'Batch changed via student update',
                },
              },
            }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(usernameChanged
          ? {
              syncState: {
                upsert: {
                  create: { status: 'NEVER_SYNCED' },
                  update: {
                    status: 'NEVER_SYNCED',
                    lastSubmissionAt: null,
                    lastProviderSubmissionId: null,
                    lastError: null,
                    consecutiveFailures: 0,
                  },
                },
              },
            }
          : {}),
      },
      include: STUDENT_INCLUDE,
    });

    return this.toSummary(student as StudentWithRelations);
  }

  /**
   * Delete a student outright — only when there is genuinely nothing to lose.
   *
   * A student with any history (submissions, daily statuses, leaderboard entries,
   * blockers, batch placements) is archived instead, because deleting them cascades that
   * history away and LeetCode cannot give it back: the provider exposes only the 20 most
   * recent submissions, so the local mirror is the sole copy of anything older (§2, §24,
   * §29). Callers that want a student gone from current views get exactly that from
   * archiving; nobody needs the rows destroyed.
   */
  async remove(id: string): Promise<{ deleted: boolean; archived: boolean }> {
    await this.assertExists(id);

    if (await this.hasHistory(id)) {
      await this.archive(id, 'Removed via admin delete — archived because history exists');
      return { deleted: false, archived: true };
    }

    await this.prisma.student.delete({ where: { id } });
    return { deleted: true, archived: false };
  }

  async removeMany(ids: string[]): Promise<{ deleted: number; archived: number }> {
    let deleted = 0;
    let archived = 0;
    for (const id of ids) {
      const result = await this.remove(id).catch(() => null);
      if (!result) continue;
      if (result.deleted) deleted += 1;
      if (result.archived) archived += 1;
    }
    return { deleted, archived };
  }

  /**
   * Archive a student out of the current programme, keeping every historical record.
   *
   * This is what "remove a student" means in this system. Their submissions, daily
   * statuses, streak history, leaderboard entries and email history all stay exactly as
   * they are; only their membership of the *current* roster ends, which is what removes
   * them from active counts, the dashboard, the daily tracker, leaderboards, new
   * assignments and daily emails.
   */
  async archive(id: string, reason: string): Promise<void> {
    await this.prisma.student.update({
      where: { id },
      data: { status: 'ARCHIVED', archivedAt: new Date(), archivedReason: reason },
    });
  }

  /** Whether anything irreplaceable hangs off this student. */
  private async hasHistory(id: string): Promise<boolean> {
    const [submissions, statuses, entries, blockers, placements] = await Promise.all([
      this.prisma.submission.count({ where: { studentId: id } }),
      this.prisma.dailyStatus.count({ where: { studentId: id } }),
      this.prisma.leaderboardEntry.count({ where: { studentId: id } }),
      this.prisma.blocker.count({ where: { studentId: id } }),
      this.prisma.studentBatchHistory.count({ where: { studentId: id } }),
    ]);
    return submissions + statuses + entries + blockers + placements > 0;
  }

  /**
   * Bulk reassignment — the operation mentors actually perform on a selection.
   *
   * Dividing an unclassified cohort into batches runs through here, so the effective day
   * of each history row follows `BatchesService.defaultPlacementDays`: a student's *first*
   * placement is back-dated to enrolment, a genuine move is effective today. Stamping the
   * whole selection with "today" is what leaves every earlier day resolving to "no batch",
   * which in turn makes batch-scoped assignments published before the split unmatchable.
   */
  async bulkUpdate(
    ids: string[],
    changes: { squadId?: string | null; batchId?: string | null; status?: string },
  ): Promise<number> {
    // A bulk batch change has to write one history row per student, so it cannot be a
    // single `updateMany`. Read the previous batches first, then write both sides.
    const previous =
      changes.batchId !== undefined
        ? await this.prisma.student.findMany({
            where: { id: { in: ids } },
            select: { id: true, batchId: true, createdAt: true },
          })
        : [];

    const result = await this.prisma.student.updateMany({
      where: { id: { in: ids } },
      data: {
        ...(changes.squadId !== undefined ? { squadId: changes.squadId } : {}),
        ...(changes.batchId !== undefined ? { batchId: changes.batchId } : {}),
        ...(changes.status !== undefined
          ? { status: changes.status as Student['status'] }
          : {}),
        ...(changes.status === 'ARCHIVED' ? { archivedAt: new Date() } : {}),
      },
    });

    const moved = previous.filter((student) => student.batchId !== changes.batchId);
    if (moved.length > 0) {
      const effectiveDays = await this.batches.defaultPlacementDays(moved);
      await this.prisma.studentBatchHistory.createMany({
        data: moved.map((student) => ({
          studentId: student.id,
          fromBatchId: student.batchId,
          toBatchId: changes.batchId ?? null,
          effectiveFromDayKey: effectiveDays.get(student.id) ?? this.time.today(),
          source: 'MANUAL' as const,
          reason: 'Bulk batch reassignment',
        })),
      });
    }

    return result.count;
  }

  /** Full profile page: level, achievements, heatmap and recent history. */
  async getProfile(id: string, days = 120): Promise<StudentProfile> {
    const student = await this.prisma.student.findUnique({
      where: { id },
      include: STUDENT_INCLUDE,
    });
    if (!student) throw new NotFoundException(`Student ${id} was not found`);

    const today = this.time.today();
    const from = this.time.addDays(today, -(days - 1));

    const [statuses, notes, achievements, placements, campusPlacements] =
      await this.prisma.$transaction([
      this.prisma.dailyStatus.findMany({
        where: { studentId: id, dayKey: { gte: from, lte: today } },
        orderBy: { dayKey: 'asc' },
      }),
      this.prisma.mentorNote.findMany({
        where: { studentId: id },
        include: { author: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.studentAchievement.findMany({ where: { studentId: id } }),
      this.prisma.studentBatchHistory.findMany({
        where: { studentId: id },
        include: {
          fromBatch: { select: { name: true, code: true } },
          toBatch: { select: { name: true, code: true } },
        },
        orderBy: [{ effectiveFromDayKey: 'desc' }, { changedAt: 'desc' }],
      }),
      this.prisma.studentCampusHistory.findMany({
        where: { studentId: id },
        include: {
          fromCampus: { select: { name: true, code: true } },
          toCampus: { select: { name: true, code: true } },
        },
        orderBy: [{ effectiveFromDayKey: 'desc' }, { changedAt: 'desc' }],
      }),
    ]);

    const week = this.time.weekBounds(today);
    const month = this.time.monthBounds(today);
    const inRange = (from_: string, to: string) =>
      statuses.filter((s) => s.dayKey >= from_ && s.dayKey <= to);

    const weekRows = inRange(week.from, week.to);
    const monthRows = inRange(month.from, month.to);

    const perfectDays = statuses.filter((s) => s.isPerfect).length;
    const earlyFinishes = statuses.filter(
      (s) => s.completionMinute !== null && s.completionMinute < 9 * 60,
    ).length;
    const weekendPerfect = statuses.filter(
      (s) => s.isPerfect && this.time.isWeekend(s.dayKey),
    ).length;

    const bestRank = await this.prisma.leaderboardEntry.aggregate({
      where: { studentId: id, period: 'DAILY' },
      _min: { rank: true },
    });

    // The five headline numbers, each derived by `StudentMetricsService` so this page
    // cannot disagree with the dashboard or the daily report about the same student.
    // "Total solved" here is lifetime LeetCode output — never today's assignment count.
    const [totalLeetcodeSolved, todayAssignment, dsaStreak, assignmentProblemsCompleted] =
      await Promise.all([
        this.metrics.calculateStudentLeetcodeTotalSolved(id),
        this.metrics.assignmentMetricsFor(id, today),
        this.metrics.calculateStudentDsaStreak(id, today),
        this.metrics.totalAssignmentProblemsCompleted(id),
      ]);

    const context = {
      currentStreak: dsaStreak.current,
      longestStreak: Math.max(student.longestStreak, dsaStreak.longest),
      totalSolved: totalLeetcodeSolved,
      perfectDays,
      perfectWeeks: 0,
      earlyFinishes,
      weekendPerfectDays: weekendPerfect,
      bestDailyRank: bestRank._min.rank ?? null,
      scoreImprovement: 0,
      hardSolved: student.hardSolved,
      mediumSolved: student.mediumSolved,
      distinctTopics: 0,
      activeDays: statuses.filter((s) => s.solvedCount > 0).length,
    };

    const unlocked = new Set(achievements.map((a) => a.code));
    const evaluated = evaluateAchievements(context).map((a) => ({
      ...a,
      // A badge already recorded as unlocked stays unlocked even if the underlying
      // statistic later dips — achievements are historical facts, not current state.
      earned: a.earned || unlocked.has(a.code),
    }));

    return {
      ...this.toSummary(student as StudentWithRelations),
      // Keep the summary's cached figures honest with what we just computed, so the
      // header and the metric tiles cannot show two different streaks.
      totalSolved: totalLeetcodeSolved,
      currentStreak: dsaStreak.current,
      levelProgress: levelProgress(student.totalScore),
      batchHistory: placements.map(
        (row): BatchHistoryEntry => ({
          id: row.id,
          studentId: row.studentId,
          fromBatchId: row.fromBatchId,
          fromBatchName: row.fromBatch?.name ?? null,
          fromBatchCode: row.fromBatch?.code ?? null,
          toBatchId: row.toBatchId,
          toBatchName: row.toBatch?.name ?? null,
          toBatchCode: row.toBatch?.code ?? null,
          effectiveFromDayKey: row.effectiveFromDayKey,
          reason: row.reason,
          source: row.source,
          changedById: row.changedById,
          changedByName: row.changedByName,
          changedAt: row.changedAt.toISOString(),
        }),
      ),
      campusHistory: campusPlacements.map(
        (row): CampusHistoryEntry => ({
          id: row.id,
          studentId: row.studentId,
          fromCampusId: row.fromCampusId,
          fromCampusName: row.fromCampus?.name ?? null,
          fromCampusCode: row.fromCampus?.code ?? null,
          toCampusId: row.toCampusId,
          toCampusName: row.toCampus?.name ?? null,
          toCampusCode: row.toCampus?.code ?? null,
          effectiveFromDayKey: row.effectiveFromDayKey,
          reason: row.reason,
          source: row.source,
          changedById: row.changedById,
          changedByName: row.changedByName,
          changedAt: row.changedAt.toISOString(),
        }),
      ),
      achievements: evaluated,
      difficultyBreakdown: {
        easy: student.easySolved,
        medium: student.mediumSolved,
        hard: student.hardSolved,
        total: totalLeetcodeSolved,
      },
      metrics: {
        totalLeetcodeSolved,
        dayKey: today,
        todayAssignment: {
          solvedCount: todayAssignment.solvedCount,
          assignedCount: todayAssignment.assignedCount,
          completionPercent: todayAssignment.completionPercent,
          hasAssignment: todayAssignment.hasAssignment,
        },
        currentDsaStreak: dsaStreak.current,
        longestDsaStreak: Math.max(student.longestStreak, dsaStreak.longest),
        totalAssignmentProblemsCompleted: assignmentProblemsCompleted,
      },
      heatmap: statuses.map((s) => ({
        dayKey: s.dayKey,
        solvedCount: s.solvedCount,
        assignedCount: s.assignedCount,
        intensity: heatmapIntensity(s.solvedCount, s.assignedCount),
      })),
      recentDays: statuses
        .slice(-30)
        .reverse()
        .map((s) => ({
          dayKey: s.dayKey,
          solvedCount: s.solvedCount,
          assignedCount: s.assignedCount,
          score: s.score,
          completionTime: this.time.localTime(s.completedAt),
        })),
      totalScore: student.totalScore,
      weeklyCompletionPercent: completionPercentage(
        weekRows.reduce((n, s) => n + s.solvedCount, 0),
        weekRows.reduce((n, s) => n + s.assignedCount, 0),
      ),
      monthlyCompletionPercent: completionPercentage(
        monthRows.reduce((n, s) => n + s.solvedCount, 0),
        monthRows.reduce((n, s) => n + s.assignedCount, 0),
      ),
      notes: notes.map((n) => ({
        id: n.id,
        body: n.body,
        authorId: n.authorId ?? '',
        authorName: n.author?.name ?? 'Unknown',
        createdAt: n.createdAt.toISOString(),
        updatedAt: n.updatedAt.toISOString(),
      })),
    };
  }

  async addNote(studentId: string, authorId: string, body: string, isPrivate = false) {
    await this.assertExists(studentId);
    return this.prisma.mentorNote.create({
      data: { studentId, authorId, body, isPrivate },
    });
  }

  async deleteNote(noteId: string): Promise<void> {
    await this.prisma.mentorNote.delete({ where: { id: noteId } });
  }

  /**
   * Distinct values powering the filter dropdowns.
   *
   * Batches and squads carry their campus so the directory's batch picker can narrow
   * itself when a campus is chosen, rather than offering two identically-named
   * "Foundation Level" options the user cannot tell apart (§10, §13).
   */
  async getFilterOptions() {
    const [campuses, batches, squads, squadNumbers] = await this.prisma.$transaction([
      this.prisma.campus.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: {
          _count: {
            select: {
              students: { where: { status: 'ACTIVE' } },
              batches: { where: { status: 'ACTIVE' } },
            },
          },
        },
      }),
      this.prisma.batch.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ campus: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
        include: {
          campus: { select: { name: true, code: true } },
          // Archived students have left the programme and are not part of a batch's size.
          _count: { select: { students: { where: { status: 'ACTIVE' } } } },
        },
      }),
      this.prisma.squad.findMany({
        orderBy: { name: 'asc' },
        include: {
          batch: { select: { name: true } },
          campus: { select: { id: true, name: true, code: true } },
          mentor: { select: { id: true, name: true } },
          _count: { select: { students: true } },
        },
      }),
      this.prisma.squad.findMany({
        where: { students: { some: { status: 'ACTIVE' } } },
        select: { name: true, campusId: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    return {
      campuses: campuses.map((c) => ({
        id: c.id,
        name: c.name,
        code: c.code,
        description: c.description,
        status: c.status,
        sortOrder: c.sortOrder,
        studentCount: c._count.students,
        batchCount: c._count.batches,
      })),
      batches: batches.map((b) => ({
        id: b.id,
        campusId: b.campusId,
        campusName: b.campus.name,
        campusCode: b.campus.code,
        name: b.name,
        code: b.code,
        description: b.description,
        status: b.status,
        sortOrder: b.sortOrder,
        studentCount: b._count.students,
        startDate: b.startDate?.toISOString() ?? null,
        isActive: b.isActive,
      })),
      squads: squads.map((g) => ({
        id: g.id,
        name: g.name,
        campusId: g.campusId,
        campusName: g.campus?.name ?? null,
        batchId: g.batchId,
        batchName: g.batch?.name ?? null,
        mentorId: g.mentorId,
        mentorName: g.mentor?.name ?? null,
        studentCount: g._count.students,
        color: g.color,
      })),
      /**
       * Squad *numbers* in use, per campus — what the directory's squad filter offers.
       *
       * Separate from `squads` because the two answer different questions: `squads` is
       * every squad record including empty ones, while this is the set a mentor can
       * usefully filter by. Numbers repeat across campuses (SRM's 83, Vels' 8), so the
       * campus travels with each one.
       */
      squadNumbers: squadNumbers
        .map((squad) => ({
          campusId: squad.campusId,
          number: normaliseSquadNumber(squad.name),
          label: squad.name,
        }))
        .filter((entry): entry is { campusId: string | null; number: number; label: string } =>
          entry.number !== null,
        )
        .sort((a, b) => a.number - b.number),
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Which students a query may see.
   *
   * The default excludes archived students: they have left the programme, and a plain
   * `GET /students` is a question about the *current* roster (§21, §24). They are
   * reachable only by asking for them explicitly — `status=ARCHIVED` for just them, or
   * `includeArchived=true` alongside everyone else — so no screen shows them by
   * accident while every historical record still points at them.
   */
  private buildWhere(
    query: StudentQueryDto,
    scope: { campusIds?: string[] } = {},
  ): Prisma.StudentWhereInput {
    const search = query.search?.trim();

    const archiveScope: Prisma.StudentWhereInput = query.status
      ? {} // An explicit status filter is the caller naming exactly what they want.
      : query.includeArchived
        ? {}
        : { status: { not: 'ARCHIVED' } };

    return {
      ...archiveScope,
      ...(query.squadId ? { squadId: query.squadId } : {}),
      // A single campus when one was asked for and permitted; otherwise the set the
      // caller may read, which reaches here from their mentor grants and never from the
      // request.
      ...(query.campusId
        ? { campusId: query.campusId }
        : scope.campusIds
          ? { campusId: { in: scope.campusIds } }
          : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.squadNumber !== undefined
        ? // Squad names are stored as "Squad 144"; matching the number alone would also
          // catch "Squad 1440". Anchoring both ends keeps 144 and 1440 distinct.
          { squad: { name: { in: [`Squad ${query.squadNumber}`, `${query.squadNumber}`] } } }
        : {}),
      // "Not assigned" is simply the absence of a batch — not a batch of its own, so it
      // is a `NULL` test rather than a code comparison.
      ...(query.unassigned ? { batchId: null } : {}),
      ...(query.cohort !== undefined ? { cohort: query.cohort } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.syncStatus ? { syncState: { status: query.syncStatus } } : {}),
      ...(query.minStreak !== undefined ? { currentStreak: { gte: query.minStreak } } : {}),
      ...(search
        ? {
            // `AND` rather than a second `OR` key: an object literal can only carry one
            // `OR`, so combining search with the placement filter above by spreading
            // would silently drop whichever came first.
            AND: [
              {
                OR: [
                  { name: { contains: search, mode: 'insensitive' } },
                  { email: { contains: search, mode: 'insensitive' } },
                  { leetcodeUsername: { contains: search, mode: 'insensitive' } },
                  { squad: { name: { contains: search, mode: 'insensitive' } } },
                  { batch: { name: { contains: search, mode: 'insensitive' } } },
                  { campus: { name: { contains: search, mode: 'insensitive' } } },
                ],
              },
            ],
          }
        : {}),
    };
  }

  private async assertExists(id: string): Promise<void> {
    const count = await this.prisma.student.count({ where: { id } });
    if (count === 0) throw new NotFoundException(`Student ${id} was not found`);
  }

  private toSummary(student: StudentWithRelations): StudentSummary {
    return {
      id: student.id,
      name: student.name,
      email: student.email,
      phone: student.phone,
      leetcodeUsername: student.leetcodeUsername,
      status: student.status,
      campusId: student.campusId,
      campusName: student.campus?.name ?? null,
      campusCode: student.campus?.code ?? null,
      batchId: student.batchId,
      batchName: student.batch?.name ?? null,
      batchCode: student.batch?.code ?? null,
      squadNumber: normaliseSquadNumber(student.squad?.name ?? null),
      cohort: student.cohort,
      maxBeltLevel: student.maxBeltLevel,
      squadId: student.squadId,
      squadName: student.squad?.name ?? null,
      avatarUrl: student.avatarUrl,
      syncStatus: (student.syncState?.status ?? 'NEVER_SYNCED') as SyncStatus,
      lastSyncedAt: student.syncState?.lastSyncedAt?.toISOString() ?? null,
      currentStreak: student.currentStreak,
      longestStreak: student.longestStreak,
      totalSolved: student.totalSolved,
      archivedAt: student.archivedAt?.toISOString() ?? null,
      archivedReason: student.archivedReason,
      createdAt: student.createdAt.toISOString(),
    };
  }
}
