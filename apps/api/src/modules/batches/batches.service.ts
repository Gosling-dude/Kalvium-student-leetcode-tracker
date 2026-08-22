/**
 * Batches — resolution, statistics, and the two operations that write batch history.
 *
 * Every other module asks this service "which batch?" rather than reading `batchId`
 * columns directly, for two reasons:
 *
 *  * **Resolution by code.** URLs and filters carry `A` / `foundation` / a UUID; the
 *    database carries a UUID. Centralising the lookup means no route has to know which
 *    form it was handed, and no route can accidentally accept a code that is not a real
 *    batch.
 *
 *  * **Historical placement.** `batchOnDay` answers "which batch was this student in on
 *    day D" from `StudentBatchHistory`, never from `Student.batchId`. That is the
 *    difference between a report that stays correct after someone is moved and one that
 *    silently rewrites itself (§7).
 *
 * Since campuses arrived, batch codes are unique *per campus* rather than globally: both
 * Vels and SRM have an `A`. `resolveSelector` therefore takes an optional campus, and a
 * bare code with no campus is only accepted while it still names exactly one batch —
 * answering with an arbitrary one is how an SRM assignment lands on Vels students. When a
 * request carries both halves of an audience, prefer `CampusesService.resolveScope`,
 * which validates the pair together.
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  deriveBatchCode,
  isRedundantMove,
  normaliseBatchCode,
  resolveBatchOnDay,
  type BatchHistoryEntry,
  type BatchPlacement,
  type BatchStats,
  type BatchSummary,
  type DayKey,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { CacheService } from '../../infra/cache/cache.service';

/** The batch selector a request may carry: a UUID, a code, or "everything". */
export type BatchSelector = string | null;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Friendly aliases accepted in query strings, so `?batch=foundation` works as well as
 * `?batch=A`. Resolution still goes through the database — these only map an alias to a
 * code, they never invent a batch.
 */
const CODE_ALIASES: Record<string, string> = {
  FOUNDATION: 'A',
  INTERMEDIATE: 'B',
};

@Injectable()
export class BatchesService {
  private readonly logger = new Logger(BatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Every batch, in display order, optionally narrowed to one campus.
   *
   * Ordered by campus first so an unfiltered list reads as `VELS/A, VELS/B, SRM/A, …`
   * rather than interleaving two campuses' Foundation rows, which is unreadable in a
   * picker and ambiguous in a report.
   */
  async findAll(includeArchived = false, campusId?: string | null): Promise<BatchSummary[]> {
    const batches = await this.prisma.batch.findMany({
      where: {
        ...(includeArchived ? {} : { status: 'ACTIVE' }),
        ...(campusId ? { campusId } : {}),
      },
      orderBy: [{ campus: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        campus: { select: { name: true, code: true } },
        // Current size means *current* students; archived students left the programme.
        _count: { select: { students: { where: { status: 'ACTIVE' } } } },
      },
    });

    return batches.map((batch) => this.toSummary(batch, batch._count.students));
  }

  async findById(id: string): Promise<BatchSummary> {
    const batch = await this.prisma.batch.findUnique({
      where: { id },
      include: {
        campus: { select: { name: true, code: true } },
        _count: { select: { students: { where: { status: 'ACTIVE' } } } },
      },
    });
    if (!batch) throw new NotFoundException(`Batch ${id} was not found`);
    return this.toSummary(batch, batch._count.students);
  }

  /**
   * Turn whatever a request carried into a batch id.
   *
   * `undefined`/empty means "all batches" and resolves to `null`, which every caller
   * treats as "do not filter". Anything else must name a real batch: an unknown code is
   * a 400, not a silent unfiltered query, because quietly widening a filter would show a
   * mentor another batch's students under their own batch's heading.
   */
  async resolveSelector(value?: string | null, campusId?: string | null): Promise<BatchSelector> {
    if (value === undefined || value === null) return null;

    const trimmed = value.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'all') return null;

    if (UUID_PATTERN.test(trimmed)) {
      const batch = await this.prisma.batch.findUnique({
        where: { id: trimmed },
        select: { id: true, campusId: true },
      });
      if (!batch) throw new NotFoundException(`Batch ${trimmed} was not found`);
      if (campusId && batch.campusId !== campusId) {
        throw new BadRequestException(
          `Batch ${trimmed} belongs to another campus. Pick a batch from the selected campus.`,
        );
      }
      return batch.id;
    }

    const code = normaliseBatchCode(trimmed);
    const resolved = CODE_ALIASES[code] ?? code;

    if (campusId) {
      const batch = await this.prisma.batch.findUnique({
        where: { campusId_code: { campusId, code: resolved } },
      });
      if (batch) return batch.id;
      const known = await this.prisma.batch.findMany({
        where: { campusId },
        select: { code: true },
        orderBy: { sortOrder: 'asc' },
      });
      throw new BadRequestException(
        `"${value}" is not a batch at the selected campus. Expected one of: ` +
          `${known.map((b) => b.code).join(', ')}, or "all".`,
      );
    }

    // No campus given. A code now names one batch *per campus*, so it is only usable
    // while exactly one matches; resolving an ambiguous code to whichever row came back
    // first would silently target the wrong campus.
    const candidates = await this.prisma.batch.findMany({
      where: { code: resolved },
      include: { campus: { select: { code: true } } },
    });
    if (candidates.length === 1 && candidates[0]) return candidates[0].id;
    if (candidates.length === 0) {
      const known = await this.prisma.batch.findMany({
        select: { code: true },
        orderBy: { sortOrder: 'asc' },
        distinct: ['code'],
      });
      throw new BadRequestException(
        `"${value}" is not a known batch. Expected one of: ${known.map((b) => b.code).join(', ')}, or "all".`,
      );
    }
    throw new BadRequestException(
      `"${value}" names a batch at ${candidates.length} campuses ` +
        `(${candidates.map((b) => b.campus.code).join(', ')}). Add a campus filter to say which.`,
    );
  }

  /**
   * A code that is free, derived from `name`.
   *
   * For the paths that create a batch from a name alone (the admin panel and the Excel
   * importer). Appends a counter on collision rather than failing, so importing a
   * spreadsheet whose batch name slugs to an existing code still succeeds.
   */
  async deriveAvailableCode(name: string, campusId: string): Promise<string> {
    const base = deriveBatchCode(name);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      // Scoped to the campus: `A` being taken at Vels must not stop SRM from having one.
      const taken = await this.prisma.batch.count({ where: { campusId, code: candidate } });
      if (taken === 0) return candidate;
    }
    // 50 batches sharing one slug is not a real scenario; fall back to something unique.
    return `${base}-${Date.now().toString(36).toUpperCase()}`.slice(0, 24);
  }

