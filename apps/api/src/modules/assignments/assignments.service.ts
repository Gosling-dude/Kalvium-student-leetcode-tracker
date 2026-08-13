import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CACHE_TTL,
  extractProblemSlug,
  selectAssignmentForBatch,
  type AssignmentAudienceChangeEntry,
  type AssignmentProblem,
  type AssignmentSummary,
  type DayKey,
  type Paginated,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { paginate } from '../../common/dto/pagination.dto';
import { BatchesService } from '../batches/batches.service';
import { SUBMISSION_PROVIDER, type SubmissionProvider } from '../providers/provider.types';
import { ProviderProblemNotFoundError } from '../providers/provider.errors';
import type {
  ChangeAssignmentTargetDto,
  CreateAssignmentDto,
  UpdateAssignmentDto,
} from './dto/assignment.dto';

/** The `target` value meaning "every batch" — an alias for `batchId = null`. */
const BOTH_TARGET = 'BOTH';

@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly time: ProgramTimeService,
    private readonly batches: BatchesService,
    @Inject(SUBMISSION_PROVIDER) private readonly provider: SubmissionProvider,
  ) {}

  /**
   * Create a day's problem set for one or more batches.
   *
   * Each batch gets its own `Assignment` row even when the problems are identical.
   * Sharing one row between batches would make "edit Foundation's Wednesday" silently
   * edit Intermediate's too, and would leave `DailyStatus.assignmentId` unable to say
   * which set a student was actually measured against.
   *
   * Returns one summary per batch created. All-or-nothing: if any batch already has an
   * assignment that day, nothing is written, so a partial multi-batch create can never
   * leave one batch with work and the other without.
   */
  async create(dto: CreateAssignmentDto, userId: string): Promise<AssignmentSummary[]> {
    if (!this.time.isValid(dto.dayKey)) {
      throw new BadRequestException(`"${dto.dayKey}" is not a valid date (expected YYYY-MM-DD)`);
    }

    const batchIds = await this.resolveTargetBatches(dto.batches);

    const clashes = await this.prisma.assignment.findMany({
      where: { dayKey: dto.dayKey, batchId: { in: batchIds } },
      include: { batch: { select: { name: true } } },
    });
    if (clashes.length > 0) {
      const names = clashes.map((c) => c.batch?.name ?? 'all batches').join(', ');
      throw new BadRequestException(
        `An assignment already exists for ${dto.dayKey} for: ${names}. Update it instead of creating a second one.`,
      );
    }

    // Resolved once, outside the transaction: fetching problem metadata hits the
    // provider, which must not run inside an open database transaction.
    const problemIds = await this.resolveProblems(dto.problemUrls);

    const created = await this.prisma.$transaction(
      batchIds.map((batchId) =>
        this.prisma.assignment.create({
          data: {
            dayKey: dto.dayKey,
            batchId,
            // Frozen at creation — see the schema note on `originalBatchId`.
            originalBatchId: batchId,
            title: dto.title ?? null,
            topic: dto.topic ?? null,
            notes: dto.notes ?? null,
            difficulty: dto.difficulty ?? null,
            createdById: userId,
            problems: {
              create: problemIds.map((problemId, index) => ({ problemId, position: index + 1 })),
            },
          },
          include: this.include(),
        }),
      ),
    );

    await this.invalidate(dto.dayKey);
    return created.map((assignment) => this.toSummary(assignment));
  }

  /**
   * Turn the requested batch selectors into ids.
   *
   * An empty/omitted list means every *active* batch. Archived batches are excluded
   * deliberately: assigning new work to a batch nobody is in creates rows that no
   * student will ever be evaluated against.
   */
  private async resolveTargetBatches(selectors?: string[]): Promise<string[]> {
    if (!selectors || selectors.length === 0) {
      const active = await this.prisma.batch.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { sortOrder: 'asc' },
        select: { id: true },
      });
      if (active.length === 0) {
        throw new BadRequestException(
          'There are no active batches to assign to. Create a batch first.',
        );
      }
      return active.map((batch) => batch.id);
    }

    const ids: string[] = [];
    for (const selector of selectors) {
      const resolved = await this.batches.resolveSelector(selector);
      if (resolved === null) {
        throw new BadRequestException(
          `"${selector}" does not name a batch. Omit "batches" entirely to assign to every batch.`,
        );
      }
      if (!ids.includes(resolved)) ids.push(resolved);
    }
    return ids;
  }

  async update(id: string, dto: UpdateAssignmentDto): Promise<AssignmentSummary> {
    const existing = await this.prisma.assignment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Assignment ${id} was not found`);

    // Replacing the problem list is a delete-then-recreate rather than a diff: the
    // positions must stay contiguous, and a partial update could leave a gap.
    const problemIds = dto.problemUrls ? await this.resolveProblems(dto.problemUrls) : null;

    const assignment = await this.prisma.$transaction(async (tx) => {
      if (problemIds) {
        await tx.assignmentProblem.deleteMany({ where: { assignmentId: id } });
        await tx.assignmentProblem.createMany({
          data: problemIds.map((problemId, index) => ({
            assignmentId: id,
            problemId,
            position: index + 1,
          })),
        });
      }

      return tx.assignment.update({
        where: { id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.topic !== undefined ? { topic: dto.topic } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.difficulty !== undefined ? { difficulty: dto.difficulty } : {}),
          ...(dto.isPublished !== undefined ? { isPublished: dto.isPublished } : {}),
        },
        include: this.include(),
      });
    });

    await this.invalidate(existing.dayKey);
    return this.toSummary(assignment);
  }

  /**
   * "Change Assignment Target" (§9): reconfigure which batch(es) an existing assignment
   * currently applies to — typically a pre-batch legacy row (`batchId = NULL`) being
   * scoped to Foundation, Intermediate or explicitly kept as "Both".
   *
   * What this does *not* do is touch a single `DailyStatus` row. Every day already
   * computed against this assignment stays computed against it: `RollupService` freezes
   * `DailyStatus.assignmentId` the first time a day is scored and never swaps it for a
   * different assignment on a later recompute, so retargeting cannot silently rewrite a
   * result that already exists. `originalBatchId` is never touched either, so the UI can
   * always show what this assignment *was* alongside what it is now.
   */
  async changeTarget(
    id: string,
    dto: ChangeAssignmentTargetDto,
    user: { id: string; name: string },
  ): Promise<AssignmentSummary> {
    const existing = await this.prisma.assignment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Assignment ${id} was not found`);

    const target = await this.resolveTarget(dto.target);

    if (target === existing.batchId) {
      const label = await this.describeBatch(target);
      throw new BadRequestException(`This assignment already targets ${label}.`);
    }

    // A partial/composite unique index (`dayKey`, `batchId`) already enforces this at the
    // database level, but resolving it here gives a mentor-readable error instead of a
    // raw constraint violation.
    const clash = await this.prisma.assignment.findFirst({
      where: { dayKey: existing.dayKey, batchId: target, id: { not: id } },
      include: { batch: { select: { name: true } } },
    });
    if (clash) {
      throw new BadRequestException(
        `${existing.dayKey} already has a separate assignment for ${clash.batch?.name ?? 'all batches'}. ` +
          'Update or delete that one first.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.assignment.update({ where: { id }, data: { batchId: target } });
      await tx.assignmentAudienceChange.create({
        data: {
          assignmentId: id,
          fromBatchId: existing.batchId,
          toBatchId: target,
          reason: dto.reason?.trim() || null,
          changedById: user.id,
          changedByName: user.name,
        },
      });
      // Re-read with the full include *after* both writes land, so the audience-change
      // row just created is the one `toSummary` sees as "latest" (`audienceChangedAt`).
      return tx.assignment.findUniqueOrThrow({ where: { id }, include: this.include() });
    });

    await this.invalidate(existing.dayKey);

    this.logger.log(
      `Retargeted assignment ${id} (${existing.dayKey}) from ${existing.batchId ?? 'all batches'} to ${target ?? 'all batches'}`,
    );

    return this.toSummary(updated);
  }

  /** `null`/absent means "every batch" (`'both'`/`'all'`); anything else must name a batch. */
  private async resolveTarget(target: string): Promise<string | null> {
    const trimmed = target.trim().toUpperCase();
    if (trimmed === BOTH_TARGET || trimmed === 'ALL') return null;
    const resolved = await this.batches.resolveSelector(target);
    if (resolved === null) {
      throw new BadRequestException(`"${target}" does not name a batch. Use "BOTH" for all batches.`);
    }
    return resolved;
  }

  private async describeBatch(batchId: string | null): Promise<string> {
    if (batchId === null) return 'all batches';
    const batch = await this.prisma.batch.findUnique({ where: { id: batchId }, select: { name: true } });
    return batch?.name ?? 'that batch';
  }

  /** Every retarget event for an assignment, newest first — the audit trail behind §9. */
  async audienceHistory(id: string): Promise<AssignmentAudienceChangeEntry[]> {
    const rows = await this.prisma.assignmentAudienceChange.findMany({
      where: { assignmentId: id },
      include: {
        fromBatch: { select: { name: true, code: true } },
        toBatch: { select: { name: true, code: true } },
      },
      orderBy: { changedAt: 'desc' },
    });

    return rows.map(
      (row): AssignmentAudienceChangeEntry => ({
        id: row.id,
        assignmentId: row.assignmentId,
        fromBatchId: row.fromBatchId,
        fromBatchName: row.fromBatch?.name ?? null,
        fromBatchCode: row.fromBatch?.code ?? null,
        toBatchId: row.toBatchId,
        toBatchName: row.toBatch?.name ?? null,
        toBatchCode: row.toBatch?.code ?? null,
        reason: row.reason,
        changedById: row.changedById,
        changedByName: row.changedByName,
        changedAt: row.changedAt.toISOString(),
      }),
    );
  }

  async remove(id: string): Promise<void> {
    const existing = await this.prisma.assignment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Assignment ${id} was not found`);
    await this.prisma.assignment.delete({ where: { id } });
    await this.invalidate(existing.dayKey);
  }

  /**
   * The assignment that applies to `batchId` on `dayKey`.
   *
   * Falls back to a batch-less row when the batch has none of its own — those are the
   * pre-batch assignments that applied to everybody, and they keep applying to everybody
   * (see `selectAssignmentForBatch`). A *different* batch's assignment is never returned.
   *
   * `batchId === null` means "no batch filter": the caller gets the batch-less row if one
   * exists, and otherwise nothing, because there is no single answer for a day where two
   * batches have different sets — use `findAllByDay` for that.
   */
  async findByDay(dayKey: DayKey, batchId?: string | null): Promise<AssignmentSummary | null> {
    const assignments = await this.prisma.assignment.findMany({
      where: {
        dayKey,
        ...(batchId ? { OR: [{ batchId }, { batchId: null }] } : { batchId: null }),
      },
      include: this.include(),
    });

    const selected = selectAssignmentForBatch(assignments, batchId ?? null);
    return selected ? this.toSummary(selected) : null;
  }

  /** Every batch's assignment for a day — what the batch-aware daily tracker renders. */
  async findAllByDay(dayKey: DayKey): Promise<AssignmentSummary[]> {
    const assignments = await this.prisma.assignment.findMany({
      where: { dayKey },
      include: this.include(),
      orderBy: [{ batch: { sortOrder: 'asc' } }, { createdAt: 'asc' }],
    });
    return assignments.map((assignment) => this.toSummary(assignment));
  }

  async findToday(batchId?: string | null): Promise<AssignmentSummary | null> {
    return this.findByDay(this.time.today(), batchId);
  }

  /** A single assignment by id, with the same shape `findByDay`/`findAll` return. */
  async findById(id: string): Promise<AssignmentSummary | null> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id },
      include: this.include(),
    });
    return assignment ? this.toSummary(assignment) : null;
  }

  /** Every batch's set for today, in program-local time. */
  async findAllToday(): Promise<AssignmentSummary[]> {
    return this.findAllByDay(this.time.today());
  }

  async findAll(query: {
    page: number;
    pageSize: number;
    from?: string;
    to?: string;
    search?: string;
    batchId?: string | null;
  }): Promise<Paginated<AssignmentSummary>> {
    const where = {
      // A batch filter includes that batch's own rows plus the pre-batch rows that
      // applied to everyone — the same resolution rule the evaluator uses, so the
      // history list and the results agree about what a batch was given.
      ...(query.batchId ? { OR: [{ batchId: query.batchId }, { batchId: null }] } : {}),
      ...(query.from || query.to
        ? { dayKey: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
      ...(query.search
        ? {
            OR: [
              { topic: { contains: query.search, mode: 'insensitive' as const } },
              { title: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.assignment.findMany({
        where,
        include: this.include(),
        orderBy: [{ dayKey: 'desc' }, { batch: { sortOrder: 'asc' } }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.assignment.count({ where }),
    ]);

    return paginate(rows.map((row) => this.toSummary(row)), total, query.page, query.pageSize);
  }

  /**
   * Preview a problem URL before the assignment is saved, so mentors see the title and
   * difficulty they are about to assign rather than discovering a typo the next day.
   */
  async previewProblem(url: string) {
    const slug = extractProblemSlug(url);
    if (!slug) {
      throw new BadRequestException(
        `Could not read a problem slug from "${url}". ` +
          'Paste a link like https://leetcode.com/problems/two-sum/',
      );
    }
    return this.fetchMetadata(slug);
  }

  // -------------------------------------------------------------------------

  /**
   * Turn pasted URLs into `Problem` rows, fetching metadata for ones we have not seen.
   *
   * Metadata is cached indefinitely-ish because titles and difficulty do not change;
   * only acceptance rate drifts, and not fast enough to matter for an assignment.
   */
  private async resolveProblems(urls: string[]): Promise<string[]> {
    const slugs = urls.map((url, index) => {
      const slug = extractProblemSlug(url);
      if (!slug) {
        throw new BadRequestException(
          `Problem ${index + 1}: could not read a slug from "${url}". ` +
            'Expected a link like https://leetcode.com/problems/two-sum/',
        );
      }
      return slug;
    });

    const duplicates = slugs.filter((slug, index) => slugs.indexOf(slug) !== index);
    if (duplicates.length > 0) {
      throw new BadRequestException(
        `The same problem was assigned more than once: ${[...new Set(duplicates)].join(', ')}`,
      );
    }

    const ids: string[] = [];
    for (const slug of slugs) {
      const existing = await this.prisma.problem.findUnique({ where: { titleSlug: slug } });
      if (existing) {
        ids.push(existing.id);
        continue;
      }

      const metadata = await this.fetchMetadata(slug);
      const created = await this.prisma.problem.upsert({
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
      ids.push(created.id);
    }

    return ids;
  }

  private async fetchMetadata(slug: string) {
    const key = `problem:meta:${slug}`;
    try {
      return await this.cache.remember(key, CACHE_TTL.problemMetadata, () =>
        this.provider.fetchProblemMetadata(slug),
      );
    } catch (error) {
      if (error instanceof ProviderProblemNotFoundError) {
        throw new BadRequestException(
          `No LeetCode problem exists with the slug "${slug}". Check the URL.`,
        );
      }
      throw error;
    }
  }

  private include() {
    return {
      problems: { include: { problem: true }, orderBy: { position: 'asc' as const } },
      createdBy: { select: { name: true } },
      batch: { select: { name: true, code: true } },
      originalBatch: { select: { name: true, code: true } },
      // Only the latest change is needed to answer "has this been retargeted, and when";
      // the full trail is fetched separately via `audienceHistory` when a mentor asks.
      audienceChanges: { orderBy: { changedAt: 'desc' as const }, take: 1 },
    };
  }

  private async invalidate(dayKey: DayKey): Promise<void> {
    await Promise.all([
      this.cache.delByPrefix(`dashboard:${dayKey}`),
      this.cache.delByPrefix(`mentor:${dayKey}`),
      this.cache.delByPrefix(`leaderboard:`),
    ]);
  }

  private toSummary(assignment: {
    id: string;
    dayKey: string;
    batchId: string | null;
    batch?: { name: string; code: string } | null;
    originalBatchId: string | null;
    originalBatch?: { name: string; code: string } | null;
    audienceChanges?: { changedAt: Date }[];
    title: string | null;
    topic: string | null;
    notes: string | null;
    difficulty: string | null;
    createdAt: Date;
    createdBy?: { name: string } | null;
    problems: {
      id: string;
      position: number;
      problem: {
        id: string;
        title: string;
        titleSlug: string;
        url: string;
        difficulty: string;
        questionFrontendId: string | null;
        acceptanceRate: number | null;
        topicTags: string[];
        companyTags: string[];
        isPaidOnly: boolean;
      };
    }[];
  }): AssignmentSummary {
    return {
      id: assignment.id,
      dayKey: assignment.dayKey,
      batchId: assignment.batchId,
      batchName: assignment.batch?.name ?? null,
      batchCode: assignment.batch?.code ?? null,
      originalBatchId: assignment.originalBatchId,
      originalBatchName: assignment.originalBatch?.name ?? null,
      originalBatchCode: assignment.originalBatch?.code ?? null,
      audienceChangedAt: assignment.audienceChanges?.[0]?.changedAt.toISOString() ?? null,
      title: assignment.title,
      topic: assignment.topic,
      notes: assignment.notes,
      difficulty: assignment.difficulty as AssignmentSummary['difficulty'],
      createdAt: assignment.createdAt.toISOString(),
      createdByName: assignment.createdBy?.name ?? null,
      problems: assignment.problems.map(
        (link): AssignmentProblem => ({
          id: link.id,
          position: link.position,
          problemId: link.problem.id,
          title: link.problem.title,
          titleSlug: link.problem.titleSlug,
          url: link.problem.url,
          difficulty: link.problem.difficulty as AssignmentProblem['difficulty'],
          questionFrontendId: link.problem.questionFrontendId,
          acceptanceRate: link.problem.acceptanceRate,
          topicTags: link.problem.topicTags,
          companyTags: link.problem.companyTags,
          isPaidOnly: link.problem.isPaidOnly,
        }),
      ),
    };
  }
}
