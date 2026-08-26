/**
 * Campuses — resolution, scoping, statistics, and the two operations that write campus
 * history.
 *
 * Every other module asks this service "which campus?" rather than reading `campusId`
 * columns directly, for the same three reasons `BatchesService` exists:
 *
 *  * **Resolution by code.** URLs and filters carry `SRM` / `vels` / a UUID / `all`; the
 *    database carries a UUID. One lookup means no route has to know which form it was
 *    handed, and no route can widen a filter by accepting a code that is not a campus.
 *
 *  * **Scope validation.** A campus + batch pair has exactly one illegal shape — a batch
 *    whose campus is not the one named — and `resolveScope` is the single place that
 *    rejects it. Without that, a mis-filed assignment would be invisible to the campus
 *    filter it belongs to.
 *
 *  * **Historical placement.** `campusOnDay` answers "which campus was this student in on
 *    day D" from `StudentCampusHistory`, never from `Student.campusId`. That is the
 *    difference between a report that stays correct after a transfer and one that
 *    silently rewrites itself (§17).
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ALL_CAMPUSES,
  deriveCampusCode,
  normaliseCampusCode,
  resolveCampusOnDay,
  UNASSIGNED_BATCH_SELECTOR,
  type AudienceScope,
  type BatchSummary,
  type CampusHistoryEntry,
  type CampusPlacement,
  type CampusStats,
  type CampusSummary,
  type DayKey,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { CacheService } from '../../infra/cache/cache.service';

/** The campus selector a request may carry: a UUID, a code, or "everything". */
export type CampusSelector = string | null;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `Campus → Batch` audience a request resolved to, with both names attached.
 *
 * Names travel with the ids because nearly every consumer needs them immediately — the
 * assignment preview, the history table, the email subject — and re-fetching them per
 * caller is how "SRM University — Foundation" ends up rendered four different ways.
 */
export interface ResolvedScope extends AudienceScope {
  campusName: string | null;
  campusCode: string | null;
  batchName: string | null;
  batchCode: string | null;
  /**
   * The caller asked for students with **no batch**, which is a third state a batch id
   * cannot express: `batchId: null` already means "every batch". Consumers that support
   * it filter on `batchId IS NULL`; those that do not ignore it and show everything,
   * which is the safe direction to be wrong in.
   */
  onlyUnassigned: boolean;
}

/** The batches every campus starts with — see `CampusesService.create`. */
const DEFAULT_BATCHES = [
  { name: 'Foundation Level', code: 'A', description: 'Batch A — Foundation Level', sortOrder: 1 },
  {
    name: 'Intermediate Level',
    code: 'B',
    description: 'Batch B — Intermediate Level',
    sortOrder: 2,
  },
] as const;

@Injectable()
export class CampusesService {
  private readonly logger = new Logger(CampusesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    private readonly cache: CacheService,
  ) {}

  /** Every campus, in display order. */
  async findAll(includeArchived = false): Promise<CampusSummary[]> {
    const campuses = await this.prisma.campus.findMany({
      where: includeArchived ? {} : { status: 'ACTIVE' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: {
            // Current size means *current* students; archived students left the programme.
            students: { where: { status: 'ACTIVE' } },
            batches: { where: { status: 'ACTIVE' } },
          },
        },
      },
    });