  /**
   * Lookup by code within a campus, used by the roster loaders. Returns null rather than
   * throwing.
   *
   * `campusId` is required rather than optional because every caller is importing into a
   * known campus, and a campus-less lookup would silently pick one of the two `A` batches.
   */
  async findByCode(
    code: string,
    campusId: string,
  ): Promise<{ id: string; name: string; code: string; campusId: string } | null> {
    const resolved = CODE_ALIASES[normaliseBatchCode(code)] ?? normaliseBatchCode(code);
    return this.prisma.batch.findUnique({
      where: { campusId_code: { campusId, code: resolved } },
      select: { id: true, name: true, code: true, campusId: true },
    });
  }

  // -------------------------------------------------------------------------
  // Historical placement
  // -------------------------------------------------------------------------

  /**
   * Which batch each of `studentIds` was in on `dayKey`.
   *
   * Batched deliberately: the rollup needs this for every student on every day, and one
   * query per student would turn a day's recompute into hundreds of round trips.
   *
   * Students with no placement effective by that day are absent from the map — they had
   * no batch then, and callers must not substitute the current one.
   */
  async batchOnDayForStudents(
    studentIds: string[],
    dayKey: DayKey,
  ): Promise<Map<string, string | null>> {
    if (studentIds.length === 0) return new Map();

    const rows = await this.prisma.studentBatchHistory.findMany({
      where: { studentId: { in: studentIds }, effectiveFromDayKey: { lte: dayKey } },
      select: {
        studentId: true,
        toBatchId: true,
        effectiveFromDayKey: true,
        changedAt: true,
      },
    });

    const byStudent = new Map<string, BatchPlacement[]>();
    for (const row of rows) {
      const list = byStudent.get(row.studentId) ?? [];
      list.push({
        toBatchId: row.toBatchId,
        effectiveFromDayKey: row.effectiveFromDayKey,
        changedAt: row.changedAt,
      });
      byStudent.set(row.studentId, list);
    }

    const resolved = new Map<string, string | null>();
    for (const [studentId, placements] of byStudent) {
      resolved.set(studentId, resolveBatchOnDay(placements, dayKey));
    }
    return resolved;
  }