    return campuses.map((campus) =>
      this.toSummary(campus, campus._count.students, campus._count.batches),
    );
  }

  async findById(id: string): Promise<CampusSummary> {
    const campus = await this.prisma.campus.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            students: { where: { status: 'ACTIVE' } },
            batches: { where: { status: 'ACTIVE' } },
          },
        },
      },
    });
    if (!campus) throw new NotFoundException(`Campus ${id} was not found`);
    return this.toSummary(campus, campus._count.students, campus._count.batches);
  }

  /**
   * Turn whatever a request carried into a campus id.
   *
   * `undefined`/empty/`all` means "every campus" and resolves to `null`, which every
   * caller treats as "do not filter". Anything else must name a real campus: an unknown
   * code is a 400 rather than a silently unfiltered query, because quietly widening a
   * filter would show a mentor SRM's students under a Vels heading.
   */
  async resolveSelector(value?: string | null): Promise<CampusSelector> {
    if (value === undefined || value === null) return null;

    const trimmed = value.trim();
    if (trimmed === '' || trimmed.toLowerCase() === ALL_CAMPUSES) return null;

    if (UUID_PATTERN.test(trimmed)) {
      const exists = await this.prisma.campus.count({ where: { id: trimmed } });
      if (exists === 0) throw new NotFoundException(`Campus ${trimmed} was not found`);
      return trimmed;
    }

    const campus = await this.prisma.campus.findUnique({
      where: { code: normaliseCampusCode(trimmed) },
    });
    if (!campus) {
      const known = await this.prisma.campus.findMany({
        select: { code: true },
        orderBy: { sortOrder: 'asc' },
      });
      throw new BadRequestException(
        `"${value}" is not a known campus. Expected one of: ${known.map((c) => c.code).join(', ')}, or "all".`,
      );
    }
    return campus.id;
  }

  /**
   * Resolve a `campus` + `batch` pair from a request into a validated audience.
   *
   * Three rules, all of which exist because breaking any one of them produces data that
   * looks fine and filters wrong:
   *
   *  1. A batch is resolved *within* its campus. `?campus=SRM&batch=A` must find SRM's
   *     Foundation, never Vels'.
   *  2. Naming a batch without a campus is only legal when the batch id is unambiguous —
   *     a UUID identifies exactly one batch, so the campus is inferred from it. A bare
   *     code like `A` with no campus is rejected, because it names two batches.
   *  3. A batch that belongs to another campus is a 400, not a silent reinterpretation.
   */
  async resolveScope(input: {
    campus?: string | null;
    batch?: string | null;
  }): Promise<ResolvedScope> {
    const campusId = await this.resolveSelector(input.campus);
    const rawBatch = (input.batch ?? '').trim();

    if (rawBatch === '' || rawBatch.toLowerCase() === 'all') {
      const campus = campusId ? await this.campusRef(campusId) : null;
      return {
        campusId,
        batchId: null,
        campusName: campus?.name ?? null,
        campusCode: campus?.code ?? null,
        batchName: null,
        batchCode: null,
        onlyUnassigned: false,
      };
    }

    // "Not assigned" — enrolled, but not yet placed into a level. Not a batch, so it
    // resolves to a flag rather than to an id.
    if (rawBatch.toLowerCase() === UNASSIGNED_BATCH_SELECTOR) {
      const campus = campusId ? await this.campusRef(campusId) : null;
      return {
        campusId,
        batchId: null,
        campusName: campus?.name ?? null,
        campusCode: campus?.code ?? null,
        batchName: null,
        batchCode: null,
        onlyUnassigned: true,
      };
    }

    const batch = await this.findBatch(campusId, rawBatch);

    if (campusId !== null && batch.campusId !== campusId) {
      const [named, owning] = await Promise.all([
        this.campusRef(campusId),
        this.campusRef(batch.campusId),
      ]);
      throw new BadRequestException(
        `Batch "${batch.name}" belongs to ${owning?.name ?? 'another campus'}, not to ` +
          `${named?.name ?? 'the campus requested'}. Pick a batch from that campus.`,
      );
    }

    const campus = await this.campusRef(batch.campusId);
    return {
      campusId: batch.campusId,
      batchId: batch.id,
      campusName: campus?.name ?? null,
      campusCode: campus?.code ?? null,
      batchName: batch.name,
      batchCode: batch.code,
      onlyUnassigned: false,
    };
  }

  /**
   * Resolve a batch selector inside a campus.
   *
   * Split out of `resolveScope` because the assignment and baseline creators need it for
   * each of several targets, and re-deriving "was that a UUID or a code" per caller is
   * how `?batch=a` starts working on one route and 400ing on another.
   */
  async findBatch(
    campusId: string | null,
    selector: string,
  ): Promise<{ id: string; name: string; code: string; campusId: string; status: string }> {
    const trimmed = selector.trim();

    if (UUID_PATTERN.test(trimmed)) {
      const batch = await this.prisma.batch.findUnique({ where: { id: trimmed } });
      if (!batch) throw new NotFoundException(`Batch ${trimmed} was not found`);
      return batch;
    }

    const code = this.canonicalBatchCode(trimmed);

    if (campusId === null) {
      // A bare code names one batch per campus, so without a campus it names several.
      // Answering with an arbitrary one is how an SRM assignment lands on Vels.
      const candidates = await this.prisma.batch.findMany({
        where: { code },
        include: { campus: { select: { name: true, code: true } } },
      });
      if (candidates.length === 1 && candidates[0]) return candidates[0];
      if (candidates.length === 0) {
        throw new BadRequestException(`"${selector}" is not a known batch at any campus.`);
      }
      throw new BadRequestException(
        `"${selector}" names a batch at ${candidates.length} campuses ` +
          `(${candidates.map((b) => b.campus.code).join(', ')}). Say which campus you mean.`,
      );
    }

    const batch = await this.prisma.batch.findUnique({
      where: { campusId_code: { campusId, code } },
    });
    if (!batch) {
      const known = await this.prisma.batch.findMany({
        where: { campusId },
        select: { code: true },
        orderBy: { sortOrder: 'asc' },
      });
      throw new BadRequestException(
        `"${selector}" is not a batch at this campus. Expected one of: ` +
          `${known.map((b) => b.code).join(', ')}, or "all".`,
      );
    }
    return batch;
  }

  /**
   * Friendly aliases accepted in query strings, so `?batch=foundation` works as well as
   * `?batch=A`. Resolution still goes through the database — these only map an alias to a
   * code, they never invent a batch.
   */
  private canonicalBatchCode(raw: string): string {
    const code = raw.trim().toUpperCase();
    const aliases: Record<string, string> = {
      FOUNDATION: 'A',
      INTERMEDIATE: 'B',
    };
    return aliases[code] ?? code;
  }

  /** Batches at one campus, in display order. Drives the campus-dependent batch picker. */
  async batchesForCampus(campusId: string, includeArchived = false): Promise<BatchSummary[]> {
    const batches = await this.prisma.batch.findMany({
      where: { campusId, ...(includeArchived ? {} : { status: 'ACTIVE' }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        campus: { select: { name: true, code: true } },
        _count: { select: { students: { where: { status: 'ACTIVE' } } } },
      },
    });

    return batches.map((batch) => ({
      id: batch.id,
      campusId: batch.campusId,
      campusName: batch.campus.name,
      campusCode: batch.campus.code,
      name: batch.name,
      code: batch.code,
      description: batch.description,
      status: batch.status as BatchSummary['status'],
      sortOrder: batch.sortOrder,
      studentCount: batch._count.students,
      startDate: batch.startDate?.toISOString() ?? null,
      isActive: batch.isActive,
    }));
  }

  /** Lookup by code, used by the roster loaders. Returns null rather than throwing. */
  /**
   * Create a campus, with the standard batches that make it usable.
   *
   * Lives here rather than in the HTTP controller because two callers need it: an admin
   * creating one by hand, and a roster import onboarding an institution the system has not
   * seen before. A second copy would eventually disagree about the clash rules or forget
   * the default batches — and a campus with no batches can hold no students and receive no
   * assignments, which looks like a silent import failure rather than a setup gap.
   */
  async create(input: {
    name: string;
    code?: string;
    description?: string | null;
    sortOrder?: number;
    createDefaultBatches?: boolean;
  }): Promise<{ id: string; name: string; code: string }> {
    const code = input.code ?? (await this.deriveAvailableCode(input.name));

    // Name and code are independently unique, so both are checked — and reported apart,
    // because "that code is taken" and "that name is taken" need different corrections.
    const clash = await this.prisma.campus.findFirst({
      where: { OR: [{ code }, { name: input.name }] },
      select: { code: true, name: true },
    });
    if (clash) {
      throw new BadRequestException(
        clash.code === code
          ? `A campus with code "${code}" already exists.`
          : `A campus named "${input.name}" already exists.`,
      );
    }

    const created = await this.prisma.campus.create({
      data: {
        name: input.name,
        code,
        description: input.description ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
      select: { id: true, name: true, code: true },
    });

    if (input.createDefaultBatches !== false) {
      await this.prisma.batch.createMany({
        data: DEFAULT_BATCHES.map((batch) => ({ ...batch, campusId: created.id })),
        skipDuplicates: true,
      });
    }

    return created;
  }

  async findByCode(code: string): Promise<{ id: string; name: string; code: string } | null> {
    return this.prisma.campus.findUnique({
      where: { code: normaliseCampusCode(code) },
      select: { id: true, name: true, code: true },
    });
  }

  /** A code that is free, derived from `name` — mirrors `BatchesService.deriveAvailableCode`. */
  async deriveAvailableCode(name: string): Promise<string> {
    const base = deriveCampusCode(name);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await this.prisma.campus.count({ where: { code: candidate } });
      if (taken === 0) return candidate;
    }
    return `${base}-${Date.now().toString(36).toUpperCase()}`.slice(0, 24);
  }

  // -------------------------------------------------------------------------
  // Historical placement
  // -------------------------------------------------------------------------

  /**
   * Which campus each of `studentIds` was in on `dayKey`.
   *
   * Batched deliberately: the rollup needs this for every student on every day, and one
   * query per student would turn a day's recompute into hundreds of round trips (§27).
   *
   * Students with no placement effective by that day are absent from the map — they had
   * no campus then, and callers must not substitute the current one.
   */
  async campusOnDayForStudents(
    studentIds: string[],
    dayKey: DayKey,
  ): Promise<Map<string, string | null>> {
    if (studentIds.length === 0) return new Map();

    const rows = await this.prisma.studentCampusHistory.findMany({
      where: { studentId: { in: studentIds }, effectiveFromDayKey: { lte: dayKey } },
      select: {
        studentId: true,
        toCampusId: true,
        effectiveFromDayKey: true,
        changedAt: true,
      },
    });

    const byStudent = new Map<string, CampusPlacement[]>();
    for (const row of rows) {
      const list = byStudent.get(row.studentId) ?? [];
      list.push({
        toCampusId: row.toCampusId,
        effectiveFromDayKey: row.effectiveFromDayKey,
        changedAt: row.changedAt,
      });
      byStudent.set(row.studentId, list);
    }

    const resolved = new Map<string, string | null>();
    for (const [studentId, placements] of byStudent) {
      resolved.set(studentId, resolveCampusOnDay(placements, dayKey));
    }
    return resolved;
  }

  /** Single-student form of `campusOnDayForStudents`. */
  async campusOnDay(studentId: string, dayKey: DayKey): Promise<string | null> {
    const map = await this.campusOnDayForStudents([studentId], dayKey);
    return map.get(studentId) ?? null;
  }

  async getHistory(studentId: string): Promise<CampusHistoryEntry[]> {
    const rows = await this.prisma.studentCampusHistory.findMany({
      where: { studentId },
      include: {
        fromCampus: { select: { name: true, code: true } },
        toCampus: { select: { name: true, code: true } },
      },
      orderBy: [{ effectiveFromDayKey: 'desc' }, { changedAt: 'desc' }],
    });

    return rows.map(
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
    );
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  /**
   * Transfer a student to another campus, recording the change.
   *
   * A campus transfer necessarily moves the student's batch too — batches belong to
   * campuses, so staying in `VELS/Foundation` while being at SRM is not a state that can
   * exist. The caller therefore names the destination batch, and both changes are written
   * in one transaction with a history row each: leaving one of the two out is how a
   * student ends up at SRM in one view and Vels in another.
   *
   * What deliberately does *not* happen: no submission, daily status, streak, leaderboard
   * entry or email is touched. Past days keep their frozen `campusId`/`batchId`, so the
   * transfer takes effect from today forward and yesterday's report still reads as it did
   * (§16, §17).
   */
  async transferStudent(input: {
    studentId: string;
    toCampusId: string;
    toBatchId?: string | null;
    reason?: string | null;
    changedById?: string | null;
    changedByName?: string | null;
    effectiveFromDayKey?: DayKey;
    source?: 'MANUAL' | 'ROSTER_SYNC' | 'IMPORT' | 'MIGRATION';
  }): Promise<{
    student: { id: string; name: string };
    fromCampusId: string | null;
    toCampusId: string;
    fromBatchId: string | null;
    toBatchId: string | null;
  }> {
    const student = await this.prisma.student.findUnique({
      where: { id: input.studentId },
      select: { id: true, name: true, campusId: true, batchId: true },
    });
    if (!student) throw new NotFoundException(`Student ${input.studentId} was not found`);

    const target = await this.prisma.campus.findUnique({
      where: { id: input.toCampusId },
      select: { id: true, status: true, name: true },
    });
    if (!target) throw new NotFoundException(`Campus ${input.toCampusId} was not found`);
    if (target.status !== 'ACTIVE') {
      throw new BadRequestException(
        `${target.name} is archived — students cannot be transferred into it.`,
      );
    }

    if (student.campusId === input.toCampusId && (input.toBatchId ?? null) === student.batchId) {
      throw new BadRequestException(
        `${student.name} is already at ${target.name} in that batch. No change was recorded.`,
      );
    }

    // Resolve the destination batch before writing anything. A transfer that left the
    // student pointing at their old campus's batch would be worse than a rejected one.
    let toBatchId: string | null = null;
    if (input.toBatchId) {
      const batch = await this.prisma.batch.findUnique({
        where: { id: input.toBatchId },
        select: { id: true, campusId: true, name: true, status: true },
      });
      if (!batch) throw new NotFoundException(`Batch ${input.toBatchId} was not found`);
      if (batch.campusId !== input.toCampusId) {
        throw new BadRequestException(
          `Batch "${batch.name}" does not belong to ${target.name}. Pick one of its batches.`,
        );
      }
      if (batch.status !== 'ACTIVE') {
        throw new BadRequestException(
          `Batch "${batch.name}" is archived — students cannot be moved into it.`,
        );
      }
      toBatchId = batch.id;
    }
    // No batch named leaves the student unassigned at the destination, which is the
    // honest outcome of a transfer with no placement decision: they have arrived, and
    // which level they belong to at the new campus has not been decided. Inventing one —
    // or carrying the old campus's level across — would state something nobody determined.

    const effectiveFrom = input.effectiveFromDayKey ?? this.time.today();
    const campusChanged = student.campusId !== input.toCampusId;
    const batchChanged = student.batchId !== toBatchId;

    await this.prisma.$transaction([
      this.prisma.student.update({
        where: { id: student.id },
        data: { campusId: input.toCampusId, batchId: toBatchId },
      }),
      ...(campusChanged
        ? [
            this.prisma.studentCampusHistory.create({
              data: {
                studentId: student.id,
                fromCampusId: student.campusId,
                toCampusId: input.toCampusId,
                effectiveFromDayKey: effectiveFrom,
                reason: input.reason?.trim() || null,
                source: input.source ?? 'MANUAL',
                changedById: input.changedById ?? null,
                changedByName: input.changedByName ?? null,
              },
            }),
          ]
        : []),
      ...(batchChanged
        ? [
            this.prisma.studentBatchHistory.create({
              data: {
                studentId: student.id,
                fromBatchId: student.batchId,
                toBatchId,
                effectiveFromDayKey: effectiveFrom,
                reason:
                  input.reason?.trim() ||
                  `Campus transfer to ${target.name}.`,
                source: input.source ?? 'MANUAL',
                changedById: input.changedById ?? null,
                changedByName: input.changedByName ?? null,
              },
            }),
          ]
        : []),
    ]);

    await this.invalidate();

    this.logger.log(
      `Transferred student ${student.id} to campus ${target.name}, effective ${effectiveFrom}`,
    );

    return {
      student: { id: student.id, name: student.name },
      fromCampusId: student.campusId,
      toCampusId: input.toCampusId,
      fromBatchId: student.batchId,
      toBatchId,
    };
  }

  /**
   * Record a campus placement without it being a "transfer" — used by the roster loaders
   * for a student's *first* enrolment.
   *
   * Effective from the enrolment day rather than today: the roster is stating what has
   * been true since they joined, not making a change now. Mirrors
   * `BatchesService.recordInitialPlacement` exactly, including the transaction hook, so
   * an importer can write both placements inside one transaction.
   */
  async recordInitialPlacement(input: {
    studentId: string;
    toCampusId: string;
    effectiveFromDayKey: DayKey;
    reason?: string | null;
    source?: 'MANUAL' | 'ROSTER_SYNC' | 'IMPORT' | 'MIGRATION';
    tx?: Prisma.TransactionClient;
  }): Promise<void> {
    const client = input.tx ?? this.prisma;
    await client.studentCampusHistory.create({
      data: {
        studentId: input.studentId,
        fromCampusId: null,
        toCampusId: input.toCampusId,
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
   * The figures behind the campus cards and the campus-aware dashboard.
   *
   * Deliberately three grouped queries plus one batch listing, rather than a loop over
   * campuses issuing four queries each: with two campuses the difference is invisible, and
   * with ten it is the difference between a dashboard that loads and one that does not (§27).
   */
  async getStats(dayKey?: DayKey): Promise<CampusStats[]> {
    const day = dayKey ?? this.time.today();

    const [campuses, studentGroups, unassignedGroups, statusRows] = await Promise.all([
      this.prisma.campus.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.student.groupBy({
        by: ['campusId', 'status'],
        _count: { _all: true },
        where: { status: { in: ['ACTIVE', 'ARCHIVED'] } },
      }),
      // Unassigned means exactly what it says: no batch yet.
      this.prisma.student.findMany({
        where: { status: 'ACTIVE', batchId: null },
        select: { campusId: true },
      }),
      this.prisma.dailyStatus.groupBy({
        by: ['campusId'],
        where: { dayKey: day, student: { status: 'ACTIVE' } },
        _sum: { solvedCount: true, assignedCount: true },
      }),
    ]);

    const batchesByCampus = new Map<string, BatchSummary[]>();
    for (const campus of campuses) {
      batchesByCampus.set(campus.id, await this.batchesForCampus(campus.id));
    }

    const activeByCampus = new Map<string, number>();
    const archivedByCampus = new Map<string, number>();
    for (const group of studentGroups) {
      if (!group.campusId) continue;
      const target = group.status === 'ACTIVE' ? activeByCampus : archivedByCampus;
      target.set(group.campusId, (target.get(group.campusId) ?? 0) + group._count._all);
    }

    const unassignedByCampus = new Map<string, number>();
    for (const row of unassignedGroups) {
      if (!row.campusId) continue;
      unassignedByCampus.set(row.campusId, (unassignedByCampus.get(row.campusId) ?? 0) + 1);
    }

    const completionByCampus = new Map<string, number>();
    for (const row of statusRows) {
      if (!row.campusId) continue;
      const assigned = row._sum.assignedCount ?? 0;
      const solved = row._sum.solvedCount ?? 0;
      completionByCampus.set(
        row.campusId,
        assigned > 0 ? Math.round((solved / assigned) * 10000) / 100 : 0,
      );
    }

    return campuses.map((campus): CampusStats => {
      const batches = batchesByCampus.get(campus.id) ?? [];
      const activeStudents = activeByCampus.get(campus.id) ?? 0;
      return {
        ...this.toSummary(campus, activeStudents, batches.length),
        activeStudents,
        archivedStudents: archivedByCampus.get(campus.id) ?? 0,
        unassignedStudents: unassignedByCampus.get(campus.id) ?? 0,
        averageCompletionPercent: completionByCampus.get(campus.id) ?? 0,
        batches,
        dayKey: day,
      };
    });
  }

  private async campusRef(id: string): Promise<{ name: string; code: string } | null> {
    return this.prisma.campus.findUnique({ where: { id }, select: { name: true, code: true } });
  }

  private async invalidate(): Promise<void> {
    await Promise.all([
      this.cache.delByPrefix('dashboard:'),
      this.cache.delByPrefix('mentor:'),
      this.cache.delByPrefix('leaderboard:'),
      this.cache.delByPrefix('batches:'),
      this.cache.delByPrefix('campuses:'),
    ]);
  }

  private toSummary(
    campus: {
      id: string;
      name: string;
      code: string;
      description: string | null;
      status: string;
      sortOrder: number;
    },
    studentCount: number,
    batchCount: number,
  ): CampusSummary {
    return {
      id: campus.id,
      name: campus.name,
      code: campus.code,
      description: campus.description,
      status: campus.status as CampusSummary['status'],
      sortOrder: campus.sortOrder,
      studentCount,
      batchCount,
    };
  }
}