  /** Single-student form of `batchOnDayForStudents`. */
  async batchOnDay(studentId: string, dayKey: DayKey): Promise<string | null> {
    const map = await this.batchOnDayForStudents([studentId], dayKey);
    return map.get(studentId) ?? null;
  }

  async getHistory(studentId: string): Promise<BatchHistoryEntry[]> {
    const rows = await this.prisma.studentBatchHistory.findMany({
      where: { studentId },
      include: {
        fromBatch: { select: { name: true, code: true } },
        toBatch: { select: { name: true, code: true } },
      },
      orderBy: [{ effectiveFromDayKey: 'desc' }, { changedAt: 'desc' }],
    });

    return rows.map(
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
    );
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  /**
   * Move a student to another batch, recording the change.
   *
   * What deliberately does *not* happen here: no submission, daily status, streak,
   * leaderboard entry, LeetCode record or email is touched. Only `Student.batchId`
   * changes, plus one appended history row. Past days keep the batch frozen on their
   * `DailyStatus`, so the move takes effect from today forward and yesterday's report
   * still reads as it did (§6, §7).
   *
   * `effectiveFromDayKey` defaults to today rather than to the student's enrolment day:
   * a mentor moving someone now is making a decision about now, and back-dating it would
   * retroactively re-file completed days under a batch the student was not in.
   */
  async moveStudent(input: {
    studentId: string;
    toBatchId: string;
    reason?: string | null;
    changedById?: string | null;
    changedByName?: string | null;
    effectiveFromDayKey?: DayKey;
    source?: 'MANUAL' | 'ROSTER_SYNC' | 'IMPORT' | 'MIGRATION';
  }): Promise<{ student: { id: string; name: string }; fromBatchId: string | null; toBatchId: string }> {
    const student = await this.prisma.student.findUnique({
      where: { id: input.studentId },
      select: { id: true, name: true, batchId: true, campusId: true },
    });
    if (!student) throw new NotFoundException(`Student ${input.studentId} was not found`);

    const target = await this.prisma.batch.findUnique({
      where: { id: input.toBatchId },
      select: { id: true, status: true, name: true, campusId: true, campus: { select: { name: true } } },
    });
    if (!target) throw new NotFoundException(`Batch ${input.toBatchId} was not found`);
    if (target.status !== 'ACTIVE') {
      throw new BadRequestException(`Batch "${target.name}" is archived — students cannot be moved into it.`);
    }

    // A batch move is a move *within* a campus. Allowing it to cross campuses here would
    // leave `Student.campusId` disagreeing with `batch.campusId` and would skip the
    // campus-history row entirely, so the transfer would be invisible to every audit
    // surface. Cross-campus movement goes through `CampusesService.transferStudent`,
    // which writes both halves (§16).
    if (student.campusId !== null && target.campusId !== student.campusId) {
      throw new BadRequestException(
        `"${target.name}" belongs to ${target.campus.name}, which is not ${student.name}'s campus. ` +
          'Use "Transfer campus" to move a student between campuses.',
      );
    }

    if (isRedundantMove(student.batchId, input.toBatchId)) {
      throw new BadRequestException(
        `${student.name} is already in ${target.name}. No change was recorded.`,
      );
    }

    const effectiveFrom = input.effectiveFromDayKey ?? this.time.today();

    await this.prisma.$transaction([
      this.prisma.student.update({
        where: { id: student.id },
        data: { batchId: input.toBatchId },
      }),
      this.prisma.studentBatchHistory.create({
        data: {
          studentId: student.id,
          fromBatchId: student.batchId,
          toBatchId: input.toBatchId,
          effectiveFromDayKey: effectiveFrom,
          reason: input.reason?.trim() || null,
          source: input.source ?? 'MANUAL',
          changedById: input.changedById ?? null,
          changedByName: input.changedByName ?? null,
        },
      }),
    ]);

    await this.invalidate();

    this.logger.log(
      `Moved student ${student.id} to batch ${target.name}, effective ${effectiveFrom}`,
    );

    return { student: { id: student.id, name: student.name }, fromBatchId: student.batchId, toBatchId: input.toBatchId };
  }

  /**
   * Record a placement without it being a "move" — used by the roster loader for a
   * student's *first* classification.
   *
   * Effective from the student's enrolment day, not today: the roster is stating what
   * has been true all along, not making a change now. Back-dating the first placement is
   * what lets an existing student's earlier days resolve to their batch instead of to
   * "no batch", and it cannot rewrite anything, because a `DailyStatus` that already
   * carries a batch is never re-stamped.
   */
  async recordInitialPlacement(input: {
    studentId: string;
    toBatchId: string;
    effectiveFromDayKey: DayKey;
    reason?: string | null;
    source?: 'MANUAL' | 'ROSTER_SYNC' | 'IMPORT' | 'MIGRATION';
    tx?: Prisma.TransactionClient;
  }): Promise<void> {
    const client = input.tx ?? this.prisma;
    await client.studentBatchHistory.create({
      data: {
        studentId: input.studentId,
        fromBatchId: null,
        toBatchId: input.toBatchId,
        effectiveFromDayKey: input.effectiveFromDayKey,
        reason: input.reason ?? null,
        source: input.source ?? 'ROSTER_SYNC',
      },
    });
  }

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  /**
   * The figures behind the Batch Management cards, for every batch — or for one campus's.
   *
   * `campusId` narrows the whole computation server-side rather than returning every
   * batch for the client to filter: with two campuses that is a nicety, and by the fifth
   * it is the difference between a card grid that loads and one that does not (§12, §27).
   */
  async getStats(dayKey?: DayKey, campusId?: string | null): Promise<BatchStats[]> {
    const day = dayKey ?? this.time.today();
    const batches = await this.prisma.batch.findMany({
      where: { status: 'ACTIVE', ...(campusId ? { campusId } : {}) },
      orderBy: [{ campus: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: { campus: { select: { name: true, code: true } } },
    });

    const stats: BatchStats[] = [];

    for (const batch of batches) {
      const [activeStudents, archivedStudents, beltAggregate, cohortGroups, assignment, statuses] =
        await Promise.all([
          this.prisma.student.count({ where: { batchId: batch.id, status: 'ACTIVE' } }),
          this.prisma.student.count({ where: { batchId: batch.id, status: 'ARCHIVED' } }),
          this.prisma.student.aggregate({
            where: { batchId: batch.id, status: 'ACTIVE', maxBeltLevel: { not: null } },
            _avg: { maxBeltLevel: true },
          }),
          this.prisma.student.groupBy({
            by: ['cohort'],
            where: { batchId: batch.id, status: 'ACTIVE' },
            _count: { _all: true },
          }),
          this.prisma.assignment.findFirst({
            where: { dayKey: day, batchId: batch.id },
            include: { _count: { select: { problems: true } } },
          }),
          this.prisma.dailyStatus.findMany({
            where: { dayKey: day, batchId: batch.id, student: { status: 'ACTIVE' } },
            select: { solvedCount: true, assignedCount: true },
          }),
        ]);

      const totalSolved = statuses.reduce((n, s) => n + s.solvedCount, 0);
      const totalAssigned = statuses.reduce((n, s) => n + s.assignedCount, 0);

      stats.push({
        ...this.toSummary(batch, activeStudents),
        activeStudents,
        archivedStudents,
        averageCompletionPercent:
          totalAssigned > 0 ? Math.round((totalSolved / totalAssigned) * 10000) / 100 : 0,
        averageBeltLevel:
          beltAggregate._avg.maxBeltLevel !== null
            ? Math.round(beltAggregate._avg.maxBeltLevel * 100) / 100
            : null,
        cohortCounts: cohortGroups
          .map((group) => ({ cohort: group.cohort, studentCount: group._count._all }))
          .sort((a, b) => (a.cohort ?? Number.MAX_SAFE_INTEGER) - (b.cohort ?? Number.MAX_SAFE_INTEGER)),
        assignedCount: assignment?._count.problems ?? 0,
        dayKey: day,
      });
    }

    return stats;
  }

  private async invalidate(): Promise<void> {
    await Promise.all([
      this.cache.delByPrefix('dashboard:'),
      this.cache.delByPrefix('mentor:'),
      this.cache.delByPrefix('leaderboard:'),
      this.cache.delByPrefix('batches:'),
    ]);
  }

  private toSummary(
    batch: {
      id: string;
      campusId: string;
      campus?: { name: string; code: string } | null;
      name: string;
      code: string;
      description: string | null;
      status: string;
      sortOrder: number;
      startDate: Date | null;
      isActive: boolean;
    },
    studentCount: number,
  ): BatchSummary {
    return {
      id: batch.id,
      campusId: batch.campusId,
      campusName: batch.campus?.name ?? '',
      campusCode: batch.campus?.code ?? '',
      name: batch.name,
      code: batch.code,
      description: batch.description,
      status: batch.status as BatchSummary['status'],
      sortOrder: batch.sortOrder,
      studentCount,
      startDate: batch.startDate?.toISOString() ?? null,
      isActive: batch.isActive,
    };
  }
}
